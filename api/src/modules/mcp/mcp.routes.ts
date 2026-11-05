// Exposes the existing browser operations through stateless Streamable HTTP.
// Credentials stay in the REST/vault flows; this module cannot send requests
// to a person or approve its own hand-off on a named agent key.
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { commandSchema } from "../../services/commands/commands.js";
import { identityVault } from "../../services/login.js";
import { scrub, scrubObject } from "../../services/vault.js";
import { getBaseUrl, getUrl } from "../../utils/url.js";
import { agentFor, suppliedKey } from "../../utils/api-key.js";
import { selectedSession } from "../sessions/sessions.controller.js";
import { getDefuddleContent } from "../../utils/scrape/readability.js";
import { BrowserEventType } from "../../types/enums.js";
import { callerTag } from "../../services/caller-outcomes.js";

const session = z.string().uuid();
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const siteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/);
const url = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }, "Use an HTTP URL without credentials");
const country = z.string().regex(/^[A-Z]{2}$/);
const actNames = new Set([
  "navigate",
  "back",
  "forward",
  "reload",
  "click",
  "dblclick",
  "hover",
  "focus",
  "type",
  "fill",
  "press",
  "keydown",
  "keyup",
  "mouse",
  "select",
  "check",
  "uncheck",
  "scroll",
  "wait",
]);
const actCommandSchema = z.discriminatedUnion(
  "command",
  commandSchema.options.filter((option) => actNames.has(option.shape.command.value)) as any,
);
const schemas = {
  browser_open: z
    .object({
      site: siteName.optional(),
      url: url.optional(),
      identity: name.optional(),
      mode: z.enum(["agent", "quiet"]).optional(),
      residential: z.union([z.boolean(), z.object({ country }).strict()]).optional(),
      caller: callerTag.default("mcp"),
    })
    .strict()
    .refine((value) => value.site || value.url, "Supply a site or URL"),
  browser_snapshot: z.object({ session, compact: z.boolean().default(true) }).strict(),
  browser_act: z
    .object({
      session,
      commands: z.array(actCommandSchema).min(1).max(50),
    })
    .strict(),
  browser_read: z
    .object({ session, format: z.enum(["markdown", "text", "html"]).default("markdown") })
    .strict(),
  browser_screenshot: z.object({ session }).strict(),
  browser_download: z
    .object({ session, url: url.optional(), ref: z.string().min(1).max(200).optional() })
    .strict()
    .refine((value) => !!value.url !== !!value.ref, "Supply one URL or element ref"),
  browser_login: z
    .object({
      session,
      identity: name.optional(),
      site: name.optional(),
      current: z.boolean().default(false),
    })
    .strict(),
  browser_handoff: z
    .object({
      session,
      reason: z.string().trim().min(1).max(1000),
      approval: z.string().uuid().optional(),
    })
    .strict(),
  browser_network: z
    .object({ session, limit: z.number().int().min(1).max(200).default(50) })
    .strict(),
  browser_close: z.object({ session }).strict(),
  fetch: z
    .object({
      url,
      site: siteName.optional(),
      residential: z.union([z.boolean(), z.object({ country }).strict()]).optional(),
      caller: callerTag.default("mcp-fetch"),
      requestId: z.string().uuid().optional(),
      timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    })
    .strict(),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  browser_open:
    "Open a browser using shared site defaults. Keep the returned session until browser_close.",
  browser_snapshot: "Read a page outline with stable element refs for subsequent actions.",
  browser_act: "Run batched navigation and native input commands. Use vault login for credentials.",
  browser_read: "Read the current page as markdown, visible text or HTML.",
  browser_screenshot:
    "Capture the page or quiet display. Protected identities refuse image capture.",
  browser_download:
    "Download a URL or click an element ref. Returns an authenticated files API URL and suggested local INBOX path; the caller copies the file before closing.",
  browser_login:
    "Run the scoped vault flow on the session identity. Local email/SMS codes use Mosaic's code-only helper; stop on credentials_rejected.",
  browser_handoff:
    "Return a noVNC link only after an admin records the owner's explicit agreement for this session and reason. Without approval, returns owner_agreement_required.",
  browser_network:
    "Read recent request metadata in agent mode. Request bodies, headers and URL queries are omitted.",
  browser_close: "Release the browser and report settled bytes and estimated residential cost.",
  fetch:
    "Read one page as markdown using the routing ladder, then release its browser. Prefer this for pages requiring no interaction.",
};

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: scrub(JSON.stringify(scrubObject(value))) }],
    ...(isError ? { isError: true } : {}),
  };
}
function metadataUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    return parsed.origin + parsed.pathname;
  } catch {
    return "[unavailable]";
  }
}

