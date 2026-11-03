import type { FastifyInstance } from "fastify";
export function selectedSession(
  server: FastifyInstance,
  request: { params?: unknown; query?: unknown; body?: unknown; headers?: Record<string, unknown> },
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
  session.touch();
  return session;
}
