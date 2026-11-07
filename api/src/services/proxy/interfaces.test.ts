import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionPool } from "../session-pool.js";
import { ProxyService } from "./service.js";
import type { Agent } from "./types.js";
import { organizationMember } from "../organization.js";
import { ToolRegistry, type ToolContext } from "../toolkits/registry.js";
import { proxyToolkit } from "../toolkits/proxies.js";
import routes from "../../modules/sessions/proxy.routes.js";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
}));
vi.mock("../agent-access.js", () => ({ assertAgentCurrent: mocks.authorize }));
vi.mock("../login.js", () => ({
  identityVault: (name: string) => (name === "protected" ? "vault" : undefined),
}));
vi.mock("../../utils/api-key.js", () => ({
  agentFor: (req: any) =>
    req.headers["fixture-agent"] === "anonymous"
      ? undefined
      : principal(req.headers["fixture-agent"] ?? "admin"),
  browserOriginAllowed: (req: any) => !req.headers.origin,
}));
function principal(name: string): Agent {
  return {
    name: name.startsWith("app-") ? "admin" : name,
    admin: name === "admin" || name.startsWith("app-"),
    dailyBudgetBytes: 100000,
    ...(name.startsWith("app-")
      ? {
          connectedApp: {
            ...organizationMember("owner"),
            keyId: name,
            admin: false,
            expires: Date.now() + 10000,
          },
        }
      : {}),
  };
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "proxy-interface-"));
  vi.stubEnv(
    "EVOMI_RESIDENTIAL_PROXY_URL",
    "http://user:private-password@core-residential.evomi.com:1000",
  );
  const probe = vi.fn(async () => ({
    ip: "203.0.113.4",
    country: "US",
    timezone: "America/New_York",
    region: "NY",
  }));
  const service = new ProxyService(root, {
    organization: "fixture",
    probe,
    forwarder: (url) => ({
      url: "http://127.0.0.1:40000",
      upstreamProxyUrl: url,
      txBytes: 0,
      rxBytes: 0,
      listen: async () => {},
      close: async () => {},
    }),
  });
  const pool = {
    proxies: service,
    identityBusy: () => false,
    connectionStore: { assertProfile: mocks.access },
  } as unknown as SessionPool;
  const app = Fastify();
  await app.register(swagger, { openapi: { info: { title: "Proxy contract", version: "2" } } });
  app.decorate("sessionPool", pool);
  await app.register(routes, { prefix: "/v1" });
  cleanups.push(async () => {
    await app.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, service, probe, registry: new ToolRegistry([proxyToolkit(pool)]) };
}
const context = (name: string): ToolContext => ({
  agent: principal(name),
  requestId: randomUUID(),
  signal: new AbortController().signal,
});

test("REST retries allocate once, isolate connected callers and never return proxy secrets", async () => {
  const { app, probe } = await fixture(),
    key = randomUUID();
  const allocate = (agent: string, body = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/proxies/leases",
      headers: { "fixture-agent": agent, "idempotency-key": key },
      payload: body,
    });
  const first = await allocate("app-one"),
    retry = await allocate("app-one"),
    other = await allocate("app-two");
  expect(first.statusCode).toBe(200);
  expect(retry.json().id).toBe(first.json().id);
  expect(other.json().id).not.toBe(first.json().id);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(first.body).not.toMatch(/private-password|127\.0\.0\.1|upstreamProxyUrl/);
  const schema = app.swagger().paths?.["/v1/proxies/leases"]?.post;
  expect(schema?.tags).toContain("Proxies");
  expect(schema && "requestBody" in schema ? JSON.stringify(schema.requestBody) : "").toContain(
    "budgetBytes",
  );
  expect((await allocate("app-one", { budgetBytes: 500 })).statusCode).toBe(409);
  expect(
    (
      await app.inject({
        url: `/v1/proxies/leases/${first.json().id}`,
        headers: { "fixture-agent": "app-two" },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/v1/proxies/profiles/open",
        headers: { "fixture-agent": "app-one" },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
});

test("REST validates, checks current authorization and enforces profile and identity access", async () => {
  const { app, probe } = await fixture();
  expect(
    (await app.inject({ url: "/v1/proxies/profiles", headers: { "fixture-agent": "anonymous" } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        url: "/v1/proxies/profiles",
        headers: { origin: "https://other.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/proxies/leases",
        payload: { identity: "protected" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/proxies/leases",
        payload: { credential: "do-not-accept" },
      })
    ).statusCode,
  ).toBe(400);
  mocks.access.mockRejectedValueOnce(Object.assign(new Error("Denied"), { statusCode: 403 }));
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/proxies/leases",
        payload: { identity: "private" },
      })
    ).statusCode,
  ).toBe(403);
  expect(probe).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalled();
});

test("native discovery and execution use the same admin policy and retry boundary", async () => {
  const { registry, probe } = await fixture();
  const names = registry.list(context("app-one")).map((t) => t.name);
  expect(names).toContain("proxy_allocate");
  expect(names).not.toContain("proxy_profile_put");
  expect(names).not.toContain("proxy_identity_rotate");
  await expect(
    registry.execute("proxy_profile_put", { name: "bad", profile: {} }, context("app-one")),
  ).rejects.toMatchObject({ code: "tool_unavailable" });
  const input = { idempotencyKey: randomUUID() };
  const first = await registry.execute("proxy_allocate", input, context("app-one"));
  expect(await registry.execute("proxy_allocate", input, context("app-one"))).toEqual(first);
  expect(probe).toHaveBeenCalledOnce();
  expect(JSON.stringify(first)).not.toContain("private-password");
  const id = JSON.parse((first.content[0] as { text: string }).text).id;
  await expect(registry.execute("proxy_get", { id }, context("app-two"))).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(registry.describe("proxy_profile_put", context("admin")).inputSchema.type).toBe("object");
});
