import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { getChromeExecutablePath } from "../../utils/browser.js";

export async function healthRoutes(server: FastifyInstance) {
  const { stdout } = await promisify(execFile)(getChromeExecutablePath(), ["--version"], {
    timeout: 5000,
  });
  const chromeVersion = stdout.trim();
  if (!/Google Chrome \d+\.\d+\.\d+\.\d+/.test(chromeVersion))
    throw new Error("Expected Google Chrome; check CHROME_EXECUTABLE_PATH");
  for (const url of ["/health", "/v1/health"])
    server.get(url, async (_req, reply) =>
      reply.code(server.sessionPool.draining ? 503 : 200).send({
        status: server.sessionPool.draining ? "draining" : "ok",
        chromeVersion,
        liveSessions: server.sessionPool.size,
        maxSessions: server.sessionPool.maxSessions,
        freeMemory: os.freemem(),
        vault: "not_configured",
        capabilities: ["managed_residential", "routing", "challenge", "reattach"],
      }),
    );
}
