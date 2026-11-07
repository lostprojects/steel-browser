import { organizationMember } from "../../services/organization.js";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectionStore } from "../../services/connection-store.js";
import { Vault, vault } from "../../services/vault.js";
import { browserApplication } from "../../services/browser-application.js";
import type { SessionPool } from "../../services/session-pool.js";
import { apiActionInput } from "../../services/toolkits/api-input.js";
import mcpRoutes from "../mcp/mcp.routes.js";
import connectionRoutes from "../sessions/connections.routes.js";

vi.mock("../../utils/api-key.js", () => ({
  agentFor: (request: { headers: Record<string, string> }) =>
    request.headers["fixture-agent"] === "anonymous"
      ? undefined
      : {
          name: request.headers["fixture-agent"] ?? "admin",
          admin: !request.headers["fixture-agent"],
          dailyBudgetBytes: 1000,
        },
  browserOriginAllowed: (request: { headers: Record<string, string> }) =>
    !request.headers.origin || request.headers.origin === "http://toolstack.test",
}));
const roots: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  vi.stubEnv("VAULT_KEY", "23".repeat(32));
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolstack-framework-"));
  roots.push(root);
  const profilesRoot = path.join(root, "profiles");
  await mkdir(path.join(profilesRoot, "saved-account"), { recursive: true });
  await writeFile(path.join(profilesRoot, "saved-account", "Preferences"), "preserved-profile");
  const credentials = new Vault(path.join(root, "vault"), "23".repeat(32));
  await credentials.ready;
  const admin = { name: "admin", admin: true, dailyBudgetBytes: 1000 };
  await credentials.put(
    "fixture-key",
    { fields: { apiKey: "fixture-secret-value" }, allowedAgents: ["admin", "teammate"] },
    admin,
  );
  vi.spyOn(vault, "list").mockImplementation(credentials.list.bind(credentials));
  vi.spyOn(vault, "use").mockImplementation(credentials.use.bind(credentials));
  const originalStatus = vault.status;
  vault.status = "open";
  cleanups.push(async () => {
    vault.status = originalStatus;
  });
  const file = path.join(root, "connections.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      profiles: {
        "saved-account": { label: "Saved account", site: null, allowedAgents: ["admin"] },
      },
      apis: {
        "legacy-exa": {
          provider: "exa",
          vault: "fixture-key",
          credentialField: "apiKey",
          allowedTools: ["exa_search", "exa_contents"],
          dailyCalls: 5,
          dailyBudgetUSD: 0.05,
          enabled: true,
          label: "Existing Exa account",
          allowedAgents: ["admin"],
        },
      },
    }),
  );
  const connectionStore = new ConnectionStore(file);
  const routing = {
    resolve: (site: string) => ({ site, url: site, identity: null, loginSite: null }),
    registry: () => [],
  };
  const pool = {
    profilesRoot,
    connectionStore,
    list: () => [],
    routing: { snapshot: async () => routing },
    identityBusy: () => false,
  } as unknown as SessionPool;
  const application = browserApplication(pool);
  const app = Fastify();
  app.decorate("sessionPool", pool);
  const dispatched = vi.fn(
    async (args: Record<string, unknown>, credential: string, signal: AbortSignal) => {
      expect(credential).toBe("fixture-secret-value");
      if (args.pause)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1500);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      return {
        state: "succeeded" as const,
        estimatedCostMicros: 1000,
        data: { value: args.value, source: "fixture:echo", acquiredAt: new Date().toISOString() },
      };
    },
  );
  app.decorate("steelBrowserConfig", {
    apiToolkits: [
      {
        id: "fixture",
        name: "Fixture API",
        version: "2.0.0",
        description: "Local acceptance adapter",
        authentication: "Fixture vault account",
        credentialFields: ["apiKey"],
        verification: {
          tool: "fixture_echo",
          arguments: { value: "verification" },
          estimatedCostUSD: 0.002,
        },
        actions: [
          {
            name: "fixture_echo",
            provider: "fixture",
            description: "Return validated fixture input",
            input: apiActionInput.extend({
              value: z.string().min(1),
              pause: z.boolean().default(false),
            }),
            reserveMicros: () => 2000,
            run: dispatched,
          },
          {
            name: "fixture_admin",
            provider: "fixture",
            description: "Admin-only fixture",
            input: apiActionInput.extend({ value: z.string().min(1) }),
            reserveMicros: () => 2000,
            run: dispatched,
            authorize: (context: any) => context.agent.admin === true,
          },
        ],
        workflows: [
          {
            id: "fixture_method",
            name: "Fixture method",
            version: "1.1.0",
            description: "Acceptance method",
            input: z.object({ value: z.string() }).strict(),
            instructions:
              "Use the permitted fixture account. Validate the echoed value and preserve the operation key on retry.",
            dependencies: [{ tool: "fixture_echo", version: "2.0.0" }],
            references: [
              {
                id: "reference",
                title: "Expected result",
                mediaType: "application/json",
                content: '{"value":"hello"}',
              },
            ],
            outputs: ["Echoed value"],
            checks: ["Value matches the input"],
            policy: {
              authority: "read",
              runtime: "worker",
              maxDurationMs: 60_000,
              retry: "Keep the operation key",
              cancellation: "Retain uncertain effects",
            },
            authorize: (context: any) => context.agent.name !== "stranger",
          },
        ],
      },
    ],
  });
  await app.register(connectionRoutes, { prefix: "/v1" });
  await app.register(mcpRoutes);
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(async () => {
    await application.closeApi();
    await app.close();
  });
  const configure = (body: Record<string, unknown>, id = "api:fixture") =>
    app.inject({ method: "PUT", url: `/v1/connections/${encodeURIComponent(id)}`, payload: body });
  const binding = {
    label: "Fixture account",
    allowedAgents: ["admin", "teammate"],
    api: {
      provider: "fixture",
      vault: "fixture-key",
      allowedTools: ["fixture_echo", "fixture_admin"],
      dailyCalls: 10,
      dailyBudgetUSD: 0.02,
    },
  };
  expect((await configure(binding)).statusCode).toBe(200);
  const client = new Client({ name: "framework-acceptance", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", address)));
  cleanups.push(async () => client.close());
  const run = (args: Record<string, unknown>, agent?: string, version = "2.0.0") =>
    app.inject({
      method: "POST",
      url: "/v1/tools/fixture_echo/execute",
      headers: agent ? { "fixture-agent": agent } : {},
      payload: { version, arguments: { connection: "api:fixture", value: "hello", ...args } },
    });
  return {
    app,
    application,
    connectionStore,
    root,
    profilesRoot,
    dispatched,
    client,
    run,
    binding,
    admin,
    credentials,
  };
}
test("a new provider uses the same UI and MCP catalog, accounts and replay ledger", async () => {
  const f = await fixture();
  const catalog = (await f.app.inject("/v1/toolkits")).json();
  expect(catalog.toolkits.some((item: any) => item.id === "muse")).toBe(false);
  expect(catalog.toolkits.find((item: any) => item.id === "fixture")).toMatchObject({
    version: "2.0.0",
    connection: { type: "api_key", credentialFields: ["apiKey"] },
  });
  const discovered: any = await f.client.callTool({
    name: "tools_describe",
    arguments: { name: "fixture_echo" },
  });
  expect(JSON.parse(discovered.content[0].text).inputSchema).toEqual(
    catalog.toolkits
      .find((item: any) => item.id === "fixture")
      .tools.find((tool: any) => tool.name === "fixture_echo").inputSchema,
  );
  const ui = (await f.run({ idempotencyKey: "same-operation" })).json();
  expect(JSON.parse(ui.content[0].text)).toMatchObject({
    ok: true,
    execution: { capabilityVersion: "2.0.0", state: "succeeded" },
    data: { value: "hello" },
  });
  const mcp: any = await f.client.callTool({
    name: "fixture_echo",
    arguments: { connection: "api:fixture", value: "hello", idempotencyKey: "same-operation" },
  });
  expect(mcp).toEqual(ui);
  expect(f.dispatched).toHaveBeenCalledTimes(1);
  expect((await f.run({ idempotencyKey: "same-operation", value: "changed" })).json().isError).toBe(
    true,
  );
  expect(await readFile(path.join(f.profilesRoot, "saved-account", "Preferences"), "utf8")).toBe(
    "preserved-profile",
  );
  const reloaded = new ConnectionStore(f.connectionStore.file);
  await reloaded.ready;
  expect((await reloaded.getApi("fixture"))?.provider).toBe("fixture");
  expect(await f.application.connections.get("api:legacy-exa", f.admin)).toMatchObject({
    id: "api:legacy-exa",
    status: "configured",
    allowedTools: ["exa_search", "exa_contents"],
  });
  expect((await reloaded.get("saved-account"))?.allowedAgents).toEqual(["admin"]);
  const journal = await readFile(path.join(f.root, "api-executions.jsonl"), "utf8");
  expect(journal).not.toContain("fixture-secret-value");
  expect(journal).not.toContain('"hello"');
});
test("per-tool policies narrow a shared connection without disabling its permitted reads", async () => {
  const f = await fixture();
  const account = await f.application.connections.get("api:fixture", {
    name: "teammate",
    dailyBudgetBytes: 1000,
  });
  expect(account).toMatchObject({ allowedTools: ["fixture_echo"], permissions: { canUse: true } });
  expect((await f.run({ idempotencyKey: "permitted-read" }, "teammate")).json().isError).toBe(
    false,
  );
  const catalog = (
    await f.app.inject({ url: "/v1/toolkits", headers: { "fixture-agent": "teammate" } })
  ).json();
  expect(
    catalog.toolkits.find((item: any) => item.id === "fixture").tools.map((tool: any) => tool.name),
  ).toEqual(["fixture_echo"]);
});
test("connected apps have distinct retry identities while each app reuses its own provider work", async () => {
  const f = await fixture();
  vi.stubEnv("STEEL_SHARED_URL", "https://gateway.example.test");
  vi.stubEnv("STEEL_SHARED_KEY", "fixture-reader-key");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toBe("https://gateway.example.test/internal/principal");
    return Response.json({ active: true });
  });
  const action = {
    name: "fixture_echo",
    provider: "fixture",
    description: "Fixture",
    input: apiActionInput.extend({ value: z.string(), pause: z.boolean().default(false) }),
    reserveMicros: () => 2000,
    run: f.dispatched,
  };
  const run = (keyId: string) =>
    f.application.api.execute(
      action,
      { connection: "api:fixture", value: "hello", idempotencyKey: "same-key" },
      {
        agent: {
          ...f.admin,
          connectedApp: {
            ...organizationMember("owner"),
            keyId,
            admin: false,
            expires: Date.now() + 60_000,
          },
        },
        requestId: "fixture",
        signal: new AbortController().signal,
      },
      "2.0.0",
    );
  const first = await run("first-app"),
    second = await run("second-app"),
    retry = await run("first-app");
  expect(first.execution.id).not.toBe(second.execution.id);
  expect(retry.execution.id).toBe(first.execution.id);
  expect(first.execution.connectedApp?.keyId).toBe("first-app");
  expect(f.dispatched).toHaveBeenCalledTimes(2);
});
test("verification is metered, replay protected, and disable/disconnect preserve stored state", async () => {
  const f = await fixture();
  const verify = () =>
    f.app.inject({
      method: "POST",
      url: "/v1/connections/api%3Afixture/verify",
      headers: { "idempotency-key": "verify-once" },
    });
  expect((await verify()).json().isError).toBe(false);
  expect((await verify()).json().isError).toBe(false);
  expect(f.dispatched).toHaveBeenCalledTimes(1);
  expect((await f.app.inject("/v1/connections/api%3Afixture/usage")).json().calls).toBe(1);
  await f.application.connections.access("browser:saved-account", false, true, f.admin);
  await expect(
    f.application.connections.select("browser:saved-account", {}, f.admin),
  ).rejects.toMatchObject({ code: "connection_disabled" });
  await f.application.connections.access("browser:saved-account", true, false, f.admin);
  expect(
    await f.application.connections.select("browser:saved-account", {}, f.admin),
  ).toMatchObject({ identity: "saved-account" });
  await f.application.connections.access("api:fixture", false, true, f.admin);
  expect((await f.app.inject("/v1/connections/api%3Afixture")).json().status).toBe("disconnected");
  expect((await f.credentials.list(f.admin)).some((row) => row.name === "fixture-key")).toBe(true);
  expect(await readFile(path.join(f.profilesRoot, "saved-account", "Preferences"), "utf8")).toBe(
    "preserved-profile",
  );
});
test("UI and MCP refuse invalid inputs, denied accounts, versions and foreign activity", async () => {
  const f = await fixture();
  expect(
    (await f.app.inject({ url: "/v1/toolkits", headers: { "fixture-agent": "anonymous" } }))
      .statusCode,
  ).toBe(401);
  expect(
    (await f.app.inject({ url: "/v1/toolkits", headers: { origin: "https://untrusted.test" } }))
      .statusCode,
  ).toBe(403);
  expect((await f.run({}, "stranger")).json().isError).toBe(true);
  expect((await f.run({ value: 1 })).json().isError).toBe(true);
  expect((await f.run({}, undefined, "1.0.0")).json().isError).toBe(true);
  expect(f.dispatched).not.toHaveBeenCalled();
  await f.run({ idempotencyKey: "private-operation" });
  expect(
    (await f.app.inject({ url: "/v1/activity", headers: { "fixture-agent": "teammate" } })).json()
      .executions,
  ).toEqual([]);
  expect((await f.app.inject("/v1/activity")).json().executions).toHaveLength(1);
  await f.application.connections.access("api:fixture", false, false, f.admin);
  expect((await f.run({ idempotencyKey: "disabled" })).json().isError).toBe(true);
  expect(f.dispatched).toHaveBeenCalledTimes(1);
});
test("interruption retains uncertain effects and refuses re-dispatch after restart", async () => {
  const f = await fixture();
  const timedOut = (
    await f.run({ pause: true, timeoutMs: 1000, idempotencyKey: "interrupted" })
  ).json();
  expect(timedOut.isError).toBe(true);
  expect(JSON.parse(timedOut.content[0].text).error.code).toBe("execution_timeout");
  const retry = (
    await f.run({ pause: true, timeoutMs: 1000, idempotencyKey: "interrupted" })
  ).json();
  expect(retry.isError).toBe(true);
  expect(f.dispatched).toHaveBeenCalledTimes(1);
  const { ApiExecutor } = await import("../../services/api-execution.js");
  const restarted = new ApiExecutor(
    f.root,
    f.application.connections,
    f.credentials,
    "23".repeat(32),
  );
  cleanups.push(() => restarted.close());
  const action = {
    name: "fixture_echo",
    provider: "fixture",
    description: "Fixture",
    input: apiActionInput.extend({ value: z.string(), pause: z.boolean().default(false) }),
    reserveMicros: () => 2000,
    run: f.dispatched,
  };
  await expect(
    restarted.execute(
      action,
      { connection: "api:fixture", value: "hello", pause: true, idempotencyKey: "interrupted" },
      { agent: f.admin, requestId: "restart", signal: new AbortController().signal },
      "2.0.0",
    ),
  ).rejects.toMatchObject({ code: "execution_replay_unavailable" });
  expect(f.dispatched).toHaveBeenCalledTimes(1);
});
test("registration and configuration reject provider/tool mismatches and enforce budgets", async () => {
  const f = await fixture();
  await expect(
    f.application.connections.configure(
      "api:wrong",
      { ...f.binding, api: { ...f.binding.api, allowedTools: ["exa_search"] } },
      f.admin,
    ),
  ).rejects.toMatchObject({ code: "invalid_connection" });
  await f.application.connections.configure(
    "api:fixture",
    { ...f.binding, api: { ...f.binding.api, dailyCalls: 1 } },
    f.admin,
  );
  await f.run({ idempotencyKey: "one" });
  const refused = (await f.run({ idempotencyKey: "two" })).json();
  expect(JSON.parse(refused.content[0].text).error.code).toBe("usage_limit");
  expect(f.dispatched).toHaveBeenCalledTimes(1);
});
test("workflow instructions and references use exact versions and the same grants on REST and MCP", async () => {
  const f = await fixture();
  const method = (await f.app.inject("/v1/workflows/fixture_method?version=1.1.0")).json();
  expect(method).toMatchObject({
    version: "1.1.0",
    dependencies: [{ tool: "fixture_echo", version: "2.0.0" }],
    outputs: ["Echoed value"],
  });
  expect(method.release).toMatch(/^[a-f0-9]{64}$/);
  const mcp: any = await f.client.callTool({
    name: "workflows_get",
    arguments: { id: "fixture_method", version: "1.1.0" },
  });
  expect(JSON.parse(mcp.content[0].text)).toEqual(method);
  const reference = (
    await f.app.inject("/v1/workflows/fixture_method/references/reference?version=1.1.0")
  ).json();
  expect(reference.sha256).toBe(method.references[0].sha256);
  expect(reference.content).toBe('{"value":"hello"}');
  expect((await f.app.inject("/v1/workflows/fixture_method?version=1.0.0")).statusCode).toBe(409);
  expect(
    (await f.app.inject("/v1/workflows/fixture_method/references/reference?version=1.0.0"))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await f.app.inject({
        url: "/v1/workflows/fixture_method",
        headers: { "fixture-agent": "stranger" },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await f.app.inject({ url: "/v1/workflows", headers: { "fixture-agent": "stranger" } }))
      .json()
      .workflows.some((method: any) => method.id === "fixture_method"),
  ).toBe(false);
});
