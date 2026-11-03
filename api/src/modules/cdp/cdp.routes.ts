import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { selectedSession } from "../sessions/sessions.controller.js";
import { z } from "zod";
import { $ref } from "../../plugins/schemas.js";
import cdpSchemas from "./cdp.schemas.js";

async function routes(server: FastifyInstance) {
  server.get(
    "/devtools/inspector.html",
    {
      schema: {
        operationId: "getDevtoolsUrl",
        description: "Get the URL for the DevTools inspector",
        tags: ["CDP"],
        summary: "Get the URL for the DevTools inspector",
        querystring: $ref("GetDevtoolsUrlSchema"),
      },
    },
    async (
      request: FastifyRequest<{ Querystring: z.infer<typeof cdpSchemas.GetDevtoolsUrlSchema> }>,
      reply: FastifyReply,
    ) => {
      return reply.redirect(selectedSession(server, request).getDebuggerUrl());
    },
  );
}

export default routes;
