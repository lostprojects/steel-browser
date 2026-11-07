import { IncomingMessage } from "http";
import { Duplex } from "stream";
import { WebSocket } from "ws";
import { EmitEvent } from "../../../types/enums.js";
import { WebSocketHandler, WebSocketHandlerContext } from "../../../types/websocket.js";
import { scrubObject } from "../../../services/vault.js";

function handleLogsWebSocket(context: WebSocketHandlerContext, ws: WebSocket) {
  const { fastify } = context;
  const logger = context.session.getInstrumentationLogger();

  const messageHandler = (payload: unknown, metadata: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify([scrubObject({ ...metadata, ...(payload as object) })]));
    }
  };

  logger.on?.(EmitEvent.Log, messageHandler);

  ws.on("error", (err) => {
    fastify.log.error({ err }, "Logs WebSocket error");
  });

  ws.on("close", () => {
    fastify.log.info("Logs WebSocket connection closed");
    logger.off?.(EmitEvent.Log, messageHandler);
  });
}

export const logsHandler: WebSocketHandler = {
  path: "/v1/sessions/logs",
  handler: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    context: WebSocketHandlerContext,
  ) => {
    context.fastify.log.info("Connecting to logs...");
    context.wss.handleUpgrade(request, socket, head, (ws) => handleLogsWebSocket(context, ws));
  },
};
