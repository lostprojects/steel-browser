import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { setImmediate as tick } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
const native = vi.hoisted(() => ({ mouse: vi.fn(), key: vi.fn(), text: vi.fn() }));
vi.mock("./quiet-input.js", () => ({
  QuietInput: class {
    mouse = native.mouse;
    key = native.key;
    text = native.text;
  },
}));
vi.mock("./vault.js", () => ({
  vault: {
    use: async (_n: string, _a: any, run: any) =>
      run({ username: "fixture", email: "fixture@example.invalid", password: "fixture-password" }),
  },
  totp: vi.fn(),
  protect: vi.fn(),
}));
vi.mock("./challenge-service.js", () => ({
  clearChallenge: vi.fn(async () => ({ status: "cleared" })),
}));
vi.mock("./login-observation.js", () => ({
  observeMemberRead: vi.fn(async () => ({
    status: "ok",
    check: "none",
    signInPrompt: false,
    deviceCheck: false,
    readBytes: 1234,
    proxyBytes: 5678,
  })),
}));
import { observeMemberRead } from "./login-observation.js";
import { LoginService } from "./login.js";
const roots: string[] = [],
  windows: JSDOM[] = [],
  stops: Array<() => void> = [];
const agent = { name: "mosaic", dailyBudgetBytes: 1000 };
beforeEach(() => {
  vi.clearAllMocks();
  native.mouse.mockReset();
  native.key.mockReset();
  native.text.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-05T04:00:00Z"));
});
afterEach(async () => {
  stops.splice(0).forEach((stop) => stop());
  windows.splice(0).forEach((dom) => dom.window.close());
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const p = await mkdtemp(path.join(os.tmpdir(), "login-test-"));
  roots.push(p);
  return p;
}
async function finish<T>(job: Promise<T>) {
  let done = false;
  job.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 180 && !done; i++) {
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
  }
  return job;
}
async function fixture(
  url: string,
  html: string,
  pages: Record<string, string | [string, string]> = {},
  identity = "ancestry",
) {
  let dom: JSDOM;
  const load = (url: string, html: string) => {
    dom = new JSDOM(html, { url, runScripts: "outside-only" });
    windows.push(dom);
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
    });
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        x: Number(this.dataset.x ?? 0),
        y: 0,
        width: this.style.display === "none" ? 0 : 10,
        height: 10,
      } as DOMRect;
    };
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  };
  load(url, html);
  const page = {
    url: () => dom.window.location.href,
    goto: vi.fn(async (url: string) => {
      const p = pages[url] ?? "<body>unrecognized</body>";
      load(...(typeof p === "string" ? ([url, p] as const) : p));
    }),
    evaluate: async (fn: Function, arg: any) => dom.window.eval(`(${fn.toString()})`)(arg),
    bringToFront: vi.fn(async () => {}),
  };
  const session = {
    id: "fixture",
    options: { identity, mode: "quiet" },
    display: { name: ":99" },
    getDimensions: () => ({ width: 1920, height: 1080 }),
    getPrimaryPage: async () => page,
    getCookies: async () => [],
    touch: vi.fn(),
    getLogger: () => ({ info: vi.fn() }),
    exit: { ip: "203.0.113.1" },
  } as any;
  return { login: new LoginService(await root()), page, session };
}
test.each([
  ["ancestry", "https://www.ancestry.com/", '<div id="navAccount"></div>'],
  ["newspapers", "https://www.newspapers.com/", '<div data-cy="member-menu"></div>'],
  ["fold3", "https://www.fold3.com/", '<a style="display:none" href="/signoff">hidden</a>'],
  [
    "mary-ferrell",
    "https://www.maryferrell.org/home",
    '<a style="display:none" href="/member/signout">hidden</a>',
  ],
])("recognizes %s member markers without a visible menu", async (site, url, html) => {
  const { login, session, page } = await fixture(
    url,
    html,
    {},
    site === "mary-ferrell" ? site : "ancestry",
  );
  expect((await finish(login.login(session, site as any, agent, true))).status).toBe("ok");
  expect(page.goto).not.toHaveBeenCalled();
  expect(native.text).not.toHaveBeenCalled();
});
test.each([
  ["/account/signin", '<div id="navAccount"></div>'],
  [
    "/account/verify-email",
    '<div id="navAccount"></div><input autocomplete="one-time-code"><p>Check your email for a verification code</p>',
  ],
  ["/account/form", '<div id="navAccount"></div><input type="password">'],
])("does not accept an account header on %s", async (pathname, html) => {
  const { login, session } = await fixture(`https://www.ancestry.com${pathname}`, html);
  expect((await finish(login.login(session, "ancestry", agent, true))).status).not.toBe("ok");
});
test("rejects a member marker on an unexpected current origin", async () => {
  const { login, session } = await fixture(
    "https://unexpected.example/",
    '<div id="navAccount"></div>',
  );
  expect(await finish(login.login(session, "ancestry", agent, true))).toMatchObject({
    status: "failed",
    check: "unexpected_origin",
  });
});
test("checks Mary Ferrell's retained member session before opening its sign-in form", async () => {
  const { login, session, page } = await fixture(
    "about:blank",
    "",
    {
      "https://www.maryferrell.org/home": '<a href="/member/signout">Sign out</a>',
    },
    "mary-ferrell",
  );
  expect((await finish(login.login(session, "mary-ferrell", agent))).status).toBe("ok");
  expect(page.goto.mock.calls.map(([url]) => url)).toEqual(["https://www.maryferrell.org/home"]);
  expect(native.text).not.toHaveBeenCalled();
});
test("settles Ancestry, follows Newspapers' callback, and confirms its home payload", async () => {
  const { login, session, page } = await fixture("https://www.newspapers.com/signin/", "", {
    "https://www.ancestry.com/": '<div id="navAccount"></div>',
    "https://www.newspapers.com/signin/api/ancestry/": [
      "https://www.newspapers.com/api/userauth/ancestry/sso",
      "<body>Please close the window</body>",
    ],
    "https://www.newspapers.com/": '<div data-cy="member-menu"></div>',
  });
  expect((await finish(login.login(session, "newspapers", agent))).status).toBe("ok");
  expect(page.goto.mock.calls.map(([url]) => url)).toEqual([
    "https://www.ancestry.com/",
    "https://www.newspapers.com/signin/api/ancestry/",
    "https://www.newspapers.com/",
  ]);
  expect(native.text).not.toHaveBeenCalled();
});
test.each(["newspapers", "fold3"] as const)(
  "stops %s when Ancestry cannot establish a member session",
  async (site) => {
    const { login, session, page } = await fixture("https://www.ancestry.com/", "", {
      "https://www.ancestry.com/": '<a href="/account/signin">Sign in</a>',
      "https://www.ancestry.com/account/signin": "<p>Invalid password</p>",
    });
    expect(await finish(login.login(session, site, agent))).toMatchObject({
      site: "ancestry",
      status: "failed",
      check: "credentials_rejected",
    });
    expect(
      page.goto.mock.calls.every(([url]) => new URL(url).hostname === "www.ancestry.com"),
    ).toBe(true);
  },
);
test("settles Ancestry before entering Fold3", async () => {
  const { login, session, page } = await fixture("https://www.fold3.com/", "", {
    "https://www.ancestry.com/": '<div id="navAccount"></div>',
    "https://www.fold3.com/login": [
      "https://www.fold3.com/home",
      '<a href="/signoff">Sign out</a>',
    ],
  });
  expect((await finish(login.login(session, "fold3", agent))).status).toBe("ok");
  expect(page.goto.mock.calls.map(([url]) => url)).toEqual([
    "https://www.ancestry.com/",
    "https://www.fold3.com/login",
  ]);
});
test("forget removes only the named identity and persists across restart", async () => {
  const p = await root();
  await writeFile(
    path.join(p, "logins.json"),
    JSON.stringify({
      "ancestry-test/ancestry": { site: "ancestry" },
      "ancestry/ancestry": { site: "ancestry" },
    }),
  );
  await writeFile(
    path.join(p, "login-daily.json"),
    JSON.stringify({ "ancestry-test/ancestry": "2026-11-05", "ancestry/ancestry": "2026-11-05" }),
  );
  const login = new LoginService(p);
  expect(await login.forget("ancestry-test")).toEqual({
    identity: "ancestry-test",
    forgotten: ["ancestry"],
  });
  expect(Object.keys(await new LoginService(p).metadata())).toEqual(["ancestry/ancestry"]);
  expect(Object.keys(JSON.parse(await readFile(path.join(p, "login-daily.json"), "utf8")))).toEqual(
    ["ancestry/ancestry"],
  );
});
test.each(["eligible", "refused", "code", "never", "checked", "busy", "capacity", "draining"])(
  "daily guard: %s",
  async (condition) => {
    const p = await root();
    const record = {
      site: "ancestry",
      status: condition === "code" ? "check_required" : "ok",
      check: condition === "refused" ? "credentials_rejected" : "none",
      ...(condition === "never" ? {} : { last_login_ok: "2026-11-04T00:00:00Z" }),
    };
    await writeFile(path.join(p, "logins.json"), JSON.stringify({ "ancestry/ancestry": record }));
    if (condition === "checked")
      await writeFile(
        path.join(p, "login-daily.json"),
        JSON.stringify({ "ancestry/ancestry": "2026-11-05:read-v1" }),
      );
    const login = new LoginService(p);
    const loginCall = vi.spyOn(login, "login").mockResolvedValue({ status: "ok" } as any);
    const pool = {
      draining: condition === "draining",
      size: condition === "capacity" ? 2 : 1,
      maxSessions: 3,
      identityBusy: () => condition === "busy",
      create: vi.fn(async () => ({ id: "daily" })),
      release: vi.fn(async () => {}),
    };
    stops.push(login.startDailyChecks(pool as any));
    await vi.advanceTimersByTimeAsync(60000);
    if (condition === "eligible") {
      await vi.waitFor(() =>
        expect(pool.release).toHaveBeenCalledWith("daily", "daily_login_check"),
      );
      expect(loginCall).not.toHaveBeenCalled();
      expect(observeMemberRead).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(await readFile(path.join(p, "login-daily.json"), "utf8"))["ancestry/ancestry"],
      ).toBe("2026-11-05:read-v1");
      await vi.advanceTimersByTimeAsync(60000);
      await tick();
      expect(loginCall).not.toHaveBeenCalled();
      expect(observeMemberRead).toHaveBeenCalledTimes(1);
    } else {
      for (let i = 0; i < 20; i++) await tick();
      expect(pool.create).not.toHaveBeenCalled();
    }
  },
);

