import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProxyService, type Agent } from "./service.js";
import { defaults, upstream, validateProfile } from "./provider.js";
import { actor } from "./types.js";
import type { BrowserSession } from "../browser-session.js";
import { httpFetch } from "../http-fetch.js";
vi.mock("../http-fetch.js", () => ({ httpFetch: vi.fn() }));
const roots: string[] = [];
const admin: Agent = { name: "admin", admin: true, dailyBudgetBytes: 100000 };
const alice: Agent = { name: "alice", dailyBudgetBytes: 100000 };
const bob: Agent = { name: "bob", dailyBudgetBytes: 100000 };
const exit = (ip = "203.0.113.4", country = "US") => ({
  ip,
  country,
  timezone: "America/New_York",
  region: "New York",
});
async function fixture() {
  vi.stubEnv(
    "EVOMI_RESIDENTIAL_PROXY_URL",
    "http://user:invisible%21%40@core-residential.evomi.com:1000",
  );
  vi.stubEnv(
    "EVOMI_PREMIUM_PROXY_URL",
    "http://premium:another-secret@premium-residential.evomi.com:1000",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "toolstack-proxy-"));
  roots.push(root);
  const servers: Array<{
    url: string;
    upstreamProxyUrl: string;
    rxBytes: number;
    txBytes: number;
    directBytes: number;
    listen: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    allowed: () => boolean;
  }> = [];
  const probe = vi.fn(async (_proxy: string, _signal: AbortSignal, _timeout: number) => {
    const server = servers.at(-1)!;
    server.rxBytes += 100;
    server.txBytes += 20;
    return exit();
  });
  const forwarder = (url: string, _split: boolean, allowed: () => boolean) => {
    const value = {
      url: `http://127.0.0.1:${40000 + servers.length}`,
      upstreamProxyUrl: url,
      rxBytes: 0,
      txBytes: 0,
      directBytes: 0,
      allowed,
      listen: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    servers.push(value);
    return value;
  };
  const options = { organization: "fixture", probe, forwarder };
  const service = new ProxyService(root, options);
  await service.ready;
  return { root, service, servers, probe, options };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("provider profiles", () => {
  it("builds product-aware, percent-encoded HTTP, TLS and SOCKS routes", async () => {
    await fixture();
    const core = new URL(upstream(defaults.core, "abc12345"));
    expect(decodeURIComponent(core.password)).toBe("invisible!@_country-US_lockedsession-abc12345");
    const tls = new URL(
      upstream(
        validateProfile({
          product: "premium",
          protocol: "https",
          session: "sticky",
          lifetimeMinutes: 12,
          target: { country: "GB", city: "New York" },
        }),
        "abc12345",
      ),
    );
    expect(tls.protocol).toBe("https:");
    expect(tls.hostname).toBe("rp.evomi-proxy.com");
    expect(tls.port).toBe("1001");
    expect(decodeURIComponent(tls.password)).toContain(
      "_city-new.york_session-abc12345_lifetime-12",
    );
    expect(new URL(upstream(validateProfile({ protocol: "socks5" }), "abc12345")).protocol).toBe(
      "socks5:",
    );
    expect(() => validateProfile({ product: "core", protocol: "https" })).toThrow();
    expect(() =>
      validateProfile({ product: "core", target: { country: "US", isp: "Comcast" } }),
    ).toThrow();
    expect(() => validateProfile({ session: "hard", lifetimeMinutes: 30 })).toThrow();
    expect(() => validateProfile({ product: "mobile", maxLatencyMs: 100 })).toThrow();
    expect(() => validateProfile({ target: { country: "US", city: "x_country-DE" } })).toThrow();
  });
  it("publishes only permitted profiles and never treats a connected app as the transport administrator", async () => {
    const f = await fixture();
    expect((await f.service.profiles(alice)).map((p) => p.name)).toEqual(["core"]);
    await expect(f.service.acquire({ profile: "premium" }, alice)).rejects.toMatchObject({
      statusCode: 403,
    });
    await f.service.putProfile("approved", { product: "premium", allowedAgents: ["alice"] }, admin);
    expect((await f.service.acquire({ profile: "approved" }, alice)).product).toBe("premium");
    const connected = {
      ...admin,
      connectedApp: {
        orgId: "org",
        membershipId: "member",
        keyId: "key",
        userId: "owner",
        admin: false,
        expires: Date.now() + 1000,
      },
    } as Agent;
    await expect(f.service.putProfile("bad", {}, connected)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(f.service.acquire({ profile: "premium" }, connected)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(actor(connected)).not.toBe("admin");
  });
});

describe("durable proxy ledger", () => {
  it("migrates the old state without resetting spend or identity allocations", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.root, "proxy-state.json"),
      JSON.stringify({
        days: { "2026-01-01": { alice: 540, admin: 7 } },
        total: 667,
        identities: { ancestry: { country: "US", stickyId: "keep123" } },
        bad: {},
      }),
    );
    const migrated = new ProxyService(f.root, f.options);
    expect(await migrated.identities()).toEqual([
      { name: "ancestry", country: "US", lastExit: undefined },
    ]);
    const total = await migrated.totals();
    expect(total.totalResidentialBytes).toBe(667);
    expect(total.totalByAgent).toEqual({ alice: 540, admin: 7 });
    expect(JSON.parse(await readFile(path.join(f.root, "proxy-state.json"), "utf8")).version).toBe(
      2,
    );
    expect((await stat(path.join(f.root, "proxy-state.json"))).mode & 0o777).toBe(0o600);
    const lease = await migrated.acquire({ identity: "ancestry" }, alice);
    expect(lease.session).toBe("hard");
    expect(decodeURIComponent(new URL(f.servers.at(-1)!.upstreamProxyUrl).password)).toContain(
      "hardsession-keep123",
    );
    await migrated.release(lease.id, alice);
    await migrated.rotateIdentity("ancestry", admin);
    expect((await migrated.acquire({ identity: "ancestry" }, alice)).session).toBe("locked");
  });
  it("refuses corrupted and cross-organization state instead of creating a fresh budget", async () => {
    const f = await fixture();
    await f.service.totals();
    await expect(
      new ProxyService(f.root, { ...f.options, organization: "other" }).ready,
    ).rejects.toThrow(/refused/);
    await writeFile(path.join(f.root, "proxy-state.json"), "broken");
    await expect(new ProxyService(f.root, f.options).ready).rejects.toThrow(/refused/);
    expect(await readFile(path.join(f.root, "proxy-state.json"), "utf8")).toBe("broken");
  });
  it("counts live and final bytes once, shares the actor budget and preserves cumulative spend over midnight", async () => {
    const f = await fixture(),
      owner = { ...alice, dailyBudgetBytes: 500 };
    const a = await f.service.acquire({}, owner),
      b = await f.service.acquire({}, owner);
    expect((await f.service.totals()).totalProxyBytes).toBe(240);
    expect((await f.service.totals()).totalProxyBytes).toBe(240);
    f.servers[0].rxBytes = 400;
    expect(f.servers[1].allowed()).toBe(false);
    await f.service.tick();
    expect((await f.service.list(owner)).every((r) => r.status === "closed")).toBe(true);
    expect((await f.service.totals()).totalProxyBytes).toBe(540);
    await f.service.release(a.id, owner);
    await f.service.release(b.id, owner);
    const restored = new ProxyService(f.root, f.options);
    await restored.ready;
    await expect(restored.acquire({}, owner)).rejects.toMatchObject({ statusCode: 429 });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 86400_000);
    expect(restored.remaining(owner)).toBe(500);
    expect((await restored.totals()).totalByAgent.alice).toBe(540);
  });
  it("marks orphaned leases closed on restart and never persists a credential", async () => {
    const f = await fixture();
    const lease = await f.service.acquire({}, alice);
    const saved = await readFile(path.join(f.root, "proxy-state.json"), "utf8");
    expect(saved).not.toMatch(/invisible|another-secret|127\.0\.0\.1|upstreamProxyUrl/);
    const restarted = new ProxyService(f.root, f.options);
    await restarted.ready;
    expect(await restarted.get(lease.id, alice)).toMatchObject({
      status: "closed",
      reason: "worker_restart",
      rxBytes: 100,
    });
  });
});

