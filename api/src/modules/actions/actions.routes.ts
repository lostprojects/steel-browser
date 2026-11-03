import type { FastifyInstance } from "fastify";
import { handlePDF, handleScrape, handleScreenshot, handleSearch } from "./actions.controller.js";
import { selectedSession } from "../sessions/sessions.controller.js";
import { quickAction } from "../commands/commands.guard.js";
export default async function routes(server: FastifyInstance) {
  for (const [action, handler] of Object.entries({
    scrape: handleScrape,
    screenshot: handleScreenshot,
    pdf: handlePDF,
    search: handleSearch,
  })) {
    server.post(`/${action}`, async (req, reply) => {
      const body = req.body as Record<string, unknown>;
      const explicit = body?.sessionId ?? req.headers["steel-session-id"];
      const temporary = !explicit;
      const session = temporary
        ? await server.sessionPool.create({ blockAds: false })
        : selectedSession(server, req);
      try {
        return await quickAction({ commandEngine: session.engine }, req as any, reply, () =>
          handler(session, session, req as any, reply),
        );
      } finally {
        if (temporary) await server.sessionPool.release(session.id);
      }
    });
  }
}
