import vaultRoutes from "./modules/sessions/vault.routes.js";
import { vault, scrub, scrubObject } from "./services/vault.js";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { healthRoutes } from "./modules/sessions/health.js";
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
import { actionsRoutes, cdpRoutes, filesRoutes, logsRoutes, sessionsRoutes } from "./routes.js";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import routingRoutes from "./modules/sessions/routing.routes.js";
import mcpRoutes from "./modules/mcp/mcp.routes.js";
import downloadPages from "./modules/files/download-page.js";
import { WebSocketHandler } from "./types/websocket.js";
import { LogStorage } from "./services/cdp/instrumentation/storage/log-storage.interface.js";
import type { Toolkit } from "./services/toolkits/registry.js";
import type { NativeApiToolkit } from "./services/toolkits/native-api.js";
import connectionRoutes from "./modules/sessions/connections.routes.js";
import { browserApplication } from "./services/browser-application.js";
import { configuredLibrary } from "./services/library/service.js";
import type { LibraryService } from "./services/library/contracts.js";
import { libraryRoutes } from "./modules/application/library.routes.js";
export type { Toolkit, ToolkitTool, ToolContext } from "./services/toolkits/registry.js";
export { PublicError } from "./utils/public-error.js";
export { nativeApiToolkit, type NativeApiToolkit } from "./services/toolkits/native-api.js";
export type { ApiAction, ProviderReply } from "./services/api-execution.js";
export { apiActionInput, apiConnectionId } from "./services/toolkits/api-input.js";
export type { Workflow } from "./services/toolkits/workflows.js";
export { contentAccess, type ContentAccess } from "./services/content-access.js";
export type {
  BrowserConnection,
  VaultConnection,
  ApiConnection,
  Connection,
  ConnectionCatalog,
  ConnectionPage,
} from "./services/connections.js";

// We need to redeclare any decorators from within the plugin that we want to expose
declare module "fastify" {
  interface FastifyInstance {
    steelBrowserConfig: ToolstackConfig;
    contentLibrary?: LibraryService;
  }

  interface LogStorageInterface extends LogStorage {}
}

export interface ToolstackConfig {
  // Trusted server-side extensions; never populate from an agent's request body.
  toolkits?: readonly Toolkit[];
  apiToolkits?: readonly NativeApiToolkit[];
  contentLibrary?: LibraryService;
  mcpToolExposure?: "all" | "discovery";
  fileStorage?: {
    maxSizePerSession?: number;
  };
  customWsHandlers?: WebSocketHandler[];
  logging?: {
    enableLogsRoutes?: boolean;
  };
}

// Compatibility type for existing server-side integrations.
export type SteelBrowserConfig = ToolstackConfig;

const toolstackPlugin: FastifyPluginAsync<ToolstackConfig> = async (fastify, opts) => {
  fastify.decorate("steelBrowserConfig", opts);
  const library = opts.contentLibrary ?? configuredLibrary();
  await library?.ready;
  fastify.decorate("contentLibrary", library);
  if (library) fastify.addHook("onClose", async () => library.close());
  await vault.ready;
  fastify.addHook("preSerialization", async (_req, _reply, payload) => scrubObject(payload));
  fastify.addHook("onSend", async (_req, reply, payload) => {
    const type = String(reply.getHeader("content-type") ?? "");
    if (typeof payload === "string" && /json|text|javascript/.test(type)) return scrub(payload);
    return payload;
  });
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
  await fastify.sessionPool.connectionStore.ready;
  fastify.addHook("preClose", async () => browserApplication(fastify.sessionPool).closeApi());
  await fastify.register(browserWebSocket, {
    customHandlers: opts.customWsHandlers,
  });
  await fastify.register(customBodyParser);

  await healthRoutes(fastify);
  if (existsSync("/usr/share/novnc"))
    await fastify.register(fastifyStatic, {
      root: "/usr/share/novnc",
      prefix: "/v1/novnc/",
      decorateReply: false,
    });
  // Routes
  const commands = env.ENABLE_COMMANDS_API
    ? await import("./modules/commands/commands.routes.js")
    : null;
  await fastify.register(actionsRoutes, { prefix: "/v1" });
  await fastify.register(sessionsRoutes, { prefix: "/v1" });
  await fastify.register(routingRoutes, { prefix: "/v1" });
  await fastify.register(vaultRoutes, { prefix: "/v1" });
  await fastify.register(connectionRoutes, { prefix: "/v1" });
  await libraryRoutes(fastify);
  await fastify.register(cdpRoutes, { prefix: "/v1" });
  await fastify.register(filesRoutes, { prefix: "/v1" });
  await fastify.register(downloadPages);
  if (commands) {
    await fastify.register(commands.default, { prefix: "/v1" });
  }

  const enableLogsRoutes = opts.logging?.enableLogsRoutes ?? true;
  if (enableLogsRoutes) {
    await fastify.register(logsRoutes, { prefix: "/v1/logs" });
  }
  await fastify.register(mcpRoutes);
};

export default fp<ToolstackConfig>(toolstackPlugin, {
  name: "toolstack",
  fastify: "5.x",
});
