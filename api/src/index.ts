import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySensible from "@fastify/sensible";
import steelBrowserPlugin from "./steel-browser-plugin.js";
import uiPlugin from "./plugins/ui-plugin.js";
import { ShutdownReason } from "./services/cdp/plugins/core/base-plugin.js";
import { loggingConfig } from "./config.js";
import { MB } from "./utils/size.js";
import path from "node:path";
import type { Duplex } from "node:stream";
import { env } from "./env.js";
import { API_KEY_COOKIE, isAuthorized, suppliedKey } from "./utils/api-key.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 120) * 1000 + 15_000;

export const server = fastify({
  logger: loggingConfig[process.env.NODE_ENV ?? "development"] ?? true,
  trustProxy: true,
  bodyLimit: 100 * MB,
  disableRequestLogging: true,
});

const setupServer = async () => {
  await server.register(fastifySensible);
  await server.register(fastifyCors, { origin: true });

  server.addHook("onRequest", async (request, reply) => {
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
    }
  });

  // Register UI plugin only in production (when we have built UI files)
  if (process.env.NODE_ENV === "production") {
    await server.register(uiPlugin, {
      uiDistPath: path.join(process.cwd(), "ui/dist"),
      uiPrefix: "/ui",
    });
  }

  await server.register(steelBrowserPlugin, {
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
  try {
    await server.sessionPool.drain();
    await server.close();
  } catch (err) {
    server.log.error(err);
  }
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown(signal));
}

startServer();
