import type { FastifyInstance, FastifyRequest } from "fastify";
import { selectedSession } from "./sessions.controller.js";
import { handleScrape, handleScreenshot, handlePDF } from "../actions/actions.controller.js";
import { quickAction } from "../commands/commands.guard.js";

export default async function routes(server: FastifyInstance) {
  server.get("/sessions/:sessionId/view", async (req, reply) => {
    const session = selectedSession(server, req);
    if (!session.display.name)
      return reply.code(409).send({ error: "X display unavailable on this host" });
    return reply
      .header("referrer-policy", "no-referrer")
      .view("session-vnc.ejs", { wsPath: `/v1/sessions/${session.id}/vnc` });
  });
  server.post("/sessions", async (req) => (await server.sessionPool.create(req.body ?? {})).info());
  server.get("/sessions", async () => ({ sessions: server.sessionPool.list() }));
  server.get(
    "/sessions/:sessionId",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>) =>
      server.sessionPool.details(req.params.sessionId),
  );
  server.post(
    "/sessions/:sessionId/release",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>) => ({
      success: true,
      ...(await server.sessionPool.release(req.params.sessionId)),
    }),
  );
  server.delete(
    "/sessions/:sessionId",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>) =>
      server.sessionPool.release(req.params.sessionId),
  );
  server.post("/sessions/release", async (req) =>
    server.sessionPool.release(selectedSession(server, req).id),
  );
  server.get("/sessions/:sessionId/context", async (req) =>
    selectedSession(server, req).getBrowserState(),
  );
  server.get("/sessions/:sessionId/live-details", async (req) => {
    const session = selectedSession(server, req);
    const pages = await session.getAllPages();
    return {
      ...session.info(),
      pages: await Promise.all(
        pages.map(async (p) => ({
          id: (p.target() as unknown as { _targetId: string })._targetId,
          url: p.url(),
          title: await p.title(),
          favicon: null,
        })),
      ),
    };
  });
  for (const route of ["/sessions/:sessionId/debug", "/sessions/debug"])
    server.get(route, async (req, reply) => {
      const session = selectedSession(server, req);
      return reply.view("live-session-streamer.ejs", {
        wsUrl: `/v1/sessions/${session.id}/cast`,
        showControls: true,
        theme: "dark",
        interactive: true,
        dimensions: session.getDimensions(),
        singlePageMode: false,
      });
    });
  for (const [action, handler] of Object.entries({
    scrape: handleScrape,
    screenshot: handleScreenshot,
    pdf: handlePDF,
  })) {
    for (const route of [`/sessions/:sessionId/${action}`, `/sessions/${action}`])
      server.post(route, async (req, reply) => {
        const session = selectedSession(server, req);
        return quickAction({ commandEngine: session.engine }, req as any, reply, () =>
          handler(session, session, req as any, reply),
        );
      });
  }
}
