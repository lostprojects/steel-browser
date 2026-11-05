import Fastify from "fastify";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ forget: vi.fn(), list: vi.fn(), deleteIdentity: vi.fn() }));
vi.mock("../../utils/api-key.js", () => ({
  agentFor: (req: any) => ({
    name: req.headers["fixture-agent"] ?? "admin",
    admin: !req.headers["fixture-agent"],
  }),
}));
vi.mock("../../services/vault.js", () => ({ vault: { list: mocks.list }, protect: vi.fn() }));
vi.mock("../../services/login.js", () => ({
  LoginService: class {
    startDailyChecks() {
      return () => {};
    }
    forget = mocks.forget;
  },
}));
import routes from "./vault.routes.js";
const apps: ReturnType<typeof Fastify>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ name: "ancestry" }]);
  mocks.forget.mockResolvedValue({ identity: "ancestry-test", forgotten: ["ancestry"] });
  mocks.deleteIdentity.mockImplementation(async (name, forget) => {
    await forget();
    return { name, deleted: true };
  });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  app.decorate("sessionPool", {
    profilesRoot: "/unused/profiles",
    deleteIdentity: mocks.deleteIdentity,
  } as any);
  await app.register(routes, { prefix: "/v1" });
  return app;
}
test("DELETE logins scopes exact identities and prefixes to the agent's vault", async () => {
  const app = await fixture();
  expect(
    (await app.inject({ method: "DELETE", url: "/v1/logins/ancestry-test" })).json().forgotten,
  ).toEqual(["ancestry"]);
  expect(mocks.forget).toHaveBeenCalledWith("ancestry-test");
  mocks.forget.mockClear();
  for (const name of ["ancestryother", "mary-ferrell", "unrelated"])
    expect((await app.inject({ method: "DELETE", url: `/v1/logins/${name}` })).statusCode).toBe(
      403,
    );
  expect(mocks.forget).not.toHaveBeenCalled();
});
test("DELETE identities permits an admin to delete a protected identity and its login records", async () => {
  const app = await fixture();
  expect(
    (await app.inject({ method: "DELETE", url: "/v1/identities/ancestry-test" })).json(),
  ).toEqual({ name: "ancestry-test", deleted: true });
  expect(mocks.forget).toHaveBeenCalledWith("ancestry-test");
  mocks.forget.mockClear();
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/v1/identities/ancestry-test",
        headers: { "fixture-agent": "mosaic" },
      })
    ).statusCode,
  ).toBe(403);
  expect(mocks.forget).not.toHaveBeenCalled();
});
test("busy identity deletion returns a conflict without forgetting logins", async () => {
  mocks.deleteIdentity.mockRejectedValue(
    Object.assign(new Error("Identity in use"), { statusCode: 409 }),
  );
  const app = await fixture();
  expect(
    (await app.inject({ method: "DELETE", url: "/v1/identities/ancestry-test" })).statusCode,
  ).toBe(409);
  expect(mocks.forget).not.toHaveBeenCalled();
});
