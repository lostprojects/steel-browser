import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { browserApplication } from "../../services/browser-application.js";
import { agentFor, browserOriginAllowed } from "../../utils/api-key.js";
import { connectionPagination } from "../../services/connections.js";
import { PublicError } from "../../utils/public-error.js";

export default async function connectionRoutes(server: FastifyInstance) {
  const app = browserApplication(server.sessionPool);
  const agent = (req: FastifyRequest) => {
    const value = agentFor(req.raw);
    if (!value) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    if (!browserOriginAllowed(req.raw))
      throw Object.assign(new Error("Origin is not allowed"), { statusCode: 403 });
    return value;
  };
  const queryNumber = (value: unknown) => (typeof value === "string" ? Number(value) : value);
  const pagination = connectionPagination.extend({
    limit: z.preprocess(queryNumber, connectionPagination.shape.limit),
    offset: z.preprocess(queryNumber, connectionPagination.shape.offset),
  });
  const validate = async <T>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new PublicError("invalid_request", "Invalid connection parameters", 400);
      throw error;
    }
  };
  server.get("/connections", (req) => {
    const principal = agent(req);
    const options = pagination.safeParse(req.query);
    if (!options.success)
      throw new PublicError("invalid_request", "Invalid connection pagination", 400);
    return app.connections.page(principal, options.data);
  });
  server.get<{ Params: { id: string } }>("/connections/:id", (req) => {
    const principal = agent(req);
    return validate(() => app.connections.get(req.params.id, principal));
  });
  server.get<{ Params: { id: string } }>("/connections/:id/usage", (req) => {
    const principal = agent(req);
    const options = pagination.safeParse(req.query);
    if (!options.success)
      throw new PublicError("invalid_request", "Invalid execution pagination", 400);
    return validate(() =>
      app.api.history(
        { connection: req.params.id, ...options.data },
        {
          agent: principal,
          requestId: req.id,
          signal: new AbortController().signal,
        },
      ),
    );
  });
  server.put<{ Params: { id: string } }>("/connections/:id", { bodyLimit: 16_000 }, (req) => {
    const principal = agent(req);
    return validate(() => app.connections.configure(req.params.id, req.body, principal));
  });
  server.post<{ Params: { id: string } }>("/connections/:id/access", { bodyLimit: 1000 }, (req) => {
    const principal = agent(req);
    return validate(async () => {
      const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      return app.connections.access(req.params.id, input.enabled, false, principal);
    });
  });
  server.delete<{ Params: { id: string } }>("/connections/:id", (req) => {
    const principal = agent(req);
    return validate(() => app.connections.access(req.params.id, false, true, principal));
  });
}
