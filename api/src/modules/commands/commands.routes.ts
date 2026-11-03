import type { FastifyInstance, FastifyRequest } from "fastify";
import { COMMANDS_API_VERSION, requestJsonSchema } from "../../services/commands/commands.js";
import { selectedSession } from "../sessions/sessions.controller.js";
export default async function routes(server: FastifyInstance) {
  server.get("/sessions/:sessionId/commands/schema", async () => ({
    version: COMMANDS_API_VERSION,
    schema: requestJsonSchema(),
  }));
  server.post(
    "/sessions/:sessionId/commands",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
      const session = selectedSession(server, req);
      const key = req.headers["idempotency-key"];
      const response = await session.engine.handle({
        sessionId: session.id,
        idempotencyKey: Array.isArray(key) ? key[0] : key,
        body: req.body,
      });
      session.touch();
      return reply.code(response.status).headers(response.headers).send(response.body);
    },
  );
}
