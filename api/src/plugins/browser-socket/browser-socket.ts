import { identityVault } from "../../services/login.js";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { WebSocketServer } from "ws";
import { WebSocketRegistryService } from "../../services/websocket-registry.service.js";
import type { WebSocketHandler } from "../../types/websocket.js";
import { defaultHandlers } from "./handlers/index.js";
import { isAuthorized, agentFor, browserOriginAllowed } from "../../utils/api-key.js";
export interface BrowserSocketOptions {
  customHandlers?: WebSocketHandler[];
}
const plugin: FastifyPluginAsync<BrowserSocketOptions> = async (server, options) => {
  const wss = new WebSocketServer({ noServer: true });
  const registry = new WebSocketRegistryService();
  for (const handler of [...defaultHandlers, ...(options.customHandlers ?? [])])
    registry.registerHandler(handler);
  server.server.on("upgrade", async (request, socket, head) => {
    if (!browserOriginAllowed(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!isAuthorized(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const match = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/(cdp|cast|logs|recording|pageId|vnc)$/,
      );
      const session = server.sessionPool.get(
        match?.[1] ?? url.searchParams.get("sessionId") ?? undefined,
      );
      const agent = agentFor(request);
      if (!agent?.admin && server.sessionPool.owner(session.id)?.name !== agent?.name) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (session.options.mode === "quiet" && match && !["cdp", "vnc"].includes(match[2])) {
        socket.end(
          "HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\nUse this session's noVNC view",
        );
        return;
      }
      const params = Object.fromEntries(url.searchParams);
      const handler = registry.matchHandler(match ? `/v1/sessions/${match[2]}` : url.pathname);
      if (match?.[2] === "vnc" && identityVault(session.options.identity)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nProtected identity");
        return;
      }
      if (match?.[2] === "vnc") {
        session.clients++;
        session.touch();
        socket.once("close", () => {
          session.clients--;
          session.touch();
        });
        wss.handleUpgrade(request, socket, head, (ws) => session.display.attach(ws));
      } else if (handler) {
        session.clients++;
        session.touch();
        socket.once("close", () => {
          session.clients--;
          session.touch();
        });
        await handler.handler(request, socket, head, { fastify: server, wss, params, session });
      } else if (match?.[2] === "cdp" || url.pathname === "/")
        await session.proxyWebSocket(request, socket, head);
      else socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    } catch {
      socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
    }
  });
  server.addHook("onClose", async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
};
export default fp(plugin, { name: "browser-websocket" });
