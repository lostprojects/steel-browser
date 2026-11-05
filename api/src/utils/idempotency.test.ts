import { beforeEach, afterEach, expect, test, vi } from "vitest";
vi.mock("./api-key.js", () => ({ agentFor: (raw: any) => ({ name: raw.agent ?? "fixture" }) }));
let idempotent: typeof import("./idempotency.js").idempotent;
beforeEach(async () => {
  vi.resetModules();
  ({ idempotent } = await import("./idempotency.js"));
});
afterEach(() => vi.useRealTimers());
const request = (token: string, body: unknown = {}, agent = "fixture") =>
  ({
    headers: { "idempotency-key": token },
    method: "POST",
    routeOptions: { url: "/op/:id" },
    params: { id: "one" },
    body,
    raw: { agent },
  }) as any;
test("evicts the oldest finished operation and keeps newer retries cached", async () => {
  for (let i = 0; i < 129; i++)
    expect(await idempotent(request(`key-${i}`), async () => i)).toBe(i);
  const run = vi.fn(async () => -1);
  expect(await idempotent(request("key-128"), run)).toBe(128);
  expect(run).not.toHaveBeenCalled();
  expect(await idempotent(request("key-0"), run)).toBe(-1);
});
test("shares in-flight work, rejects changed arguments, and never evicts running work", async () => {
  let done!: (v: number) => void;
  const pending = new Promise<number>((r) => {
    done = r;
  });
  const run = vi.fn(() => pending);
  const first = idempotent(request("running-0"), run);
  const retry = idempotent(request("running-0"), run);
  await expect(idempotent(request("running-0", { changed: true }), run)).rejects.toMatchObject({
    statusCode: 409,
  });
  const jobs = [first, retry];
  for (let i = 1; i < 128; i++) jobs.push(idempotent(request(`running-${i}`), () => pending));
  await expect(idempotent(request("overflow"), run)).rejects.toMatchObject({ statusCode: 429 });
  expect(run).toHaveBeenCalledTimes(1);
  done(42);
  expect(await Promise.all(jobs)).toEqual(Array(129).fill(42));
  expect(await idempotent(request("overflow"), async () => 43)).toBe(43);
});
test("scopes keys to the agent and removes errors and expired results", async () => {
  vi.useFakeTimers();
  const run = vi.fn(async () => 1);
  await expect(
    idempotent(request("failed"), async () => {
      throw new Error("fixture");
    }),
  ).rejects.toThrow("fixture");
  expect(await idempotent(request("failed"), run)).toBe(1);
  expect(await idempotent(request("failed", {}, "other"), run)).toBe(1);
  vi.advanceTimersByTime(600001);
  expect(await idempotent(request("failed"), run)).toBe(1);
  expect(run).toHaveBeenCalledTimes(3);
});
