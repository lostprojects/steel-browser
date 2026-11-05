// Select a route by verified payload, recording first attempts separately from
// retries. Identity cookies must never enter an anonymous HTTP probe.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import type { SessionPool } from "./session-pool.js";
import type { Agent } from "./proxy-manager.js";
import { httpFetch } from "./http-fetch.js";
import { clearChallenge, challengeMarker } from "./challenge-service.js";
import { randomUUID } from "node:crypto";

// Registry rows share routes.json with learned rungs and measured split policies.
// Do not put credentials or a second copy of identity exit allocations here.
export type Site = {
  site: string;
  url: string;
  identity: string | null;
  mode: "agent" | "quiet";
  country: string | null;
  loginSite: string | null;
};
const sites: Array<Site & { startRung: number }> = [
  {
    site: "udn",
    url: "https://newspapers.lib.utah.edu/",
    identity: null,
    mode: "agent",
    country: null,
    startRung: 2,
    loginSite: null,
  },
  {
    site: "annas",
    url: "https://annas-archive.pk/",
    identity: null,
    mode: "agent",
    country: null,
    startRung: 2,
    loginSite: null,
  },
  {
    site: "bizapedia",
    url: "https://www.bizapedia.com/",
    identity: "bizapedia",
    mode: "quiet",
    country: "US",
    startRung: 3,
    loginSite: null,
  },
  ...["ancestry", "newspapers", "fold3"].map((site) => ({
    site,
    url: `https://www.${site}.com/`,
    identity: "ancestry",
    mode: "quiet" as const,
    country: "US",
    startRung: 3,
    loginSite: site,
  })),
  {
    site: "mary-ferrell",
    url: "https://www.maryferrell.org/",
    identity: "mary-ferrell",
    mode: "quiet",
    country: "US",
    startRung: 3,
    loginSite: "mary-ferrell",
  },
  ...Object.entries({
    dtic: "apps.dtic.mil",
    fbi: "vault.fbi.gov",
    crest: "www.cia.gov",
    yale: "collections.library.yale.edu",
    aip: "repository.aip.org",
    documentcloud: "api.www.documentcloud.org",
    dpia: "www.dpiarchive.com",
    hathitrust: "babel.hathitrust.org",
    kroki: "kroki.io",
    wayback: "web.archive.org",
    nara: "catalog.archives.gov",
    viaf: "viaf.org",
  }).map(([site, host]) => ({
    site,
    url: `https://${host}/`,
    identity: null,
    mode: "agent" as const,
    country: null,
    startRung: 1,
    loginSite: null,
  })),
  ...[
    "azmemory.azlibrary.gov",
    "www.coloradohistoricnewspapers.org",
    "www.ppc-historicnewspapers.org",
  ].map((host) => ({
    site: host,
    url: `https://${host}/`,
    identity: "residential-US",
    mode: "quiet" as const,
    country: "US",
    startRung: 3,
    loginSite: null,
  })),
  ...["gd", "gl"].map((tld) => ({
    site: `annas-${tld}`,
    url: `https://annas-archive.${tld}/`,
    identity: null,
    mode: "agent" as const,
    country: null,
    startRung: 2,
    loginSite: null,
  })),
];

