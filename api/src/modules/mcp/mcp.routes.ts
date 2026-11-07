import { browserApplication } from "../../services/browser-application.js";
// Exposes the existing browser operations through stateless Streamable HTTP.
// Credentials stay in the REST/vault flows; this module cannot send requests
// to a person or approve its own hand-off on a named agent key.
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CommandRequest } from "../../services/commands/commands.js";
import { identityVault } from "../../services/login.js";
import { agentFor, browserOriginAllowed } from "../../utils/api-key.js";
import { selectedSession, selectedTransfers } from "../sessions/sessions.controller.js";
import { getDefuddleContent } from "../../utils/scrape/readability.js";
import { stripBase64Images } from "../../utils/scrape/stripBase64Images.js";
import { DEFAULT_TEXT_LIMIT, textPage } from "../../utils/text.js";
import { scrub } from "../../services/vault.js";
import { BrowserEventType } from "../../types/enums.js";
import { env } from "../../env.js";

import { schemas, descriptions, textResult, commandFailed } from "./tools.js";
import { ToolRegistry, type ToolContext } from "../../services/toolkits/registry.js";
import { callRegisteredTool, discoveryDefinitions } from "./discovery.js";
import type { ToolName } from "./tools.js";
import { commandResult, deliveryResult, scrubToolMetadata } from "./output.js";
import { connectionToolkit } from "./connections.js";
import { apiToolkit } from "./api.js";
import { builtInApiToolkits } from "../../services/toolkits/builtins.js";
import { nativeApiToolkit } from "../../services/toolkits/native-api.js";
import { applicationRoutes } from "../application/application.routes.js";
import { workflowToolkit } from "./workflows.js";
import { verifyConnection } from "../../services/toolkits/verify-connection.js";
import { libraryToolkit } from "./library.js";