test("retries a lost first-field focus before typing and submitting Mary Ferrell", async () => {
  const { login, session } = await fixture(
    "about:blank",
    "",
    {
      "https://www.maryferrell.org/home": '<a href="/member/signin">Sign in</a>',
      "https://www.maryferrell.org/member/signin":
        '<input id="username" name="username" data-x="100"><input id="password" type="password" data-x="200"><button id="submit_button" data-x="300">Sign in</button>',
    },
    "mary-ferrell",
  );
  let usernameClicks = 0;
  native.mouse.mockImplementation(async (event: any) => {
    if (event.type !== "mouseReleased") return;
    const dom = windows.at(-1)!;
    const field = [...dom.window.document.querySelectorAll<HTMLElement>("input,button")].find(
      (e) => Number(e.dataset.x) + 5 === event.x,
    );
    if (field?.id === "username" && ++usernameClicks === 1) return;
    field?.focus();
    if (field?.id === "submit_button") {
      dom.reconfigure({ url: "https://www.maryferrell.org/home" });
      dom.window.document.body.innerHTML = '<a href="/member/signout">Sign out</a>';
    }
  });
  native.text.mockImplementation(async (value: string) => {
    (windows.at(-1)!.window.document.activeElement as HTMLInputElement).value = value;
  });
  expect((await finish(login.login(session, "mary-ferrell", agent))).status).toBe("ok");
  expect(usernameClicks).toBe(2);
  expect(native.text).toHaveBeenCalledTimes(2);
});

