// Shared application entry points for REST and MCP. Authorization and input
// validation belong here so transport adapters cannot bypass either.
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionPool } from "./session-pool.js";
import type { Agent } from "./proxy-manager.js";
import { LoginService } from "./login.js";
import { callerTag, outcomeBody } from "./caller-outcomes.js";
import { TransferRequest } from "../modules/files/files.schema.js";
import type { Operation } from "./operations.js";
import { retryOperation } from "../utils/idempotency.js";
import { BrowserConnections } from "./connections.js";
import { connectionId } from "./connection-store.js";
import { ApiExecutor } from "./api-execution.js";
import { assertAgentCurrent } from "./agent-access.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  });
export const fetchBody = z
  .object({
    url: httpUrl,
    site: z.string().min(1).max(2048).optional(),
    caller: callerTag.optional(),
    outcomeAttemptId: z.string().uuid().optional(),
    requestId: z.string().uuid().optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).default(180_000),
    route: z.enum(["annas", "bizapedia", "udn", "ancestry", "newspapers", "fold3"]).optional(),
    startRung: z.number().int().min(1).max(3).optional(),
    identity: name.optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    retry: z.boolean().optional(),
    retain: z.boolean().optional(),
    splitTraffic: z.boolean().optional(),
    maxRung: z.number().int().min(1).max(3).optional(),
    forceDirectFailure: z.boolean().optional(),
  })
  .strict();

export interface ApplicationContext {
  agent: Agent;
  idempotencyKey?: string;
  assertAuthorized?: () => void;
}
export const loginBody = z
  .object({
    site: z.enum(["ancestry", "newspapers", "fold3", "mary-ferrell", "hathitrust-google"]),
    current: z.boolean().default(false),
  })
  .strict();
export class BrowserApplication {
  private loginService?: LoginService;
  private connectionService?: BrowserConnections;
  private apiService?: ApiExecutor;
  constructor(readonly pool: SessionPool) {}
  get login() {
    return (this.loginService ??= new LoginService(path.dirname(this.pool.profilesRoot)));
  }
  get connections() {
    return (this.connectionService ??= new BrowserConnections(this.pool, this.login));
  }
  get api() {
    return (this.apiService ??= new ApiExecutor(
      path.dirname(this.pool.connectionStore.file),
      this.connections,
    ));
  }
  async closeApi() {
    await this.apiService?.close();
  }
  session(context: ApplicationContext, id: string) {
    const session = this.pool.get(id);
    if (!context.agent.admin && this.pool.owner(id)?.name !== context.agent.name)
      throw Object.assign(new Error("Session belongs to another agent"), { statusCode: 403 });
    session.touch();
    return session;
  }
  private retry<T>(
    context: ApplicationContext,
    action: string,
    input: unknown,
    run: (operation?: Operation<any>) => Promise<T>,
  ) {
    const owner = context.agent.connectedApp
      ? `${context.agent.name}:${context.agent.connectedApp.orgId}:${context.agent.connectedApp.membershipId}:${context.agent.connectedApp.userId}:${context.agent.connectedApp.keyId}`
      : context.agent.name;
    return retryOperation<T>(owner, action, context.idempotencyKey, input, run);
  }
  list(context: ApplicationContext) {
    return {
      sessions: this.pool
        .list()
        .filter((s) => context.agent.admin || this.pool.owner(s.id)?.name === context.agent.name),
    };
  }
  open(context: ApplicationContext, input: unknown) {
    return this.retry(context, "session.open", input, async (operation) => {
      let options = input;
      if (input && typeof input === "object" && !Array.isArray(input) && "connection" in input)
        options = await this.connections.select(
          connectionId.parse(input.connection),
          input as Record<string, unknown>,
          context.agent,
        );
      operation?.markActed();
      return (
        await this.pool.create(options ?? {}, context.agent, false, context.assertAuthorized)
      ).info();
    });
  }
  release(context: ApplicationContext, id: string) {
    // Ended sessions still have an owner and may be released again.
    if (!context.agent.admin && this.pool.owner(id)?.name !== context.agent.name)
      throw Object.assign(new Error("Session belongs to another agent"), { statusCode: 403 });
    return this.retry(context, "session.release", { id }, async (operation) => {
      operation?.markActed();
      return { success: true, ...(await this.pool.release(id)) };
    });
  }
  async commands(context: ApplicationContext, id: string, body: unknown) {
    const session = this.session(context, id);
    await session.prepareCommands();
    const response = await session.engine.handle({
      sessionId: id,
      idempotencyKey:
        context.idempotencyKey && context.agent.connectedApp
          ? createHash("sha256")
              .update(JSON.stringify([context.agent.connectedApp.keyId, context.idempotencyKey]))
              .digest("hex")
          : context.idempotencyKey,
      body,
      authorize: async () => {
        await assertAgentCurrent(context.agent);
        context.assertAuthorized?.();
      },
    });
    session.touch();
    return response;
  }
  fetch(context: ApplicationContext, input: unknown) {
    const options = fetchBody.parse(input);
    if (!options.outcomeAttemptId && !options.requestId) {
      if (context.idempotencyKey) {
        const hash = createHash("sha256").update(context.idempotencyKey).digest("hex");
        options.requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      } else options.requestId = randomUUID();
    }
    if (options.splitTraffic !== undefined && !context.agent.admin)
      throw Object.assign(new Error("Admin key required for unmeasured policies"), {
        statusCode: 403,
      });
    return this.pool.routing.fetch(options, context.agent);
  }
  prepareDelivery(context: ApplicationContext, id: string, input: unknown) {
    const body = TransferRequest.parse(input);
    const session = this.session(context, id);
    return this.retry(context, "delivery.prepare", { id, body }, async (operation) => {
      operation?.markActed();
      return body.file
        ? session.transfers.fromFile(body.file, body.name)
        : session.transfers.fromUrl(session, body.url!, body.name, body.referer);
    });
  }
  signIn(context: ApplicationContext, id: string, input: unknown) {
    const body = loginBody.parse(input);
    const session = this.session(context, id);
    return this.retry(context, "session.login", { id, body }, async (operation) => {
      operation?.markActed();
      return this.login.login(session, body.site, context.agent, body.current);
    });
  }
  async outcome(context: ApplicationContext, input: unknown) {
    const body = outcomeBody.parse(input);
    if (
      body.sessionId &&
      body.backend === "steel" &&
      !context.agent.admin &&
      (this.pool.owner(body.sessionId)?.name ??
        (await this.pool.outcomes.sessionOwner(body.sessionId))) !== context.agent.name
    )
      throw Object.assign(new Error("Session belongs to another agent"), { statusCode: 403 });
    return this.pool.outcomes.result(body, context.agent.name);
  }
}
const applications = new WeakMap<SessionPool, BrowserApplication>();
export function browserApplication(pool: SessionPool) {
  let app = applications.get(pool);
  if (!app) applications.set(pool, (app = new BrowserApplication(pool)));
  return app;
}
