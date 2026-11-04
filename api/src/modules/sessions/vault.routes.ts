import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { vault } from "../../services/vault.js";
import { LoginService } from "../../services/login.js";
import { agentFor } from "../../utils/api-key.js";
import { selectedSession } from "./sessions.controller.js";
import { idempotent } from "../../utils/idempotency.js";

export default async function routes(server: FastifyInstance) {
  const login = new LoginService(path.dirname(server.sessionPool.profilesRoot));
  const stopDaily = login.startDailyChecks(server.sessionPool);
  server.addHook("onClose", async () => stopDaily());
  server.get("/vault", (req) => vault.list(agentFor(req.raw)!));
  server.get<{ Params: { name: string } }>("/vault/:name", (req) =>
    vault.list(agentFor(req.raw)!, req.params.name),
  );
  server.put<{ Params: { name: string } }>("/vault/:name", (req) =>
    vault.put(req.params.name, req.body, agentFor(req.raw)!),
  );
  server.get("/logins", async (req) => {
    const allowed = new Set((await vault.list(agentFor(req.raw)!)).map((e) => e.name));
    return Object.fromEntries(
      Object.entries(await login.metadata()).filter(([key]) =>
        [...allowed].some((n) => key.startsWith(n + "/") || key.startsWith(n + "-")),
      ),
    );
  });
  server.post("/sessions/:sessionId/login", async (req) => {
    const { site, current } = z
      .object({
        site: z.enum(["ancestry", "newspapers", "fold3", "mary-ferrell", "hathitrust-google"]),
        current: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return idempotent(req, () =>
      login.login(selectedSession(server, req), site, agentFor(req.raw)!, current),
    );
  });
}