export default async function mcpRoutes(server: FastifyInstance) {
  const approvals = new Map<
    string,
    { session: string; reason: string; owner: string; expires: number }
  >();
  const validOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    // The canonical service origin comes from deployment configuration, never
    // from the caller's Host or forwarded headers.
    return origin === new URL(getBaseUrl()).origin;
  };
  const check = (req: FastifyRequest) => {
    if (!agentFor(req.raw)) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    if (!validOrigin(req))
      throw Object.assign(new Error("Origin is not allowed"), { statusCode: 403 });
  };
  const access = (req: FastifyRequest, id: string) =>
    selectedSession(server, { raw: req.raw, params: { sessionId: id } });

  server.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/handoff-approval",
    async (req) => {
      check(req);
      if (!agentFor(req.raw)?.admin)
        throw Object.assign(new Error("Admin key required to record the owner's agreement"), {
          statusCode: 403,
        });
      const browser = access(req, session.parse(req.params.sessionId));
      if (identityVault(browser.options.identity))
        throw Object.assign(new Error("Protected identity view unavailable"), { statusCode: 403 });
      const body = z
        .object({ ownerAgreed: z.literal(true), reason: schemas.browser_handoff.shape.reason })
        .strict()
        .parse(req.body);
      for (const [key, value] of approvals) if (value.expires <= Date.now()) approvals.delete(key);
      if (approvals.size >= 1000)
        throw Object.assign(new Error("Too many pending approvals"), { statusCode: 429 });
      const approval = randomUUID();
      const expires = Date.now() + 300_000;
      approvals.set(approval, {
        session: browser.id,
        reason: body.reason,
        owner: server.sessionPool.owner(browser.id)!.name,
        expires,
      });
      return { approval, session: browser.id, expiresAt: new Date(expires).toISOString() };
    },
  );

  server.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
      check(req);
      return reply
        .header("allow", "POST")
        .code(405)
        .send({ error: "Use POST for stateless Streamable HTTP" });
    },
  });

  server.post("/mcp", { bodyLimit: 2_000_000 }, async (req, reply) => {
    check(req);
    const agent = agentFor(req.raw)!;
    const key = suppliedKey(req.raw).key;
    const requestKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : randomUUID();
    const api = async (
      method: "GET" | "POST",
      endpoint: string,
      payload?: unknown,
      operation = endpoint,
    ) => {
      const response = await server.inject({
        method,
        url: endpoint,
        headers: {
          ...(key ? { "steel-api-key": key } : {}),
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
          ...(method === "POST"
            ? {
                "idempotency-key": createHash("sha256")
                  .update(requestKey + ":" + operation)
                  .digest("hex"),
              }
            : {}),
        },
        ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
      });
      const data = response.json();
      if (response.statusCode >= 400)
        throw Object.assign(
          new Error(data.message ?? data.error ?? `Browser API HTTP ${response.statusCode}`),
          {
            statusCode: response.statusCode,
            ...(response.statusCode === 408
              ? { requestId: data.requestId, reason: data.reason }
              : {}),
          },
        );
      return data;
    };
    const commands = async (id: string, list: unknown[], operation: string) => {
      let result = await api("POST", `/v1/sessions/${id}/commands`, { commands: list }, operation);
      const deadline = Date.now() + 150_000;
      while (["queued", "running"].includes(result.execution?.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = await api(
          "POST",
          `/v1/sessions/${id}/commands`,
          { commands: [{ command: "status", execution: result.execution.id }] },
          randomUUID(),
        );
      }
      if (
        result.execution?.state !== "completed" ||
        result.results?.some((value: any) => !value.ok)
      )
        throw Object.assign(
          new Error(
            result.results?.find((value: any) => value.error)?.error?.message ??
              result.execution?.error?.message ??
              "Browser command did not complete",
          ),
          { statusCode: 409 },
        );
      return result;
    };
    const protocol = new Server(
      { name: "mosaic-browser", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "Use fetch for one-page reads. Close each interactive session in finally. Use vault login; do not type credentials. A human hand-off requires the owner's agreement.",
      },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.entries(schemas).map(([tool, schema]) => ({
        name: tool,
        description: descriptions[tool as ToolName],
        inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as any,
      })),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = request.params.name as ToolName;
      const eventHash = createHash("sha256").update(`${requestKey}:${tool}:outcome`).digest("hex");
      const outcomeId = `${eventHash.slice(0, 8)}-${eventHash.slice(8, 12)}-4${eventHash.slice(
        13,
        16,
      )}-8${eventHash.slice(17, 20)}-${eventHash.slice(20, 32)}`;
      let outcomeContext: { caller: string; site?: string; sessionId?: string } = { caller: "mcp" };
      let outcomeReason: "completed" | "exception" | "auth_required" | "unobserved" | undefined;
      const run = async (): Promise<CallToolResult> => {
        try {
          if (!Object.hasOwn(schemas, tool))
            return textResult({ error: "Unknown browser tool" }, true);
          const args = schemas[tool].parse(request.params.arguments ?? {}) as any;
          if (tool === "browser_open") {
            outcomeContext = { caller: args.caller, site: args.site };
            const body = {
              ...(args.site ? { site: args.site } : {}),
              ...(args.url ? { targetUrl: args.url } : {}),
              caller: args.caller,
              ...(args.identity ? { identity: args.identity } : {}),
              ...(args.mode ? { mode: args.mode } : {}),
              ...(args.residential === false
                ? { residential: false }
                : args.residential
                ? {
                    residential:
                      typeof args.residential === "object" ? args.residential : { country: "US" },
                  }
                : {}),
            };
            const opened = await api("POST", "/v1/sessions", body, "open");
            try {
              const browser = access(req, opened.id);
              outcomeContext = {
                caller: browser.options.caller ?? "mcp",
                site: browser.options.site,
                sessionId: browser.id,
              };
              const destination = args.url ?? browser.options.targetUrl;
              if (destination)
                await commands(
                  opened.id,
                  [{ command: "navigate", url: destination }],
                  "open-navigate",
                );
              return textResult({
                session: opened.id,
                site: browser.options.site,
                mode: opened.mode,
                identity: opened.identity ?? null,
                url: destination,
                idleTimeoutMs: opened.timeout,
              });
            } catch (error) {
              await api("POST", `/v1/sessions/${opened.id}/release`, {}, "open-failed-release");
              throw error;
            }
          }
          if (tool === "fetch") {
            let result: any;
            try {
              if (args.residential === false) {
                const site = await server.sessionPool.routing.resolve(args.site ?? args.url);
                if (identityVault(site?.identity ?? undefined))
                  throw Object.assign(
                    new Error("Protected identities require their managed residential exit"),
                    { statusCode: 403 },
                  );
              }
              result = await api(
                "POST",
                "/v1/fetch",
                {
                  url: args.url,
                  ...(args.site ? { site: args.site } : {}),
                  caller: args.caller,
                  requestId: args.requestId ?? outcomeId,
                  timeoutMs: args.timeoutMs ?? 180_000,
                  retain: false,
                  ...(args.residential === false ? { maxRung: 2 } : {}),
                  ...(args.residential
                    ? {
                        startRung: 3,
                        country:
                          typeof args.residential === "object" ? args.residential.country : "US",
                      }
                    : {}),
                },
                "fetch",
              );
              if (result.status !== "ok")
                return textResult(
                  { status: result.status, rung: result.rung, attempts: result.attempts },
                  true,
                );
              const content = await getDefuddleContent(result.html, result.url ?? args.url);
              return textResult({
                status: "ok",
                url: result.url ?? args.url,
                rung: result.rung,
                markdown: content.contentMarkdown ?? "",
                attempts: result.attempts,
                residentialBytes:
                  (result.settled?.proxyTxBytes ?? 0) + (result.settled?.proxyRxBytes ?? 0),
              });
            } finally {
              if (result?.session?.id)
                await api(
                  "POST",
                  `/v1/sessions/${result.session.id}/release`,
                  {},
                  "fetch-finally-release",
                );
            }
          }
          if (tool === "browser_close") {
            const ended = await api("POST", `/v1/sessions/${args.session}/release`, {}, "close");
            outcomeContext = {
              caller: ended.caller ?? "mcp",
              site: ended.site,
              sessionId: args.session,
            };
            const residentialBytes = (ended.proxyTxBytes ?? 0) + (ended.proxyRxBytes ?? 0);
            return textResult({
              session: args.session,
              endReason: ended.endReason,
              residentialBytes,
              directBytes: ended.directBytes ?? 0,
              estimatedResidentialUSD: residentialBytes / 1_000_000_000,
              costBasis: "Evomi Core estimate at USD 1 per GB; Railway compute excluded",
            });
          }
          const browser = access(req, args.session);
          outcomeContext = {
            caller: browser.options.caller ?? "mcp",
            site: browser.options.site,
            sessionId: browser.id,
          };
          if (tool === "browser_snapshot")
            return textResult(
              await commands(
                args.session,
                [{ command: "snapshot", compact: args.compact }],
                "snapshot",
              ),
            );
          if (tool === "browser_act")
            return textResult(await commands(args.session, args.commands, "act"));
          if (tool === "browser_read")
            return textResult(
              await commands(args.session, [{ command: "get", what: args.format }], "read"),
            );
          if (tool === "browser_screenshot") {
            if (identityVault(browser.options.identity))
              throw Object.assign(new Error("Protected identity image capture unavailable"), {
                statusCode: 403,
              });
            const result = await commands(
              args.session,
              [{ command: "screenshot", format: "png" }],
              "screenshot",
            );
            return {
              content: [{ type: "image", data: result.results[0].data, mimeType: "image/png" }],
            };
          }
          if (tool === "browser_download") {
            let filename: string;
            let bytes: number;
            if (args.url) {
              const downloaded = await api(
                "POST",
                `/v1/sessions/${args.session}/download`,
                { url: args.url },
                "download",
              );
              if (downloaded.status < 200 || downloaded.status >= 300)
                throw new Error(`Download HTTP ${downloaded.status}`);
              const data = Buffer.from(downloaded.body, "base64");
              if (!data.length) throw new Error("Download returned no bytes");
              const raw = decodeURIComponent(path.posix.basename(new URL(args.url).pathname));
              filename = (
                raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "download"
              ).slice(0, 160);
              filename = `${randomUUID()}-${filename}`;
              await writeFile(path.join(browser.filesPath, filename), data, {
                flag: "wx",
                mode: 0o600,
              });
              bytes = data.length;
            } else {
              const result = await commands(
                args.session,
                [
                  { command: "click", target: args.ref },
                  { command: "wait", download: true, timeout: 50_000 },
                ],
                "download-ref",
              );
              filename = path.basename(result.results.at(-1).file);
              bytes = result.results.at(-1).bytes;
            }
            const remotePath = filename;
            const uri = getUrl(
              `v1/sessions/${args.session}/files/${remotePath
                .split("/")
                .map(encodeURIComponent)
                .join("/")}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: scrub(
                    JSON.stringify({
                      name: filename,
                      bytes,
                      suggestedInboxPath: `Source Data/-INBOX/browser-downloads/${filename}`,
                      requiresAuthentication: true,
                      copyBeforeClose: true,
                    }),
                  ),
                },
                {
                  type: "resource_link",
                  uri,
                  name: filename,
                  description:
                    "Copy this authenticated file to the suggested local INBOX path before closing the session.",
                },
              ],
            };
          }
          if (tool === "browser_login") {
            if (args.identity && args.identity !== browser.options.identity)
              throw new Error("Login identity must match the open session");
            const selectedSite = browser.options.site ?? browser.options.targetUrl;
            const site =
              args.site ??
              (selectedSite
                ? (await server.sessionPool.routing.resolve(selectedSite))?.loginSite
                : undefined) ??
              identityVault(browser.options.identity);
            if (!site) throw new Error("The site has no configured vault login");
            const result = await api(
              "POST",
              `/v1/sessions/${args.session}/login`,
              { site, current: args.current },
              "login",
            );
            outcomeReason = result.status === "ok" ? "completed" : "auth_required";
            return textResult(result, result.status !== "ok");
          }
          if (tool === "browser_handoff") {
            if (identityVault(browser.options.identity))
              throw Object.assign(new Error("Protected identity view unavailable"), {
                statusCode: 403,
              });
            const permission = args.approval ? approvals.get(args.approval) : undefined;
            if (
              !permission ||
              permission.expires <= Date.now() ||
              permission.session !== args.session ||
              permission.reason !== args.reason ||
              (!agent.admin && permission.owner !== agent.name)
            ) {
              outcomeReason = "unobserved";
              return textResult({
                status: "owner_agreement_required",
                session: args.session,
                reason: args.reason,
              });
            }
            approvals.delete(args.approval);
            return textResult({
              status: "awaiting_owner",
              session: args.session,
              noVncUrl: browser.info().noVncUrl,
              requiresAuthentication: true,
              idleTimeoutMs: browser.info().timeout,
            });
          }
          if (tool === "browser_network") {
            if (browser.options.mode !== "agent")
              throw Object.assign(new Error("Network inventory is available only in agent mode"), {
                statusCode: 409,
              });
            const result = await browser
              .getInstrumentationLogger()
              .getStorage()!
              .query({
                eventTypes: [
                  BrowserEventType.Request,
                  BrowserEventType.Response,
                  BrowserEventType.RequestFailed,
                ],
                limit: args.limit,
              });
            return textResult({
              events: result.events.map((event: any) => ({
                type: event.type,
                timestamp: event.timestamp,
                url: metadataUrl(
                  event.request?.url ?? event.response?.url ?? event.error?.url ?? "",
                ),
                ...(event.request
                  ? { method: event.request.method, resourceType: event.request.resourceType }
                  : {}),
                ...(event.response
                  ? { status: event.response.status, mimeType: event.response.mimeType }
                  : {}),
              })),
              hasMore: result.hasMore,
            });
          }
          return textResult({ error: "Unknown browser tool" }, true);
        } catch (error) {
          const message =
            error instanceof z.ZodError
              ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
              : (error as Error).message;
          return textResult(
            {
              error: message,
              statusCode: (error as any).statusCode ?? 400,
              ...((error as any).statusCode === 408
                ? { requestId: (error as any).requestId, reason: (error as any).reason }
                : {}),
            },
            true,
          );
        }
      };
      const result = await run();
      // Fetch already records its routing result. These rows describe MCP tool
      // operations, separately from the browser session's eventual end reason.
      if (tool !== "fetch") {
        try {
          await api(
            "POST",
            "/v1/caller-outcomes",
            {
              attemptId: outcomeId,
              ...outcomeContext,
              backend: "steel",
              outcome:
                outcomeReason === "unobserved" ? "unknown" : result.isError ? "failure" : "success",
              reason: outcomeReason ?? (result.isError ? "exception" : "completed"),
              fallback: false,
            },
            "tool-outcome",
          );
        } catch {
          result.content.push({
            type: "text",
            text: "Caller outcome was not recorded; this operation cannot establish migration acceptance.",
          });
        }
      }
      return result;
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.once("close", () => {
      void protocol.close();
    });
    await protocol.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