export const routeChecks: Record<string, { host: string; minimum: number; selector: string }> = {
  annas: { host: "annas-archive.pk", minimum: 1, selector: 'a[href*="/md5/"]' },
  bizapedia: {
    host: "www.bizapedia.com",
    minimum: 10,
    selector: 'a[href*="/people/"],a[href*="/company/"],a[href*="/officers/"]',
  },
  udn: {
    host: "newspapers.lib.utah.edu",
    minimum: 3,
    selector: 'a[href*="/details"],a[href*="/ark:"]',
  },
  ancestry: {
    host: "www.ancestry.com",
    minimum: 1,
    selector:
      'input[type="password"],input[type="email"],input[name="username"],iframe[src*="signin"],iframe[src*="login"]',
  },
  newspapers: {
    host: "www.newspapers.com",
    minimum: 1,
    selector: 'input[type="password"],input[type="email"]',
  },
  fold3: {
    host: "www.fold3.com",
    minimum: 1,
    selector: 'input[type="password"],input[type="email"],input[name="username"]',
  },
};
export function validPayload(
  html: string,
  status: number,
  headers: Record<string, string>,
  route?: string,
  baseUrl?: string,
) {
  const $ = load(html);
  if (baseUrl) {
    $("a[href]").each((_index, element) => {
      try {
        $(element).attr("href", new URL($(element).attr("href")!, baseUrl).href);
      } catch {
        /* Invalid page links do not count as payload. */
      }
    });
  }
  const title = $("title").text();
  const text = $("body").text().trim();
  const check = route && routeChecks[route];
  const payloads = check ? $(check.selector).length : text.length;
  let real = check ? payloads >= check.minimum : text.length > 100;
  if (route === "annas" && /No files found/i.test(text)) real = true;
  if (route === "udn" && /Utah Digital Newspapers/.test(title))
    real ||=
      !!$(".main-search-results").length ||
      (!!$("h4#title").length && !!$("td[data-field=type_t]").length);
  if (route && ["ancestry", "newspapers", "fold3"].includes(route))
    real ||=
      !!$(
        '#navAccountUsername,#navAccount,[data-cy="member-menu"],a[href="/signoff"],[data-cy="footer-sign-out"]',
      ).length && text.length > 200;
  // Utah's HTTP 418 can contain its real search payload.
  const blocked =
    headers["cf-mitigated"] === "challenge" ||
    challengeMarker(title) ||
    (!real && (status === 418 || status === 429 || /__ddg/.test(headers["set-cookie"] ?? ""))) ||
    ((status === 403 || status === 503) && /cloudflare/i.test(headers.server ?? ""));
  return {
    pass:
      real && !blocked && ((status >= 200 && status < 400) || (route === "udn" && status === 418)),
    payloads,
    title,
  };
}
type Entry = {
  rung: number;
  expires: number;
  split: boolean;
  startRung?: number;
  ttlSeconds?: number;
} & Partial<Site>;
const initialRungs: Record<string, number> = { annas: 2, udn: 2, newspapers: 1 };
export class Routing {
  private entries: Record<string, Entry> = {};
  private ready: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private pool: SessionPool,
    private root: string,
  ) {
    this.ready = this.read();
  }
  private async read() {
    await mkdir(this.root, { recursive: true });
    try {
      this.entries = JSON.parse(await readFile(path.join(this.root, "routes.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const site of sites) {
      const host = new URL(site.url).hostname;
      const current = this.entries[host];
      const defaults: Entry = { rung: site.startRung, expires: 0, split: false, ...site };
      this.entries[host] = {
        ...defaults,
        ...current,
        // A public sign-in probe's learned rung does not change identity sessions.
        ...(site.identity === "ancestry"
          ? { identity: "ancestry", country: "US", mode: "quiet", loginSite: site.loginSite }
          : {}),
      };
    }
    await this.save();
  }
  private async save() {
    const text = JSON.stringify(this.entries);
    const result = this.writes.then(async () => {
      const file = path.join(this.root, "routes.json");
      await writeFile(file + ".tmp", text, { mode: 0o600 });
      await rename(file + ".tmp", file);
    });
    this.writes = result.catch(() => undefined);
    await result;
  }
  async table() {
    await this.ready;
    return this.entries;
  }
  async resolve(siteOrUrl: string) {
    await this.ready;
    const entry = Object.entries(this.entries).find(([, value]) => value.site === siteOrUrl);
    const url = entry
      ? entry[1].url ?? `https://${entry[0]}/`
      : /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(siteOrUrl)
      ? `https://${siteOrUrl}/`
      : siteOrUrl;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw Object.assign(new Error("Unknown site"), { statusCode: 400 });
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw Object.assign(new Error("Invalid site URL"), { statusCode: 400 });
    const host = parsed.hostname;
    const known = this.entries[host];
    return {
      host,
      site: known?.site ?? host,
      url: entry ? url : parsed.href,
      identity: known?.identity ?? null,
      mode: known?.mode ?? ("agent" as const),
      country: known?.country ?? null,
      loginSite: known?.loginSite ?? null,
      startRung: known && known.expires > Date.now() ? known.rung : known?.startRung ?? 1,
      split: known?.split ?? false,
    };
  }
  async registry() {
    await this.ready;
    return Promise.all(
      Object.entries(this.entries)
        .filter(([, value]) => value.site)
        .map(([host]) => this.resolve(`https://${host}/`)),
    );
  }
  async sessionOptions(body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const supplied = body as Record<string, any>;
    if (supplied.residential === false) {
      const direct = { ...supplied };
      delete direct.residential;
      direct.mode ??= "agent";
      if (!supplied.site && !supplied.targetUrl) return direct;
    }
    if (!supplied.site && !supplied.targetUrl) return body;
    const site = await this.resolve(supplied.site ?? supplied.targetUrl);
    if (supplied.site && supplied.targetUrl && new URL(supplied.targetUrl).hostname !== site.host)
      throw Object.assign(new Error("Site does not match target host"), { statusCode: 400 });
    if (
      site.identity === "ancestry" &&
      ((supplied.identity && supplied.identity !== "ancestry") ||
        (supplied.profile && supplied.profile !== "ancestry"))
    )
      throw Object.assign(new Error("Ancestry family requires its known identity"), {
        statusCode: 403,
      });
    const resolved: Record<string, any> = {
      targetUrl: site.url,
      mode: site.mode,
      ...(site.identity ? { identity: site.identity } : {}),
      ...(site.country ? { residential: { country: site.country } } : {}),
      ...supplied,
      site: site.site,
    };
    if (supplied.residential === false) {
      delete resolved.residential;
      resolved.mode = supplied.mode ?? "agent";
    }
    return resolved;
  }
  async policy(
    host: string,
    split?: boolean,
    startRung?: number,
    ttlSeconds?: number,
    site?: Partial<Site>,
  ) {
    await this.ready;
    const current = this.entries[host];
    if (
      site?.site &&
      Object.entries(this.entries).some(
        ([other, entry]) => other !== host && entry.site === site?.site,
      )
    )
      throw Object.assign(new Error("Site name already belongs to another host"), {
        statusCode: 409,
      });
    if (site?.site && !site.url) site = { ...site, url: current?.url ?? `https://${host}/` };
    this.entries[host] = {
      ...current,
      ...site,
      rung: startRung ?? current?.rung ?? 3,
      startRung: startRung ?? current?.startRung,
      ttlSeconds: ttlSeconds ?? current?.ttlSeconds,
      expires: startRung === undefined ? current?.expires ?? 0 : 0,
      split: split ?? current?.split ?? false,
    };
    await this.save();
  }
  async fetch(
    options: {
      url: string;
      site?: string;
      caller?: string;
      outcomeAttemptId?: string;
      route?: string;
      startRung?: number;
      identity?: string;
      country?: string;
      retry?: boolean;
      retain?: boolean;
      splitTraffic?: boolean;
      maxRung?: number;
      forceDirectFailure?: boolean;
    },
    agent: Agent,
  ) {
    await this.ready;
    const spec = await this.resolve(options.site ?? options.url);
    if (spec) {
      if (new URL(options.url).hostname !== spec.host)
        throw Object.assign(new Error("Site does not match target host"), { statusCode: 400 });
      if (spec.identity === "ancestry" && options.identity && options.identity !== "ancestry")
        throw Object.assign(new Error("Ancestry family requires its known identity"), {
          statusCode: 403,
        });
      options = {
        ...options,
        site: spec.site,
        identity: options.identity ?? spec.identity ?? undefined,
        country: options.country ?? spec.country ?? undefined,
      };
    }
    const attemptId = randomUUID();
    let result;
    try {
      result = await this.fetchRoute(options, agent);
    } catch (error) {
      if (!options.outcomeAttemptId)
        await this.pool.outcomes?.result(
          {
            attemptId,
            caller: options.caller ?? "unattributed",
            site: spec?.site ?? new URL(options.url).hostname,
            backend: "steel",
            outcome: "failure",
            reason: "unavailable",
            fallback: false,
          },
          agent.name,
        );
      throw error;
    }
    try {
      if (!options.outcomeAttemptId)
        await this.pool.outcomes?.result(
          {
            attemptId,
            caller: options.caller ?? "unattributed",
            site: spec?.site ?? new URL(options.url).hostname,
            backend: "steel",
            outcome: result.status === "ok" ? "success" : "failure",
            reason:
              result.status === "ok"
                ? "completed"
                : result.status === "challenge_required"
                ? "challenge_required"
                : "payload_missing",
            fallback: false,
          },
          agent.name,
        );
      return result;
    } catch (error) {
      const retainedId = (result as { session?: { id: string } }).session?.id;
      if (retainedId) await this.pool.release(retainedId, "outcome_failed");
      throw error;
    }
  }
  private async fetchRoute(
    options: {
      url: string;
      site?: string;
      caller?: string;
      route?: string;
      startRung?: number;
      identity?: string;
      country?: string;
      retry?: boolean;
      retain?: boolean;
      splitTraffic?: boolean;
      maxRung?: number;
      forceDirectFailure?: boolean;
    },
    agent: Agent,
  ) {
    const host = new URL(options.url).hostname;
    const route =
      options.route ??
      (/^annas-archive\.(pk|gd|gl)$/.test(host)
        ? "annas"
        : Object.keys(routeChecks).find((k) => routeChecks[k].host === host));
    if (
      route &&
      routeChecks[route]?.host !== host &&
      !(route === "annas" && /^annas-archive\.(pk|gd|gl)$/.test(host))
    )
      throw Object.assign(new Error("Route does not match host"), { statusCode: 400 });
    const known = this.entries[host];
    if (options.forceDirectFailure && !agent.admin)
      throw Object.assign(new Error("Admin key required for failure injection"), {
        statusCode: 403,
      });
    const baseline = known?.startRung ?? (route ? initialRungs[route] ?? 3 : 1);
    const nextEntry = (rung: number): Entry => ({
      ...known,
      rung: Math.max(rung, known?.startRung ?? 1),
      split: known?.split ?? false,
      expires: Date.now() + (known?.ttlSeconds ?? 604800) * 1000,
    });
    const start = options.identity
      ? 3
      : options.startRung ?? (known && known.expires > Date.now() ? known.rung : baseline);
    const attempts: any[] = [];
    for (let rung = start; rung <= (options.maxRung ?? 3); rung++) {
      if (rung < 3 && options.forceDirectFailure) {
        attempts.push({
          rung,
          pass: false,
          error: "Injected direct failure",
          bytes: 0,
          seconds: 0,
        });
        this.entries[host] = nextEntry(rung + 1);
        await this.save();
        continue;
      }
      if (rung === 1) {
        const began = Date.now();
        try {
          const response = await httpFetch({ url: options.url });
          const html = Buffer.from(response.body, "base64").toString();
          const validation = validPayload(
            html,
            response.status,
            response.headers,
            route,
            response.url,
          );
          attempts.push({
            rung,
            ...validation,
            seconds: (Date.now() - began) / 1000,
            bytes: 0,
            directBytes: Buffer.byteLength(html),
          });
          if (validation.pass) {
            this.entries[host] = nextEntry(rung);
            await this.save();
            return {
              status: "ok",
              rung,
              attempts,
              html,
              url: response.url,
              httpStatus: response.status,
            };
          }
        } catch {
          attempts.push({
            rung,
            pass: false,
            error: "HTTP probe failed",
            bytes: 0,
            seconds: (Date.now() - began) / 1000,
          });
        }
      } else {
        const maxAttempts = rung === 3 && options.retry !== false && !options.identity ? 2 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const began = Date.now();
          let session;
          try {
            session = await this.pool.create(
              {
                mode: rung === 3 ? "quiet" : "agent",
                ...(rung === 3 ? { residential: { country: options.country ?? "US" } } : {}),
                identity: options.identity,
                site: options.site,
                caller: options.caller,
                targetUrl: options.url,
                splitTraffic: rung === 3 && (options.splitTraffic ?? known?.split ?? false),
              },
              agent,
              true,
            );
          } catch (error) {
            attempts.push({
              rung,
              retry: attempt > 0,
              pass: false,
              error: "Session or exit unavailable",
              seconds: (Date.now() - began) / 1000,
            });
            if ((error as any).statusCode === 429) throw error;
            if (attempt + 1 < maxAttempts) continue;
            break;
          }
          const before = session.info();
          let released = false;
          let retained = false;
          let retrying = false;
          try {
            const page = await session.getPrimaryPage();
            session.lastNavigation = Date.now();
            try {
              await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
            } catch {
              /* Validation below records the first attempt, including navigation failure. */
            }
            let html = "";
            let validation = { pass: false, payloads: 0, title: "" };
            let challenge: Awaited<ReturnType<typeof clearChallenge>> | undefined;
            const challengeActions: string[] = [];
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline && session.status === "live") {
              try {
                html = await page.evaluate(() => document.documentElement.outerHTML);
                validation = validPayload(html, 200, {}, route, page.url());
                if (validation.pass) break;
                // A redirect can insert a challenge after an earlier clear
                // observation. Recheck until the actual payload arrives.
                if (!challenge || challenge.status === "cleared") {
                  challenge = await clearChallenge(session, undefined, 45_000);
                  challengeActions.push(...challenge.actions);
                  if (challenge.status === "challenge_required") break;
                }
              } catch {
                /* A challenge redirect may replace the document. */
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
            const after = session.info();
            attempts.push({
              rung,
              retry: attempt > 0,
              ...validation,
              seconds: (Date.now() - began) / 1000,
              bytes:
                after.proxyTxBytes + after.proxyRxBytes - before.proxyTxBytes - before.proxyRxBytes,
              directBytes: after.directBytes - before.directBytes,
              sessionId: session.id,
              exit: session.exit,
              challengeActions,
            });
            if (validation.pass) {
              this.entries[host] = nextEntry(rung);
              await this.save();
              if (options.retain) {
                retained = true;
                return { status: "ok", rung, attempts, html, session: session.info() };
              }
              const settled = await this.pool.release(session.id);
              released = true;
              return { status: "ok", rung, attempts, html, settled };
            }
            if (session.exit) await this.pool.proxies?.markBad(host, session.exit.ip);
            if (rung === 3 && attempt + 1 === maxAttempts) {
              challenge ??= await clearChallenge(session, undefined, 1);
              if (challenge.status === "cleared") {
                const settled = await this.pool.release(session.id, "payload_missing");
                released = true;
                return { status: "failed", rung, attempts, settled };
              }
              if (!options.retain) {
                const settled = await this.pool.release(session.id, "challenge_required");
                released = true;
                return { status: "challenge_required", rung, attempts, settled };
              }
              retained = true;
              return {
                status: "challenge_required",
                rung,
                attempts,
                session: session.info(),
                challenge,
              };
            }
            retrying = attempt + 1 < maxAttempts;
          } finally {
            if (!released && !retained)
              await this.pool.release(session.id, retrying ? "challenge_retry" : "payload_missing");
          }
        }
      }
      this.entries[host] = nextEntry(Math.min(3, rung + 1));
      await this.save();
    }
    return { status: "failed", attempts };
  }
}
