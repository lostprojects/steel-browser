import type { FastifyReply } from "fastify";

import { operations } from "../../services/operations.js";
import type { CommandEngine } from "../../services/commands/engine.js";
function execution(engine: object) {
  const selected = engine as Partial<CommandEngine>;
  return { runner: selected.runner ?? operations, resource: selected.resource ?? engine };
}

export function heldByCommands(
  server: { commandEngine: import("../../services/commands/engine.js").CommandEngine | null },
  request: { body?: { proxyUrl?: string | null } },
  reply: FastifyReply,
): boolean {
  const engine = server.commandEngine;
  if (!engine || request.body?.proxyUrl) {
    return false;
  }
  if (engine.busy()) {
    reply.code(409).send({
      message:
        "Commands are running in this session. Try again when they finish, or pass proxyUrl to work in a separate browser context.",
    });
    return true;
  }
  return false;
}

export async function quickAction(
  server: { commandEngine: import("../../services/commands/engine.js").CommandEngine | null },
  request: { body?: { proxyUrl?: string | null } },
  reply: FastifyReply,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (heldByCommands(server, request, reply)) {
    return reply;
  }
  if (!server.commandEngine || request.body?.proxyUrl) {
    return run();
  }
  const engine = server.commandEngine;
  const { runner, resource } = execution(engine);
  return runner.run({ resource, timeoutMs: 180_000 }, async (operation) => {
    operation.markActed();
    try {
      return await run();
    } finally {
      engine.pageChanged();
    }
  });
}

export function quickActionsDone(engine: object): Promise<void> {
  const { runner, resource } = execution(engine);
  return runner.run({ resource, access: "exclusive" }, async () => {});
}
