// Metadata for migration acceptance. Never store URLs, page content, credentials
// or error messages here. Session endings and caller results are separate facts.
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { z } from "zod";

export const callerTag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/);
export const outcomeBody = z
  .object({
    attemptId: z.string().uuid(),
    observedAt: z.string().datetime().optional(),
    caller: callerTag,
    site: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/)
      .optional(),
    sessionId: z.string().uuid().optional(),
    backend: z.enum(["steel", "browserbase"]),
    outcome: z.enum(["success", "failure", "unknown"]),
    reason: z.enum([
      "completed",
      "payload_missing",
      "challenge_required",
      "auth_required",
      "quota",
      "http_error",
      "exception",
      "unavailable",
      "unobserved",
    ]),
    fallback: z.boolean().default(false),
    fallbackReason: z
      .enum(["unavailable", "transport", "capacity", "identity_busy", "forced", "http_error"])
      .optional(),
  })
  .strict();
type Event = Record<string, any> & { eventId: string; at: string; caller: string; kind: string };

export class CallerOutcomes {
  private events: Event[] = [];
  private ids = new Set<string>();
  private serial: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  private file: string;
  constructor(root: string) {
    this.file = path.join(root, "caller-outcomes.jsonl");
    this.ready = this.read(root);
  }
  private async read(root: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      for await (const line of createInterface({
        input: createReadStream(this.file),
        crlfDelay: Infinity,
      })) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as Event;
        this.events.push(row);
        this.ids.add(row.eventId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async append(event: Event) {
    await this.ready;
    const work = this.serial.then(async () => {
      if (this.ids.has(event.eventId)) return;
      await appendFile(this.file, JSON.stringify(event) + "\n", { mode: 0o600 });
      this.events.push(event);
      this.ids.add(event.eventId);
    });
    this.serial = work.catch(() => undefined);
    await work;
  }
  async result(body: z.infer<typeof outcomeBody>, agent: string) {
    await this.append({
      ...body,
      eventId: `result:${agent}:${body.attemptId}`,
      kind: "result",
      agent,
      at: body.observedAt ?? new Date().toISOString(),
    });
    return { recorded: true };
  }
  async session(info: any, agent: string, caller?: string, site?: string) {
    await this.append({
      eventId: `session:${info.id}`,
      kind: "session",
      at: new Date().toISOString(),
      agent,
      caller: caller ?? "unattributed",
      site,
      sessionId: info.id,
      mode: info.mode,
      identity: info.identity,
      endReason: info.endReason,
      durationMs: info.duration,
      residentialBytes: (info.proxyTxBytes ?? 0) + (info.proxyRxBytes ?? 0),
      directBytes: info.directBytes ?? 0,
    });
  }
  async sessionOwner(sessionId: string) {
    await this.ready;
    return this.events.find((event) => event.kind === "session" && event.sessionId === sessionId)
      ?.agent;
  }
  async summary(from?: string, to?: string) {
    await this.ready;
    await this.serial;
    const groups = new Map<string, any>();
    for (const e of this.events) {
      if ((from && e.at < from) || (to && e.at >= to)) continue;
      const day = e.at.slice(0, 10);
      const key = `${day}/${e.caller}`;
      let row = groups.get(key);
      if (!row) {
        row = {
          day,
          caller: e.caller,
          sessions: 0,
          endReasons: {},
          residentialBytes: 0,
          directBytes: 0,
          attempts: 0,
          successes: 0,
          failures: 0,
          unknown: 0,
          fallbacks: 0,
          failedOrFallback: 0,
          fallbackReasons: {},
          firstAt: e.at,
          lastAt: e.at,
        };
        groups.set(key, row);
      }
      row.firstAt = row.firstAt < e.at ? row.firstAt : e.at;
      row.lastAt = row.lastAt > e.at ? row.lastAt : e.at;
      if (e.kind === "session") {
        row.sessions++;
        const reason = e.endReason ?? "unknown";
        row.endReasons[reason] = (row.endReasons[reason] ?? 0) + 1;
        row.residentialBytes += e.residentialBytes;
        row.directBytes += e.directBytes;
      } else {
        row.attempts++;
        if (e.outcome === "failure" || e.fallback) row.failedOrFallback++;
        row[
          e.outcome === "success" ? "successes" : e.outcome === "failure" ? "failures" : "unknown"
        ]++;
        if (e.fallback) {
          row.fallbacks++;
          const reason = e.fallbackReason ?? "unavailable";
          row.fallbackReasons[reason] = (row.fallbackReasons[reason] ?? 0) + 1;
        }
      }
    }
    return {
      from,
      to,
      days: [...groups.values()]
        .map((row) => ({
          ...row,
          observedAttempts: row.successes + row.failures,
          failureRate: row.attempts ? row.failedOrFallback / row.attempts : null,
          fallbackRate: row.attempts ? row.fallbacks / row.attempts : null,
        }))
        .sort((a, b) => `${a.day}/${a.caller}`.localeCompare(`${b.day}/${b.caller}`)),
      acceptance:
        "Evaluate failures and fallbacks over seven days of normal use; unknown outcomes cannot establish acceptance.",
    };
  }
}
