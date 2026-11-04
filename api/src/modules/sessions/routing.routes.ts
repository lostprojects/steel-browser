import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "node:path";
import { z } from "zod";
import { agentFor } from "../../utils/api-key.js";
import { Routing } from "../../services/routing.js";
import { clearChallenge } from "../../services/challenge-service.js";
import { downloadFile } from "../../services/http-fetch.js";
import { selectedSession } from "./sessions.controller.js";
import { idempotent } from "../../utils/idempotency.js";
import { QuietInput } from "../../services/quiet-input.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const httpUrl = z
  .string()
  .url()
  .refine((v) => ["http:", "https:"].includes(new URL(v).protocol));
const fetchBody = z
  .object({
    url: httpUrl,
    route: z.enum(["annas", "bizapedia", "udn", "ancestry", "newspapers", "fold3"]).optional(),
    startRung: z.number().int().min(1).max(3).optional(),
    identity: name.optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    retry: z.boolean().optional(),
    retain: z.boolean().optional(),
    splitTraffic: z.boolean().optional(),
  })
  .strict();
export default async function routes(server: FastifyInstance) {
  const routing = new Routing(
    server.sessionPool,
    path.join(path.dirname(server.sessionPool.profilesRoot), "routing"),
  );
  const admin = (req: FastifyRequest) => {
    if (!agentFor(req.raw)?.admin)
      throw Object.assign(new Error("Admin key required"), { statusCode: 403 });
  };
  server.get("/routing", () => routing.table());
  server.get("/usage", async (req) => {
    const totals = await server.sessionPool.proxies!.totals();
    const agent = agentFor(req.raw)!;
    return agent.admin
      ? totals
      : {
          date: totals.date,
          agent: agent.name,
          residentialBytes: totals.agents[agent.name] ?? 0,
          totalResidentialBytes: totals.totalByAgent[agent.name] ?? 0,
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
    const { split } = z.object({ split: z.boolean() }).strict().parse(req.body);
    await routing.policy(host, split);
    return { host, split };
  });
  server.post("/fetch", async (req) => {
    const options = fetchBody.parse(req.body);
    const agent = agentFor(req.raw)!;
    if (options.splitTraffic !== undefined && !agent.admin)
      throw Object.assign(new Error("Admin key required for unmeasured policies"), {
        statusCode: 403,
      });
    return idempotent(req, () => routing.fetch(options, agent));
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
    return idempotent(req, () => clearChallenge(session, options.targetId, options.budgetMs));
  });
  server.post("/sessions/:sessionId/download", async (req) => {
    const { url, referer } = z
      .object({ url: httpUrl, referer: httpUrl.optional() })
      .strict()
      .parse(req.body);
    return downloadFile(selectedSession(server, req), url, referer);
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
    return idempotent(req, async () => {
      const { width, height } = session.getDimensions();
      const input = new QuietInput(session.display.name!, width, height);
      const mouse = (type: string, x: number | undefined, y: number | undefined, deltaY = 0) =>
        input.mouse({ type, x, y, deltaY, button: "left" }, { x: 0, y: 0 });
      for (const a of actions) {
        if (a.action === "type") await input.text(a.text ?? "");
        else if (a.action === "press") {
          await input.key({ type: "keyDown", key: a.text });
          await input.key({ type: "keyUp", key: a.text });
        } else if (a.action === "wait")
          await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10, a.value ?? 0)) * 1000));
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
    });
  });
}
