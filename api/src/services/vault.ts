// Stores service-owned credentials. Values must not leave the service through
// metadata, errors or logs; writes are encrypted and replaced atomically.
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Agent } from "./proxy/service.js";
import { readSharedStore, storeName } from "./shared-store.js";

const name = storeName;
export const vaultInput = z
  .object({
    fields: z.record(name, z.string().min(1).max(8192)).refine((v) => Object.keys(v).length <= 24),
    allowedAgents: z.array(name).min(1).max(64).default(["admin"]),
  })
  .strict();
type Entry = z.infer<typeof vaultInput> & { lastUsed?: string };
export const protectedDisplays = new Set<string>();
const secrets = new Set<string>();
export function protect(value: string) {
  if (!value) return;
  for (const variant of [
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString("base64"),
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  ])
    secrets.add(variant);
}
export function scrub(text: string): string {
  for (const value of [...secrets].sort((a, b) => b.length - a.length))
    text = text.split(value).join("[redacted]");
  return text;
}
export function scrubObject<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map(scrubObject) as T;
  if (value instanceof Error) return { name: value.name, message: scrub(value.message) } as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        scrub(k),
        /^(?:password|authorization|cookie|set-cookie|seed|proxyUrl|VAULT_KEY|steel-api-key|apiKey|STEEL_API_KEY|STEEL_AGENT_KEYS)$/i.test(
          k,
        )
          ? "[redacted]"
          : scrubObject(v),
      ]),
    ) as T;
  return value;
}

export class Vault {
  private key?: Buffer;
  private entries: Record<string, Entry> = {};
  private serial: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  status: "locked" | "open" = "locked";
  constructor(
    readonly file = process.env.VAULT_PATH ?? "/data/vault",
    key = process.env.VAULT_KEY,
  ) {
    if (key && /^[a-fA-F0-9]{64}$/.test(key)) {
      this.key = Buffer.from(key, "hex");
      protect(key);
    }
    this.ready = this.load();
  }
  private async load() {
    if (!this.key) return;
    try {
      const bytes = await readFile(this.file);
      if (bytes.subarray(0, 4).toString() !== "MV01" || bytes.length < 32) return;
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(4, 16));
      decipher.setAAD(Buffer.from("mosaic-vault-v1"));
      decipher.setAuthTag(bytes.subarray(16, 32));
      const data = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString(),
      );
      for (const [key, entry] of Object.entries(data)) {
        name.parse(key);
        const parsed = vaultInput.extend({ lastUsed: z.string().optional() }).parse(entry);
        this.entries[key] = parsed;
        Object.values(parsed.fields).forEach(protect);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.entries = {};
        return;
      }
    }
    this.status = "open";
  }
  private async save() {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    cipher.setAAD(Buffer.from("mosaic-vault-v1"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.entries)), cipher.final()]);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(
      this.file + ".tmp",
      Buffer.concat([Buffer.from("MV01"), iv, cipher.getAuthTag(), ciphertext]),
      { mode: 0o600 },
    );
    await rename(this.file + ".tmp", this.file);
  }
  private async transaction<T>(fn: () => Promise<T>) {
    await this.ready;
    if (this.status !== "open")
      throw Object.assign(new Error("Vault is locked"), { statusCode: 503 });
    const work = this.serial.then(fn);
    this.serial = work.catch(() => undefined);
    return work;
  }
  async list(agent: Agent, entryName?: string, scope: "all" | "personal" = "all", fresh = false) {
    await this.ready;
    const shared =
      scope === "personal" || (entryName && Object.hasOwn(this.entries, entryName))
        ? {}
        : (await readSharedStore(fresh)).credentials;
    for (const fields of Object.values(shared)) Object.values(fields).forEach(protect);
    const personal = Object.entries(this.entries)
      .filter(
        ([n, e]) =>
          (!entryName || n === entryName) && (agent.admin || e.allowedAgents.includes(agent.name)),
      )
      .map(([name, e]) => ({
        name,
        fields: Object.keys(e.fields),
        lastUsed: e.lastUsed ?? null,
        scope: "personal" as const,
      }));
    return [
      ...personal,
      ...Object.entries(shared)
        .filter(
          ([name]) => (!entryName || name === entryName) && !Object.hasOwn(this.entries, name),
        )
        .map(([name, fields]) => ({
          name,
          fields: Object.keys(fields),
          lastUsed: null,
          scope: "global" as const,
        })),
    ];
  }
  async put(entryName: string, input: unknown, agent: Agent) {
    if (!agent.admin) throw Object.assign(new Error("Admin key required"), { statusCode: 403 });
    name.parse(entryName);
    // Register before validation so validation errors cannot echo supplied values.
    if (input && typeof input === "object" && "fields" in input)
      for (const value of Object.values((input as any).fields ?? {}))
        if (typeof value === "string") protect(value);
    const data = vaultInput.parse(input);
    await this.transaction(async () => {
      const previous = this.entries[entryName];
      this.entries[entryName] = data;
      try {
        await this.save();
      } catch (error) {
        if (previous) this.entries[entryName] = previous;
        else delete this.entries[entryName];
        throw error;
      }
    });
    return (await this.list(agent, entryName))[0];
  }
  async use<T>(
    entryName: string,
    agent: Agent,
    fn: (fields: Readonly<Record<string, string>>) => Promise<T>,
    expectedScope?: "personal" | "global",
  ): Promise<T> {
    await this.ready;
    const shared = Object.hasOwn(this.entries, entryName)
      ? {}
      : (await readSharedStore(true)).credentials;
    let fields!: Record<string, string>;
    await this.transaction(async () => {
      const entry = this.entries[entryName];
      if (expectedScope && expectedScope !== (entry ? "personal" : "global"))
        throw Object.assign(
          new Error("The selected credential binding changed; select the account again"),
          { statusCode: 409 },
        );
      if (!entry && Object.hasOwn(shared, entryName)) {
        fields = { ...shared[entryName] };
        Object.values(fields).forEach(protect);
        return;
      }
      if (!entry || (!agent.admin && !entry.allowedAgents.includes(agent.name)))
        throw Object.assign(new Error("Vault entry unavailable for this agent"), {
          statusCode: 403,
        });
      entry.lastUsed = new Date().toISOString();
      fields = { ...entry.fields };
      await this.save();
    });
    return fn(fields);
  }
  async delete(entryName: string, agent: Agent) {
    if (!agent.admin) throw Object.assign(new Error("Admin key required"), { statusCode: 403 });
    name.parse(entryName);
    await this.transaction(async () => {
      const previous = this.entries[entryName];
      delete this.entries[entryName];
      try {
        await this.save();
      } catch (error) {
        if (previous) this.entries[entryName] = previous;
        throw error;
      }
    });
    return { name: entryName, deleted: true };
  }
}

// RFC 6238 SHA-1, six digits and thirty seconds. The seed never goes to a client.
export function totp(seed: string, now = Date.now()) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of seed.toUpperCase().replace(/[\s=-]/g, "")) {
    const n = chars.indexOf(ch);
    if (n < 0) throw new Error("Invalid TOTP seed");
    bits += n.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  if (key.length < 10) throw new Error("Invalid TOTP seed");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash[19] & 15;
  const code = ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
  protect(code);
  return code;
}
export const vault = new Vault();
