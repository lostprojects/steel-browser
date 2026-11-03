import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
    constructor(url: string) { seen.urls.push(url); }
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
});
describe("residential accounting", () => {
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
