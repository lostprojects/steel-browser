import { browserApplication } from "../../services/browser-application.js";
import { scrub } from "../../services/vault.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentFor } from "../../utils/api-key.js";
import { clearChallenge } from "../../services/challenge-service.js";
import { downloadFile, httpFetch, httpCapacity } from "../../services/http-fetch.js";
import { selectedSession } from "./sessions.controller.js";
import { idempotent, retryKey } from "../../utils/idempotency.js";
import { QuietInput } from "../../services/quiet-input.js";
import { withSessionOperation } from "../../services/session-access.js";
import { actor, proxyAdmin } from "../../services/proxy/types.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const httpUrl = z
  .string()
  .url()
  .refine((v) => {
    const url = new URL(v);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  });
export default async function routes(server: FastifyInstance) {
  const routing = server.sessionPool.routing;
  const app = browserApplication(server.sessionPool);
  const context = (req: FastifyRequest) => ({
    agent: agentFor(req.raw)!,
    idempotencyKey: retryKey(req.headers),
  });
  const admin = (req: FastifyRequest) => {
    if (!agentFor(req.raw) || !proxyAdmin(agentFor(req.raw)!))
      throw Object.assign(new Error("Admin key required"), { statusCode: 403 });
  };
  server.get("/routing", () => routing.table());
  server.get("/sites", () => routing.registry());
  server.get<{ Params: { site: string } }>("/sites/:site", (req) =>
    routing.resolve(req.params.site),
  );
  server.post("/caller-outcomes", async (req) => {
    return app.outcome(context(req), req.body);
  });
  server.get("/caller-outcomes", async (req) => {
    admin(req);
    const q = z
      .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
      .strict()
      .parse(req.query);
    return server.sessionPool.outcomes.summary(q.from, q.to);
  });
  server.get("/usage", async (req) => {
    const totals = await server.sessionPool.proxies!.totals();
    const agent = agentFor(req.raw)!;
    return proxyAdmin(agent)
      ? { ...totals, http: httpCapacity() }
      : {
          date: totals.date,
          agent: agent.name,
          residentialBytes: totals.agents[actor(agent)] ?? 0,
          totalResidentialBytes: totals.totalByAgent[actor(agent)] ?? 0,
          dailyBudgetBytes: agent.dailyBudgetBytes,
        };
  });
  server.get("/identities", () => server.sessionPool.proxies!.identities());
  server.put<{ Params: { name: string } }>("/identities/:name", async (req) => {
    admin(req);
    const identityName = name.parse(req.params.name);
    if (server.sessionPool.identityBusy(identityName))
      throw Object.assign(new Error("Identity is in use"), { statusCode: 409 });
    const data = z
      .object({
        country: z.string().regex(/^[A-Z]{2}$/),
        stickyId: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
      })
      .strict()
      .parse(req.body);
    await server.sessionPool.proxies!.saveIdentity(identityName, data);
    return { name: identityName, saved: true };
  });
  server.put<{ Params: { host: string } }>("/routing/policies/:host", async (req) => {
    admin(req);
    const host = z
      .string()
      .regex(/^[A-Za-z0-9.-]{1,253}$/)
      .parse(req.params.host)
      .toLowerCase();
    const policy = z
      .object({
        split: z.boolean().optional(),
        startRung: z.number().int().min(1).max(3).optional(),
        ttlSeconds: z.number().int().min(1).max(604800).optional(),
        site: name.optional(),
        url: httpUrl.optional(),
        identity: name.nullable().optional(),
        mode: z.enum(["agent", "quiet"]).optional(),
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable()
          .optional(),
        loginSite: z
          .enum(["ancestry", "newspapers", "fold3", "mary-ferrell", "hathitrust-google"])
          .nullable()
          .optional(),
      })
      .strict()
      .parse(req.body);
    if (policy.url && new URL(policy.url).hostname !== host)
      throw Object.assign(new Error("Site URL must match policy host"), { statusCode: 400 });
    const { split, startRung, ttlSeconds, ...site } = policy;
    await routing.policy(host, split, startRung, ttlSeconds, site);
    return { host, ...policy };
  });
  server.post<{ Params: { requestId: string } }>("/fetch/:requestId/cancel", async (req) => {
    const requestId = z.string().uuid().parse(req.params.requestId);
    return routing.cancel(requestId, agentFor(req.raw)!);
  });
  server.post("/fetch", async (req, reply) => {
    try {
      return await app.fetch(context(req), req.body);
    } catch (error) {
      const stopped = error as { statusCode?: number; requestId?: string; reason?: string };
      if (
        stopped.statusCode === 408 &&
        ["fetch_timeout", "fetch_cancelled"].includes(stopped.reason ?? "")
      )
        return reply.code(408).send({
          status: "failed",
          requestId: stopped.requestId,
          reason: stopped.reason,
          error: stopped.reason,
        });
      throw error;
    }
  });
  server.post("/sessions/:sessionId/challenge", async (req) => {
    const options = z
      .object({
        targetId: z.string().max(100).optional(),
        budgetMs: z.number().int().min(1).max(60_000).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const session = selectedSession(server, req);
    return idempotent(req, () =>
      withSessionOperation(session, () =>
        clearChallenge(session, options.targetId, options.budgetMs),
      ),
    );
  });
  server.post("/sessions/:sessionId/download", async (req) => {
    const { url, referer } = z
      .object({ url: httpUrl, referer: httpUrl.optional() })
      .strict()
      .parse(req.body);
    const session = selectedSession(server, req);
    return withSessionOperation(session, () => downloadFile(session, url, referer));
  });
  server.post("/sessions/:sessionId/request", async (req) => {
    const session = selectedSession(server, req);
    const options = z
      .object({
        url: httpUrl,
        method: z.enum(["GET", "POST"]).default("GET"),
        data: z.string().max(2000000).optional(),
        headers: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .parse(req.body);
    for (const key of Object.keys(options.headers))
      if (!/^(accept|content-type|accept-language|referer)$/i.test(key))
        throw Object.assign(new Error("Request header is not allowed"), { statusCode: 400 });
    return withSessionOperation(session, async (operation) => {
      const result = await httpFetch({
        ...options,
        cookies: await session.getCookies(),
        userAgent: session.getUserAgent(),
        proxy: session.proxyServer?.url,
        maxBytes: 64000000,
        timeout: operation.remaining(120_000) / 1000,
        signal: operation.signal,
      });
      delete result.headers["set-cookie"];
      const type = result.headers["content-type"] ?? "";
      if (/json|text|javascript/.test(type))
        result.body = Buffer.from(scrub(Buffer.from(result.body, "base64").toString())).toString(
          "base64",
        );
      session.touch();
      return result;
    });
  });
  server.post("/sessions/:sessionId/input", async (req) => {
    const session = selectedSession(server, req);
    const { actions } = z
      .object({
        actions: z
          .array(
            z
              .object({
                action: z.enum(["click", "dblclick", "drag", "type", "press", "scroll", "wait"]),
                x: z.number().finite().optional(),
                y: z.number().finite().optional(),
                x2: z.number().finite().optional(),
                y2: z.number().finite().optional(),
                text: z.string().max(10000).optional(),
                value: z.number().finite().optional(),
              })
              .strict(),
          )
          .max(30),
      })
      .strict()
      .parse(req.body);
    if (!session.display.name) throw new Error("Session display unavailable");
    return idempotent(req, () =>
      withSessionOperation(session, async (operation) => {
        const { width, height } = session.getDimensions();
        const input = new QuietInput(session.display.name!, width, height);
        const mouse = (type: string, x: number | undefined, y: number | undefined, deltaY = 0) =>
          operation.wait(() => input.mouse({ type, x, y, deltaY, button: "left" }, { x: 0, y: 0 }));
        for (const a of actions) {
          operation.check();
          if (a.action === "type") await operation.wait(() => input.text(a.text ?? ""));
          else if (a.action === "press") {
            await operation.wait(() => input.key({ type: "keyDown", key: a.text }));
            await operation.wait(() => input.key({ type: "keyUp", key: a.text }));
          } else if (a.action === "wait")
            await operation.wait(
              () =>
                new Promise<void>((r) =>
                  setTimeout(r, Math.max(0, Math.min(10, a.value ?? 0)) * 1000),
                ),
            );
          else if (a.action === "scroll")
            await mouse("mouseWheel", a.x ?? width / 2, a.y ?? height / 2, a.value);
          else {
            await mouse("mousePressed", a.x, a.y);
            if (a.action === "drag") await mouse("mouseMoved", a.x2, a.y2);
            await mouse(
              "mouseReleased",
              a.action === "drag" ? a.x2 : a.x,
              a.action === "drag" ? a.y2 : a.y,
            );
            if (a.action === "dblclick") {
              await mouse("mousePressed", a.x, a.y);
              await mouse("mouseReleased", a.x, a.y);
            }
          }
        }
        session.touch();
        return { success: true, sessionId: session.id };
      }),
    );
  });
}
