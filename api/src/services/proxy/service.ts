// A lease owns a route, a forwarding listener and a ledger entry. Browsers are consumers.
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ProxyServer, type IProxyServer } from "../../utils/proxy.js";
import { httpFetch } from "../http-fetch.js";
import type { BrowserSession } from "../browser-session.js";
import { currentOrganization } from "../organization.js";
import { PublicError } from "../../utils/public-error.js";
import { ProxyStore } from "./store.js";
import { binding, configured, defaults, upstream, validateProfile } from "./provider.js";
import {
  actor,
  leaseInput,
  proxyAdmin,
  ProxyError,
  proxyName,
  utcDay,
  type Agent,
  type Exit,
  type Identity,
  type LeaseInput,
  type LeaseRecord,
  type ProxyProfile,
} from "./types.js";
export { DAILY_BUDGET, ProxyError, actor, proxyAdmin } from "./types.js";
export type { Agent, Exit, LeaseInput, ProxyProfile } from "./types.js";

type Runtime = {
  record: LeaseRecord;
  profile: ProxyProfile;
  policyBinding: string;
  agent: Agent;
  server?: IProxyServer;
  session?: string;
  autoSession?: boolean;
  ephemeral?: boolean;
  abort: AbortController;
  requests: Set<AbortController>;
  close?: Promise<void>;
};
type Dependencies = {
  organization?: string;
  forwarder?: (
    url: string,
    split: boolean,
    allowed: () => boolean,
    identity?: string,
  ) => IProxyServer;
  probe?: (proxy: string, signal: AbortSignal, timeout: number) => Promise<Exit>;
  authorize?: (agent: Agent) => Promise<void>;
  authorizeIdentity?: (identity: string, agent: Agent) => Promise<void>;
};
const permitted = (p: ProxyProfile, a: Agent) =>
  p.enabled &&
  (proxyAdmin(a) || p.allowedAgents.includes("*") || p.allowedAgents.includes(actor(a)));
const min = (...values: Array<number | undefined>) =>
  Math.min(...values.filter((v): v is number => v !== undefined));
