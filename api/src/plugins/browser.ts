import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { SessionPool } from "../services/session-pool.js";
const browserInstancePlugin: FastifyPluginAsync = async (server) => {
  server.decorate("sessionPool", new SessionPool(server.log));
  await server.sessionPool.proxies?.ready;
  server.addHook("onClose", async () => {
    await server.sessionPool.drain(0);
  });
};
export default fp(browserInstancePlugin, { name: "browser-pool" });
