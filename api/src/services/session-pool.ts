// Coordinates exclusive profile ownership and browser lifetimes. It must not reuse
// a throwaway profile, expose proxy credentials, or start browsers between jobs.
import { identityVault } from "./login.js";
import { vault } from "./vault.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { BrowserSession } from "./browser-session.js";
import { SessionContextSchema } from "./context/types.js";
import { releaseStaleProfileLock } from "./cdp/utils/profile-lock.js";
import { ProxyManager, DAILY_BUDGET, type Agent } from "./proxy-manager.js";
import { Routing } from "./routing.js";
import { CallerOutcomes, callerTag } from "./caller-outcomes.js";
import { runCleanup } from "../utils/cleanup.js";
import { FileTransfers } from "./file-transfers.js";
import { FileService } from "./file.service.js";
import { ConnectionStore } from "./connection-store.js";
import { assertAgentCurrent } from "./agent-access.js";

export const sessionOptions = z
  .object({
    sessionId: z.string().uuid().optional(),
    site: z.string().min(1).max(2048).optional(),
    caller: callerTag.optional(),
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
  factory?: (
    id: string,
    options: SessionOptions,
    profilePath: string,
    end: (reason: string) => Promise<void>,
  ) => BrowserSession;
}
type SessionInfo = ReturnType<BrowserSession["info"]>;
type SessionEntry = {
  authorize?: () => void;
  id: string;
  options: SessionOptions;
  owner: Agent;
  reserved: boolean;
  profilePath?: string;
  startup?: Promise<BrowserSession>;
  closing?: Promise<void>;
  endReason?: string;
};
type QueuedSlot = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class SessionPool {
  readonly routing: Routing;
  readonly outcomes: CallerOutcomes;
  readonly proxies?: ProxyManager;
  private entries = new Map<string, SessionEntry>();
  owner(id: string) {
    return (
      this.entries.get(id)?.owner ?? this.deliveries.get(id)?.owner ?? this.history.get(id)?.owner
    );
  }
  fileTransfers(id: string) {
    return this.sessions.get(id)?.transfers ?? this.deliveries.get(id)?.files;
  }
  identityBusy(name: string) {
    return this.identities.has(name);
  }
  async deleteIdentity(name: string, forgetLogin: () => Promise<unknown>) {
    // Share the creation lock through every asynchronous removal. Protected
    // identities follow the same deletion path; the route requires an admin.
    sessionOptions.parse({ identity: name });
    if (this.identities.has(name)) throw new PoolError(409, "Identity is already in use");
    this.identities.add(name);
    try {
      await rm(path.join(this.profilesRoot, name), { recursive: true, force: true });
      await this.proxies?.forgetIdentity(name);
      await forgetLogin();
      return { name, deleted: true };
    } finally {
      this.identities.delete(name);
    }
  }
  private launchHooks: Array<(session: BrowserSession) => Promise<void> | void> = [];
  registerSessionHook(hook: (session: BrowserSession) => Promise<void> | void) {
    this.launchHooks.push(hook);
  }
  readonly sessions = new Map<string, BrowserSession>();
  private history = new Map<string, { info: SessionInfo; owner: Agent }>();
  private deliveries = new Map<string, { files: FileTransfers; owner: Agent }>();
  private identities = new Set<string>();
  private queue = new Map<string, QueuedSlot>();
  private stopping = false;
  private drainingWork?: Promise<void>;
  private expiring = false;
  private timer: NodeJS.Timeout;
  readonly maxSessions: number;
  readonly profilesRoot: string;
  readonly connectionStore: ConnectionStore;
  constructor(
    private logger: FastifyBaseLogger,
    private options: PoolOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? Number(process.env.MAX_SESSIONS ?? 3);
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1)
      throw new Error("MAX_SESSIONS must be a positive integer");
    this.profilesRoot = options.profilesRoot ?? process.env.PROFILES_ROOT ?? "/data/profiles";
    this.connectionStore = new ConnectionStore(
      options.factory
        ? path.join(this.profilesRoot, ".connections.json")
        : path.join(path.dirname(this.profilesRoot), "connections.json"),
    );
    const routingRoot = options.factory
      ? path.join(this.profilesRoot, ".routing")
      : path.join(path.dirname(this.profilesRoot), "routing");
    this.routing = new Routing(this, routingRoot);
    this.outcomes = new CallerOutcomes(routingRoot);
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
    return [...this.entries.values()].filter((entry) => entry.reserved).length;
  }
  get(id?: string) {
    if (!id) {
      const live = [...this.sessions.values()].filter(
        (s) => s.status === "live" && !this.entries.get(s.id)?.closing,
      );
      if (live.length !== 1) throw new PoolError(409, "Choose a sessionId explicitly");
      return live[0];
    }
    const session = this.sessions.get(id);
    if (!session || session.status !== "live" || this.entries.get(id)?.closing)
      throw new PoolError(410, "Session is not running");
    return session;
  }
  details(id: string) {
    const info = this.sessions.get(id)?.info() ?? this.history.get(id)?.info;
    if (!info) throw new PoolError(404, "Unknown session");
    return info;
  }
  list() {
    return [...this.sessions.values()]
      .map((s) => s.info())
      .concat(
        [...this.history.values()]
          .filter((entry) => !this.sessions.has(entry.info.id))
          .map((entry) => entry.info),
      );
  }
  private async slot(entry: SessionEntry) {
    if (this.stopping) throw new PoolError(503, "Service is draining");
    if (this.size < this.maxSessions) {
      entry.reserved = true;
      return;
    }
    if (this.queue.size >= (this.options.maxQueued ?? 8))
      throw new PoolError(429, "Session queue is full");
    await new Promise<void>((resolve, reject) => {
      this.queue.set(entry.id, {
        resolve: () => {
          entry.reserved = true;
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          this.queue.delete(entry.id);
          reject(new PoolError(429, "Session limit reached; retry after a session ends"));
        }, this.options.queueMs ?? 5000),
      });
    });
  }
  private free(entry: SessionEntry) {
    if (!entry.reserved) return;
    entry.reserved = false;
    if (this.stopping) return;
    const next = this.queue.entries().next().value;
    if (!next) return;
    const [id, item] = next;
    this.queue.delete(id);
    clearTimeout(item.timer);
    item.resolve();
  }
  private assertStarting(entry: SessionEntry) {
    if (this.stopping) throw new PoolError(503, "Service is draining");
    if (entry.closing) throw new PoolError(410, "Session ended during startup");
  }
  async create(
    body: unknown,
    agent: Agent = { name: "admin", admin: true, dailyBudgetBytes: DAILY_BUDGET },
    measuredPolicy = false,
    authorize?: () => void,
  ): Promise<BrowserSession> {
    if (this.stopping) throw new PoolError(503, "Service is draining");
    const parsed = sessionOptions.safeParse(await this.routing.sessionOptions(body));
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
    if (identity) await this.connectionStore.assertProfile(identity, agent);
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
    if (this.entries.has(id) || this.history.has(id) || this.deliveries.has(id))
      throw new PoolError(409, "Session ID is already in use");
    const entry: SessionEntry = { id, options, owner: agent, reserved: false, authorize };
    this.entries.set(id, entry);
    if (identity) this.identities.add(identity);
    // Startup covers the slot, profile and hooks as well as Chrome. Release
    // waits for this work before touching any resource that it may still create.
    entry.startup = this.start(entry);
    try {
      const session = await entry.startup;
      this.assertStarting(entry);
      if (session.status !== "live") throw new PoolError(410, "Session ended during startup");
      return session;
    } catch (error) {
      try {
        await this.closeEntry(entry, this.stopping ? "draining" : "launch_failed");
      } catch {
        this.logger.error({ sessionId: id }, "Failed startup cleanup was incomplete");
      }
      throw error;
    }
  }

  private async authorizeEntry(entry: SessionEntry) {
    await assertAgentCurrent(entry.owner);
    entry.authorize?.();
    if (entry.options.identity)
      await this.connectionStore.assertProfile(entry.options.identity, entry.owner);
    const credential = identityVault(entry.options.identity);
    if (credential && !(await vault.list(entry.owner, credential, "all", true)).length)
      throw new PoolError(403, "Identity unavailable for this agent");
    this.assertStarting(entry);
  }
  private async start(entry: SessionEntry): Promise<BrowserSession> {
    const { id, options, owner } = entry;
    await this.slot(entry);
    this.assertStarting(entry);
    await this.authorizeEntry(entry);
    const identity = options.identity;
    const profilePath = (entry.profilePath = identity
      ? path.join(this.profilesRoot, identity)
      : await mkdtemp(path.join(os.tmpdir(), "mosaic-browser-")));
    await mkdir(profilePath, { recursive: true });
    // Railway mounts one volume on one replica. A previous host cannot still
    // own Chrome after relinquishing that volume.
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
    this.assertStarting(entry);
    const end = async (reason: string) => {
      await this.release(id, reason);
    };
    const session =
      this.options.factory?.(id, options, profilePath, end) ??
      new BrowserSession(id, options, profilePath, this.logger, end);
    this.sessions.set(id, session);
    for (const hook of this.launchHooks) {
      await hook(session);
      this.assertStarting(entry);
    }
    await this.proxies?.prepare(session, owner);
    this.assertStarting(entry);
    await this.authorizeEntry(entry);
    await session.launch();
    return session;
  }

  private closeEntry(entry: SessionEntry, reason: string): Promise<void> {
    entry.endReason ??= reason;
    // Publish the promise before cleanup starts, including synchronous callbacks.
    entry.closing ??= Promise.resolve().then(() => this.finish(entry));
    const queued = this.queue.get(entry.id);
    if (queued) {
      this.queue.delete(entry.id);
      clearTimeout(queued.timer);
      queued.reject(new PoolError(this.stopping ? 503 : 410, "Session ended before startup"));
    }
    return entry.closing;
  }

  private async finish(entry: SessionEntry) {
    const { id, options, owner } = entry;
    await entry.startup?.catch(() => undefined);
    const session = this.sessions.get(id);
    let info: SessionInfo | undefined;
    try {
      await runCleanup(
        [
          () => session?.close(entry.endReason!),
          () => this.proxies?.settle(id),
          async () => {
            if (entry.profilePath && !options.identity) {
              await rm(entry.profilePath, { recursive: true, force: true });
              if (session) session.temporaryProfileRemoved = true;
            }
          },
          () => {
            info = session?.info?.();
            if (info) {
              this.history.set(id, { info, owner });
              while (this.history.size > 100)
                this.history.delete(this.history.keys().next().value!);
            }
          },
          () => {
            if (session?.transfers?.retained)
              this.deliveries.set(id, { files: session.transfers, owner });
            this.sessions.delete(id);
            if (options.identity) this.identities.delete(options.identity);
            this.free(entry);
          },
          () => info && this.outcomes.session(info, owner.name, options.caller, options.site),
          () => {
            if (info)
              this.logger.info(
                {
                  sessionId: id,
                  caller: options.caller,
                  site: options.site,
                  reason: entry.endReason,
                  bytes: info.proxyTxBytes + info.proxyRxBytes,
                  duration: info.duration,
                },
                "Session ended",
              );
          },
        ],
        "Session cleanup failed",
      );
    } finally {
      this.entries.delete(id);
    }
  }

  async release(id: string, reason = "released") {
    const entry = this.entries.get(id);
    if (entry) await this.closeEntry(entry, reason);
    return this.details(id);
  }
  async expire(now = Date.now()) {
    if (this.expiring) return;
    this.expiring = true;
    try {
      for (const id of (await this.proxies?.tick()) ?? []) {
        if (this.sessions.get(id)?.status === "live")
          await this.release(id, "residential_budget_exceeded");
      }
      const results = await Promise.allSettled(
        [...this.sessions.values()]
          .filter((s) => s.status === "live" && !this.entries.get(s.id)?.closing)
          .map(async (s) => {
            await s.transfers?.expire(now);
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
      const errors = results.filter((result) => result.status === "rejected");
      for (const [id, item] of this.deliveries) {
        await item.files.expire(now);
        if (!item.files.retained) this.deliveries.delete(id);
      }
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "Session expiry failed",
        );
      if (!this.options.factory && now - this.lastFileSweep >= 60_000) {
        this.lastFileSweep = now;
        await FileTransfers.reap(
          FileService.getInstance().getBaseFilesPath(),
          new Set([...this.entries.keys(), ...this.deliveries.keys()]),
          now,
        );
      }
    } finally {
      this.expiring = false;
    }
  }
  private lastFileSweep = 0;
  drain(
    ms = Math.max(
      0,
      Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 120) * 1000 - 10_000,
    ),
  ) {
    this.drainingWork ??= this.drainSessions(ms);
    return this.drainingWork;
  }
  private async drainSessions(ms: number) {
    this.stopping = true;
    clearInterval(this.timer);
    for (const item of this.queue.values()) {
      clearTimeout(item.timer);
      item.reject(new PoolError(503, "Service is draining"));
    }
    this.queue.clear();
    const deadline = Date.now() + ms;
    while (this.size && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
    // Wait for every startup and cleanup, even if another session fails. Metadata
    // failures must not prevent Chrome from being closed during shutdown.
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.closeEntry(entry, "draining")),
    );
    await runCleanup(
      [
        () =>
          runCleanup(
            [...this.deliveries].map(([id, item]) => async () => {
              await item.files.close(false);
              this.deliveries.delete(id);
            }),
            "Download shutdown cleanup failed",
          ),
        () => {
          const errors = results.filter((result) => result.status === "rejected");
          if (errors.length)
            throw new AggregateError(
              errors.map((result) => result.reason),
              "Session drain failed",
            );
        },
        () => this.routing.table(false),
        () => this.outcomes.summary(),
      ],
      "Service drain failed",
    );
  }
}
