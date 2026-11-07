import type { FastifyInstance, FastifyRequest } from "fastify";
import { COMMANDS_API_VERSION, requestJsonSchema } from "../../services/commands/commands.js";
import { browserApplication } from "../../services/browser-application.js";
import { agentFor } from "../../utils/api-key.js";
export default async function routes(server: FastifyInstance) {
  server.get("/sessions/:sessionId/commands/schema", async () => ({
    version: COMMANDS_API_VERSION,
    schema: requestJsonSchema(),
  }));
  server.post(
    "/sessions/:sessionId/commands",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
      const key = req.headers["idempotency-key"];
      const response = await browserApplication(server.sessionPool).commands(
        {
          agent: agentFor(req.raw)!,
          idempotencyKey: Array.isArray(key) ? key[0] : key,
        },
        req.params.sessionId,
        req.body,
      );
      return reply.code(response.status).headers(response.headers).send(response.body);
    },
  );
}
