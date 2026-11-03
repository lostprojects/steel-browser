import fastifyView from "@fastify/view";
import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path, { dirname } from "node:path";
import { env } from "./env.js";
import browserInstancePlugin from "./plugins/browser.js";
import browserWebSocket from "./plugins/browser-socket/browser-socket.js";
import customBodyParser from "./plugins/custom-body-parser.js";
import fileStoragePlugin from "./plugins/file-storage.js";
import requestLogger from "./plugins/request-logger.js";
import openAPIPlugin from "./plugins/schemas.js";
import {
  actionsRoutes,
  cdpRoutes,
  filesRoutes,
  logsRoutes,
  sessionsRoutes,
} from "./routes.js";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import type { BrowserSession } from "./services/browser-session.js";
import type { CommandEngine } from "./services/commands/engine.js";
import type { BrowserLauncherOptions } from "./types/browser.js";
import { WebSocketHandler } from "./types/websocket.js";
import { WebSocketRegistryService } from "./services/websocket-registry.service.js";
import { LogStorage } from "./services/cdp/instrumentation/storage/log-storage.interface.js";

// We need to redeclare any decorators from within the plugin that we want to expose
declare module "fastify" {
  interface FastifyInstance {
    steelBrowserConfig: SteelBrowserConfig;

  }

  interface LogStorageInterface extends LogStorage {}
}

export interface SteelBrowserConfig {
  fileStorage?: {
    maxSizePerSession?: number;
  };
  customWsHandlers?: WebSocketHandler[];
  logging?: {
    enableStorage?: boolean;
    storagePath?: string;
    enableConsoleLogging?: boolean;
    enableLogsRoutes?: boolean;
  };
}

const steelBrowserPlugin: FastifyPluginAsync<SteelBrowserConfig> = async (fastify, opts) => {
  fastify.decorate("steelBrowserConfig", opts);
  // Plugins
  await fastify.register(fastifyView, {
    engine: {
      ejs,
    },
    root: path.join(dirname(fileURLToPath(import.meta.url)), "templates"),
  });
  await fastify.register(requestLogger);
  await fastify.register(openAPIPlugin);
  await fastify.register(fileStoragePlugin);
  await fastify.register(browserInstancePlugin);
  await fastify.register(browserWebSocket, {
    customHandlers: opts.customWsHandlers,
  });
  await fastify.register(customBodyParser);

  // Routes
  const commands = env.ENABLE_COMMANDS_API
    ? await import("./modules/commands/commands.routes.js")
    : null;
  await fastify.register(actionsRoutes, { prefix: "/v1" });
  await fastify.register(sessionsRoutes, { prefix: "/v1" });
  await fastify.register(cdpRoutes, { prefix: "/v1" });
  await fastify.register(filesRoutes, { prefix: "/v1" });
  if (commands) {
    await fastify.register(commands.default, { prefix: "/v1" });
  }

  const enableLogsRoutes = opts.logging?.enableLogsRoutes ?? true;
  if (enableLogsRoutes) {
    await fastify.register(logsRoutes, { prefix: "/v1/logs" });
  }
};

export default fp<SteelBrowserConfig>(steelBrowserPlugin, {
  name: "steel-browser",
  fastify: "5.x",
});