interface BrowserToolContext extends ToolContext {
  request: FastifyRequest;
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
  const application = browserApplication(server.sessionPool);
  const approvals = new Map<
    string,
    { session: string; reason: string; owner: string; expires: number }
  >();
  const check = (req: FastifyRequest) => {
    if (!agentFor(req.raw)) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    if (!browserOriginAllowed(req.raw))
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
      const browser = access(req, schemas.browser_close.shape.session.parse(req.params.sessionId));
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

  async function executeBrowser(tool: ToolName, args: any, context: BrowserToolContext) {
    const req = context.request;
    const agent = context.agent;
    let requestKey = context.requestId;
    if (typeof args.idempotencyKey === "string") requestKey = args.idempotencyKey;
    const appContext = (operation: string, idempotencyKey?: string) => ({
      agent,
      assertAuthorized: context.assertAuthorized,
      idempotencyKey:
        idempotencyKey ??
        createHash("sha256")
          .update(requestKey + ":" + operation)
          .digest("hex"),
    });
    const unwrap = (response: import("../../services/commands/engine.js").EngineResponse) => {
      if (response.status >= 400)
        throw Object.assign(
          new Error((response.body.error as any)?.message ?? "Browser operation failed"),
          {
            statusCode: response.status,
            details: response.body,
            retryAfter: response.headers["retry-after"],
          },
        );
      return response.body as any;
    };
    let unfinished = false;
    const commands = async (
      id: string,
      body: CommandRequest,
      operation: string,
      idempotencyKey?: string,
    ) => {
      const result = unwrap(
        await application.commands(appContext(operation, idempotencyKey), id, {
          ...body,
          commands: body.commands.map((command) =>
            command.command === "snapshot" ||
            (command.command === "get" && ["text", "html", "markdown"].includes(command.what))
              ? { ...command, limit: command.limit ?? DEFAULT_TEXT_LIMIT }
              : command,
          ),
          ...(body.observe && body.observe.mode !== "none"
            ? { observe: { ...body.observe, limit: body.observe.limit ?? DEFAULT_TEXT_LIMIT } }
            : {}),
        }),
      );
      unfinished = ["queued", "running"].includes(result.execution?.state);
      return result;
    };
    const eventHash = createHash("sha256").update(`${requestKey}:${tool}:outcome`).digest("hex");
    const outcomeId = `${eventHash.slice(0, 8)}-${eventHash.slice(8, 12)}-4${eventHash.slice(
      13,
      16,
    )}-8${eventHash.slice(17, 20)}-${eventHash.slice(20, 32)}`;
    let outcomeContext: { caller: string; site?: string; sessionId?: string } = { caller: "mcp" };
    let outcomeReason: "completed" | "exception" | "auth_required" | "unobserved" | undefined;
    const run = async (): Promise<CallToolResult> => {
      try {
        if (tool === "browser_sessions") {
          const { sessions } = application.list({ agent });
          return textResult({
            sessions: sessions
              .filter((value: any) => value.status === "live")
              .map((value: any) => ({
                session: value.id,
                status: value.status,
                site: value.site,
                mode: value.mode,
                identity: value.identity ?? null,
                caller: value.caller,
                createdAt: value.createdAt,
                idleTimeoutMs: value.timeout,
                residentialBytes: (value.proxyTxBytes ?? 0) + (value.proxyRxBytes ?? 0),
              })),
          });
        }
        if (tool === "browser_open") {
          outcomeContext = { caller: args.caller, site: args.site };
          const body = {
            ...(args.connection ? { connection: args.connection } : {}),
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
          const opened = await application.open(appContext("open"), body);
          try {
            const browser = access(req, opened.id);
            outcomeContext = {
              caller: browser.options.caller ?? "mcp",
              site: browser.options.site,
              sessionId: browser.id,
            };
            const destination = args.url ?? browser.options.targetUrl;
            const state = await commands(
              opened.id,
              {
                commands: destination
                  ? [{ command: "navigate", url: destination }]
                  : [{ command: "get", what: "url" }],
                observe: args.observe,
              },
              "open-navigate",
            );
            return textResult(
              {
                session: opened.id,
                site: browser.options.site,
                mode: opened.mode,
                identity: opened.identity ?? null,
                url: destination,
                idleTimeoutMs: opened.timeout,
                ...state,
              },
              commandFailed(state),
            );
          } catch (error) {
            try {
              await application.release(appContext("open-failed-release"), opened.id);
            } catch (cleanupError) {
              Object.assign(error as Error, {
                details: {
                  ...(error as any).details,
                  session: opened.id,
                  cleanupError: (cleanupError as Error).message,
                },
              });
            }
            throw error;
          }
        }
        if (tool === "fetch") {
          const requestId = args.requestId ?? outcomeId;
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
            result = await application.fetch(
              appContext(
                "fetch",
                createHash("sha256").update(`mcp-fetch:${requestId}`).digest("hex"),
              ),
              {
                url: args.url,
                ...(args.site ? { site: args.site } : {}),
                caller: args.caller,
                requestId,
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
            );
            if (result.status !== "ok")
              return textResult(
                { status: result.status, rung: result.rung, attempts: result.attempts },
                true,
              );
            const content = await getDefuddleContent(result.html, result.url ?? args.url);
            const { value: markdown, ...page } = textPage(
              scrub(stripBase64Images(content.contentMarkdown ?? "")),
              args,
            );
            return textResult({
              status: "ok",
              requestId,
              url: result.url ?? args.url,
              rung: result.rung,
              markdown,
              ...page,
              attempts: result.attempts,
              residentialBytes:
                (result.settled?.proxyTxBytes ?? 0) + (result.settled?.proxyRxBytes ?? 0),
            });
          } finally {
            if (result?.session?.id)
              await application.release(appContext("fetch-finally-release"), result.session.id);
          }
        }
        if (tool === "browser_close") {
          const ended = await application.release(appContext("close"), args.session);
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
        if (tool === "browser_download" && args.transfer) {
          const files = selectedTransfers(server, {
            raw: req.raw,
            params: { sessionId: args.session },
          });
          let delivery = args.cancel
            ? await files.cancel(args.transfer)
            : files.status(args.transfer);
          if (!args.cancel && delivery.state === "ready") delivery = files.share(args.transfer);
          unfinished = delivery.state === "receiving";
          return deliveryResult(delivery, args.cancel);
        }
        const browser = access(req, args.session);
        outcomeContext = {
          caller: browser.options.caller ?? "mcp",
          site: browser.options.site,
          sessionId: browser.id,
        };
        if (tool === "browser_snapshot") {
          const { session: id, after, eventsAfter, ...options } = args;
          return await commandResult(
            browser,
            await commands(
              id,
              {
                commands: [{ command: "snapshot", ...options }],
                after,
                eventsAfter,
              },
              "snapshot",
            ),
          );
        }
        if (tool === "browser_act") {
          const { session: id, idempotencyKey, ...body } = args;
          const list = Array.isArray(body.commands) ? body.commands : [body.commands];
          if (
            identityVault(browser.options.identity) &&
            list.some((item: any) => ["screenshot", "pdf"].includes(item.command))
          )
            throw Object.assign(new Error("Protected identity image capture unavailable"), {
              statusCode: 403,
            });
          return await commandResult(
            browser,
            await commands(id, { ...body, commands: list }, "act", idempotencyKey),
            list.length === 1 && list[0].command === "cancel",
          );
        }
        if (tool === "browser_read") {
          const { session: id, format, after, eventsAfter, ...options } = args;
          return await commandResult(
            browser,
            await commands(
              id,
              {
                commands: [
                  {
                    command: "get",
                    what: format,
                    ...options,
                    target: options.target ?? (format === "markdown" ? undefined : ":root"),
                  },
                ],
                after,
                eventsAfter,
              },
              "read",
            ),
          );
        }
        if (tool === "browser_screenshot") {
          if (identityVault(browser.options.identity))
            throw Object.assign(new Error("Protected identity image capture unavailable"), {
              statusCode: 403,
            });
          const { session: id, ...options } = args;
          const result = await commands(
            args.session,
            { commands: [{ command: "screenshot", ...options }] },
            "screenshot",
          );
          return await commandResult(browser, result);
        }
        if (tool === "browser_download") {
          if (args.url) {
            const delivery = await application.prepareDelivery(
              appContext("download"),
              args.session,
              { url: args.url },
            );
            unfinished = delivery.state === "receiving";
            return deliveryResult(delivery);
          }
          return await commandResult(
            browser,
            await commands(
              args.session,
              {
                commands: [
                  { command: "click", target: args.ref },
                  { command: "wait", download: true, timeout: 50_000 },
                ],
              },
              "download-ref",
            ),
          );
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
          const result = await application.signIn(appContext("login"), args.session, {
            site,
            current: args.current,
          });
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
              url: metadataUrl(event.request?.url ?? event.response?.url ?? event.error?.url ?? ""),
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
            ...(error as any).details,
            ...(["fetch_timeout", "fetch_cancelled"].includes((error as any).reason)
              ? {
                  status: "failed",
                  requestId: (error as any).requestId,
                  reason: (error as any).reason,
                }
              : {}),
            error: (error as any).details?.error ?? {
              code: error instanceof z.ZodError ? "invalid_request" : "browser_error",
              message,
            },
            statusCode: (error as any).statusCode ?? 400,
            ...((error as any).retryAfter ? { retryAfter: (error as any).retryAfter } : {}),
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
        await application.outcome(appContext("tool-outcome"), {
          attemptId: outcomeId,
          ...outcomeContext,
          backend: "steel",
          outcome: result.isError
            ? "failure"
            : outcomeReason === "unobserved" || unfinished
              ? "unknown"
              : "success",
          reason:
            outcomeReason ??
            (result.isError ? "exception" : unfinished ? "unobserved" : "completed"),
          fallback: false,
        });
      } catch {
        result.content.push({
          type: "text",
          text: "Caller outcome was not recorded; this operation cannot establish migration acceptance.",
        });
      }
    }
    return result;
  }

  const registry: ToolRegistry<BrowserToolContext> = new ToolRegistry<BrowserToolContext>([
    {
      id: "browser",
      name: "Toolstack",
      version: "1.3.0",
      description: "Browser sessions, page reads, authenticated browsing and downloads",
      authentication:
        "Uses your Toolstack key and its session ownership; site logins use scoped vault entries.",
      tools: Object.entries(schemas).map(([name, input]) => ({
        name,
        description: descriptions[name as ToolName],
        input,
        execute: (args, context) => executeBrowser(name as ToolName, args, context),
      })),
    },
    connectionToolkit(
      () => application.connections,
      (id, context) =>
        verifyConnection(registry, application.connections, id, context as BrowserToolContext),
    ),
    apiToolkit(() => application.api),
    workflowToolkit(() => registry as unknown as ToolRegistry),
    libraryToolkit(() => server.contentLibrary),
    ...[...builtInApiToolkits(), ...(server.steelBrowserConfig?.apiToolkits ?? [])].map(
      (definition) => nativeApiToolkit(definition, () => application.api),
    ),
    ...(server.steelBrowserConfig?.toolkits ?? []),
  ]);
  const exposure = server.steelBrowserConfig?.mcpToolExposure ?? env.MCP_TOOL_EXPOSURE;
  application.connections.useCatalog(registry as unknown as ToolRegistry);
  await applicationRoutes(server, registry, application);

  server.post("/mcp", { bodyLimit: 2_000_000 }, async (req, reply) => {
    check(req);
    const controller = new AbortController();
    const context: BrowserToolContext = {
      agent: agentFor(req.raw)!,
      request: req,
      requestId:
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : randomUUID(),
      signal: controller.signal,
    };
    const protocol = new Server(
      { name: "toolstack", version: "1.5.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "This connection is bound to one organization and private membership workspace. Global sharing applies only within that organization. library_list returns your organization context. Use library_list to find your owned skills and content explicitly assigned to you or published globally, then library_get to read the applicable instructions. Content sharing grants no account access; uploaded scripts require a registered execution runtime. Use connections_list to discover permitted accounts and pass a browser connection ID to browser_open. Discover native API tools for the selected api: connection; api_usage reads allowances and private history. Use workflows_list and workflows_get to fetch versioned working methods, and workflows_reference for declared reference material. Check the verification estimate before connections_verify; it consumes the normal allowance. Reuse the same idempotencyKey on API transport retries; unknown provider outcomes retain their reservation. Use tools_search to discover registered tools and tools_describe for exact schemas. tools_execute runs a discovered tool with the same permissions and results as its direct name. Use fetch for one-page reads. browser_open starts navigation with an initial snapshot; reuse its session and pass next as after. Reuse idempotencyKey when retrying an open, action or reference download. Every command-based tool can return a queued/running execution; inspect or cancel it through browser_act status/cancel. Batch actions with observe to read changes in one call. Failed batches retain partial results and effects; inspect them before retrying. Continue long reads at results[0].nextOffset. Ready downloads return webUri links for ordinary browser downloads without a local installer. These handoffs expire thirty minutes after publication and survive remote browser closure; wait for ready before closing. Binary URI and checksum remain available for optional automated receivers. Use browser_sessions to resume your work and close sessions in finally. Use vault login for credentials. A human hand-off requires the owner's agreement.",
      },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: scrubToolMetadata([
        ...(exposure === "all" ? registry.list(context) : []),
        ...discoveryDefinitions,
      ]),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, (request) =>
      callRegisteredTool(registry, request.params.name, request.params.arguments ?? {}, context),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.once("close", () => {
      controller.abort();
      void protocol.close();
    });
    await protocol.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
