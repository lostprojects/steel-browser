import fastifyStatic from "@fastify/static";
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";

export interface UIPluginOptions {
  uiDistPath?: string;
  uiPrefix?: string;
}

const uiPlugin: FastifyPluginAsync<UIPluginOptions> = async (fastify, opts) => {
  const uiDistPath = opts.uiDistPath || path.join(process.cwd(), "ui/dist");
  const uiPrefix = opts.uiPrefix || "/ui";

  const externalOrigin = process.env.TOOLSTACK_UI_ORIGIN;
  if (externalOrigin) {
    const upstream = new URL(externalOrigin);
    if (
      !["http:", "https:"].includes(upstream.protocol) ||
      upstream.username ||
      upstream.password ||
      upstream.pathname !== "/" ||
      upstream.search ||
      upstream.hash
    )
      throw new Error("TOOLSTACK_UI_ORIGIN must be an HTTP origin without credentials or a path");
    // Authentication and URL-key removal run in the API's existing onRequest
    // hook. The private static service receives no credentials or query strings.
    const serveDashboard = async (request: FastifyRequest, reply: FastifyReply) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      timeout.unref();
      reply.raw.once("close", () => {
        clearTimeout(timeout);
        controller.abort();
      });
      try {
        const pathname = new URL(request.url, "http://localhost").pathname;
        const target = new URL(upstream);
        target.pathname = pathname;
        const headers: Record<string, string> = { "accept-encoding": "identity" };
        for (const name of ["if-none-match", "if-modified-since"]) {
          const value = request.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        const response = await fetch(target, {
          method: request.method,
          headers,
          signal: controller.signal,
          redirect: "manual",
        });
        clearTimeout(timeout);
        reply.code(response.status);
        for (const name of ["content-type", "cache-control", "etag", "last-modified", "location"]) {
          const value = response.headers.get(name);
          if (value) reply.header(name, value);
        }
        return reply.send(
          response.body
            ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
            : undefined,
        );
      } catch {
        clearTimeout(timeout);
        return reply.code(502).send({ error: "Dashboard unavailable" });
      }
    };
    fastify.get(uiPrefix, serveDashboard);
    fastify.get(`${uiPrefix}/*`, serveDashboard);
    fastify.get("/", async (request, reply) => {
      if (request.headers["user-agent"]?.includes("Mozilla")) return reply.redirect(uiPrefix);
      return { message: "Toolstack API", ui: uiPrefix };
    });
    fastify.log.info("Dashboard served by the separate private UI service");
    return;
  }

  if (!fs.existsSync(uiDistPath)) {
    fastify.log.info("UI dist not found, skipping UI serving");
    return;
  }

  fastify.log.info(`UI plugin activated: serving from ${uiDistPath} at ${uiPrefix}`);

  await fastify.register(fastifyStatic, {
    root: uiDistPath,
    prefix: uiPrefix,
    decorateReply: true,
  });

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const userAgent = request.headers["user-agent"];

    // If it's a browser, redirect to UI
    if (userAgent && userAgent.includes("Mozilla")) {
      return reply.redirect(uiPrefix);
    }

    return { message: "Toolstack API", ui: uiPrefix };
  });

  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;
    if (url.startsWith(uiPrefix)) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  fastify.log.info("UI plugin registered successfully");
};

export default fp<UIPluginOptions>(uiPlugin, {
  name: "ui-plugin",
  fastify: "5.x",
});
