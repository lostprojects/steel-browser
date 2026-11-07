// Authenticated routing is selected exclusively from the credential's user.
// No request header, path, query or administrator option may select another user.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { Transform } from "node:stream";
import { z } from "zod";
import { GatewayError, GatewayStore, registration, type Principal } from "./store.js";
import { connectPage, connectScript, connectStyle } from "./connect.js";
import { GatewayOAuth } from "./oauth.js";
import { configuredLibrary, callLibrary } from "../services/library/service.js";
import { libraryCommand } from "../services/library/http.js";
import type { LibraryService } from "../services/library/contracts.js";
import { attachmentContentDisposition } from "../utils/content-disposition.js";
import { PublicError } from "../utils/public-error.js";
import { membershipId } from "../services/organization.js";
import {
  principalHeader,
  signPrincipal,
  connectedPrincipal,
} from "../services/gateway-principal.js";

const forwarded = new Set([
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "range",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
  "idempotency-key",
  "steel-session-id",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const returned = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "content-encoding",
  "content-range",
  "accept-ranges",
  "etag",
  "x-content-sha256",
  "cache-control",
  "last-modified",
  "location",
  "mcp-session-id",
]);
const secretBody = z.string().min(1).max(512);
const jsonHeaders = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const bearer = (req: IncomingMessage) => {
  const header = req.headers["steel-api-key"];
  return typeof header === "string"
    ? header
    : req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
};
const cookie = (req: IncomingMessage, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + "="))
    ?.slice(name.length + 1);
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage, maxBytes = 256_000) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new GatewayError(415, "Send application/json");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new GatewayError(413, "Request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new GatewayError(400, "Invalid JSON");
  }
}
function backendUrl(value: string, development: boolean) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname.endsWith(".railway.internal") ||
          (development && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    )
  )
    throw new GatewayError(400, "Worker must use an HTTPS or Railway private origin");
  return url.origin;
}

