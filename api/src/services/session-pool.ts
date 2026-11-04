import { identityVault } from "./login.js";
import { vault } from "./vault.js";
// Coordinates exclusive profile ownership and browser lifetimes. It must not reuse
// a throwaway profile, expose proxy credentials, or start browsers between jobs.
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readlink, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { BrowserSession } from "./browser-session.js";
import { SessionContextSchema } from "./context/types.js";
import { releaseStaleProfileLock } from "./cdp/utils/profile-lock.js";
import { ProxyManager, DAILY_BUDGET, type Agent } from "./proxy-manager.js";

export const sessionOptions = z
  .object({
    sessionId: z.string().uuid().optional(),
    residential: z
      .object({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .default("US"),
      })
      .optional(),
    targetUrl: z.string().url().optional(),
    splitTraffic: z.boolean().default(false),
    budgetBytes: z.number().int().min(1).max(1_000_000_000).optional(),
    mode: z.enum(["agent", "quiet"]).default("agent"),
    identity: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
      .optional(),
    profile: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
      .optional(),
    proxyUrl: z
      .string()
      .url()
      .refine(
        (v) => ["http:", "https:", "socks5:"].includes(new URL(v).protocol),
        "Unsupported proxy protocol",
      )
      .optional(),
    timezone: z
      .string()
      .refine((v) => {
        try {
          Intl.DateTimeFormat("en-US", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone")
      .optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/)
      .default("en-US"),
    headless: z.boolean().optional(),
    blockAds: z.literal(false).optional(),
    dimensions: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(240).max(2160),
      })
      .optional(),
    sessionContext: SessionContextSchema.optional(),
  })
  .strict()
  .superRefine((options, ctx) => {
    if (options.mode === "quiet" && options.headless)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headless"],
        message: "Quiet mode requires a visible X display",
      });
    if (options.mode === "quiet" && options.sessionContext)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionContext"],
        message:
          "Quiet mode uses a named profile for saved state; context injection is unavailable",
      });
  });
