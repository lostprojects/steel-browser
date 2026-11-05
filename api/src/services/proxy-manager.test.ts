import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const seen = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("axios", () => ({
  default: {
    get: vi.fn(async () => ({
      data: {
        success: true,
        ip: "203.0.113.4",
        country_code: "US",
        region: "New York",
        timezone: { id: "America/New_York" },
      },
    })),
  },
}));
vi.mock("../utils/proxy.js", () => ({
  ProxyServer: class {
    constructor(url: string) {
      seen.urls.push(url);
    }
    url = "http://127.0.0.1:43210";
    rxBytes = 100;
    txBytes = 20;
    listen = vi.fn(async () => {});
    close = vi.fn(async () => {});
  },
}));
import { ProxyManager } from "./proxy-manager.js";
import type { BrowserSession } from "./browser-session.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("residential accounting", () => {
  it("forgets only the named sticky allocation and preserves metered spend", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "proxy-forget-"));
    roots.push(root);
    await writeFile(
      path.join(root, "proxy-state.json"),
      JSON.stringify({
        days: {},
        total: 123,
        identities: {
          "ancestry-test": { country: "US", stickyId: "test123" },
          ancestry: { country: "US", stickyId: "keep123" },
        },
        bad: {},
      }),
    );
    const manager = new ProxyManager(root);
    await manager.forgetIdentity("ancestry-test");
    const state = JSON.parse(await readFile(path.join(root, "proxy-state.json"), "utf8"));
    expect(Object.keys(state.identities)).toEqual(["ancestry"]);
    expect(state.total).toBe(123);
    expect((await new ProxyManager(root).identities()).map((v) => v.name)).toEqual(["ancestry"]);
  });
  it("keeps cumulative per-key totals distinct from the new UTC day's budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T00:01:00Z"));
    const root = await mkdtemp(path.join(os.tmpdir(), "proxy-days-"));
    roots.push(root);
    await writeFile(
      path.join(root, "proxy-state.json"),
      JSON.stringify({
        days: { "2026-11-03": { collector: 540, admin: 7 }, "2026-11-04": { collector: 120 } },
        total: 667,
        identities: {},
        bad: {},
      }),
    );
    const totals = await new ProxyManager(root).totals();
    expect(totals.agents).toEqual({ collector: 120 });
    expect(totals.totalByAgent).toEqual({ collector: 660, admin: 7 });
    expect(totals.totalResidentialBytes).toBe(667);
  });
  it("counts active bytes once, enforces a shared agent budget and retains totals after restart", async () => {
    vi.stubEnv("EVOMI_RESIDENTIAL_PROXY_URL", "http://user:secret@core-residential.evomi.com:1000");
    const root = await mkdtemp(path.join(os.tmpdir(), "proxy-budget-"));
    roots.push(root);
    const manager = new ProxyManager(root);
    const agent = { name: "collector", dailyBudgetBytes: 500 };
    const session = (id: string) =>
      ({
        id,
        options: { residential: { country: "US" } },
        priorProxyRxBytes: 0,
        priorProxyTxBytes: 0,
        status: "live",
      }) as unknown as BrowserSession;
    const a = session("a"),
      b = session("b");
    await manager.prepare(a, agent);
    expect(new URL(seen.urls.at(-1)!).password).toMatch(/_hardsession-[a-f0-9]{8}$/);
    await manager.prepare(b, agent);
    expect((await manager.totals()).totalResidentialBytes).toBe(240);
    (a.proxyServer as any).rxBytes = 400;
    expect((await manager.tick()).sort()).toEqual(["a", "b"]);
    await manager.settle("a");
    await manager.settle("b");
    expect((await manager.totals()).totalResidentialBytes).toBe(540);
    const restored = new ProxyManager(root);
    expect((await restored.totals()).totalResidentialBytes).toBe(540);
    await expect(restored.prepare(session("c"), agent)).rejects.toMatchObject({ statusCode: 429 });
  });
  it("preserves an imported sticky identity and rejects changing its exit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "proxy-identity-"));
    roots.push(root);
    const manager = new ProxyManager(root);
    await manager.saveIdentity("residential-US", { country: "US", stickyId: "old123" });
    await manager.saveIdentity("residential-US", { country: "US", stickyId: "old123" });
    await expect(
      manager.saveIdentity("residential-US", { country: "US", stickyId: "other" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await manager.identities()).toEqual([
      { name: "residential-US", country: "US", lastExit: undefined },
    ]);
  });
});
