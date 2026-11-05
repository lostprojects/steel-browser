import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("../../utils/api-key.js", () => ({
  agentFor: (req: any) => ({
    name: req.headers["fixture-agent"] ?? "admin",
    admin: !req.headers["fixture-agent"],
  }),
}));
import routes from "./sessions.routes.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  const session = {
    id: "one",
    options: { identity: "ancestry" },
    touch: vi.fn(),
    diagnostics: vi.fn(async () => ({ chromeRssBytes: 1024 })),
    killChrome: vi.fn(async () => ({ signal: "SIGKILL" })),
    getCookies: vi.fn(async () => [
      {
        domain: ".ancestry.com",
        name: "persistent",
        value: "private-value",
        expires: 2000000000,
        httpOnly: true,
      },
      {
        domain: "www.ancestry.com",
        name: "session",
        value: "private-value",
        session: true,
        expires: -1,
        httpOnly: false,
      },
      {
        domain: "evilancestry.com",
        name: "unrelated",
        value: "private-value",
        expires: 2000000000,
      },
      { domain: ".fold3.com", name: "sibling", value: "private-value", expires: 2000000000 },
    ]),
  };
  app.decorate("sessionPool", { get: () => session, owner: () => ({ name: "owner" }) } as any);
  await app.register(routes, { prefix: "/v1" });
  return { app, session };
}
test("reports protected cookie lifetimes without values and matches domain boundaries", async () => {
  const { app } = await fixture();
  const response = await app.inject("/v1/sessions/one/cookie-lifetimes?domain=.ANCESTRY.COM");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([
    {
      domain: ".ancestry.com",
      name: "persistent",
      expires: new Date(2000000000 * 1000).toISOString(),
      httpOnly: true,
    },
    { domain: "www.ancestry.com", name: "session", expires: "session", httpOnly: false },
  ]);
  expect(response.body).not.toContain("private-value");
  expect((await app.inject("/v1/sessions/one/cookie-lifetimes")).json()).toHaveLength(4);
});
test("keeps cookie metadata inside the owning agent's session", async () => {
  const { app, session } = await fixture();
  const response = await app.inject({
    url: "/v1/sessions/one/cookie-lifetimes",
    headers: { "fixture-agent": "other" },
  });
  expect(response.statusCode).toBe(403);
  expect(session.getCookies).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        url: "/v1/sessions/one/cookie-lifetimes",
        headers: { "fixture-agent": "owner" },
      })
    ).statusCode,
  ).toBe(200);
});

test("fault and process metadata require an admin", async () => {
  const { app, session } = await fixture();
  for (const [method, url] of [
    ["GET", "/v1/sessions/one/diagnostics"],
    ["POST", "/v1/sessions/one/fault/chrome-kill"],
  ] as const) {
    expect(
      (await app.inject({ method, url, headers: { "fixture-agent": "owner" } })).statusCode,
    ).toBe(403);
  }
  expect(session.killChrome).not.toHaveBeenCalled();
  expect((await app.inject("/v1/sessions/one/diagnostics")).json()).toEqual({
    chromeRssBytes: 1024,
  });
});
