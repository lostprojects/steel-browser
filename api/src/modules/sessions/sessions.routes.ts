import { identityVault } from "../../services/login.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { selectedSession } from "./sessions.controller.js";
import { handleScrape, handleScreenshot, handlePDF } from "../actions/actions.controller.js";
import { quickAction } from "../commands/commands.guard.js";
import { agentFor } from "../../utils/api-key.js";
import { idempotent } from "../../utils/idempotency.js";

export default async function routes(server: FastifyInstance) {
  const access = (req: FastifyRequest, id: string) => {
    const agent = agentFor(req.raw)!;
    if (!agent.admin && server.sessionPool.owner(id)?.name !== agent.name)
      throw Object.assign(new Error("Session belongs to another agent"), { statusCode: 403 });
  };
  const admin = (req: FastifyRequest) => {
    if (!agentFor(req.raw)?.admin)
      throw Object.assign(new Error("Admin key required"), { statusCode: 403 });
  };
  server.get("/sessions/:sessionId/diagnostics", async (req) => {
    admin(req);
    return selectedSession(server, req).diagnostics();
  });
  server.post("/sessions/:sessionId/fault/chrome-kill", async (req) => {
    admin(req);
    return idempotent(req, async () => {
      const session = selectedSession(server, req);
      const result = await session.killChrome();
      await server.sessionPool.release(session.id, "chrome_exit");
      return result;
    });
  });
  server.get("/sessions/:sessionId/view", async (req, reply) => {
    const session = selectedSession(server, req);
    if (!session.display.name)
      return reply.code(409).send({ error: "X display unavailable on this host" });
    return reply
      .header("referrer-policy", "no-referrer")
      .view("session-vnc.ejs", { wsPath: `/v1/sessions/${session.id}/vnc` });
  });
  server.post("/sessions", async (req) =>
    idempotent(req, async () =>
      (await server.sessionPool.create(req.body ?? {}, agentFor(req.raw))).info(),
    ),
  );
  server.get("/sessions", async (req) => {
    const agent = agentFor(req.raw)!;
    return {
      sessions: server.sessionPool
        .list()
        .filter((s) => agent.admin || server.sessionPool.owner(s.id)?.name === agent.name),
    };
  });
  server.get(
    "/sessions/:sessionId",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>) => {
      access(req, req.params.sessionId);
      return server.sessionPool.details(req.params.sessionId);
    },
  );
  server.post(
    "/sessions/:sessionId/release",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>) => {
      access(req, req.params.sessionId);
      return {
        success: true,
        ...(await server.sessionPool.release(req.params.sessionId)),
      };
    },
  );
  server.delete(
    "/sessions/:sessionId",
    async (req: FastifyRequest<{ Params: { sessionId: string } }>) => {
      access(req, req.params.sessionId);
      return server.sessionPool.release(req.params.sessionId);
    },
  );
  server.post("/sessions/release", async (req) =>
    server.sessionPool.release(selectedSession(server, req).id),
  );
  server.get("/sessions/:sessionId/context", async (req) => {
    const session = selectedSession(server, req);
    if (identityVault(session.options.identity))
      throw Object.assign(new Error("Protected identity state cannot be exported"), {
        statusCode: 403,
      });
    return session.getBrowserState();
  });
  // Cookie lifetimes without values, so login persistence can be measured on
  // protected identities. Optional ?domain= keeps cookies for that site.
  server.get<{ Querystring: { domain?: string } }>(
    "/sessions/:sessionId/cookie-lifetimes",
    async (req) => {
      const session = selectedSession(server, req);
      const domain = (req.query.domain ?? "").replace(/^\./, "").toLowerCase();
      return (await session.getCookies())
        .filter((c: any) => {
          const host = c.domain.replace(/^\./, "").toLowerCase();
          return !domain || host === domain || host.endsWith(`.${domain}`);
        })
        .map((c: any) => ({
          domain: c.domain,
          name: c.name,
          expires:
            c.session || c.expires < 0 ? "session" : new Date(c.expires * 1000).toISOString(),
          httpOnly: c.httpOnly,
        }));
    },
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
      if (session.options.mode === "quiet") return reply.redirect(session.info().noVncUrl);
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
        if (session.options.mode === "quiet")
          return reply.code(409).send({
            error: "Use the commands API for quiet-session reads and display screenshots",
          });
        return quickAction({ commandEngine: session.engine }, req as any, reply, () =>
          handler(session, session, req as any, reply),
        );
      });
  }
}
