// Reserves API usage durably before a provider call. This journal contains
// metadata and keyed fingerprints only; never persist queries, results or keys.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { apiToolName, type ApiConnectionSettings } from "./connection-store.js";
import { storeName } from "./shared-store.js";
import { PublicError } from "../utils/public-error.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const recordSchema = z
  .object({
    key: digest,
    fingerprint: digest,
    id: z.string().uuid(),
    owner: storeName,
    connection: z.string().regex(/^api:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    tool: apiToolName,
    capabilityVersion: z.string().min(1).max(100).optional(),
    connectedApp: z
      .object({
        orgId: z.string().uuid().optional(),
        membershipId: z.string().uuid().optional(),
        userId: storeName,
        keyId: z.string().max(128),
        oauthClientId: z.string().max(2048).optional(),
      })
      .strict()
      .optional(),
    accountBinding: z
      .object({
        provider: z.string().max(64),
        credential: storeName,
        field: storeName,
        scope: z.enum(["personal", "global"]),
      })
      .strict()
      .optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    state: z.enum(["running", "succeeded", "partial", "failed", "unknown"]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    reservedMicros: micros,
    accountedMicros: micros,
    costBasis: z.enum(["reservation", "provider_estimate", "no_request"]),
    providerRequestId: z.string().max(128).optional(),
    errorCode: z
      .string()
      .regex(/^[a-z0-9_]{1,100}$/)
      .optional(),
  })
  .strict();
export type ApiExecutionRecord = z.infer<typeof recordSchema>;
export type ApiExecutionMetadata = Omit<ApiExecutionRecord, "key" | "fingerprint">;
export function executionMetadata(row: ApiExecutionRecord): ApiExecutionMetadata {
  const { key: _key, fingerprint: _fingerprint, ...metadata } = row;
  return metadata;
}
const retentionMs = 7 * 24 * 60 * 60_000;

export class ApiLedger {
  private readonly rows = new Map<string, ApiExecutionRecord>();
  private serial: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  readonly ready: Promise<void>;
  constructor(
    readonly file: string,
    private readonly now = () => Date.now(),
  ) {
    this.ready = this.load();
    void this.ready.catch(() => undefined);
  }
  private async load() {
    try {
      const info = await stat(this.file);
      if (info.size > 64 * 1024 * 1024) throw new Error("API journal is too large");
      const text = await readFile(this.file, "utf8");
      this.bytes = Buffer.byteLength(text);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const row = recordSchema.parse(JSON.parse(line));
        if (row.state === "running") {
          row.state = "unknown";
          row.finishedAt = new Date(this.now()).toISOString();
          row.errorCode = "execution_interrupted";
        }
        this.rows.set(row.key, row);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("API usage journal could not be validated; execution refused");
    }
  }
  private async change<T>(work: () => Promise<T>) {
    await this.ready;
    const pending = this.serial.then(work);
    this.serial = pending.catch(() => undefined);
    return pending;
  }
  private async append(row: ApiExecutionRecord) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(row) + "\n";
    const handle = await open(this.file, "a", 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.bytes += Buffer.byteLength(line);
    this.rows.set(row.key, row);
  }
  private async compact() {
    let expired = false;
    for (const [key, row] of this.rows)
      if (Date.parse(row.startedAt) < this.now() - retentionMs) {
        this.rows.delete(key);
        expired = true;
      }
    if (!expired && this.bytes < 8 * 1024 * 1024) return;
    const text = [...this.rows.values()].map((row) => JSON.stringify(row) + "\n").join("");
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file + ".tmp", text, { mode: 0o600 });
    const handle = await open(this.file + ".tmp", "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.file + ".tmp", this.file);
    this.bytes = Buffer.byteLength(text);
  }
  async reserve(
    input: Pick<
      ApiExecutionRecord,
      | "key"
      | "fingerprint"
      | "owner"
      | "connection"
      | "tool"
      | "capabilityVersion"
      | "connectedApp"
      | "accountBinding"
    >,
    reservedMicros: number,
    policy: ApiConnectionSettings,
  ) {
    return this.change(async () => {
      await this.compact();
      const previous = this.rows.get(input.key);
      if (previous) {
        if (previous.fingerprint !== input.fingerprint)
          throw new PublicError(
            "idempotency_conflict",
            "Retry key was used with different arguments or account binding",
            409,
          );
        throw new PublicError(
          "execution_replay_unavailable",
          "This execution is already recorded; its response is no longer retained",
          409,
          { execution: executionMetadata(previous) },
        );
      }
      if (this.rows.size >= 10_000)
        throw new PublicError("execution_capacity", "API history capacity is full", 429);
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const used = [...this.rows.values()].filter(
        (row) => row.day === day && row.connection === input.connection,
      );
      const accounted = used.reduce((sum, row) => sum + row.accountedMicros, 0);
      if (
        used.length >= policy.dailyCalls ||
        accounted + reservedMicros > Math.round(policy.dailyBudgetUSD * 1_000_000)
      )
        throw new PublicError(
          "usage_limit",
          "This API connection has reached its daily call or estimated-spend limit",
          429,
        );
      const row = recordSchema.parse({
        ...input,
        id: randomUUID(),
        day,
        state: "running",
        startedAt: new Date(this.now()).toISOString(),
        reservedMicros,
        accountedMicros: reservedMicros,
        costBasis: "reservation",
      });
      await this.append(row);
      return structuredClone(row);
    });
  }
  async finish(
    key: string,
    outcome: Pick<ApiExecutionRecord, "state" | "accountedMicros" | "costBasis"> &
      Partial<Pick<ApiExecutionRecord, "providerRequestId" | "errorCode">>,
  ) {
    return this.change(async () => {
      const previous = this.rows.get(key);
      if (!previous) throw new Error("Missing API usage reservation");
      if (previous.state !== "running") return structuredClone(previous);
      const row = recordSchema.parse({
        ...previous,
        ...outcome,
        finishedAt: new Date(this.now()).toISOString(),
      });
      await this.append(row);
      return structuredClone(row);
    });
  }
  async history(
    connection: string,
    owner: string,
    admin: boolean,
    options: { limit: number; offset: number },
  ) {
    await this.ready;
    await this.serial;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const rows = [...this.rows.values()].filter(
      (row) =>
        row.connection === connection && Date.parse(row.startedAt) >= this.now() - retentionMs,
    );
    const daily = rows.filter((row) => row.day === day);
    const visible = rows
      .filter((row) => admin || row.owner === owner)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const end = options.offset + options.limit;
    return {
      day,
      connection,
      calls: daily.length,
      accountedUSD: daily.reduce((sum, row) => sum + row.accountedMicros, 0) / 1_000_000,
      total: visible.length,
      nextOffset: end < visible.length ? end : null,
      executions: visible.slice(options.offset, end).map(executionMetadata),
    };
  }
  async flush() {
    await this.ready;
    await this.serial;
  }
  async activity(owner: string, options: { limit: number; offset: number }) {
    await this.ready;
    await this.serial;
    const rows = [...this.rows.values()]
      .filter((row) => row.owner === owner && Date.parse(row.startedAt) >= this.now() - retentionMs)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const end = options.offset + options.limit;
    return {
      total: rows.length,
      nextOffset: end < rows.length ? end : null,
      executions: rows.slice(options.offset, end).map(executionMetadata),
    };
  }
}
