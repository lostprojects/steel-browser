import { selectedSession } from "../sessions/sessions.controller.js";
import { FastifyPluginAsync, FastifyRequest } from "fastify";
import { LogQueryInput } from "./logs.schema.js";
import { $ref } from "../../plugins/schemas.js";
import { EmitEvent } from "../../types/enums.js";
import { scrubObject } from "../../services/vault.js";

const logsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Query logs from local storage
   */
  fastify.get(
    "/query",
    {
      schema: {
        querystring: $ref("LogQuerySchema"),
        tags: ["Logs"],
        description: "Query browser logs from local storage",
      },
    },
    async (request: FastifyRequest<{ Querystring: LogQueryInput }>) => {
      const query = request.query;
      const storage = selectedSession(fastify, request).getInstrumentationLogger().getStorage()!;

      let result;
      try {
        result = await storage.query({
          startTime: query.startTime ? new Date(query.startTime) : undefined,
          endTime: query.endTime ? new Date(query.endTime) : undefined,
          eventTypes: query.eventTypes ? query.eventTypes.split(",") : undefined,
          pageId: query.pageId,
          targetType: query.targetType,
          limit: query.limit,
          offset: query.offset,
        });
      } catch (error) {
        fastify.log.error({ error }, "Error querying logs");
        throw error;
      }

      return result;
    },
  );

  /**
   * Get log statistics
   */
  fastify.get(
    "/stats",
    {
      schema: {
        tags: ["Logs"],
        description: "Get statistics about stored browser logs",
      },
    },
    async (request) => {
      const storage = selectedSession(fastify, request).getInstrumentationLogger().getStorage()!;
      const stats = await storage.getStats();

      return {
        totalEvents: stats.totalEvents,
        oldestEvent: stats.oldestEvent?.toISOString() || null,
        newestEvent: stats.newestEvent?.toISOString() || null,
        sizeBytes: stats.sizeBytes,
      };
    },
  );

  /**
   * Stream logs in real-time using Server-Sent Events
   */
  fastify.get(
    "/stream",
    {
      schema: {
        tags: ["Logs"],
        description: "Stream browser logs in real-time using SSE",
      },
    },
    async (request, reply) => {
      const logger = selectedSession(fastify, request).getInstrumentationLogger();

      if (!logger) {
        return reply.code(503).send({ error: "Browser logger not available" });
      }

      // Set SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send initial comment to establish connection
      reply.raw.write(": connected\n\n");

      // Listen for new log events
      const handleLog = (event: any, context: any) => {
        const data = JSON.stringify(scrubObject({ ...event, ...context }));
        reply.raw.write(`data: ${data}\n\n`);
      };

      logger.on?.(EmitEvent.Log, handleLog);

      // Clean up on disconnect
      request.raw.on("close", () => {
        logger.off?.(EmitEvent.Log, handleLog);
      });
    },
  );

  /**
   * Retain a clear response for clients of the removed disk-storage export.
   */
  fastify.post(
    "/export",
    {
      schema: {
        tags: ["Logs"],
        deprecated: true,
        description: "Parquet export is unavailable; retrieve JSON with /v1/logs/query",
      },
    },
    async (request, reply) => {
      selectedSession(fastify, request);
      return reply
        .code(501)
        .send({ message: "Use /v1/logs/query for JSON logs; Parquet export is unavailable" });
    },
  );

  /**
   * Clear all logs from storage
   */
  fastify.delete(
    "/",
    {
      schema: {
        tags: ["Logs"],
        description: "Clear all browser logs from storage",
      },
    },
    async (request) => {
      const storage = selectedSession(fastify, request).getInstrumentationLogger().getStorage()!;
      await storage.clear();

      return {
        message: "Logs cleared successfully",
      };
    },
  );
};

export default logsRoutes;
