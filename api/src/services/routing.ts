// Select a route by verified payload, recording first attempts separately from
// retries. Identity cookies must never enter an anonymous HTTP probe.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import type { SessionPool } from "./session-pool.js";
import type { Agent } from "./proxy-manager.js";
import { httpFetch } from "./http-fetch.js";
import { clearChallenge, challengeMarker } from "./challenge-service.js";

export const routeChecks: Record<string, { host: string; minimum: number; selector: string }> = {
  annas: { host: "annas-archive.pk", minimum: 3, selector: 'a[href*="/md5/"]' },
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
  const real = check ? payloads >= check.minimum : text.length > 100;
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
};
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
  async policy(host: string, split: boolean, startRung?: number, ttlSeconds?: number) {
    await this.ready;
    const current = this.entries[host];
    this.entries[host] = {
      ...current,
      rung: startRung ?? current?.rung ?? 3,
      startRung: startRung ?? current?.startRung,
      ttlSeconds: ttlSeconds ?? current?.ttlSeconds,
      expires: startRung === undefined ? current?.expires ?? 0 : 0,
      split,
    };
    await this.save();
  }
  async fetch(
    options: {
      url: string;
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
    const host = new URL(options.url).hostname;
    const route =
      options.route ?? Object.keys(routeChecks).find((k) => routeChecks[k].host === host);
    if (route && routeChecks[route]?.host !== host)
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
            return { status: "ok", rung, attempts, html, url: response.url };
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
            if (!released && !retained && (rung < 3 || !session.challenge))
              await this.pool.release(session.id);
            // A retry releases its failed throwaway browser, including a visual puzzle.
            if (retrying && session.status === "live")
              await this.pool.release(session.id, "challenge_retry");
          }
        }
      }
      this.entries[host] = nextEntry(Math.min(3, rung + 1));
      await this.save();
    }
    return { status: "failed", attempts };
  }
}