test("refuses to submit when native typing does not populate a form field", async () => {
  const { login, session } = await fixture(
    "about:blank",
    "",
    {
      "https://www.maryferrell.org/home": '<a href="/member/signin">Sign in</a>',
      "https://www.maryferrell.org/member/signin":
        '<input id="username" name="username" data-x="100"><input id="password" type="password" data-x="200"><button id="submit_button" data-x="300">Sign in</button>',
    },
    "mary-ferrell",
  );
  native.mouse.mockImplementation(async (event: any) => {
    if (event.type === "mouseReleased") {
      const dom = windows.at(-1)!;
      [...dom.window.document.querySelectorAll<HTMLElement>("input")]
        .find((e) => Number(e.dataset.x) + 5 === event.x)
        ?.focus();
    }
  });
  expect(await finish(login.login(session, "mary-ferrell", agent))).toMatchObject({
    status: "failed",
    check: "form_field_input_failed",
  });
  expect(native.mouse.mock.calls.some(([event]) => event.x === 305)).toBe(false);
});

test("history drops account payloads and code requests from legacy rows", async () => {
  const p = await root();
  await writeFile(
    path.join(p, "login-checks.jsonl"),
    [
      { at: "2026-11-04T00:00:00Z", site: "ancestry", status: "ok" },
      {
        at: "2026-11-05T00:00:00Z",
        site: "ancestry",
        readBytes: 123,
        codeRequest: { recipientHash: "private" },
        html: "private",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const result = await new LoginService(p).history(
    "2026-11-05T00:00:00Z",
    "2026-11-06T00:00:00Z",
    1,
  );
  expect(result.checks).toEqual([{ at: "2026-11-05T00:00:00Z", site: "ancestry", readBytes: 123 }]);
});
