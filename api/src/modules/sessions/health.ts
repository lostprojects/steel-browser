import { vault } from "../../services/vault.js";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { getChromeExecutablePath } from "../../utils/browser.js";
import { createHash } from "node:crypto";
import { agentFor } from "../../utils/api-key.js";
import { getBaseUrl } from "../../utils/url.js";
import { currentOrganization, membershipId } from "../../services/organization.js";

export async function healthRoutes(server: FastifyInstance) {
  const { stdout } = await promisify(execFile)(getChromeExecutablePath(), ["--version"], {
    timeout: 5000,
  });
  const chromeVersion = stdout.trim();
  if (!/Google Chrome \d+\.\d+\.\d+\.\d+/.test(chromeVersion))
    throw new Error("Expected Google Chrome; check CHROME_EXECUTABLE_PATH");
  if (process.env.STEEL_ROLE === "worker") {
    server.get("/v1/worker", async (req, reply) => {
      if (!agentFor(req.raw)?.admin) return reply.code(403).send({ error: "Worker key required" });
      return {
        userId: process.env.STEEL_USER_ID,
        orgId: currentOrganization().id,
        membershipId: membershipId(currentOrganization().id, process.env.STEEL_USER_ID!),
        publicOrigin: new URL(getBaseUrl()).origin,
        sharedOrigin: new URL(process.env.STEEL_SHARED_URL!).origin,
        sharedKeyHash: createHash("sha256").update(process.env.STEEL_SHARED_KEY!).digest("hex"),
      };
    });
  }
  for (const url of ["/health", "/v1/health"])
    server.get(url, async (_req, reply) =>
      reply.code(server.sessionPool.draining ? 503 : 200).send(
        process.env.STEEL_ROLE === "worker"
          ? {
              status: server.sessionPool.draining ? "draining" : "ok",
            }
          : {
              status: server.sessionPool.draining ? "draining" : "ok",
              chromeVersion,
              revision: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
              liveSessions: server.sessionPool.size,
              maxSessions: server.sessionPool.maxSessions,
              freeMemory: os.freemem(),
              vault: vault.status,
              capabilities: [
                "managed_residential",
                "routing",
                "challenge",
                "reattach",
                "vault",
                "login",
                ...(server.contentLibrary ? ["content_library"] : []),
              ],
            },
      ),
    );
}