const freshSticky = () => randomBytes(4).toString("hex");
const snapshot = (r: LeaseRecord) => structuredClone(r);
const lookup = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export class ProxyService {
  private readonly store: ProxyStore;
  readonly ready: Promise<void>;
  private active = new Map<string, Runtime>();
  private bindings = new Map<string, string>();
  private sessions = new Map<string, string>();
  private stopped = false;
  constructor(
    readonly root: string,
    private dependencies: Dependencies = {},
  ) {
    this.store = new ProxyStore(root, dependencies.organization ?? currentOrganization().id);
    this.ready = this.store.ready;
  }
  private get state() {
    return this.store.state;
  }
  private profile(name: string, agent: Agent) {
    const value = lookup(this.state.profiles, name) ?? lookup(defaults, name);
    if (!value || !permitted(value, agent)) throw new ProxyError("proxy_profile_unavailable", 403);
    return structuredClone(value);
  }
  async profiles(agent: Agent) {
    await this.ready;
    return Object.entries({ ...defaults, ...this.state.profiles })
      .filter(([, p]) => permitted(p, agent))
      .map(([name, p]) => ({
        name,
        ...structuredClone(p),
        configured: configured(p),
        ...(proxyAdmin(agent)
          ? {
              health: lookup(this.state.health, name) ?? { attempts: 0, successes: 0, failures: 0 },
            }
          : {}),
      }));
  }
  async putProfile(name: string, input: unknown, agent: Agent) {
    await this.ready;
    if (!proxyAdmin(agent)) throw new ProxyError("proxy_admin_required", 403);
    proxyName.parse(name);
    if (!lookup(this.state.profiles, name) && Object.keys(this.state.profiles).length >= 256)
      throw new ProxyError("proxy_profile_capacity", 429);
    const p = validateProfile(input);
    if (
      p.fallback.includes(name) ||
      p.fallback.some((id) => !(lookup(this.state.profiles, id) ?? lookup(defaults, id)))
    )
      throw new ProxyError("invalid_proxy_fallback", 400);
    this.state.profiles[name] = p;
    await this.store.persist();
    return (
      (await this.profiles(agent)).find((row) => row.name === name) ?? { name, enabled: false }
    );
  }
  async deleteProfile(name: string, agent: Agent) {
    await this.ready;
    if (!proxyAdmin(agent)) throw new ProxyError("proxy_admin_required", 403);
    if (lookup(defaults, name)) throw new ProxyError("builtin_proxy_profile_cannot_be_deleted");
    if (!lookup(this.state.profiles, name)) throw new ProxyError("proxy_profile_not_found", 404);
    if (
      [...this.active.values()].some((v) => v.record.profile === name) ||
      Object.values(this.state.identities).some((i) => i.profile === name) ||
      Object.values(this.state.profiles).some((p) => p.fallback.includes(name))
    )
      throw new ProxyError("proxy_profile_in_use");
    delete this.state.profiles[name];
    await this.store.persist();
    return { name, deleted: true };
  }
  private collect() {
    const today = (this.state.days[utcDay()] ??= {});
    for (const item of this.active.values()) {
      if (!item.server) continue;
      const r = item.record;
      const tx = Math.max(r.txBytes, item.server.txBytes),
        rx = Math.max(r.rxBytes, item.server.rxBytes);
      const delta = tx + rx - r.txBytes - r.rxBytes;
      if (delta > 0) {
        today[r.owner] = (lookup(today, r.owner) ?? 0) + delta;
        this.state.lifetime[r.owner] = (lookup(this.state.lifetime, r.owner) ?? 0) + delta;
        this.state.products[r.product] = (lookup(this.state.products, r.product) ?? 0) + delta;
        this.state.total += delta;
      }
      r.txBytes = tx;
      r.rxBytes = rx;
      r.directBytes = item.server.directBytes ?? 0;
    }
  }
  remaining(agent: Agent) {
    this.collect();
    return Math.max(
      0,
      agent.dailyBudgetBytes - (lookup(this.state.days[utcDay()] ?? {}, actor(agent)) ?? 0),
    );
  }
  private remainingLease(item: Runtime) {
    return Math.max(
      0,
      min(
        this.remaining(item.agent),
        item.record.budgetBytes === undefined
          ? Infinity
          : item.record.budgetBytes - item.record.rxBytes - item.record.txBytes,
      ),
    );
  }
  private allowed(item: Runtime) {
    this.collect();
    const current =
      lookup(this.state.profiles, item.record.profile) ?? lookup(defaults, item.record.profile);
    const policy =
      item.ephemeral ||
      (current &&
        permitted(current, item.agent) &&
        binding(current) === item.policyBinding &&
        (!current.allowedCountries || current.allowedCountries.includes(item.record.country)) &&
        (current.budgetBytes === undefined ||
          item.record.rxBytes + item.record.txBytes < current.budgetBytes));
    return (
      !this.stopped &&
      !item.abort.signal.aborted &&
      item.record.status !== "closed" &&
      item.record.expiresAt > Date.now() &&
      Boolean(policy) &&
      this.remainingLease(item) > 0
    );
  }
  private own(id: string, agent: Agent, allowAdmin = true) {
    const value = this.active.get(id);
    if (!value || value.record.status !== "active")
      throw new ProxyError("proxy_lease_not_found", 404);
    if (value.record.owner !== actor(agent) && !(allowAdmin && proxyAdmin(agent)))
      throw new ProxyError("proxy_lease_not_found", 404);
    return value;
  }
  async list(agent: Agent) {
    await this.ready;
    this.collect();
    return Object.values(this.state.leases)
      .filter((r) => r.owner === actor(agent) || proxyAdmin(agent))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(snapshot);
  }
  async get(id: string, agent: Agent) {
    await this.ready;
    this.collect();
    const row = lookup(this.state.leases, id);
    if (!row || (row.owner !== actor(agent) && !proxyAdmin(agent)))
      throw new ProxyError("proxy_lease_not_found", 404);
    return snapshot(row);
  }
  private async probe(proxy: string, signal: AbortSignal, timeout: number) {
    if (this.dependencies.probe) return this.dependencies.probe(proxy, signal, timeout);
    const result = await httpFetch({
      url: "https://ipwho.is/",
      proxy,
      timeout: timeout / 1000,
      maxBytes: 64000,
      signal,
    });
    if (result.status !== 200) throw new ProxyError("proxy_exit_check_failed", 502);
    const data = JSON.parse(Buffer.from(result.body, "base64").toString());
    return {
      ip: data.ip,
      timezone: data.timezone?.id,
      country: data.country_code,
      region: data.region ?? "",
    } as Exit;
  }
  async acquire(
    input: unknown,
    agent: Agent,
    transport?: { split?: boolean; raw?: string; session?: string; signal?: AbortSignal },
  ): Promise<LeaseRecord> {
    await this.ready;
    transport?.signal?.throwIfAborted();
    await this.dependencies.authorize?.(agent);
    if (this.stopped) throw new ProxyError("proxy_service_draining", 503);
    if (transport?.raw && !proxyAdmin(agent)) throw new ProxyError("proxy_admin_required", 403);
    const request = leaseInput.parse(input);
    if (request.identity) await this.dependencies.authorizeIdentity?.(request.identity, agent);
    if (
      request.identity &&
      !lookup(this.state.identities, request.identity) &&
      Object.keys(this.state.identities).length >= 1000
    )
      throw new ProxyError("proxy_identity_capacity", 429);
    const primary = this.profile(request.profile, agent);
    if (request.identity && primary.session === "rotating")
      throw new ProxyError("identity_requires_persistent_proxy");
    if (request.identity && this.bindings.has(request.identity))
      throw new ProxyError("proxy_identity_in_use");
    const candidates = request.identity
      ? [request.profile]
      : [request.profile, ...primary.fallback];
    const deadline = Date.now() + 30_000;
    let budget = min(request.budgetBytes, primary.budgetBytes, agent.dailyBudgetBytes);
    let failure: unknown;
    for (const name of [...new Set(candidates)]) {
      const template = this.profile(name, agent);
      let profile = template;
      profile = validateProfile({ ...profile, target: { ...profile.target, ...request.target } });
      if (profile.allowedCountries && !profile.allowedCountries.includes(profile.target.country))
        throw new ProxyError("proxy_country_not_allowed", 403);
      for (let attempt = 0; attempt < (request.identity ? 1 : 2); attempt++) {
        if (this.stopped) throw new ProxyError("proxy_service_draining", 503);
        if (deadline <= Date.now()) throw new ProxyError("proxy_allocation_timeout", 504);
        if (this.remaining(agent) <= 0 || (budget !== undefined && budget <= 0))
          throw new ProxyError("proxy_budget_exhausted", 429);
        if (
          this.active.size >= 64 ||
          [...this.active.values()].filter((v) => v.record.owner === actor(agent)).length >= 16
        )
          throw new ProxyError("proxy_lease_capacity", 429);
        const existing = request.identity
          ? lookup(this.state.identities, request.identity)
          : undefined;
        if (
          existing &&
          (existing.country !== profile.target.country ||
            (existing.binding && existing.binding !== binding(profile)) ||
            (existing.profile && existing.profile !== name))
        )
          throw new ProxyError("proxy_identity_route_conflict");
        const identity: Identity = existing ?? {
          country: profile.target.country,
          stickyId: freshSticky(),
        };
        const route = { ...profile, session: existing?.session ?? profile.session };
        if (request.identity && this.bindings.has(request.identity))
          throw new ProxyError("proxy_identity_in_use");
        const id = randomUUID(),
          now = Date.now();
        const record: LeaseRecord = {
          id,
          owner: actor(agent),
          agent: agent.name,
          profile: name,
          product: profile.provider === "custom" ? "custom" : profile.product,
          session: route.session,
          identity: request.identity,
          country: profile.target.country,
          createdAt: now,
          expiresAt: now + min(request.ttlSeconds, profile.ttlSeconds) * 1000,
          status: "preparing",
          txBytes: 0,
          rxBytes: 0,
          directBytes: 0,
          budgetBytes: min(budget, profile.budgetBytes, agent.dailyBudgetBytes),
        };
        const item: Runtime = {
          record,
          profile,
          policyBinding: binding(template),
          agent,
          abort: new AbortController(),
          requests: new Set(),
          ephemeral: Boolean(transport?.raw),
        };
        const cancel = () => item.abort.abort();
        transport?.signal?.addEventListener("abort", cancel, { once: true });
        if (transport?.signal?.aborted) cancel();
        this.active.set(id, item);
        this.state.leases[id] = record;
        if (request.identity) this.bindings.set(request.identity, id);
        const health =
          lookup(this.state.health, name) ??
          (this.state.health[name] = { attempts: 0, successes: 0, failures: 0 });
        health.attempts++;
        try {
          await this.store.persist();
          if (!this.allowed(item)) throw new ProxyError("proxy_allocation_cancelled", 410);
          const url = transport?.raw ?? upstream(route, identity.stickyId);
          item.server = (this.dependencies.forwarder ?? ((...args) => new ProxyServer(...args)))(
            url,
            transport?.split ?? false,
            () => this.allowed(item),
            request.identity,
          );
          await item.server.listen();
          if (record.status === "closed") {
            await item.server.close(true);
            throw new ProxyError("proxy_allocation_cancelled", 410);
          }
          const exit = await this.probe(
            item.server.url,
            item.abort.signal,
            Math.max(1, Math.min(20_000, deadline - Date.now())),
          );
          if (!isIP(exit.ip) || !exit.timezone || !exit.country)
            throw new ProxyError("proxy_exit_check_failed", 502);
          try {
            Intl.DateTimeFormat("en-US", { timeZone: exit.timezone });
          } catch {
            throw new ProxyError("proxy_exit_check_failed", 502);
          }
          if (exit.country !== profile.target.country)
            throw new ProxyError("proxy_country_mismatch", 502);
          if (existing?.lastExit && existing.lastExit.ip !== exit.ip)
            throw new ProxyError("proxy_identity_exit_changed");
          const host = request.host?.toLowerCase() ?? "";
          if (this.quarantined(name, host, exit.ip))
            throw new ProxyError("proxy_exit_quarantined", 502);
          if (!this.allowed(item)) throw new ProxyError("proxy_budget_or_lease_exhausted", 429);
          await this.dependencies.authorize?.(agent);
          if (request.identity)
            await this.dependencies.authorizeIdentity?.(request.identity, agent);
          if (!this.allowed(item)) throw new ProxyError("proxy_service_draining", 503);
          record.exit = exit;
          record.status = "active";
          if (request.identity)
            this.state.identities[request.identity] = {
              ...identity,
              session: route.session,
              profile: name,
              binding: binding(profile),
              lastExit: exit,
            };
          health.successes++;
          health.lastSuccessAt = Date.now();
          this.collect();
          await this.store.persist();
          if (!this.allowed(item)) throw new ProxyError("proxy_allocation_cancelled", 410);
          return snapshot(record);
        } catch (error) {
          health.failures++;
          health.lastFailure =
            error instanceof PublicError ? error.code : "proxy_exit_check_failed";
          failure = transport?.signal?.aborted
            ? new ProxyError("proxy_allocation_cancelled", 410)
            : error instanceof PublicError
              ? error
              : new ProxyError("proxy_exit_check_failed", 502);
          await this.finish(item, "allocation_failed");
          if (budget !== undefined) budget -= record.txBytes + record.rxBytes;
          if (
            !(failure instanceof ProxyError) ||
            ![
              "proxy_exit_check_failed",
              "proxy_country_mismatch",
              "proxy_exit_quarantined",
            ].includes(failure.code)
          )
            throw failure;
        } finally {
          transport?.signal?.removeEventListener("abort", cancel);
        }
      }
    }
    throw failure ?? new ProxyError("proxy_allocation_failed", 502);
  }
  private quarantined(profile: string, host: string, ip: string) {
    return (
      (this.state.bad[`${profile}:${host}`]?.[ip] ?? this.state.bad[host]?.[ip] ?? 0) > Date.now()
    );
  }
  async markBad(host: string, ip: string, profile?: string) {
    await this.ready;
    if (!isIP(ip) || !/^[A-Za-z0-9.-]{1,253}$/.test(host))
      throw new ProxyError("invalid_proxy_outcome", 400);
    const names = profile
      ? [profile]
      : [
          ...new Set(
            [...this.active.values()]
              .filter((v) => v.record.exit?.ip === ip)
              .map((v) => v.record.profile),
          ),
        ];
    for (const name of names)
      (this.state.bad[`${name}:${host.toLowerCase()}`] ??= {})[ip] = Date.now() + 3_600_000;
    await this.store.persist();
  }
  async report(
    id: string,
    host: string,
    outcome: "ok" | "blocked" | "rate_limited" | "transport_failed",
    agent: Agent,
  ) {
    const lease = await this.get(id, agent);
    if (lease.owner !== actor(agent)) throw new ProxyError("proxy_lease_not_found", 404);
    const key = `${lease.profile}:${host.toLowerCase()}`;
    if (!this.state.health[key] && Object.keys(this.state.health).length >= 1024)
      throw new ProxyError("proxy_health_capacity", 429);
    const health = (this.state.health[key] ??= { attempts: 0, successes: 0, failures: 0 });
    health.attempts++;
    if (outcome === "ok") {
      health.successes++;
      health.lastSuccessAt = Date.now();
    } else {
      health.failures++;
      health.lastFailure = outcome;
    }
    if (outcome === "blocked" && lease.exit) await this.markBad(host, lease.exit.ip, lease.profile);
    await this.store.persist();
    return { id, host, outcome, quarantined: outcome === "blocked" && Boolean(lease.exit) };
  }
  async health(agent: Agent) {
    await this.ready;
    if (!proxyAdmin(agent)) throw new ProxyError("proxy_admin_required", 403);
    return structuredClone(this.state.health);
  }
  private async finish(item: Runtime, reason: string) {
    const work = (item.close ??= (async () => {
      item.record.status = "closed";
      item.record.reason = reason;
      item.abort.abort();
      for (const request of item.requests) request.abort();
      try {
        await item.server?.close(true);
      } catch {
        throw new ProxyError("proxy_cleanup_failed", 503);
      }
      this.collect();
      await this.store.persist();
      this.active.delete(item.record.id);
      if (item.record.identity && this.bindings.get(item.record.identity) === item.record.id)
        this.bindings.delete(item.record.identity);
    })());
    try {
      await work;
    } catch (error) {
      if (item.close === work) item.close = undefined;
      throw error;
    }
  }
  async release(id: string, agent: Agent, reason = "released") {
    await this.ready;
    await this.get(id, agent);
    const item = this.active.get(id);
    if (item?.session) throw new ProxyError("proxy_lease_attached_to_browser");
    if (item) await this.finish(item, reason);
    return this.get(id, agent);
  }
  async renew(id: string, seconds: number, agent: Agent) {
    await this.ready;
    const item = this.own(id, agent);
    await this.dependencies.authorize?.(agent);
    if (item.record.identity)
      await this.dependencies.authorizeIdentity?.(item.record.identity, agent);
    if (!this.allowed(item)) throw new ProxyError("proxy_lease_expired", 410);
    const profile = item.ephemeral ? item.profile : this.profile(item.record.profile, agent);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > profile.ttlSeconds)
      throw new ProxyError("invalid_proxy_lease_duration", 400);
    item.record.expiresAt = Date.now() + seconds * 1000;
    await this.store.persist();
    return snapshot(item.record);
  }
  async fetch(
    id: string,
    input: {
      url: string;
      method?: "GET" | "POST";
      data?: string;
      headers?: Record<string, string>;
      maxBytes?: number;
      timeout?: number;
    },
    agent: Agent,
    signal?: AbortSignal,
  ) {
    await this.ready;
    await this.dependencies.authorize?.(agent);
    const item = this.own(id, agent, false);
    if (item.record.identity)
      await this.dependencies.authorizeIdentity?.(item.record.identity, agent);
    if (!this.allowed(item)) throw new ProxyError("proxy_budget_or_lease_exhausted", 429);
    const controller = new AbortController();
    item.requests.add(controller);
    try {
      return await httpFetch({
        ...input,
        proxy: item.server!.url,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        maxBytes: Math.max(
          1,
          Math.floor(min(input.maxBytes ?? 8_000_000, this.remainingLease(item), 64_000_000)),
        ),
        timeout: Math.max(
          0.001,
          Math.min(input.timeout ?? 30, (item.record.expiresAt - Date.now()) / 1000),
        ),
      });
    } finally {
      item.requests.delete(controller);
      this.collect();
      await this.store.persist();
    }
  }
  async prepare(session: BrowserSession, agent: Agent) {
    const options = session.options;
    if (!options.residential && !options.proxyUrl && !options.proxyProfile && !options.proxyLeaseId)
      return;
    let lease: LeaseRecord;
    const supplied = Boolean(options.proxyLeaseId);
    if (supplied) {
      await this.ready;
      const item = this.own(options.proxyLeaseId!, agent, false);
      if (item.session || item.requests.size || item.record.identity !== options.identity)
        throw new ProxyError("proxy_lease_attachment_conflict");
      if (!this.allowed(item)) throw new ProxyError("proxy_budget_or_lease_exhausted", 429);
      lease = snapshot(item.record);
    } else
      lease = await this.acquire(
        {
          profile: options.proxyProfile ?? "core",
          identity: options.identity,
          ...(options.residential ? { target: { country: options.residential.country } } : {}),
          host: options.targetUrl ? new URL(options.targetUrl).hostname : undefined,
          budgetBytes: options.budgetBytes,
        },
        agent,
        { split: options.splitTraffic, raw: options.proxyUrl, session: session.id },
      );
    const item = this.own(lease.id, agent, false);
    if (item.record.session === "rotating") {
      if (!supplied) await this.finish(item, "browser_requires_persistent_proxy");
      throw new ProxyError("browser_requires_persistent_proxy");
    }
    if (item.session) throw new ProxyError("proxy_lease_attachment_conflict");
    item.session = session.id;
    item.autoSession = !supplied;
    this.sessions.set(session.id, lease.id);
    options.proxyLeaseId = lease.id;
    session.exit = lease.exit;
    options.timezone = lease.exit!.timezone;
    const server = item.server!,
      tx = supplied ? server.txBytes : 0,
      rx = supplied ? server.rxBytes : 0;
    // The lease owns closing; a browser borrows a per-session view of its counters.
    session.proxyServer = {
      get url() {
        return server.url;
      },
      get upstreamProxyUrl() {
        return server.upstreamProxyUrl;
      },
      get txBytes() {
        return Math.max(0, server.txBytes - tx);
      },
      get rxBytes() {
        return Math.max(0, server.rxBytes - rx);
      },
      get directBytes() {
        return server.directBytes;
      },
      get traffic() {
        return server.traffic;
      },
      listen: async () => {},
      close: async () => {},
    };
  }
  async settle(sessionId: string) {
    await this.ready;
    const id = this.sessions.get(sessionId),
      item = id ? this.active.get(id) : undefined;
    this.sessions.delete(sessionId);
    if (!item) return;
    item.session = undefined;
    if (item.autoSession) await this.finish(item, "browser_released");
    else {
      this.collect();
      await this.store.persist();
    }
  }
  async saveIdentity(name: string, identity: Identity) {
    await this.ready;
    proxyName.parse(name);
    if (this.bindings.has(name)) throw new ProxyError("proxy_identity_in_use");
    const existing = lookup(this.state.identities, name);
    if (
      existing &&
      (existing.country !== identity.country || existing.stickyId !== identity.stickyId)
    )
      throw new ProxyError("proxy_identity_route_conflict");
    this.state.identities[name] = existing ?? identity;
    await this.store.persist();
  }
  async identities() {
    await this.ready;
    return Object.entries(this.state.identities).map(([name, v]) => ({
      name,
      country: v.country,
      lastExit: v.lastExit,
    }));
  }
  async forgetIdentity(name: string) {
    await this.ready;
    proxyName.parse(name);
    if (this.bindings.has(name)) throw new ProxyError("proxy_identity_in_use");
    delete this.state.identities[name];
    await this.store.persist();
  }
  async rotateIdentity(name: string, agent: Agent) {
    await this.ready;
    proxyName.parse(name);
    if (!proxyAdmin(agent)) throw new ProxyError("proxy_admin_required", 403);
    if (this.bindings.has(name)) throw new ProxyError("proxy_identity_in_use");
    const identity = lookup(this.state.identities, name);
    if (!identity) throw new ProxyError("proxy_identity_not_found", 404);
    this.state.identities[name] = {
      ...identity,
      stickyId: freshSticky(),
      lastExit: undefined,
      session: undefined,
    };
    await this.store.persist();
    return {
      name,
      rotated: true,
      note: "Next allocation verifies the new exit; browser state is retained",
    };
  }
  async totals() {
    await this.ready;
    this.collect();
    await this.store.persist();
    return {
      date: utcDay(),
      totalProxyBytes: this.state.total,
      totalResidentialBytes: this.state.total,
      agents: structuredClone(this.state.days[utcDay()] ?? {}),
      totalByAgent: structuredClone(this.state.lifetime),
      products: structuredClone(this.state.products),
      units: "observed upstream bytes; provider billing is separate",
      activeLeases: this.active.size,
    };
  }
  async tick() {
    await this.ready;
    this.collect();
    const ended: string[] = [];
    for (const item of [...this.active.values()]) {
      if (item.record.status === "closed") {
        if (item.session) ended.push(item.session);
        await this.finish(item, item.record.reason ?? "cleanup_retry");
        continue;
      }
      if (item.record.status !== "active") continue;
      let identityAllowed = true;
      if (item.record.identity)
        try {
          await this.dependencies.authorizeIdentity?.(item.record.identity, item.agent);
        } catch {
          identityAllowed = false;
        }
      if (!identityAllowed || !this.allowed(item)) {
        if (item.session) ended.push(item.session);
        await this.finish(
          item,
          !identityAllowed
            ? "identity_access_revoked"
            : item.record.expiresAt <= Date.now()
              ? "expired"
              : "budget_or_policy_exhausted",
        );
      }
    }
    for (const [host, ips] of Object.entries(this.state.bad)) {
      for (const [ip, until] of Object.entries(ips)) if (until <= Date.now()) delete ips[ip];
      if (!Object.keys(ips).length) delete this.state.bad[host];
    }
    const closed = Object.values(this.state.leases)
      .filter((r) => r.status === "closed")
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const row of closed.slice(1000)) delete this.state.leases[row.id];
    for (const date of Object.keys(this.state.days).sort().slice(0, -90))
      delete this.state.days[date];
    await this.store.persist();
    return ended;
  }
  async close() {
    await this.ready;
    this.stopped = true;
    const results = await Promise.allSettled(
      [...this.active.values()].map((item) => this.finish(item, "worker_shutdown")),
    );
    if (results.some((r) => r.status === "rejected"))
      throw new ProxyError("proxy_shutdown_incomplete", 503);
  }
}