export function createGateway(
  store: GatewayStore,
  publicOrigin: string,
  development = false,
  library?: LibraryService,
) {
  const origin = new URL(publicOrigin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(
        development &&
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  )
    throw new Error("Gateway requires a canonical HTTPS origin");
  const cookieName = origin.protocol === "https:" ? "__Host-steel_session" : "steel_session_dev";
  const oauth = new GatewayOAuth(store, origin.origin);
  const cookieHeader = (value: string, age = 43200) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${origin.protocol === "https:" ? "; Secure" : ""}`;
  const connections = new Set<{ principal: Principal; close: () => void }>();
  store.on("changed", () => {
    for (const item of connections) if (!store.active(item.principal)) item.close();
  });
  const attempts = new Map<string, { count: number; reset: number }>();
  let libraryRequests = 0;
  function limit(req: IncomingMessage) {
    const now = Date.now(),
      address = req.socket.remoteAddress ?? "unknown";
    for (const [key, entry] of attempts) if (entry.reset < now) attempts.delete(key);
    if (attempts.size >= 10000 && !attempts.has(address))
      throw new GatewayError(429, "Try again shortly");
    const entry = attempts.get(address) ?? { count: 0, reset: now + 60000 };
    attempts.set(address, entry);
    if (++entry.count > 120) throw new GatewayError(429, "Try again shortly");
  }
  function access(req: IncomingMessage) {
    if (
      req.headers["x-toolstack-org-id"] !== undefined &&
      req.headers["x-toolstack-org-id"] !== store.organization.id
    )
      throw new GatewayError(403, "Organization unavailable");
    const supplied = bearer(req);
    // An invalid explicit key cannot fall back to a browser cookie.
    const principal =
      supplied !== undefined ? store.authenticate(supplied) : store.cookie(cookie(req, cookieName));
    if (!principal) throw new GatewayError(401, "Authentication required");
    if (principal.grantId && principal.resource !== new URL("/mcp", origin).href)
      throw new GatewayError(401, "Connection belongs to another Toolstack resource");
    if (
      !supplied &&
      !["GET", "HEAD"].includes(req.method ?? "GET") &&
      req.headers.origin !== origin.origin
    )
      throw new GatewayError(403, "Use the service origin for browser requests");
    return principal;
  }
  function checkOrigin(req: IncomingMessage) {
    if (
      (req.headers.origin && req.headers.origin !== origin.origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw new GatewayError(403, "Origin is not allowed");
  }
  function track(principal: Principal, close: () => void) {
    const entry = { principal, close };
    connections.add(entry);
    const timer = Number.isFinite(principal.expires)
      ? setTimeout(close, Math.max(1, principal.expires - Date.now()))
      : undefined;
    timer?.unref();
    return () => {
      connections.delete(entry);
      if (timer) clearTimeout(timer);
    };
  }
  function target(req: IncomingMessage, principal: Principal) {
    if ([...connections].filter((item) => item.principal.userId === principal.userId).length >= 128)
      throw new GatewayError(429, "Too many connections");
    const backend = store.backend(principal);
    const url = new URL(req.url!, origin);
    url.searchParams.delete("apiKey");
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers))
      if (forwarded.has(key) && value !== undefined) headers[key] = value;
    headers["steel-api-key"] = backend.key;
    headers[principalHeader] = signPrincipal(principal, backend.key);
    if (req.headers.origin) headers.origin = origin.origin;
    return { backend: new URL(backend.url), path: url.pathname + url.search, headers };
  }
  const server = http.createServer(
    { maxHeaderSize: 16384, requestTimeout: 330000, headersTimeout: 30000 },
    async (req, res) => {
      try {
        await store.ready;
        res.setHeader("cache-control", "no-store");
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("x-content-type-options", "nosniff");
        if (origin.protocol === "https:")
          res.setHeader("strict-transport-security", "max-age=31536000");
        const url = new URL(req.url!, origin),
          route = url.pathname,
          method = req.method;
        if (
          route === "/internal/library" ||
          route === "/v1/library" ||
          route.startsWith("/v1/library/")
        ) {
          if (route === "/internal/library") {
            if (!store.libraryActorForWorker(bearer(req)))
              throw new GatewayError(401, "Worker authorization required");
          } else access(req);
          if (libraryRequests >= 4) {
            res.setHeader("retry-after", "1");
            throw new GatewayError(429, "The content library is busy. Retry shortly.");
          }
          libraryRequests++;
          let held = true;
          const release = () => {
            if (held) {
              held = false;
              libraryRequests--;
            }
          };
          res.once("finish", release);
          res.once("close", release);
        }
        if (route === "/internal/library" && method === "POST") {
          const input = z
            .object({
              principal: connectedPrincipal.optional(),
              command: z
                .object({
                  action: z.enum([
                    "list",
                    "get",
                    "history",
                    "create",
                    "update",
                    "share",
                    "archive",
                    "upload",
                    "file",
                    "file_info",
                  ]),
                  id: z.string().uuid().optional(),
                  version: z.number().int().positive().optional(),
                  input: z.unknown().optional(),
                })
                .strict(),
            })
            .strict()
            .parse(await body(req, 24 * 1024 * 1024));
          const actor = store.libraryActorForWorker(bearer(req), input.principal);
          if (!actor) throw new GatewayError(401, "Worker authorization required");
          return send(res, 200, await callLibrary(library, actor, input.command));
        }
        if (route === "/internal/principal" && method === "POST") {
          const active = store.principalActiveForWorker(
            bearer(req),
            connectedPrincipal.parse(await body(req)),
          );
          return send(res, 200, { active });
        }
        if (oauth.routes.has(route.replace(/\/$/, ""))) return oauth.handler(req, res);
        const browserResource =
          route === "/mcp" ||
          /^\/v1\/sessions\/[a-f0-9-]{36}\/(?:transfers|files)(?:\/|$)/.test(route);
        if (browserResource) {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("access-control-allow-methods", "GET, HEAD, POST, DELETE, OPTIONS");
          res.setHeader(
            "access-control-allow-headers",
            "Authorization, steel-api-key, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Range, If-Match",
          );
          res.setHeader(
            "access-control-expose-headers",
            "WWW-Authenticate, Mcp-Session-Id, X-Content-SHA256, ETag, Content-Range, Accept-Ranges",
          );
          if (method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }
          res.setHeader(
            "www-authenticate",
            `Bearer resource_metadata="${origin.origin}/.well-known/oauth-protected-resource/mcp", scope="browser"`,
          );
        }
        const publicNavigation =
          method === "GET" &&
          req.headers["sec-fetch-mode"] === "navigate" &&
          req.headers["sec-fetch-dest"] === "document" &&
          (["/connect", "/account"].includes(route) ||
            /^\/downloads\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(route));
        if (!publicNavigation && !(browserResource && bearer(req))) checkOrigin(req);
        if (url.searchParams.has("apiKey"))
          throw new GatewayError(
            400,
            "Use Authorization: Bearer or /connect; keys in URLs are refused",
          );
        if (["/health", "/v1/health"].includes(route) && method === "GET")
          return send(res, 200, { status: "ok", role: "gateway" });
        if (
          ["/connect", "/account", "/connect.js", "/connect.css"].includes(route) &&
          method === "GET"
        ) {
          res.setHeader(
            "content-security-policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
          );
          res.setHeader(
            "content-type",
            route.endsWith(".js")
              ? "text/javascript"
              : route.endsWith(".css")
                ? "text/css"
                : "text/html; charset=utf-8",
          );
          return res.end(
            route.endsWith(".js")
              ? connectScript
              : route.endsWith(".css")
                ? connectStyle
                : connectPage,
          );
        }
        if (route === "/auth/login" && method === "POST") {
          limit(req);
          const { key } = z
            .object({ key: secretBody })
            .strict()
            .parse(await body(req));
          const principal = store.authenticate(key);
          if (!principal) throw new GatewayError(401, "Key unavailable");
          res.setHeader("set-cookie", cookieHeader(store.login(principal)));
          return send(res, 200, { userId: principal.userId });
        }
        if (route === "/auth/claim" && method === "POST") {
          limit(req);
          const { invitation } = z
            .object({ invitation: secretBody })
            .strict()
            .parse(await body(req));
          const result = await store.claim(invitation);
          res.setHeader("set-cookie", cookieHeader(store.login(store.authenticate(result.key)!)));
          return send(res, 201, result);
        }
        if (route === "/internal/shared" && method === "GET") {
          const snapshot = store.sharedForWorker(bearer(req));
          if (!snapshot) throw new GatewayError(401, "Authentication required");
          return send(res, 200, snapshot);
        }
        let principal: Principal;
        try {
          principal = access(req);
        } catch (error) {
          if (
            (route === "/" ||
              route.startsWith("/ui/") ||
              /^\/downloads\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(route)) &&
            method === "GET" &&
            (error as GatewayError).statusCode === 401
          ) {
            res.writeHead(303, { location: "/connect?next=" + encodeURIComponent(route) });
            return res.end();
          }
          limit(req);
          throw error;
        }
        if (
          principal.grantId &&
          !(
            route === "/mcp" ||
            /^\/v1\/sessions\/[a-f0-9-]{36}\/(?:transfers|files)(?:\/|$)/.test(route)
          )
        )
          throw new GatewayError(403, "This connection permits browser tools and files only");
        const authorizationRequest = route.match(/^\/auth\/authorization\/([A-Za-z0-9_-]{43})$/);
        if (authorizationRequest) {
          const browserCookie = cookie(req, cookieName);
          const browser = store.cookie(browserCookie);
          if (!browserCookie || !browser || browser.grantId)
            throw new GatewayError(401, "Sign in through your browser");
          if (method === "GET")
            return send(res, 200, oauth.review(authorizationRequest[1], browser, browserCookie));
          if (method === "POST") {
            if (req.headers.origin !== origin.origin)
              throw new GatewayError(403, "Approve connections from the Toolstack page");
            const { csrf, allow } = z
              .object({ csrf: secretBody, allow: z.boolean() })
              .strict()
              .parse(await body(req));
            return send(
              res,
              200,
              oauth.approve(authorizationRequest[1], csrf, allow, browser, browserCookie),
            );
          }
          throw new GatewayError(405, "Use GET or POST");
        }
        if (route === "/auth/logout" && method === "POST") {
          store.logout(cookie(req, cookieName));
          res.setHeader("set-cookie", cookieHeader("", 0));
          return send(res, 200, { signedOut: true });
        }
        if (route === "/v1/library" || route.startsWith("/v1/library/")) {
          const parsed = libraryCommand(
            method ?? "GET",
            url,
            ["POST", "PUT"].includes(method ?? "") ? await body(req, 24 * 1024 * 1024) : undefined,
          );
          const value = await callLibrary(library, principal, parsed.command);
          if (!parsed.binary) return send(res, 200, value);
          res.writeHead(200, {
            ...jsonHeaders,
            "content-type": "application/octet-stream",
            "content-disposition": attachmentContentDisposition(value.name),
            "content-length": value.bytes,
            "x-content-sha256": value.sha256,
            etag: `"${value.sha256}"`,
          });
          return res.end(method === "HEAD" ? undefined : Buffer.from(value.base64, "base64"));
        }
        if (route === "/v1/organization" && method === "GET")
          return send(res, 200, {
            organization: store.organization,
            membership: {
              orgId: principal.orgId,
              id: principal.membershipId,
              userId: principal.userId,
              role: principal.userId === "owner" ? "owner" : "member",
            },
          });
        if (route === "/v1/me" && method === "GET")
          return send(res, 200, { userId: principal.userId, admin: principal.admin });
        if (route === "/v1/me/connections" && method === "GET")
          return send(res, 200, store.oauthConnections(principal));
        const connectionRoute = route.match(/^\/v1\/me\/connections\/([a-f0-9-]{36})$/);
        if (connectionRoute && method === "DELETE")
          return send(res, 200, await store.revokeOAuth(principal, connectionRoute[1]));
        if (route === "/v1/me/keys" && method === "GET")
          return send(res, 200, store.keys(principal));
        if (route === "/v1/me/keys" && method === "POST") {
          const { label } = z
            .object({ label: z.string().trim().min(1).max(80) })
            .strict()
            .parse(await body(req));
          return send(res, 201, await store.createKey(principal, label));
        }
        const keyRoute = route.match(/^\/v1\/me\/keys\/([a-f0-9-]{36})$/);
        if (keyRoute && method === "DELETE")
          return send(res, 200, await store.revoke(principal, keyRoute[1]));
        if (route.startsWith("/v1/team/")) {
          if (!principal.admin) throw new GatewayError(403, "Owner key required");
          if (route === "/v1/team/users" && method === "GET") return send(res, 200, store.users());
          if (route === "/v1/team/users" && method === "POST") {
            const input = registration.parse(await body(req));
            input.backendUrl = backendUrl(input.backendUrl, development);
            if (input.backendUrl === origin.origin)
              throw new GatewayError(400, "Gateway cannot be a worker");
            // Verify a separately provisioned worker before issuing an invitation.
            const response = await fetch(new URL("/v1/worker", input.backendUrl), {
              headers: { "steel-api-key": input.backendKey },
              redirect: "error",
              signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) throw new GatewayError(400, "Worker verification failed");
            const info = (await response.json()) as Record<string, unknown>;
            if (
              info.userId !== input.id ||
              info.orgId !== store.organization.id ||
              info.membershipId !== membershipId(store.organization.id, input.id) ||
              info.publicOrigin !== origin.origin ||
              info.sharedOrigin !== origin.origin ||
              info.sharedKeyHash !== createHash("sha256").update(input.sharedKey).digest("hex")
            )
              throw new GatewayError(
                400,
                "Worker identity or gateway configuration does not match",
              );
            const result = await store.register(input);
            return send(res, 201, {
              ...result,
              ...(result.invitation
                ? { inviteUrl: `${origin.origin}/connect#invite=${result.invitation}` }
                : {}),
            });
          }
          const userRoute = route.match(/^\/v1\/team\/users\/([A-Za-z0-9_-]+)\/(invite|access)$/);
          if (userRoute && method === "POST") {
            if (userRoute[2] === "invite") {
              const result = await store.invite(userRoute[1]);
              return send(res, 201, {
                ...result,
                inviteUrl: `${origin.origin}/connect#invite=${result.invitation}`,
              });
            }
            const { disabled } = z
              .object({ disabled: z.boolean() })
              .strict()
              .parse(await body(req));
            return send(res, 200, await store.disable(userRoute[1], disabled));
          }
          throw new GatewayError(404, "Unknown team operation");
        }
        if (route === "/v1/global" && method === "GET")
          return send(res, 200, store.sharedMetadata(principal));
        if (route.startsWith("/v1/global/")) {
          if (!principal.admin) throw new GatewayError(403, "Owner key required");
          const grantRoute = route.match(/^\/v1\/global\/vault\/([A-Za-z0-9_-]+)\/grants$/);
          if (grantRoute && method === "PUT")
            return send(res, 200, await store.putSharedGrants(grantRoute[1], await body(req)));
          const match = route.match(/^\/v1\/global\/(vault|sites)\/([A-Za-z0-9_.-]+)$/);
          if (match && ["PUT", "DELETE"].includes(method ?? "")) {
            const kind = match[1] as "vault" | "sites";
            return send(
              res,
              200,
              method === "PUT"
                ? await store.putShared(kind, match[2], await body(req))
                : await store.deleteShared(kind, match[2]),
            );
          }
          throw new GatewayError(404, "Unknown global store operation");
        }
        if (
          route.startsWith("/internal/") ||
          route.startsWith("/auth/") ||
          route.startsWith("/v1/me") ||
          route === "/v1/worker"
        )
          throw new GatewayError(404, "Unknown operation");
        const endpoint = target(req, principal);
        const upstream = (endpoint.backend.protocol === "https:" ? https : http).request(
          endpoint.backend,
          {
            method,
            path: endpoint.path,
            headers: endpoint.headers,
            timeout: 330000,
          },
        );
        const untrack = track(principal, () => {
          upstream.destroy();
          res.destroy();
        });
        res.once("close", () => {
          untrack();
          upstream.destroy();
        });
        req.once("aborted", () => upstream.destroy());
        req.once("error", () => upstream.destroy());
        upstream.once("timeout", () => upstream.destroy());
        upstream.once("error", () => {
          untrack();
          if (!res.headersSent && !res.destroyed)
            send(res, 502, { error: "Your browser worker is unavailable" });
          else res.destroy();
        });
        upstream.once("response", (response) => {
          if (!store.active(principal)) {
            upstream.destroy();
            res.destroy();
            return;
          }
          res.statusCode = response.statusCode ?? 502;
          for (const [key, value] of Object.entries(response.headers))
            if (returned.has(key) && value !== undefined) res.setHeader(key, value);
          response.once("error", () => res.destroy());
          response.pipe(res);
        });
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > 100 * 1024 * 1024 ? new Error("Request too large") : null, chunk);
          },
        });
        bounded.once("error", () => {
          upstream.destroy();
          if (!res.headersSent) send(res, 413, { error: "Request is too large" });
          else res.destroy();
        });
        req.pipe(bounded).pipe(upstream);
      } catch (error) {
        const status =
          error instanceof GatewayError || error instanceof PublicError
            ? error.statusCode
            : error instanceof z.ZodError
              ? 400
              : 503;
        const message =
          error instanceof GatewayError || error instanceof PublicError
            ? error.message
            : error instanceof z.ZodError
              ? "Invalid request"
              : "Operation unavailable";
        if (!res.headersSent) send(res, status, { error: message });
        else res.destroy();
      }
    },
  );
  server.on("upgrade", (req, socket, head) => {
    try {
      checkOrigin(req);
      const principal = access(req);
      const route = new URL(req.url!, origin);
      if (route.searchParams.has("apiKey")) throw new GatewayError(400, "Use a key header");
      if (!(
        route.pathname === "/" ||
        /^\/v1\/sessions\/(?:[a-f0-9-]{36}\/)?(?:cdp|cast|logs|vnc)$/.test(route.pathname)
      ))
        throw new GatewayError(404, "Unknown socket");
      const endpoint = target(req, principal);
      const headers = { ...endpoint.headers, connection: "Upgrade", upgrade: "websocket" };
      for (const name of [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
      ])
        if (req.headers[name]) headers[name] = req.headers[name]!;
      const upstream = (endpoint.backend.protocol === "https:" ? https : http).request(
        endpoint.backend,
        { path: endpoint.path, headers, timeout: 10000 },
      );
      let peer: Duplex | undefined;
      const untrack = track(principal, () => {
        peer?.destroy();
        upstream.destroy();
        socket.destroy();
      });
      socket.once("close", () => {
        untrack();
        peer?.destroy();
        upstream.destroy();
      });
      socket.on("error", () => {
        peer?.destroy();
        upstream.destroy();
      });
      upstream.once("error", () => socket.destroy());
      upstream.once("timeout", () => {
        upstream.destroy();
        socket.destroy();
      });
      upstream.once("response", () => {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        upstream.destroy();
      });
      upstream.once("upgrade", (response, remote, remoteHead) => {
        peer = remote;
        remote.setTimeout(0);
        if (!store.active(principal)) {
          remote.destroy();
          socket.destroy();
          return;
        }
        const responseHeaders = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
        ];
        for (const name of [
          "sec-websocket-accept",
          "sec-websocket-protocol",
          "sec-websocket-extensions",
        ]) {
          const value = response.headers[name];
          if (typeof value === "string") responseHeaders.push(`${name}: ${value}`);
        }
        socket.write(responseHeaders.join("\r\n") + "\r\n\r\n");
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        remote.once("error", () => socket.destroy());
        remote.once("close", () => socket.destroy());
        socket.pipe(remote).pipe(socket);
      });
      upstream.end();
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("close", () => {
    for (const item of connections) item.close();
  });
  return server;
}

export async function startGateway() {
  const store = new GatewayStore(
    process.env.GATEWAY_STORE_PATH ?? "/data/gateway.enc",
    process.env.GATEWAY_STORE_KEY ?? "",
    process.env.STEEL_API_KEY ?? "",
  );
  await store.ready;
  const library = configuredLibrary();
  await library?.ready;
  const server = createGateway(
    store,
    process.env.STEEL_PUBLIC_ORIGIN ?? "",
    process.env.NODE_ENV !== "production",
    library,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "0.0.0.0", resolve);
  });
  console.info("Toolstack team gateway listening");
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      server.close(() => {
        void (library?.close() ?? Promise.resolve()).then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
      server.emit("close");
      setTimeout(() => process.exit(0), 10000).unref();
    });
}