export type SessionOptions = z.infer<typeof sessionOptions>;
export class PoolError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface PoolOptions {
  maxSessions?: number;
  queueMs?: number;
  maxQueued?: number;
  idleMs?: number;
  lifetimeMs?: number;
  profilesRoot?: string;
  // Agent identity will be used by the later vault and byte-budget implementation.
  ownerKey?: string;
  factory?: (
    id: string,
    options: SessionOptions,
    profilePath: string,
    end: (reason: string) => Promise<void>,
  ) => BrowserSession;
}
export class SessionPool {
  readonly proxies?: ProxyManager;
  private owners = new Map<string, Agent>();
  owner(id: string) {
    return this.owners.get(id);
  }
  identityBusy(name: string) {
    return this.identities.has(name);
  }
  private launchHooks: Array<(session: BrowserSession) => Promise<void> | void> = [];
  registerSessionHook(hook: (session: BrowserSession) => Promise<void> | void) {
    this.launchHooks.push(hook);
  }
  readonly sessions = new Map<string, BrowserSession>();
  private history = new Map<string, ReturnType<BrowserSession["info"]>>();
  private identities = new Set<string>();
  private reservations = new Set<string>();
  private pendingIds = new Set<string>();
  private queue: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> =
    [];
  private launching = new Map<string, Promise<unknown>>();
  private closing = new Map<string, Promise<void>>();
  private stopping = false;
  private expiring = false;
  private timer: NodeJS.Timeout;
  readonly maxSessions: number;
  readonly profilesRoot: string;
  constructor(
    private logger: FastifyBaseLogger,
    private options: PoolOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? Number(process.env.MAX_SESSIONS ?? 3);
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1)
      throw new Error("MAX_SESSIONS must be a positive integer");
    this.profilesRoot = options.profilesRoot ?? process.env.PROFILES_ROOT ?? "/data/profiles";
    if (!options.factory)
      this.proxies = new ProxyManager(path.join(path.dirname(this.profilesRoot), "routing"));
    this.timer = setInterval(
      () => void this.expire().catch(() => logger.error("Session expiry cleanup failed")),
      1000,
    );
    this.timer.unref();
  }
  get draining() {
    return this.stopping;
  }
  get size() {
    return this.reservations.size;
  }
  get(id?: string) {
    if (!id) {
      const live = [...this.sessions.values()].filter((s) => s.status === "live");
      if (live.length !== 1) throw new PoolError(409, "Choose a sessionId explicitly");
      return live[0];
    }
    const session = this.sessions.get(id);
    if (!session || session.status !== "live") throw new PoolError(410, "Session is not running");
    return session;
  }
  details(id: string) {
    const info = this.sessions.get(id)?.info() ?? this.history.get(id);
    if (!info) throw new PoolError(404, "Unknown session");
    return info;
  }
  list() {
    return [...this.sessions.values()].map((s) => s.info()).concat([...this.history.values()]);
  }
  private async slot(id: string) {
    if (this.stopping) throw new PoolError(503, "Service is draining");
    if (this.reservations.size < this.maxSessions) {
      this.reservations.add(id);
      return;
    }
    if (this.queue.length >= (this.options.maxQueued ?? 8))
      throw new PoolError(429, "Session queue is full");
    await new Promise<void>((resolve, reject) => {
      const item = {
        resolve: () => {
          this.reservations.add(id);
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new PoolError(429, "Session limit reached; retry after a session ends"));
        }, this.options.queueMs ?? 5000),
      };
      this.queue.push(item);
    });
  }
  private free(id: string) {
    if (!this.reservations.delete(id)) return;
    const item = this.queue.shift();
    if (item) {
      clearTimeout(item.timer);
      item.resolve();
    }
  }
  async create(
    body: unknown,
    agent: Agent = { name: "admin", admin: true, dailyBudgetBytes: DAILY_BUDGET },
    measuredPolicy = false,
  ): Promise<BrowserSession> {
    const parsed = sessionOptions.safeParse(body);
    if (!parsed.success)
      throw new PoolError(
        400,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    const options = parsed.data;
    if (!agent.admin && options.proxyUrl) throw new PoolError(403, "Use managed residential exits");
    if (!agent.admin && options.splitTraffic && !measuredPolicy)
      throw new PoolError(403, "Traffic policy requires measured site approval");
    if (options.identity && options.profile && options.identity !== options.profile)
      throw new PoolError(400, "identity and profile must agree");
    options.identity ??= options.profile;
    const identity = options.identity;
    const credential = identityVault(identity);
    if (credential) {
      if (!(await vault.list(agent, credential)).length)
        throw new PoolError(403, "Identity unavailable for this agent");
      if (options.proxyUrl || options.sessionContext || options.headless)
        throw new PoolError(403, "Protected identities use their managed exit and profile");
      options.mode = "quiet";
      options.residential = { country: "US" };
    }
    if (identity && this.identities.has(identity))
      throw new PoolError(409, "Identity is already in use");
    const id = options.sessionId ?? randomUUID();
    if (
      this.pendingIds.has(id) ||
      this.reservations.has(id) ||
      this.sessions.has(id) ||
      this.history.has(id)
    )
      throw new PoolError(409, "Session ID is already in use");
    this.pendingIds.add(id);
    if (identity) this.identities.add(identity);
    let profilePath: string | undefined;
    let acquired = false;
    try {
      await this.slot(id);
      acquired = true;
      profilePath = identity
        ? path.join(this.profilesRoot, identity)
        : await mkdtemp(path.join(os.tmpdir(), "mosaic-browser-"));
      await mkdir(profilePath, { recursive: true });
      // Railway mounts one volume on one replica. A lock from a previous host
      // cannot have a live owner after that host has relinquished the volume.
      if (identity && process.env.RAILWAY_REPLICA_ID) {
        const lock = await readlink(path.join(profilePath, "SingletonLock")).catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return "";
        });
        if (lock && !lock.startsWith(`${os.hostname()}-`)) {
          for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
            await rm(path.join(profilePath, name), { force: true });
        }
      }
      await releaseStaleProfileLock(profilePath);
      const end = async (reason: string) => {
        await this.release(id, reason);
      };
      const session =
        this.options.factory?.(id, options, profilePath, end) ??
        new BrowserSession(id, options, profilePath, this.logger, end);
      this.sessions.set(id, session);
      this.owners.set(id, agent);
      for (const hook of this.launchHooks) await hook(session);
      const launch = (async () => {
        await this.proxies?.prepare(session, agent);
        return session.launch();
      })();
      this.launching.set(id, launch);
      try {
        await launch;
      } finally {
        this.launching.delete(id);
      }
      if (this.stopping) {
        await this.release(id, "draining");
        throw new PoolError(503, "Service is draining");
      }
      return session;
    } catch (error) {
      const session = this.sessions.get(id);
      try {
        await session?.close("launch_failed");
      } finally {
        await this.proxies?.settle(id);
        this.sessions.delete(id);
        if (profilePath && !identity) await rm(profilePath, { recursive: true, force: true });
        if (acquired && this.reservations.has(id)) this.free(id);
        if (identity) this.identities.delete(identity);
      }
      throw error;
    } finally {
      this.pendingIds.delete(id);
    }
  }
  async release(id: string, reason = "released") {
    if (this.closing.has(id)) {
      await this.closing.get(id);
      return this.details(id);
    }
    const session = this.sessions.get(id);
    if (!session) return this.details(id);
    const work = (async () => {
      await this.launching.get(id)?.catch(() => undefined);
      await session.close(reason);
      await this.proxies?.settle(id);
      if (!session.options.identity) {
        await rm(session.profilePath, { recursive: true, force: true });
        try {
          await access(session.profilePath);
          throw new Error("Temporary profile still exists after cleanup");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          session.temporaryProfileRemoved = true;
        }
      }
      const info = session.info();
      this.history.set(id, info);
      while (this.history.size > 100) this.history.delete(this.history.keys().next().value!);
      this.sessions.delete(id);
      if (session.options.identity) this.identities.delete(session.options.identity);
      this.free(id);
      this.logger.info(
        {
          sessionId: id,
          reason,
          bytes: info.proxyTxBytes + info.proxyRxBytes,
          duration: info.duration,
        },
        "Session ended",
      );
    })();
    this.closing.set(id, work);
    try {
      await work;
      return this.details(id);
    } finally {
      this.closing.delete(id);
    }
  }
  async expire(now = Date.now()) {
    if (this.expiring) return;
    this.expiring = true;
    try {
      for (const id of (await this.proxies?.tick()) ?? []) {
        if (this.sessions.get(id)?.status === "live")
          await this.release(id, "residential_budget_exceeded");
      }
      await Promise.all(
        [...this.sessions.values()]
          .filter((s) => s.status === "live")
          .map(async (s) => {
            const trafficReason = await s.trafficReason?.(now);
            if (trafficReason) {
              await this.release(s.id, trafficReason);
              return;
            }
            if (now - s.startedAt >= (this.options.lifetimeMs ?? 10_800_000))
              await this.release(s.id, "lifetime");
            else if (
              !s.clients &&
              !s.engine.busy() &&
              now - s.lastActivity >= (this.options.idleMs ?? 600_000)
            )
              await this.release(s.id, "idle");
          }),
      );
    } finally {
      this.expiring = false;
    }
  }
  async drain(
    ms = Math.max(
      0,
      Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 120) * 1000 - 10_000,
    ),
  ) {
    this.stopping = true;
    clearInterval(this.timer);
    for (const item of this.queue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new PoolError(503, "Service is draining"));
    }
    const deadline = Date.now() + ms;
    while (this.size && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
    await Promise.all([...this.sessions.keys()].map((id) => this.release(id, "draining")));
  }
}
