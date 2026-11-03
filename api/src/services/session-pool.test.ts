import { describe, test, expect, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionPool, type PoolOptions } from "./session-pool.js";
import type { BrowserSession } from "./browser-session.js";
import type { FastifyBaseLogger } from "fastify";
const pools: SessionPool[] = [];
const roots: string[] = [];
async function fixture(options: PoolOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pool-test-"));
  roots.push(root);
  const factory: NonNullable<PoolOptions["factory"]> = (id, opts, profilePath) => {
    const s = {
      id,
      options: opts,
      profilePath,
      status: "starting",
      startedAt: Date.now(),
      lastActivity: Date.now(),
      clients: 0,
      engine: { busy: () => false },
      launch: vi.fn(async () => {
        s.status = "live";
      }),
      close: vi.fn(async (reason: string) => {
        s.status = "released";
        s.endReason = reason;
      }),
      endReason: "",
      temporaryProfileRemoved: false,
      info: () => ({
        id,
        status: s.status,
        endReason: s.endReason,
        temporaryProfileRemoved: s.temporaryProfileRemoved,
        proxyTxBytes: 0,
        proxyRxBytes: 0,
        duration: 1,
      }),
    };
    return s as unknown as BrowserSession;
  };
  const pool = new SessionPool({ info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger, {
    profilesRoot: root,
    queueMs: 20,
    factory,
    ...options,
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  for (const p of pools.splice(0)) await p.drain(0);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("session pool", () => {
  test("runs three isolated sessions and refuses a fourth after its queue deadline", async () => {
    const pool = await fixture();
    const sessions = await Promise.all([pool.create({}), pool.create({}), pool.create({})]);
    expect(new Set(sessions.map((s) => s.profilePath)).size).toBe(3);
    await expect(pool.create({})).rejects.toMatchObject({ statusCode: 429 });
    expect(sessions.every((s) => s.status === "live")).toBe(true);
    const first = sessions[0];
    await pool.release(first.id);
    await expect(stat(first.profilePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(sessions[1].status).toBe("live");
    expect(pool.details(first.id).temporaryProfileRemoved).toBe(true);
  });
  test("locks a named identity before launch and preserves it across pool replacement", async () => {
    const pool = await fixture();
    const first = await pool.create({ identity: "account" });
    await writeFile(path.join(first.profilePath, "cookie-marker"), "retained");
    await expect(pool.create({ identity: "account" })).rejects.toMatchObject({ statusCode: 409 });
    await pool.release(first.id);
    const next = await pool.create({ identity: "account" });
    expect(await readFile(path.join(next.profilePath, "cookie-marker"), "utf8")).toBe("retained");
  });
  test("hands a freed slot to the queued caller without exceeding the limit", async () => {
    const pool = await fixture({ maxSessions: 1, queueMs: 500 });
    const a = await pool.create({});
    const b = pool.create({});
    await pool.release(a.id);
    const next = await b;
    expect(pool.size).toBe(1);
    expect(next.status).toBe("live");
  });
  test("cleans up a failed launch and unlocks the identity", async () => {
    const pool = await fixture({
      factory: (id, options, profilePath) =>
        ({
          id,
          options,
          profilePath,
          launch: async () => {
            throw new Error("launch failed");
          },
          close: async () => {},
        }) as unknown as BrowserSession,
    });
    await expect(pool.create({ identity: "account" })).rejects.toThrow("launch failed");
    await expect(pool.create({ identity: "account" })).rejects.toThrow("launch failed");
    expect(pool.size).toBe(0);
  });
  test("idle timeout ignores attached clients; lifetime cap still applies", async () => {
    const pool = await fixture({ idleMs: 10, lifetimeMs: 100 });
    const a = await pool.create({});
    a.clients = 1;
    await pool.expire(a.startedAt + 20);
    expect(pool.size).toBe(1);
    await pool.expire(a.startedAt + 101);
    expect(pool.details(a.id).endReason).toBe("lifetime");
    const b = await pool.create({});
    await pool.expire(b.lastActivity + 11);
    expect(pool.details(b.id).endReason).toBe("idle");
  });
  test("draining rejects new requests and ends remaining sessions", async () => {
    const pool = await fixture();
    const a = await pool.create({});
    await pool.drain(0);
    await expect(pool.create({})).rejects.toMatchObject({ statusCode: 503 });
    expect(pool.details(a.id).endReason).toBe("draining");
  });
  test("rejects path traversal and removed modes", async () => {
    const pool = await fixture();
    for (const body of [
      { identity: "../escape" },
      { isSelenium: true },
      { userDataDir: "/tmp/a" },
      { mode: "selenium" },
      { mode: "quiet", headless: true },
      { mode: "quiet", sessionContext: { cookies: [] } },
    ])
      await expect(pool.create(body)).rejects.toMatchObject({ statusCode: 400 });
  });
  test("accepts quiet mode with a named profile", async () => {
    const pool = await fixture();
    const session = await pool.create({ mode: "quiet", identity: "quiet-account" });
    expect(session.options.mode).toBe("quiet");
    expect(session.options.identity).toBe("quiet-account");
  });
  test("reports an unknown session without affecting a live browser", async () => {
    const pool = await fixture();
    const a = await pool.create({});
    await expect(pool.release("missing")).rejects.toMatchObject({ statusCode: 404 });
    expect(a.status).toBe("live");
  });
});
