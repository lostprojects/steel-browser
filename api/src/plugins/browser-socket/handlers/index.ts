export { logsHandler } from "./logs.handler.js";
export { castHandler } from "./cast.handler.js";

import { WebSocketHandler } from "../../../types/websocket.js";
import { logsHandler } from "./logs.handler.js";
import { castHandler } from "./cast.handler.js";

export const defaultHandlers: WebSocketHandler[] = [logsHandler, castHandler];
