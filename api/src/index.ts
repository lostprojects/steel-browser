import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import toolstackPlugin from "./toolstack-plugin.js";
import uiPlugin from "./plugins/ui-plugin.js";
import { loggingConfig } from "./config.js";
import { MB } from "./utils/size.js";
import path from "node:path";
import type { Duplex } from "node:stream";
import { env } from "./env.js";
import { requireWorkerBoundary } from "./services/worker-boundary.js";
import { runCleanup } from "./utils/cleanup.js";
import {
  API_KEY_COOKIE,
  isAuthorized,
  suppliedKey,
  requireApiKey,
  browserOriginAllowed,
} from "./utils/api-key.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SHUTDOWN_TIMEOUT_MS =
  Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 120) * 1000 + 15_000;

export const server = fastify({
  logger: loggingConfig[process.env.NODE_ENV ?? "development"] ?? true,
  trustProxy: true,
  bodyLimit: 100 * MB,
  disableRequestLogging: true,
});

const setupServer = async () => {
  await requireWorkerBoundary();
  requireApiKey();
  await server.register(fastifyCors, { origin: true });

  server.addHook("onRequest", async (request, reply) => {
    if (!browserOriginAllowed(request.raw))
      return reply.code(403).send({ error: "Origin is not allowed" });
    if (request.method === "OPTIONS") return;
    if (!isAuthorized(request.raw)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    // Opening the UI with ?apiKey= stores the key so its own calls carry it
    const { key, fromQuery } = suppliedKey(request.raw);
    if (env.STEEL_API_KEY && fromQuery && key) {
      const secure = request.protocol === "https" ? "; Secure" : "";
      reply.header(
        "set-cookie",
        `${API_KEY_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      );
      reply.header("referrer-policy", "no-referrer").header("cache-control", "no-store");
      const url = new URL(request.raw.url ?? "/", "http://localhost");
      if (
        request.method === "GET" &&
        (url.pathname.startsWith("/ui/") || /^\/v1\/sessions\/[^/]+\/view$/.test(url.pathname))
      ) {
        url.searchParams.delete("apiKey");
        return reply.redirect(url.pathname + url.search);
      }
    }
  });

  // Register UI plugin only in production (when we have built UI files)
  if (process.env.NODE_ENV === "production") {
    await server.register(uiPlugin, {
      uiDistPath: path.join(process.cwd(), "ui/dist"),
      uiPrefix: "/ui",
    });
  }

  await server.register(toolstackPlugin, {
    fileStorage: {
      maxSizePerSession: 100 * MB,
    },
  });

  const upgradedSockets = new Set<Duplex>();
  server.server.on("upgrade", (_request, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
  });

  server.addHook("preClose", async () => {
    try {
      await server.sessionPool.drain(0);
    } finally {
      for (const socket of upgradedSockets) socket.destroy();
    }
  });
};

const startServer = async () => {
  try {
    await setupServer();
    await server.listen({ port: PORT, host: HOST });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

let shuttingDown = false;

const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.log.info(`${signal} received, shutting down`);
  setTimeout(() => {
    server.log.error(`Shutdown took longer than ${SHUTDOWN_TIMEOUT_MS}ms, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  let exitCode = 0;
  try {
    await runCleanup(
      [() => server.sessionPool?.drain(), () => server.close()],
      "Service shutdown failed",
    );
  } catch (err) {
    server.log.error(err);
    exitCode = 1;
  }
  process.exit(exitCode);
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown(signal));
}

startServer();