describe("lease lifecycle and identity continuity", () => {
  it("keeps HTTP, browser and downloads on one lease without Chrome owning its listener", async () => {
    const f = await fixture();
    const lease = await f.service.acquire({}, alice);
    const session = {
      id: "browser",
      options: { proxyLeaseId: lease.id },
      priorProxyTxBytes: 0,
      priorProxyRxBytes: 0,
    } as unknown as BrowserSession;
    await f.service.prepare(session, alice);
    expect(session.exit).toEqual(exit());
    await session.proxyServer!.close(true);
    expect(f.servers[0].close).not.toHaveBeenCalled();
    vi.mocked(httpFetch).mockImplementationOnce(async (options) => {
      expect(options.proxy).toBe(f.servers[0].url);
      f.servers[0].rxBytes += 30;
      return { status: 200, url: options.url, headers: {}, body: "" };
    });
    await f.service.fetch(lease.id, { url: "https://example.com" }, alice);
    expect(session.proxyServer!.rxBytes).toBe(30);
    await expect(f.service.release(lease.id, alice)).rejects.toMatchObject({ statusCode: 409 });
    await f.service.settle("browser");
    expect((await f.service.get(lease.id, alice)).status).toBe("active");
    await f.service.release(lease.id, alice);
    expect(f.servers[0].close).toHaveBeenCalledTimes(1);
    expect((await f.service.totals()).totalProxyBytes).toBe(150);
  });
  it("does not leak another actor's leases or allow them to spend through it", async () => {
    const f = await fixture();
    const lease = await f.service.acquire({}, alice);
    expect(await f.service.list(bob)).toEqual([]);
    for (const work of [
      () => f.service.get(lease.id, bob),
      () => f.service.release(lease.id, bob),
      () => f.service.fetch(lease.id, { url: "https://example.com" }, bob),
    ])
      await expect(work()).rejects.toMatchObject({ statusCode: 404 });
    expect(httpFetch).not.toHaveBeenCalled();
  });
  it("binds identities only after verification, refuses silent exit changes and rotates only while idle", async () => {
    const f = await fixture();
    f.probe.mockRejectedValueOnce(new Error("invisible credential"));
    await expect(f.service.acquire({ identity: "login" }, alice)).rejects.toMatchObject({
      code: "proxy_exit_check_failed",
    });
    expect(await f.service.identities()).toEqual([]);
    const lease = await f.service.acquire({ identity: "login" }, alice);
    await expect(f.service.acquire({ identity: "login" }, alice)).rejects.toMatchObject({
      code: "proxy_identity_in_use",
    });
    await expect(f.service.rotateIdentity("login", admin)).rejects.toMatchObject({
      code: "proxy_identity_in_use",
    });
    await f.service.release(lease.id, alice);
    f.probe.mockImplementation(async () => exit("203.0.113.9"));
    await expect(f.service.acquire({ identity: "login" }, alice)).rejects.toMatchObject({
      code: "proxy_identity_exit_changed",
    });
    expect((await f.service.identities())[0].lastExit?.ip).toBe("203.0.113.4");
    await f.service.rotateIdentity("login", admin);
    expect((await f.service.acquire({ identity: "login" }, alice)).exit?.ip).toBe("203.0.113.9");
  });
  it("bounds fallback, accounts failed probes and never escalates a named identity", async () => {
    const f = await fixture();
    await f.service.putProfile("core", { fallback: ["premium"] }, admin);
    f.probe
      .mockRejectedValueOnce(new Error("bad core"))
      .mockRejectedValueOnce(new Error("bad core"));
    expect((await f.service.acquire({}, admin)).product).toBe("premium");
    expect(f.servers).toHaveLength(3);
    await f.service.close();
    const next = await fixture();
    await next.service.putProfile("core", { fallback: ["premium"] }, admin);
    next.probe.mockRejectedValue(new Error("bad core"));
    await expect(next.service.acquire({ identity: "login" }, admin)).rejects.toThrow();
    expect(next.servers).toHaveLength(1);
  });
  it("expires and revokes live leases and refuses implicit renewal", async () => {
    const f = await fixture(),
      lease = await f.service.acquire({ ttlSeconds: 1 }, alice);
    await expect(f.service.renew(lease.id, 86400, alice)).rejects.toMatchObject({
      statusCode: 400,
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    await f.service.tick();
    expect((await f.service.get(lease.id, alice)).reason).toBe("expired");
    vi.useRealTimers();
    const active = await f.service.acquire({}, alice);
    await f.service.putProfile("core", { enabled: false }, admin);
    expect(f.servers.at(-1)!.allowed()).toBe(false);
    await f.service.tick();
    expect((await f.service.get(active.id, alice)).status).toBe("closed");
  });
  it("does not bind two concurrent allocations to the same identity", async () => {
    const f = await fixture();
    let resolve!: (value: ReturnType<typeof exit>) => void;
    f.probe.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = f.service.acquire({ identity: "shared" }, alice);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await expect(f.service.acquire({ identity: "shared" }, alice)).rejects.toMatchObject({
      code: "proxy_identity_in_use",
    });
    resolve(exit());
    await first;
  });
});

it("shares the primary profile's probe budget across attempts and fallback", async () => {
  const f = await fixture();
  await f.service.putProfile("core", { budgetBytes: 150, fallback: ["premium"] }, admin);
  f.probe.mockImplementation(async () => {
    const server = f.servers.at(-1)!;
    server.rxBytes += 100;
    server.txBytes += 20;
    throw new Error("failed paid probe");
  });
  await expect(f.service.acquire({}, admin)).rejects.toMatchObject({
    code: "proxy_budget_exhausted",
  });
  expect(f.servers).toHaveLength(2);
  expect(f.servers[1].allowed()).toBe(false);
  expect((await f.service.totals()).totalProxyBytes).toBe(240);
});

it("cancels verification, settles probe traffic and frees identity ownership", async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.probe.mockImplementationOnce(
    (_proxy, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
  );
  const pending = f.service.acquire({ identity: "cancelled" }, alice, {
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: "proxy_allocation_cancelled" });
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalled());
  controller.abort();
  await rejected;
  expect(f.servers[0].close).toHaveBeenCalledOnce();
  expect(await f.service.identities()).toEqual([]);
  expect((await f.service.acquire({ identity: "cancelled" }, alice)).status).toBe("active");
});

it("scopes quarantine to a host and profile without rotating identities", async () => {
  const f = await fixture(),
    lease = await f.service.acquire({}, admin);
  await f.service.report(lease.id, "blocked.example", "blocked", admin);
  await f.service.release(lease.id, admin);
  await expect(f.service.acquire({ host: "blocked.example" }, admin)).rejects.toMatchObject({
    code: "proxy_exit_quarantined",
  });
  expect((await f.service.acquire({ host: "other.example" }, admin)).status).toBe("active");
  expect(
    (await f.service.acquire({ profile: "premium", host: "blocked.example" }, admin)).status,
  ).toBe("active");
  const named = await f.service.acquire({ identity: "named" }, admin);
  await f.service.report(named.id, "named.example", "rate_limited", admin);
  await f.service.release(named.id, admin);
  expect(
    (await f.service.acquire({ identity: "named", host: "named.example" }, admin)).exit?.ip,
  ).toBe(lease.exit?.ip);
});

it("preserves configured country for partial targeting and denies rotating browser routes", async () => {
  const f = await fixture();
  await f.service.putProfile("british", { target: { country: "GB" } }, admin);
  f.probe.mockResolvedValueOnce(exit("203.0.113.4", "GB"));
  expect(
    (await f.service.acquire({ profile: "british", target: { city: "London" } }, admin)).country,
  ).toBe("GB");
  await f.service.putProfile("rotating", { session: "rotating" }, admin);
  const lease = await f.service.acquire({ profile: "rotating" }, alice);
  const session = {
    id: "browser",
    options: { proxyLeaseId: lease.id },
  } as unknown as BrowserSession;
  await expect(f.service.prepare(session, alice)).rejects.toMatchObject({
    code: "browser_requires_persistent_proxy",
  });
  expect((await f.service.get(lease.id, alice)).status).toBe("active");
});

it("rechecks identity grants after verification and closes leases whose identity is disabled", async () => {
  const f = await fixture();
  const check = vi.fn(async () => {});
  const service = new ProxyService(f.root, { ...f.options, authorizeIdentity: check });
  await service.ready;
  check
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      new (await import("../../utils/public-error.js")).PublicError(
        "connection_disabled",
        "Disabled",
        403,
      ),
    );
  await expect(service.acquire({ identity: "private" }, alice)).rejects.toMatchObject({
    code: "connection_disabled",
  });
  expect(f.probe).toHaveBeenCalledOnce();
  expect(await service.identities()).toEqual([]);
  const lease = await service.acquire({ identity: "private" }, alice);
  check.mockRejectedValue(new Error("disabled"));
  await service.tick();
  expect((await service.get(lease.id, alice)).reason).toBe("identity_access_revoked");
});

it("retries incomplete cleanup without stranding identity ownership", async () => {
  const f = await fixture(),
    lease = await f.service.acquire({ identity: "cleanup" }, alice);
  f.servers[0].close.mockRejectedValueOnce(new Error("close failed"));
  await expect(f.service.release(lease.id, alice)).rejects.toMatchObject({
    code: "proxy_cleanup_failed",
  });
  expect(f.servers[0].allowed()).toBe(false);
  await f.service.tick();
  expect(f.servers[0].close).toHaveBeenCalledTimes(2);
  expect((await f.service.acquire({ identity: "cleanup" }, alice)).status).toBe("active");
});

it("drains a pending allocation without retrying or publishing its route", async () => {
  const f = await fixture();
  f.probe.mockImplementationOnce(
    (_url, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }),
      ),
  );
  const pending = f.service.acquire({}, alice);
  const failed = expect(pending).rejects.toMatchObject({ code: "proxy_service_draining" });
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalled());
  await f.service.close();
  await failed;
  expect(f.servers).toHaveLength(1);
  expect((await f.service.totals()).activeLeases).toBe(0);
});
