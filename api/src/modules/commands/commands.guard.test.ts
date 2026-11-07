import type { FastifyInstance, FastifyReply } from "fastify";
import { describe, expect, test, vi } from "vitest";
import { quickAction, quickActionsDone } from "./commands.guard.js";

function fixture() {
  let changes = 0;
  const engine = {
    busy: () => false,
    pageChanged: () => {
      changes++;
    },
  };
  const server = { commandEngine: engine } as unknown as Parameters<typeof quickAction>[0];
  return { engine, server, reply: {} as FastifyReply, changes: () => changes };
}

describe("quick action tracking", () => {
  test("holds commands until a quick action on the primary page finishes", async () => {
    const { engine, server, reply, changes } = fixture();
    let finish = () => {};
    const running = quickAction(
      server,
      { body: {} },
      reply,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    let done = false;
    const waiting = quickActionsDone(engine).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    expect(changes()).toBe(0);
    finish();
    await running;
    await waiting;
    expect(done).toBe(true);
    expect(changes()).toBe(1);
  });

  test("runs quick actions as before when the commands API is off", async () => {
    const server = { commandEngine: null } as unknown as Parameters<typeof quickAction>[0];
    const result = await quickAction(server, { body: {} }, {} as FastifyReply, async () => "done");
    expect(result).toBe("done");
  });

  test("rejects per-action proxy overrides before running", async () => {
    const { server, changes } = fixture();
    const reply = { code: vi.fn(), send: vi.fn() };
    reply.code.mockReturnValue(reply);
    const run = vi.fn();
    await quickAction(
      server,
      { body: { proxyUrl: "http://proxy.test:8080" } },
      reply as unknown as FastifyReply,
      run,
    );
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(run).not.toHaveBeenCalled();
    expect(changes()).toBe(0);
  });
});
