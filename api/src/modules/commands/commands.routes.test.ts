import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
vi.mock("../../utils/api-key.js", () => ({ agentFor: () => ({ name: "admin", admin: true }) }));
import routes from "./commands.routes.js";
import { PoolError, type SessionPool } from "../../services/session-pool.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  const one = {
    id: "one",
    prepareCommands: vi.fn(async () => {}),
    touch: vi.fn(),
    engine: { handle: vi.fn(async () => ({ status: 200, headers: {}, body: { session: "one" } })) },
  };
  const two = {
    id: "two",
    prepareCommands: vi.fn(async () => {}),
    touch: vi.fn(),
    engine: { handle: vi.fn(async () => ({ status: 200, headers: {}, body: { session: "two" } })) },
  };
  const sessions = new Map([
    ["one", one],
    ["two", two],
  ]);
  app.decorate("sessionPool", {
    get: (id: string) => {
      const s = sessions.get(id);
      if (!s) throw new PoolError(410, "Session is not running");
      return s;
    },
  } as unknown as SessionPool);
  await app.register(routes, { prefix: "/v1" });
  await app.ready();
  return { app, one, two };
}
describe("commands routes", () => {
  test("routes simultaneous commands to their own engine", async () => {
    const { app, one, two } = await fixture();
    const responses = await Promise.all(
      ["one", "two"].map((id) =>
        app.inject({
          method: "POST",
          url: `/v1/sessions/${id}/commands`,
          headers: { "idempotency-key": "shared-key" },
          payload: { commands: { command: "snapshot" } },
        }),
      ),
    );
    expect(responses.map((r) => r.json().session)).toEqual(["one", "two"]);
    expect(one.engine.handle).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "one", idempotencyKey: "shared-key" }),
    );
    expect(two.engine.handle).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "two" }));
  });
  test("unknown session cannot operate another session", async () => {
    const { app, one, two } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/missing/commands",
      payload: { commands: { command: "snapshot" } },
    });
    expect(response.statusCode).toBe(410);
    expect(one.engine.handle).not.toHaveBeenCalled();
    expect(two.engine.handle).not.toHaveBeenCalled();
  });
  test("publishes the commands schema", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/v1/sessions/one/commands/schema" });
    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(1);
    expect(JSON.stringify(response.json().schema)).toContain("navigate");
  });
});
