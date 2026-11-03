import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { agentFor } from "../../utils/api-key.js";
export function selectedSession(
  server: FastifyInstance,
  request: {
    params?: unknown;
    query?: unknown;
    body?: unknown;
    headers?: Record<string, unknown>;
    raw?: IncomingMessage;
  },
) {
  const params = request.params as { sessionId?: string; id?: string } | undefined;
  const query = request.query as { sessionId?: string } | undefined;
  const body = request.body as { sessionId?: string } | undefined;
  const header = request.headers?.["steel-session-id"];
  const session = server.sessionPool.get(
    params?.sessionId ??
      params?.id ??
      query?.sessionId ??
      body?.sessionId ??
      (typeof header === "string" ? header : undefined),
  );
  if (request.raw) {
    const agent = agentFor(request.raw);
    if (!agent?.admin && server.sessionPool.owner(session.id)?.name !== agent?.name)
      throw Object.assign(new Error("Session belongs to another agent"), { statusCode: 403 });
  }
  session.touch();
  return session;
}
