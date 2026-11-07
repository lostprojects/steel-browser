import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { type ProxyState, proxyName, proxyProfile } from "./types.js";

const count = z.number().nonnegative().finite();
const exit = z
  .object({ ip: z.string(), timezone: z.string(), country: z.string(), region: z.string() })
  .strict();
const schema = z
  .object({
    version: z.literal(2),
    organization: z.string().min(1),
    days: z.record(z.string(), z.record(z.string(), count)),
    total: count,
    lifetime: z.record(z.string(), count),
    products: z.record(z.string(), count),
    profiles: z.record(proxyName, proxyProfile),
    identities: z.record(
      proxyName,
      z
        .object({
          country: z.string().regex(/^[A-Z]{2}$/),
          stickyId: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
          lastExit: exit.optional(),
          profile: proxyName.optional(),
          binding: z.string().optional(),
          session: proxyProfile.shape.session.optional(),
        })
        .strict(),
    ),
    leases: z.record(
      z.string(),
      z
        .object({
          id: z.string(),
          owner: z.string(),
          agent: z.string(),
          profile: z.string(),
          product: z.string(),
          session: proxyProfile.shape.session,
          identity: proxyName.optional(),
          country: z.string(),
          createdAt: count,
          expiresAt: count,
          status: z.enum(["preparing", "active", "closed"]),
          reason: z.string().optional(),
          exit: exit.optional(),
          txBytes: count,
          rxBytes: count,
          directBytes: count,
          budgetBytes: count.optional(),
        })
        .strict(),
    ),
    bad: z.record(z.string(), z.record(z.string(), count)),
    health: z.record(
      z.string(),
      z
        .object({
          attempts: count,
          successes: count,
          failures: count,
          lastFailure: z.string().optional(),
          lastSuccessAt: count.optional(),
        })
        .strict(),
    ),
  })
  .strict();

export class ProxyStore {
  state: ProxyState;
  readonly ready: Promise<void>;
  private serial: Promise<void> = Promise.resolve();
  private persisted?: string;
  readonly file: string;
  constructor(
    root: string,
    readonly organization: string,
  ) {
    this.file = path.join(root, "proxy-state.json");
    this.state = {
      version: 2,
      organization,
      days: {},
      total: 0,
      lifetime: {},
      products: {},
      profiles: {},
      identities: {},
      leases: {},
      bad: {},
      health: {},
    };
    this.ready = this.load(root);
    void this.ready.catch(() => undefined);
  }
  private async load(root: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (value.version === undefined) {
        // Validate before migration: malformed or credential-bearing state never resets spend.
        const legacy = z
          .object({
            days: schema.shape.days,
            total: count,
            identities: schema.shape.identities,
            bad: schema.shape.bad,
          })
          .strict()
          .parse(value);
        const lifetime: Record<string, number> = {};
        for (const day of Object.values(legacy.days))
          for (const [name, bytes] of Object.entries(day))
            lifetime[name] = (lifetime[name] ?? 0) + bytes;
        this.state = { ...this.state, ...legacy, lifetime, products: { core: legacy.total } };
        for (const identity of Object.values(this.state.identities)) identity.session ??= "hard";
      } else this.state = schema.parse(value);
      if (this.state.organization !== this.organization) throw new Error("Wrong organization");
      for (const lease of Object.values(this.state.leases))
        if (lease.status !== "closed") {
          lease.status = "closed";
          lease.reason = "worker_restart";
        }
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Proxy state could not be loaded; access refused");
    }
  }
  persist() {
    const text = JSON.stringify(this.state);
    const work = this.serial.then(async () => {
      if (this.persisted === text) return;
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(text);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.file);
        this.persisted = text;
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
    this.serial = work.catch(() => undefined);
    return work;
  }
}
