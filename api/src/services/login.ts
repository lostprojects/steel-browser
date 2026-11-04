import type { SessionPool } from "./session-pool.js";
// Runs named login flows inside the service. Never return field values or ask a
// client to type credentials. Authentication needs a positive account payload.
import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BrowserSession } from "./browser-session.js";
import type { Agent } from "./proxy-manager.js";
import { vault, totp, protect } from "./vault.js";
import { QuietInput } from "./quiet-input.js";
import { clearChallenge } from "./challenge-service.js";

// `signedIn` marks a member page whose sign-out control sits in an unopened
// menu (observed 4 November 2026 on all three Ancestry-family sites).
// Newspapers.com's "Sign in with Ancestry" button opens /signin/api/ancestry/
// in a popup and ignores clicks while it thinks one is open, so the flow starts
// at that URL in the main tab. Its OAuth callback (`ssoReturn`) shows only
// "Please close the window"; the flow then loads `home` to confirm membership.
export const loginSites = {
  ancestry: {
    vault: "ancestry",
    url: "https://www.ancestry.com/account/signin",
    hosts: ["www.ancestry.com", "www.newspapers.com", "www.fold3.com"],
    signedIn: "#navAccountUsername,#navAccount",
  },
  newspapers: {
    vault: "ancestry",
    url: "https://www.newspapers.com/signin/api/ancestry/",
    hosts: ["www.newspapers.com", "www.ancestry.com"],
    signedIn: '[data-cy="member-menu"],a[href^="/account/edit-profile"]',
    ssoReturn: "/api/userauth/ancestry/sso",
    home: "https://www.newspapers.com/",
  },
  fold3: {
    vault: "ancestry",
    url: "https://www.fold3.com/login",
    hosts: ["www.fold3.com", "www.ancestry.com"],
    signedIn: 'a[href="/signoff"],[data-cy="footer-sign-out"]',
  },
  "mary-ferrell": {
    vault: "mary-ferrell",
    url: "https://www.maryferrell.org/member/signin",
    hosts: ["www.maryferrell.org"],
  },
  "hathitrust-google": {
    vault: "hathitrust-google",
    url: "https://babel.hathitrust.org/",
    hosts: ["babel.hathitrust.org", "accounts.google.com"],
  },
} as const;
export type LoginSite = keyof typeof loginSites;
// Ancestry's sign-in codes for this account arrive from info.ancestry.co.uk
// (observed 4 November 2026).
const codeSources: Record<string, { senderDomains: string[]; brands: string[] }> = {
  "www.ancestry.com": { senderDomains: ["ancestry.com", "ancestry.co.uk"], brands: ["Ancestry"] },
  "www.newspapers.com": { senderDomains: ["newspapers.com"], brands: ["Newspapers.com"] },
  "www.fold3.com": { senderDomains: ["fold3.com"], brands: ["Fold3"] },
  "www.maryferrell.org": { senderDomains: ["maryferrell.org"], brands: ["Mary Ferrell"] },
  "accounts.google.com": { senderDomains: ["google.com"], brands: ["Google"] },
};
export function identityVault(identity?: string) {
  return ["ancestry", "mary-ferrell", "hathitrust-google"].find(
    (n) => identity === n || identity?.startsWith(n + "-"),
  );
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeInputs =
  'input[autocomplete="one-time-code"],input[name*="code" i],input[id*="code" i],input[name*="otp" i],input[id*="otp" i]';
type LoginRecord = {
  last_login_ok?: string;
  last_exit_ip?: string;
  site: string;
  status: string;
  check: string;
  at: string;
};
type CodeRequest = {
  id: string;
  site: LoginSite;
  channel: "email" | "sms";
  after: string;
  expires: string;
  senderDomains: string[];
  brands: string[];
  recipientHash?: string;
  phoneSuffix?: string;
};
type PendingCode = {
  request: CodeRequest;
  agent: string;
  identity: string;
  url: string;
  back?: string;
};
export class LoginService {
  private records: Record<string, LoginRecord> = {};
  private active = new Map<string, Promise<unknown>>();
  private pendingCodes = new Map<string, PendingCode>();
  private writes: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  constructor(private root = "/data") {
    this.ready = this.load();
  }
  private async load() {
    try {
      this.records = JSON.parse(await readFile(path.join(this.root, "logins.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  startDailyChecks(pool: SessionPool) {
    let running = false;
    const timer = setInterval(async () => {
      if (running || pool.draining) return;
      running = true;
      try {
        await this.ready;
        const file = path.join(this.root, "login-daily.json");
        let checked: Record<string, string> = {};
        try {
          checked = JSON.parse(await readFile(file, "utf8"));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const today = new Date().toISOString().slice(0, 10);
        for (const [key, record] of Object.entries(this.records)) {
          const [identity, site] = key.split("/");
          if (
            !record.last_login_ok ||
            checked[key] === today ||
            pool.identityBusy(identity) ||
            pool.size ||
            pool.draining
          )
            continue;
          // Persist before opening a session so a restart cannot repeat a code request.
          checked[key] = today;
          await writeFile(file + ".tmp", JSON.stringify(checked), { mode: 0o600 });
          await rename(file + ".tmp", file);
          let session: BrowserSession | undefined;
          let outcome: any = { identity, site, status: "failed", check: "session_unavailable" };
          try {
            const agent = { name: "mosaic", dailyBudgetBytes: 1000000000 };
            session = await pool.create(
              { identity, mode: "quiet", residential: { country: "US" } },
              agent,
            );
            outcome = await this.login(session, site as LoginSite, agent);
          } catch {
            /* Report only a stable classification, with no browser payload. */
          } finally {
            if (session) await pool.release(session.id, "daily_login_check");
          }
          await appendFile(
            path.join(this.root, "login-checks.jsonl"),
            JSON.stringify({
              at: new Date().toISOString(),
              ...outcome,
              deviceCheck: [
                "email_mailbox_missing",
                "email",
                "sms",
                "totp",
                "device",
                "google",
              ].includes(outcome.check),
            }) + "\n",
            { mode: 0o600 },
          );
        }
      } catch {
        /* The next minute retries metadata I/O; attempted sites remain recorded. */
      } finally {
        running = false;
      }
    }, 60000);
    timer.unref();
    return () => clearInterval(timer);
  }
  async metadata() {
    await this.ready;
    return this.records;
  }
  private async record(
    session: BrowserSession,
    site: LoginSite,
    status: string,
    check: string,
    agent: Agent,
  ) {
    const identity = session.options.identity!;
    await session.getCookies().catch(() => undefined);
    const key = `${identity}/${site}`;
    const row = {
      ...this.records[key],
      site,
      status,
      check,
      at: new Date().toISOString(),
      last_exit_ip: session.exit?.ip,
    };
    if (status === "ok") row.last_login_ok = row.at;
    this.records[key] = row;
    session.lastLoginOk = row.last_login_ok;
    const text = JSON.stringify(this.records);
    const work = this.writes.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.root, "logins.json.tmp"), text, { mode: 0o600 });
      await rename(path.join(this.root, "logins.json.tmp"), path.join(this.root, "logins.json"));
    });
    this.writes = work.catch(() => undefined);
    await work;
    session.getLogger("login").info(
      {
        sessionId: session.id,
        agent: agent.name,
        identity,
        site,
        status,
        check,
        exitIp: session.exit?.ip,
      },
      "Login result",
    );
    return {
      identity,
      site,
      status,
      check,
      last_login_ok: row.last_login_ok,
      exitIp: session.exit?.ip,
    };
  }
  async codeRequest(session: BrowserSession, agent: Agent) {
    const pending = this.pendingCodes.get(session.id);
    if (!pending) return null;
    if (Date.parse(pending.request.expires) <= Date.now()) {
      this.pendingCodes.delete(session.id);
      return null;
    }
    if (pending.agent !== agent.name || pending.identity !== session.options.identity)
      throw Object.assign(new Error("Login code request belongs to another agent"), {
        statusCode: 403,
      });
    const allowed = await vault.list(agent, loginSites[pending.request.site].vault);
    if (!allowed.length)
      throw Object.assign(new Error("Vault entry unavailable for this agent"), { statusCode: 403 });
    const page = await session.getPrimaryPage();
    const waiting =
      page.url() === pending.url &&
      (await page.evaluate(
        (selector) =>
          [...document.querySelectorAll(selector)].some((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
          }),
        codeInputs,
      ));
    if (!waiting) {
      this.pendingCodes.delete(session.id);
      return null;
    }
    return pending.request;
  }
  async submitCode(session: BrowserSession, agent: Agent, requestId: string, code: string) {
    protect(code);
    const request = await this.codeRequest(session, agent);
    if (!request || request.id !== requestId)
      throw Object.assign(new Error("Login code request expired or unavailable"), {
        statusCode: 409,
      });
    const pending = this.pendingCodes.get(session.id);
    if (!pending || pending.request.id !== requestId)
      throw Object.assign(new Error("Login code request already consumed"), { statusCode: 409 });
    return this.login(session, request.site, agent, false, { ...pending, code });
  }
  async login(
    session: BrowserSession,
    site: LoginSite,
    agent: Agent,
    current = false,
    resume?: PendingCode & { code: string },
  ) {
    await this.ready;
    const spec = loginSites[site];
    if (identityVault(session.options.identity) !== spec.vault)
      throw Object.assign(new Error("Session identity does not match the login"), {
        statusCode: 403,
      });
    if (session.options.mode !== "quiet" || !session.display.name)
      throw Object.assign(new Error("Vault logins require quiet mode"), { statusCode: 409 });
    if (this.active.has(session.id))
      throw Object.assign(new Error("Login already running"), { statusCode: 409 });
    // A submission consumes its request before any input. A fresh login replaces it.
    this.pendingCodes.delete(session.id);
    for (const [id, pending] of this.pendingCodes)
      if (Date.parse(pending.request.expires) <= Date.now()) this.pendingCodes.delete(id);
    const job = vault.use(spec.vault, agent, async (fields) => {
      session.loginBusy = true;
      try {
        return await this.run(session, site, fields, agent, current, resume);
      } finally {
        session.loginBusy = false;
      }
    });
    this.active.set(session.id, job);
    try {
      return await job;
    } finally {
      this.active.delete(session.id);
    }
  }
  private async run(
    session: BrowserSession,
    site: LoginSite,
    fields: Readonly<Record<string, string>>,
    agent: Agent,
    current: boolean,
    resume?: PendingCode & { code: string },
  ) {
    const spec = loginSites[site];
    const page = await session.getPrimaryPage();
    const { width, height } = session.getDimensions();
    const input = new QuietInput(session.display.name!, width, height);
    const back = resume?.back ?? (current ? page.url() : undefined);
    const started = Date.now();
    const signedIn = "signedIn" in spec ? spec.signedIn : "";
    const state = () =>
      page.evaluate(({ otpSelector, signedIn }) => {
        const visible = (e: Element) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        const text = document.body?.innerText ?? "";
        const lower = text.toLowerCase();
        const inputs = [...document.querySelectorAll<HTMLInputElement>("input")].filter(visible);
        const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(visible);
        return {
          host: location.hostname,
          path: location.pathname,
          loggedIn:
            links.some(
              (a) =>
                /sign\s*out|log\s*out/i.test(a.textContent ?? "") ||
                /\/(?:signout|logout)(?:[/?]|$)/i.test(a.href),
            ) ||
            (!!signedIn &&
              !!document.querySelector(signedIn) &&
              !inputs.some((e) => e.type === "password")),
          mary: /sign out/i.test(text) && /my membership/i.test(text),
          signedOut:
            inputs.some((e) => e.type === "password") ||
            links.some((a) => /^(?:sign|log)\s*in$/i.test(a.textContent?.trim() ?? "")),
          password: inputs.some((e) => e.type === "password"),
          submitDisabled: [
            ...document.querySelectorAll<HTMLButtonElement>(
              'button[type="submit"],input[type="submit"]',
            ),
          ]
            .filter(visible)
            .some((e) => e.disabled || e.getAttribute("aria-disabled") === "true"),
          username: inputs.some((e) => /email|username|userId/i.test(e.name + e.id + e.type)),
          otp: inputs.some((e) => e.matches(otpSelector)),
          phoneSuffix: text.match(
            /(?:[\*•●x]{2,}[\s-]*|(?:phone|number)[\s\S]{0,35}ending (?:in )?)(\d{2,4})(?!\d)/i,
          )?.[1],
          check: /text message|sms|phone number.*code|code.*phone number/i.test(text)
            ? "sms"
            : /authenticator|authentication app/i.test(text)
            ? "totp"
            : /check your email|email.*(?:code|link)|(?:code|link).*email/i.test(text) &&
              /verify|verification|device|sent|check/i.test(text)
            ? "email"
            : /verify (?:it.s|your)|confirm it.s you|google prompt|check your.*(?:phone|device)|security key|passkey/i.test(
                text,
              )
            ? "device"
            : "none",
          rejected:
            /incorrect password|invalid password|password is incorrect|invalid username|couldn.t sign you in|wrong password/i.test(
              lower,
            ),
          codeRejected: /incorrect code|invalid code|code (?:has )?expired|code is incorrect/i.test(
            text,
          ),
          consent: [...document.querySelectorAll("button,a")].some(
            (e) => visible(e) && /^Accept (?:All )?Cookies$/i.test(e.textContent?.trim() ?? ""),
          ),
          oauth: [...document.querySelectorAll("button,a")].some(
            (e) => visible(e) && /(?:sign in|continue).*ancestry/i.test(e.textContent ?? ""),
          ),
        };
      }, { otpSelector: codeInputs, signedIn });
    const point = async (selector: string, label?: string) =>
      page.evaluate(
        ({ selector, label }) => {
          const e = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => {
            const r = e.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              (!label || new RegExp(label, "i").test(e.innerText || e.getAttribute("value") || ""))
            );
          });
          if (!e) return null;
          e.scrollIntoView({ block: "center" });
          const b = e.getBoundingClientRect();
          return {
            x: b.x + b.width / 2,
            y: b.y + b.height / 2,
            offset: {
              x: screenX + (outerWidth - innerWidth) / 2,
              y: screenY + outerHeight - innerHeight - (outerWidth - innerWidth) / 2,
            },
          };
        },
        { selector, label },
      );
    const click = async (selector: string, label?: string) => {
      // Native X11 input goes to the visible tab. A restored profile can have
      // another tab active even when CDP reads the primary page successfully.
      await page.bringToFront();
      const p = await point(selector, label);
      if (!p) return false;
      await input.mouse({ type: "mousePressed", x: p.x, y: p.y, button: "left" }, p.offset);
      await input.mouse({ type: "mouseReleased", x: p.x, y: p.y, button: "left" }, p.offset);
      return true;
    };
    const type = async (selector: string, value: string) => {
      if (!value) throw new Error("Required vault field is missing");
      if (!(await click(selector))) return false;
      await input.key({ type: "keyDown", key: "Control" });
      await input.key({ type: "keyDown", key: "a" });
      await input.key({ type: "keyUp", key: "a" });
      await input.key({ type: "keyUp", key: "Control" });
      await input.text(value);
      return true;
    };
    const go = async (url: string) => {
      session.lastNavigation = Date.now();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch {}
      await pause(1500);
    };
    if (current) {
      const s = await state();
      if (site === "mary-ferrell" ? s.mary : s.loggedIn)
        return this.record(session, site, "ok", "none", agent);
      if (!s.signedOut && s.check === "none")
        return { identity: session.options.identity, site, status: "unchecked", check: "none" };
    }
    if (site === "hathitrust-google")
      return this.record(session, site, "not_attempted", "google_flow_unimplemented", agent);
    if (resume) {
      if (page.url() !== resume.url || Date.parse(resume.request.expires) <= Date.now())
        return this.record(session, site, "failed", "code_request_changed", agent);
    } else await go(spec.url);
    let submissions = 0,
      otpUsed = false,
      check = "none";
    let submittedPassword = Boolean(resume);
    let formFilled = false;
    let formChallenges = 0;
    const deadline = Date.now() + 120000;
    for (let step = 0; step < 60 && Date.now() < deadline; step++) {
      session.touch();
      let s;
      try {
        s = await state();
      } catch {
        await pause(1000);
        continue;
      }
      if (!(spec.hosts as readonly string[]).includes(s.host) || !page.url().startsWith("https://"))
        return this.record(session, site, "failed", "unexpected_origin", agent);
      const targetHost = new URL(spec.url).hostname;
      if (s.host === targetHost && (site === "mary-ferrell" ? s.mary : s.loggedIn)) {
        if (back && back !== page.url()) await go(back);
        return this.record(session, site, "ok", check, agent);
      }
      if ("ssoReturn" in spec && s.host === targetHost && s.path.startsWith(spec.ssoReturn)) {
        await go(spec.home);
        continue;
      }
      if (s.rejected) return this.record(session, site, "failed", "credentials_rejected", agent);
      if (otpUsed && s.codeRejected)
        return this.record(session, site, "failed", "code_rejected", agent);
      if (
        resume &&
        !otpUsed &&
        (!s.otp ||
          s.check !== resume.request.channel ||
          page.url() !== resume.url ||
          Date.parse(resume.request.expires) <= Date.now())
      )
        return this.record(session, site, "failed", "code_request_changed", agent);
      if (s.consent) {
        await click("button,a", "^Accept (?:All )?Cookies$");
        await pause(1000);
        continue;
      }
      if (s.check !== "none" && !s.password) {
        check = s.check;
        if (resume && !otpUsed) {
          if (!(await type(codeInputs, resume.code)))
            return this.record(session, site, "failed", "code_field_missing", agent);
          await click(
            'button[type="submit"],input[type="submit"],button',
            "verify|continue|submit|confirm|sign in|log in|next",
          );
          otpUsed = true;
          await pause(2000);
          continue;
        }
        if (resume && otpUsed && s.check === resume.request.channel) {
          await pause(2000);
          continue;
        }
        if (s.check === "totp" && fields.totpSeed && s.otp && !otpUsed) {
          await type(codeInputs, totp(fields.totpSeed));
          await click(
            'button[type="submit"],input[type="submit"],button',
            "verify|continue|submit|confirm",
          );
          otpUsed = true;
          await pause(2000);
          continue;
        }
        if (!resume && s.otp && (s.check === "email" || s.check === "sms")) {
          const source = codeSources[s.host];
          if (!source) return this.record(session, site, "check_required", s.check, agent);
          const request: CodeRequest = {
            id: randomUUID(),
            site,
            channel: s.check,
            after: new Date(started).toISOString(),
            expires: new Date(Math.min(started + 600000, Date.now() + 300000)).toISOString(),
            ...source,
            ...(s.check === "email" && fields.email
              ? {
                  recipientHash: createHash("sha256")
                    .update(fields.email.trim().toLowerCase())
                    .digest("hex"),
                }
              : {}),
            ...(s.check === "sms" && s.phoneSuffix ? { phoneSuffix: s.phoneSuffix } : {}),
          };
          this.pendingCodes.set(session.id, {
            request,
            agent: agent.name,
            identity: session.options.identity!,
            url: page.url(),
            back,
          });
          return {
            ...(await this.record(session, site, "check_required", s.check, agent)),
            codeRequest: request,
          };
        }
        return this.record(session, site, "check_required", s.check, agent);
      }
      if (site === "fold3" && s.host === targetHost && s.oauth) {
        await click("button,a", "(?:sign in|continue).*ancestry");
        await pause(2500);
        continue;
      }
      if (s.password || s.username) {
        // Authentication can keep the form visible while its request runs.
        // Wait for that result instead of submitting the same password again.
        if (submittedPassword) {
          await pause(2000);
          continue;
        }
        if (submissions >= 2)
          return this.record(session, site, "failed", "form_did_not_advance", agent);
        // Ancestry credentials are typed only at Ancestry, including sibling OAuth.
        if (spec.vault === "ancestry" && s.host !== "www.ancestry.com")
          return this.record(session, site, "failed", "ancestry_oauth_missing", agent);
        if (!formFilled) {
          await type(
            'input[type="email"],input[name="username"],input#username,input[name="email"],input#email,input[name="userId"]',
            fields.username || fields.email,
          );
          if (s.password) await type('input[type="password"]', fields.password);
          formFilled = true;
        }
        if ((await state()).submitDisabled) {
          if (formChallenges++ < 2) {
            const result = await clearChallenge(session, undefined, 30000);
            if (result.status !== "cleared")
              return this.record(session, site, "check_required", "browser_challenge", agent);
          }
          await pause(2000);
          continue;
        }
        if (!(await click('button[type="submit"],input[type="submit"],#submit_button')))
          await click("button", "^(sign in|log in|continue|next)$");
        submissions++;
        submittedPassword = s.password;
        formFilled = false;
        await pause(3000);
        continue;
      }
      const challenge = await clearChallenge(session, undefined, 15000);
      if (challenge.status !== "cleared")
        return this.record(session, site, "check_required", "browser_challenge", agent);
      await pause(1500);
    }
    return this.record(session, site, "failed", "account_payload_missing", agent);
  }
}
