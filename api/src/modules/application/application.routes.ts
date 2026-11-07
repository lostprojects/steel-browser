// The application and MCP call the same registry and application services.
// Never execute a UI-provided module or accept a client-provided owner.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BrowserApplication } from "../../services/browser-application.js";
import type { ToolRegistry, ToolContext } from "../../services/toolkits/registry.js";
import { agentFor, browserOriginAllowed } from "../../utils/api-key.js";
import { PublicError } from "../../utils/public-error.js";
import { callRegisteredTool } from "../mcp/discovery.js";
import { verifyConnection } from "../../services/toolkits/verify-connection.js";
import { scrubToolResult } from "../mcp/output.js";

export async function applicationRoutes<Context extends ToolContext & { request: FastifyRequest }>(
  server: FastifyInstance,
  registry: ToolRegistry<Context>,
  application: BrowserApplication,
) {
  const context = (req: FastifyRequest, signal = new AbortController().signal): Context => {
    const agent = agentFor(req.raw);
    if (!agent) throw new PublicError("unauthorized", "Sign in to Toolstack", 401);
    if (!browserOriginAllowed(req.raw))
      throw new PublicError("forbidden_origin", "Use the Toolstack origin", 403);
    return { agent, request: req, requestId: randomUUID(), signal } as Context;
  };
  server.get("/v1/toolkits", (req, reply) => {
    reply.header("cache-control", "no-store");
    return registry.catalog(context(req));
  });
  server.post<{ Params: { id: string } }>("/v1/connections/:id/verify", async (req, reply) => {
    const controller = new AbortController();
    const principal = context(req, controller.signal);
    const retry = req.headers["idempotency-key"];
    const execution =
      retry === undefined
        ? principal
        : {
            ...principal,
            requestId: z
              .string()
              .regex(/^[A-Za-z0-9_-]{1,128}$/)
              .parse(retry),
          };
    const abort = () => controller.abort();
    reply.raw.once("close", abort);
    try {
      return scrubToolResult(
        await verifyConnection(registry, application.connections, req.params.id, execution),
      );
    } finally {
      reply.raw.removeListener("close", abort);
    }
  });
  server.get<{ Params: { name: string } }>("/v1/tools/:name", (req) =>
    registry.describe(req.params.name, context(req)),
  );
  server.get("/v1/workflows", (req) => registry.listWorkflows(context(req)));
  server.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    "/v1/workflows/:id",
    (req) => {
      const principal = context(req);
      return registry.getWorkflow(
        req.params.id,
        principal,
        z.string().min(1).max(100).optional().parse(req.query.version),
      );
    },
  );
  server.get<{ Params: { id: string; reference: string }; Querystring: { version: string } }>(
    "/v1/workflows/:id/references/:reference",
    (req) => {
      const principal = context(req);
      return registry.workflowReference(
        req.params.id,
        req.params.reference,
        z.string().min(1).max(100).parse(req.query.version),
        principal,
      );
    },
  );
  const execution = z
    .object({
      arguments: z.record(z.string(), z.unknown()).default({}),
      version: z.string().min(1).max(100).optional(),
    })
    .strict();
  server.post<{ Params: { name: string } }>(
    "/v1/tools/:name/execute",
    { bodyLimit: 2_000_000 },
    async (req, reply) => {
      const controller = new AbortController();
      const principal = context(req, controller.signal);
      const input = execution.safeParse(req.body);
      if (!input.success)
        throw new PublicError(
          "invalid_request",
          "Supply tool arguments and an optional version",
          400,
        );
      const abort = () => controller.abort();
      reply.raw.once("close", abort);
      try {
        reply.header("cache-control", "no-store");
        return await callRegisteredTool(
          registry,
          "tools_execute",
          {
            name: req.params.name,
            ...input.data,
          },
          principal,
        );
      } finally {
        reply.raw.removeListener("close", abort);
      }
    },
  );
  server.get("/v1/activity", async (req, reply) => {
    const principal = context(req);
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      })
      .strict()
      .safeParse(req.query);
    if (!parsed.success)
      throw new PublicError("invalid_request", "Invalid activity pagination", 400);
    const api = await application.api.ledger.activity(principal.agent.name, parsed.data);
    reply.header("cache-control", "no-store");
    return { ...api, sessions: application.list(principal).sessions };
  });
}
