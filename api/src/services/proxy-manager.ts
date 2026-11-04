// Owns residential identity exits and durable byte totals. Never persist proxy
// credentials, reset spend during a retry, or let a named identity change exits.
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { BrowserSession } from "./browser-session.js";
import { ProxyServer } from "../utils/proxy.js";

export const DAILY_BUDGET = 1_000_000_000;
export type Agent = { name: string; dailyBudgetBytes: number; admin?: boolean };
export type Exit = { ip: string; timezone: string; country: string; region: string };
type Identity = { country: string; stickyId: string; lastExit?: Exit };
type State = {
  days: Record<string, Record<string, number>>;
  total: number;
  identities: Record<string, Identity>;
  bad: Record<string, Record<string, number>>;
};
const empty = (): State => ({ days: {}, total: 0, identities: {}, bad: {} });
const day = () => new Date().toISOString().slice(0, 10);
export class ProxyManager {
  private state: State = empty();
  private ready: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private active = new Map<string, { session: BrowserSession; agent: Agent; accounted: number }>();
  constructor(readonly root: string) {
    this.ready = this.load();
  }
  private async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await readFile(path.join(this.root, "proxy-state.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private async persist() {
    const text = JSON.stringify(this.state);
    const work = this.serial.then(async () => {
      const file = path.join(this.root, "proxy-state.json");
      await writeFile(file + ".tmp", text, { mode: 0o600 });
      await rename(file + ".tmp", file);
    });
    this.serial = work.catch(() => undefined);
    await work;
  }
  private collect() {
    let changed = false;
    const today = (this.state.days[day()] ??= {});
    for (const item of this.active.values()) {
      const server = item.session.proxyServer;
      const current =
        item.session.priorProxyRxBytes +
        item.session.priorProxyTxBytes +
        (server?.rxBytes ?? 0) +
        (server?.txBytes ?? 0);
      const delta = Math.max(0, current - item.accounted);
      if (delta) {
        today[item.agent.name] = (today[item.agent.name] ?? 0) + delta;
        this.state.total += delta;
        item.accounted = current;
        changed = true;
      }
    }
    return changed;
  }
  remaining(agent: Agent) {
    this.collect();
    return agent.dailyBudgetBytes - (this.state.days[day()]?.[agent.name] ?? 0);
  }
  async totals() {
    await this.ready;
    this.collect();
    await this.persist();
    const totalByAgent: Record<string, number> = {};
    for (const totals of Object.values(this.state.days)) {
      for (const [agent, bytes] of Object.entries(totals))
        totalByAgent[agent] = (totalByAgent[agent] ?? 0) + bytes;
    }
    return {
      date: day(),
      totalResidentialBytes: this.state.total,
      agents: this.state.days[day()] ?? {},
      totalByAgent,
    };
  }
  async saveIdentity(name: string, identity: Identity) {
    await this.ready;
    const existing = this.state.identities[name];
    if (
      existing &&
      (existing.stickyId !== identity.stickyId || existing.country !== identity.country)
    )
      throw Object.assign(new Error("Identity already has a different exit; migration refused"), {
        statusCode: 409,
      });
    this.state.identities[name] = existing ?? identity;
    await this.persist();
  }
  async identities() {
    await this.ready;
    return Object.entries(this.state.identities).map(([name, v]) => ({
      name,
      country: v.country,
      lastExit: v.lastExit,
    }));
  }
  async markBad(host: string, ip: string) {
    await this.ready;
    (this.state.bad[host] ??= {})[ip] = Date.now() + 3_600_000;
    await this.persist();
  }
  async prepare(session: BrowserSession, agent: Agent) {
    await this.ready;
    const options = session.options;
    if (!options.residential && !options.proxyUrl) return;
    if (this.remaining(agent) <= 0)
      throw Object.assign(new Error("Daily residential byte budget exhausted"), {
        statusCode: 429,
      });
    let identity = options.identity && this.state.identities[options.identity];
    if (identity && options.residential && identity.country !== options.residential.country)
      throw Object.assign(new Error("Identity country differs from requested exit"), {
        statusCode: 409,
      });
    if (options.residential && !identity) {
      identity = { country: options.residential.country, stickyId: randomBytes(4).toString("hex") };
      if (options.identity) {
        this.state.identities[options.identity] = identity;
        await this.persist();
      }
    }
    const host = options.targetUrl ? new URL(options.targetUrl).hostname : "";
    // A refused IP causes a fresh throwaway allocation; identities retain their sticky ID.
    for (let attempt = 0; attempt < 3; attempt++) {
      let upstream = options.proxyUrl;
      if (identity) {
        const base = process.env.EVOMI_RESIDENTIAL_PROXY_URL;
        if (!base) throw new Error("Evomi Core is not configured on the service");
        const url = new URL(base);
        if (url.hostname !== "core-residential.evomi.com")
          throw new Error("Only Evomi Core is enabled");
        const stickyId =
          options.identity || attempt === 0 ? identity.stickyId : randomBytes(4).toString("hex");
        url.password = `${decodeURIComponent(url.password)}_country-${
          identity.country
        }_hardsession-${stickyId}`;
        upstream = url.toString();
      }
      if (!upstream) throw new Error("Residential exit unavailable");
      const proxy = new ProxyServer(
        upstream,
        options.splitTraffic,
        () => this.remaining(agent) > 0 && session.status !== "released",
      );
      session.proxyServer = proxy;
      const previous = this.active.get(session.id);
      this.active.set(session.id, { session, agent, accounted: previous?.accounted ?? 0 });
      await proxy.listen();
      try {
        const response = await axios.get("https://ipwho.is/", {
          httpsAgent: new HttpsProxyAgent(proxy.url),
          proxy: false,
          timeout: 20_000,
          maxContentLength: 64_000,
        });
        const data = response.data;
        if (!data.success || !data.ip || !data.timezone?.id)
          throw new Error("Exit lookup returned no timezone");
        Intl.DateTimeFormat("en-US", { timeZone: data.timezone.id });
        const exit: Exit = {
          ip: data.ip,
          timezone: data.timezone.id,
          country: data.country_code,
          region: data.region,
        };
        session.exit = exit;
        options.timezone = exit.timezone;
        if (identity && options.identity) {
          identity.lastExit = exit;
          await this.persist();
        }
        if (!options.identity && (this.state.bad[host]?.[exit.ip] ?? 0) > Date.now()) {
          await proxy.close(true);
          this.collect();
          await this.persist();
          if (attempt === 2) throw new Error("Repeated bad exit for this host");
          session.priorProxyTxBytes += proxy.txBytes;
          session.priorProxyRxBytes += proxy.rxBytes;
          continue;
        }
        this.collect();
        await this.persist();
        if (this.remaining(agent) <= 0)
          throw new Error("Daily residential byte budget exhausted during exit check");
        return;
      } catch (error) {
        await proxy.close(true);
        this.collect();
        await this.persist();
        // Never include axios errors: their request configuration contains credentials.
        throw Object.assign(
          new Error(
            error instanceof Error && error.message.startsWith("Daily")
              ? error.message
              : "Residential exit check failed",
          ),
          { statusCode: 502 },
        );
      }
    }
  }
  async tick() {
    await this.ready;
    if (this.collect()) await this.persist();
    return [...this.active.values()]
      .filter(
        ({ session, agent }) =>
          this.remaining(agent) <= 0 ||
          (session.options.budgetBytes !== undefined &&
            (session.proxyServer?.txBytes ?? 0) + (session.proxyServer?.rxBytes ?? 0) >=
              session.options.budgetBytes),
      )
      .map((v) => v.session.id);
  }
  async settle(id: string) {
    await this.ready;
    this.collect();
    await this.persist();
    this.active.delete(id);
  }
}
