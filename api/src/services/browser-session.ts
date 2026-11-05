// Owns one browser and its resources. Sessions must be created through SessionPool;
// this class must not launch an idle browser or reuse another session's profile.
import { chromeProcesses, killChromeGroup } from "./chrome-processes.js";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { SessionDisplay, unusedPort } from "./session-display.js";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import puppeteer, { type Browser, type Page, type Target, type CDPSession } from "puppeteer-core";
import { WebSocket, WebSocketServer } from "ws";
import { scrubObject, protectedDisplays, protect } from "./vault.js";
import { identityVault } from "./login.js";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import {
  getChromeExecutablePath,
  defaultPluginPreferences,
  browserProcessEnv,
} from "../utils/browser.js";
import {
  deepMerge,
  groupSessionStorageByOrigin,
  injectStorageOnNewDocument,
} from "../utils/context.js";
import { ProxyServer, type IProxyServer } from "../utils/proxy.js";
import { getBaseUrl, getUrl } from "../utils/url.js";
import { FileService } from "./file.service.js";
import { CommandEngine } from "./commands/engine.js";
import { quickActionsDone } from "../modules/commands/commands.guard.js";
import { PluginManager } from "./cdp/plugins/core/plugin-manager.js";
import { BasePlugin, ShutdownReason } from "./cdp/plugins/core/base-plugin.js";
import { TargetInstrumentationManager } from "./cdp/instrumentation/target-manager.js";
import { createBrowserLogger } from "./cdp/instrumentation/browser-logger.js";
import { InMemoryStorage } from "./cdp/instrumentation/storage/in-memory-storage.js";
import type { BrowserLauncherOptions } from "../types/browser.js";
import type { SessionData } from "./context/types.js";
import type { SessionOptions } from "./session-pool.js";
import { QuietBrowser } from "./quiet-browser.js";
import { QuietInput } from "./quiet-input.js";
import type { Exit } from "./proxy-manager.js";
import { scopeClientFiles } from "./commands/policy.js";
import { beginSessionOperation } from "./session-access.js";

export class BrowserSession extends EventEmitter {
  readonly createdAt = new Date().toISOString();
  readonly startedAt = Date.now();
  lastActivity = Date.now();
  lastLoginOk?: string;
  loginBusy = false;
  clients = 0;
  status: "starting" | "live" | "released" | "failed" = "starting";
  endReason?: string;
  temporaryProfileRemoved = false;
  endedAt?: number;
  proxyServer?: IProxyServer;
  exit?: Exit;
  priorProxyTxBytes = 0;
  priorProxyRxBytes = 0;
  lastNavigation = Date.now();
  private lastUrl = "";
  private trafficWindow = { at: Date.now(), bytes: 0 };
  private warnedHosts = new Set<string>();
  challenge?: { status: string; kind: string; url: string };
  readonly filesPath: string;
  readonly engine: CommandEngine;
  readonly display = new SessionDisplay();
  private browser: Browser | null = null;
  private quiet?: QuietBrowser;
  private chrome?: ChildProcess;
  private commandSetup?: Promise<void>;
  private primary: Page | null = null;
  private endpoint = "";
  private userAgent = "";
  private stopping = false;
  private closing?: Promise<void>;
  private chromeGroup?: number;
  chromeCleanup?: { remainingProcesses: number; remainingZombies: number };
  private setups = new Map<string, Promise<void>>();
  private sockets = new Set<Duplex>();
  private launchConfig!: BrowserLauncherOptions;
  private storage = new InMemoryStorage(1000);
  private instrumentation;
  private targets;
  private plugins;
  private cdpRelay = new WebSocketServer({ noServer: true });
  private launchHooks: Array<(config: BrowserLauncherOptions) => Promise<void> | void> = [];
  private shutdownHooks: Array<(config: BrowserLauncherOptions | null) => Promise<void> | void> =
    [];
  private async storedSessionCookies(): Promise<any[]> {
    if (!this.options.identity) return [];
    try {
      return JSON.parse(
        await readFile(path.join(this.profilePath, "mosaic-session-cookies.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async restoreSessionCookies() {
    const cookies = await this.storedSessionCookies();
    if (identityVault(this.options.identity))
      cookies.forEach((c) => {
        if (c.value.length >= 16) protect(c.value);
      });
    if (!cookies.length || this.options.sessionContext) return;
    await this.prepareCommands();
    const client = await this.getBrowserInstance()!.target().createCDPSession();
    try {
      await client.send("Storage.setCookies", { cookies });
    } finally {
      await client.detach().catch(() => undefined);
    }
  }
  proxyFactory = (url: string): IProxyServer => new ProxyServer(url);

  constructor(
    readonly id: string,
    readonly options: SessionOptions,
    readonly profilePath: string,
    private logger: FastifyBaseLogger,
    private end: (reason: string) => Promise<void>,
  ) {
    super();
    this.filesPath = path.join(FileService.getInstance().getBaseFilesPath(), id);
    this.instrumentation = createBrowserLogger({
      baseLogger: logger,
      initialContext: { sessionId: id },
      storage: this.storage,
      enableConsoleLogging: false,
    });
    this.plugins = new PluginManager(this, logger);
    this.targets = new TargetInstrumentationManager(
      this.instrumentation,
      logger,
      {},
      this.plugins.onTargetSession.bind(this.plugins),
    );
    this.engine = new CommandEngine({
      browser: () => this.browser ?? this.quiet?.asBrowser() ?? null,
      waitForPageSetup: (page) => this.waitForPageSetup(page),
      endSession: async () => this.end("command"),
      filesRoot: () => this.filesPath,
      released: () => this.status !== "live",
      quickActionsDone: () => quickActionsDone(this.engine),
    });
  }

  async launch(): Promise<Browser | void> {
    if (this.browser) return this.browser;
    if (this.status !== "starting") throw new Error("Session cannot be relaunched");
    if (this.stopping) throw new Error("Session has ended");
    await mkdir(path.join(this.profilePath, "Default"), { recursive: true });
    await mkdir(this.filesPath, { recursive: true });
    await this.storage.initialize();
    if (this.options.proxyUrl && !this.proxyServer) {
      this.proxyServer = this.proxyFactory(this.options.proxyUrl);
      await this.proxyServer.listen();
    }
    const timezone = this.options.timezone ?? env.DEFAULT_TIMEZONE ?? "UTC";
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
    this.launchConfig = {
      options: {
        headless: this.options.headless ?? env.CHROME_HEADLESS,
        proxyUrl: this.proxyServer?.url,
      },
      userDataDir: this.profilePath,
      dimensions: this.getDimensions(),
      timezone: Promise.resolve(timezone),
      sessionContext: this.options.sessionContext as BrowserLauncherOptions["sessionContext"],
      blockAds: false,
    };
    if (this.options.mode === "agent")
      for (const hook of this.launchHooks) await hook(this.launchConfig);
    const preferencesFile = path.join(this.profilePath, "Default", "Preferences");
    let preferences = {};
    try {
      preferences = JSON.parse(await readFile(preferencesFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(
      preferencesFile,
      JSON.stringify(
        deepMerge(deepMerge(preferences, defaultPluginPreferences()), {
          intl: { accept_languages: this.options.locale ?? "en-US,en" },
        }),
      ),
    );
    this.engine.prepare(this.id);
    if (this.options.mode === "agent") await this.plugins.onSessionStart(this.launchConfig);
    const { width, height } = this.getDimensions();
    await this.display.start(width, height, () => {
      if (!this.stopping)
        void this.end("display_exit").catch(() => this.logger.error("Display cleanup failed"));
    });
    const debugPort = await unusedPort();
    const args = this.chromeArgs(debugPort, width, height);
    if (this.options.mode === "quiet") {
      if (!this.display.name) throw new Error("Quiet mode requires Linux with a session X display");
      this.chrome = spawn(
        getChromeExecutablePath(),
        [...args, `--user-data-dir=${this.profilePath}`, "about:blank"],
        {
          env: browserProcessEnv({ TZ: timezone, DISPLAY: this.display.name }),
          stdio: "ignore",
          detached: true,
        },
      );
      this.chromeGroup = this.chrome.pid;
      let launchError: Error | undefined;
      this.chrome.once("error", (error) => {
        launchError = error;
      });
      this.chrome.once("exit", () => {
        if (!this.stopping)
          void this.end("chrome_exit").catch(() =>
            this.logger.error("Quiet browser cleanup failed"),
          );
      });
      for (let i = 0; i < 300; i++) {
        if (launchError) throw launchError;
        if (this.chrome.exitCode !== null) throw new Error("Quiet Chrome exited during startup");
        try {
          const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
            signal: AbortSignal.timeout(500),
          });
          const version = (await response.json()) as {
            webSocketDebuggerUrl: string;
            "User-Agent": string;
          };
          this.endpoint = version.webSocketDebuggerUrl;
          this.userAgent = version["User-Agent"];
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!this.endpoint) throw new Error("Quiet Chrome did not publish its DevTools endpoint");
      this.status = "live";
      await this.restoreSessionCookies();
      this.touch();
      return;
    }
    this.browser = await puppeteer.launch({
      executablePath: getChromeExecutablePath(),
      userDataDir: this.profilePath,
      defaultViewport: null,
      headless: this.launchConfig.options.headless,
      ignoreDefaultArgs: [
        "--enable-automation",
        "--disable-popup-blocking",
        "--disable-ipc-flooding-protection",
      ],
      timeout: 30_000,
      env: browserProcessEnv({ TZ: timezone, DISPLAY: this.display.name ?? env.DISPLAY }),
      args,
    });
    this.endpoint = this.browser.wsEndpoint();
    this.userAgent = await this.browser.userAgent();
    this.browser.once("disconnected", () => {
      if (!this.stopping)
        void this.end("chrome_exit").catch(() => this.logger.error("Session cleanup failed"));
    });
    this.browser.on("targetcreated", (target) => {
      void this.setup(target).catch(() =>
        this.logger.warn({ sessionId: this.id }, "Page setup failed"),
      );
    });
    this.browser.on("targetdestroyed", (target) =>
      this.setups.delete((target as unknown as { _targetId: string })._targetId),
    );
    const control = await this.browser.target().createCDPSession();
    await control.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: this.filesPath,
      eventsEnabled: true,
    });
    await control.detach();
    if (this.options.sessionContext?.cookies?.length) {
      const session = await this.browser.target().createCDPSession();
      await session.send("Storage.setCookies", {
        cookies: this.options.sessionContext.cookies as any,
      });
      await session.detach();
    }
    await Promise.all(this.browser.targets().map((target) => this.setup(target)));
    this.primary = (await this.browser.pages())[0] ?? (await this.createPage());
    await this.plugins.onBrowserLaunch(this.browser);
    this.engine.browserLaunched(this.browser);
    this.status = "live";
    await this.restoreSessionCookies();
    this.engine.browserReady();
    await this.plugins.onBrowserReady(this.launchConfig);
    this.touch();
    return this.browser;
  }

  private chromeArgs(debugPort: number, width: number, height: number) {
    return [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      ...(this.options.mode === "quiet" ? ["--disable-features=OptimizationHints"] : []),
      "--disable-sync",
      "--password-store=basic",
      "--disable-session-crashed-bubble",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy",
      "--use-angle=gl",
      "--ignore-gpu-blocklist",
      "--ozone-platform=x11",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      `--window-size=${width},${height}`,
      `--lang=${this.options.locale ?? "en-US"}`,
      "--autoplay-policy=user-gesture-required",
      ...(this.proxyServer ? [`--proxy-server=${this.proxyServer.url}`] : []),
    ];
  }

  async prepareCommands() {
    if (this.options.mode !== "quiet") return;
    this.commandSetup ??= (async () => {
      if (!this.display.name || !this.endpoint) throw new Error("Quiet session is not ready");
      const { width, height } = this.getDimensions();
      if (identityVault(this.options.identity)) protectedDisplays.add(this.display.name);
      this.quiet = await QuietBrowser.connect(
        this.endpoint,
        new QuietInput(this.display.name, width, height),
      );
      this.engine.browserLaunched(this.quiet.asBrowser());
      this.engine.browserReady();
    })();
    return this.commandSetup;
  }

  private setup(target: Target): Promise<void> {
    const id = (target as unknown as { _targetId: string })._targetId;
    if (!this.setups.has(id)) this.setups.set(id, this.prepareTarget(target));
    return this.setups.get(id)!;
  }
  private async prepareTarget(target: Target) {
    await this.targets.attach(target, target.type());
    if (target.type() !== "page") return;
    const page = await target.page();
    if (!page) return;
    if (this.options.sessionContext) {
      const data = groupSessionStorageByOrigin(
        this.options.sessionContext as BrowserLauncherOptions["sessionContext"],
      );
      await injectStorageOnNewDocument(page, data);
    }
    await this.plugins.onPageCreated(page);
  }
  async waitForPageSetup(page: Page) {
    if (this.options.mode === "quiet") return;
    await this.setup(page.target());
  }
  touch() {
    this.lastActivity = Date.now();
  }
  async trafficReason(now: number) {
    if (!this.proxyServer || now - this.trafficWindow.at < 30_000) return;
    const page = await this.getPrimaryPage();
    const url = page.url();
    if (url !== this.lastUrl) {
      this.lastUrl = url;
      this.lastNavigation = now;
    }
    for (const host of this.proxyServer.traffic ?? []) {
      if (host.rxBytes + host.txBytes > 10_000_000 && !this.warnedHosts.has(host.hostname)) {
        this.warnedHosts.add(host.hostname);
        this.logger.warn(
          {
            sessionId: this.id,
            hostname: host.hostname,
            residentialBytes: host.rxBytes + host.txBytes,
          },
          "Host residential traffic exceeded 10 MB",
        );
      }
    }
    const bytes = this.proxyServer.rxBytes + this.proxyServer.txBytes;
    const delta = bytes - this.trafficWindow.bytes;
    this.trafficWindow = { at: now, bytes };
    if (now - this.lastNavigation > 120_000 && delta > 5_000_000)
      return "stream_without_navigation";
  }
  getBrowserInstance() {
    return this.browser ?? this.quiet?.asBrowser() ?? null;
  }
  async diagnostics() {
    const processes = this.chromeGroup ? await chromeProcesses(this.chromeGroup) : [];
    return {
      sessionId: this.id,
      at: new Date().toISOString(),
      status: this.status,
      chromeProcesses: processes.length,
      chromeRssBytes: processes.reduce((total, row) => total + row.rssBytes, 0),
      chromeZombies: processes.filter((row) => row.zombie).length,
      cleanup: this.chromeCleanup ?? null,
    };
  }
  async killChrome() {
    if (!this.chromeGroup || !this.chrome?.pid || this.status !== "live")
      throw Object.assign(new Error("A live quiet Chrome session is required"), {
        statusCode: 409,
      });
    const group = this.chromeGroup;
    const exited = new Promise<void>((resolve) => this.chrome!.once("exit", () => resolve()));
    this.chrome.kill("SIGKILL");
    await exited;
    await this.close("chrome_exit");
    const remaining = await chromeProcesses(group);
    return {
      sessionId: this.id,
      signal: "SIGKILL",
      endReason: this.endReason,
      remainingProcesses: remaining.filter((row) => !row.zombie).length,
      remainingZombies: remaining.filter((row) => row.zombie).length,
    };
  }
  getBrowserProcess() {
    return this.chrome ?? this.browser?.process() ?? null;
  }
  getLaunchConfig() {
    return this.launchConfig;
  }
  getSessionContext() {
    return this.options.sessionContext ?? null;
  }
  getLogger(name: string) {
    return this.logger.child({ component: name });
  }
  getInstrumentationLogger() {
    return this.instrumentation;
  }
  registerPlugin(plugin: BasePlugin) {
    this.plugins.register(plugin);
  }
  registerLaunchHook(hook: (config: BrowserLauncherOptions) => Promise<void> | void) {
    this.launchHooks.push(hook);
  }
  registerShutdownHook(hook: (config: BrowserLauncherOptions | null) => Promise<void> | void) {
    this.shutdownHooks.push(hook);
  }
  isRunning() {
    return (
      this.status === "live" &&
      (this.chrome
        ? this.chrome.exitCode === null && this.chrome.signalCode === null
        : this.browser?.connected === true)
    );
  }
  getUserAgent() {
    return this.userAgent;
  }
  getDimensions() {
    return this.options.dimensions ?? { width: 1920, height: 1080 };
  }
  async getAllPages() {
    await this.prepareCommands();
    return this.getBrowserInstance()?.pages() ?? [];
  }
  async getPrimaryPage() {
    if (!this.primary || this.primary.isClosed())
      this.primary = (await this.getAllPages())[0] ?? (await this.createPage());
    return this.primary;
  }
  async createPage() {
    if (!this.browser) throw new Error("Browser is not running");
    const page = await this.browser.newPage();
    await this.waitForPageSetup(page);
    return page;
  }
  async refreshPrimaryPage(signal?: AbortSignal) {
    const old = this.primary;
    const page = await this.createPage();
    if (signal?.aborted) {
      await page.close();
      return;
    }
    if (old && !old.isClosed()) await this.plugins.onBeforePageClose(old);
    if (signal?.aborted) {
      await page.close();
      return;
    }
    this.primary = page;
    if (old && !old.isClosed()) await old.close();
  }
  async createBrowserContext(proxyUrl: string) {
    if (!this.browser) throw new Error("Browser is not running");
    return this.browser.createBrowserContext({ proxyServer: proxyUrl });
  }
  async getCookies() {
    await this.prepareCommands();
    const browser = this.getBrowserInstance();
    if (!browser) throw new Error("Browser is not running");
    const session = await browser.target().createCDPSession();
    try {
      const cookies = (await session.send("Storage.getCookies")).cookies;
      if (identityVault(this.options.identity))
        cookies.forEach((c: any) => {
          if (c.value.length >= 16) protect(c.value);
        });
      return cookies;
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
  async getBrowserState(): Promise<SessionData> {
    const localStorage: Record<string, Record<string, string>> = {};
    for (const page of await this.getAllPages()) {
      const entry = await page
        .evaluate(() => ({ origin: location.origin, values: { ...window.localStorage } }))
        .catch(() => null);
      if (entry && entry.origin !== "null") localStorage[entry.origin] = entry.values;
    }
    return { cookies: await this.getCookies(), localStorage };
  }
  getDebuggerUrl() {
    return getUrl(`v1/sessions/${this.id}/${this.options.mode === "quiet" ? "view" : "debug"}`);
  }
  getDebuggerWsUrl() {
    return `${getBaseUrl("ws").replace(/\/$/, "")}/v1/sessions/${this.id}/cdp`;
  }
  getEndpoint() {
    return this.endpoint;
  }
  async proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!this.isRunning()) throw new Error("Session is not running");
    this.clients++;
    this.touch();
    this.sockets.add(socket);
    socket.once("close", () => {
      this.clients--;
      this.touch();
      this.sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    this.cdpRelay.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(this.endpoint);
      const queued: string[] = [];
      const pending = new Map<string, { method: string; finish: () => void }>();
      const messageKey = (message: any) => JSON.stringify([message.sessionId ?? "", message.id]);
      const finishPending = () => {
        for (const operation of pending.values()) operation.finish();
        pending.clear();
      };
      let incoming = Promise.resolve();
      client.on("message", (data) => {
        incoming = incoming
          .then(async () => {
            let message: any;
            try {
              message = JSON.parse(data.toString());
              if (
                !message ||
                !Number.isSafeInteger(message.id) ||
                typeof message.method !== "string"
              )
                throw new Error("Invalid browser command");
            } catch {
              client.close(1003);
              return;
            }
            let setup = false;
            if (identityVault(this.options.identity)) {
              // An observing client must not pause newly opened login frames.
              if (message.method === "Target.setAutoAttach") {
                message.params ??= {};
                message.params.waitForDebuggerOnStart = false;
              }
              setup =
                /^(Target\.(setDiscoverTargets|getTargets|getTargetInfo|attachToTarget|detachFromTarget|setAutoAttach)|Page\.(enable|setLifecycleEventsEnabled|getFrameTree)|DOM.enable|Accessibility.enable|Runtime.runIfWaitingForDebugger|Browser.getVersion)$/.test(
                  message.method,
                );
              if (
                (this.loginBusy && !setup) ||
                ["Page.captureScreenshot", "Page.startScreencast", "Page.printToPDF"].includes(
                  message.method,
                )
              ) {
                client.send(
                  JSON.stringify({
                    id: message.id,
                    sessionId: message.sessionId,
                    error: {
                      code: -32000,
                      message:
                        "Protected identity output unavailable during login or image capture",
                    },
                  }),
                );
                return;
              }
            }
            let finish = () => {};
            try {
              if (pending.has(messageKey(message))) throw new Error("Duplicate browser command ID");
              if (!(this.loginBusy && setup)) finish = beginSessionOperation(this);
              await scopeClientFiles(message, this.filesPath);
              if (client.readyState !== WebSocket.OPEN || upstream.readyState > WebSocket.OPEN) {
                finish();
                return;
              }
              pending.set(messageKey(message), { method: message.method, finish });
              const raw = JSON.stringify(message);
              if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
              else queued.push(raw);
            } catch {
              finish();
              if (client.readyState === WebSocket.OPEN)
                client.send(
                  JSON.stringify({
                    id: message.id,
                    sessionId: message.sessionId,
                    error: {
                      code: -32000,
                      message: "Browser command refused by session access policy",
                    },
                  }),
                );
            }
          })
          .catch(() => client.close(1011));
      });
      upstream.on("open", () => {
        for (const raw of queued) upstream.send(raw);
        queued.length = 0;
      });
      upstream.on("message", (data) => {
        let payload: any;
        try {
          payload = JSON.parse(data.toString());
        } catch {
          client.close(1011);
          return;
        }
        const operation = pending.get(messageKey(payload));
        if (operation) {
          if (
            identityVault(this.options.identity) &&
            /^(Storage|Network)\.get(?:All)?Cookies$/.test(operation.method)
          )
            for (const cookie of payload.result?.cookies ?? []) cookie.value = "[redacted]";
          operation.finish();
          pending.delete(messageKey(payload));
        }
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(scrubObject(payload)));
      });
      client.on("close", () => {
        finishPending();
        upstream.terminate();
      });
      upstream.on("close", () => {
        finishPending();
        client.close();
      });
      client.on("error", () => upstream.terminate());
      upstream.on("error", () => client.close(1011));
    });
  }

  info() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      status: this.status,
      mode: this.options.mode,
      identity: this.options.identity,
      site: this.options.site,
      caller: this.options.caller,
      last_login_ok: this.lastLoginOk,
      duration: (this.endedAt ?? Date.now()) - this.startedAt,
      endReason: this.endReason,
      temporaryProfileRemoved: this.temporaryProfileRemoved,
      timeout: 600_000,
      websocketUrl: this.getDebuggerWsUrl(),
      debugUrl: this.getDebuggerUrl(),
      debuggerUrl: this.getDebuggerUrl(),
      sessionViewerUrl: this.getDebuggerUrl(),
      userAgent: this.userAgent,
      dimensions: this.getDimensions(),
      display: this.display.name,
      noVncUrl: getUrl(`v1/sessions/${this.id}/view`),
      exit: this.exit,
      challenge: this.challenge,
      proxyTxBytes: this.priorProxyTxBytes + (this.proxyServer?.txBytes ?? 0),
      proxyRxBytes: this.priorProxyRxBytes + (this.proxyServer?.rxBytes ?? 0),
      directBytes: this.proxyServer?.directBytes ?? 0,
      proxyTraffic: this.proxyServer?.traffic ?? [],
      eventCount: 0,
      creditsUsed: 0,
      ...(this.options.mode === "quiet"
        ? { commandMethods: [...(this.quiet?.connection.methods ?? [])] }
        : {}),
    };
  }
  close(reason: string): Promise<void> {
    this.closing ??= this.closeResources(reason);
    return this.closing;
  }
  private async closeResources(reason: string) {
    this.stopping = true;
    this.endReason = reason;
    if (this.options.identity && this.status === "live" && reason !== "chrome_exit") {
      try {
        const cookies = (await this.getCookies())
          .filter((c) => c.session || c.expires <= 0)
          .map((c) => {
            const saved: Record<string, unknown> = {};
            for (const key of [
              "name",
              "value",
              "domain",
              "path",
              "secure",
              "httpOnly",
              "sameSite",
              "priority",
              "sourceScheme",
              "sourcePort",
              "partitionKey",
            ])
              if ((c as any)[key] !== undefined) saved[key] = (c as any)[key];
            return saved;
          });
        const file = path.join(this.profilePath, "mosaic-session-cookies.json");
        await writeFile(file + ".tmp", JSON.stringify(cookies), { mode: 0o600 });
        await rename(file + ".tmp", file);
      } catch {
        this.logger.warn(
          { sessionId: this.id },
          "Could not preserve session cookies before browser shutdown",
        );
      }
    }
    this.engine.sessionEnded();
    for (const socket of this.sockets) socket.destroy();
    if (this.launchConfig && this.options.mode === "agent")
      await this.plugins.onBeforeSessionEnd(this.launchConfig);
    const browser = this.browser;
    if (browser) await this.plugins.onBrowserClose(browser);
    const child = this.chrome ?? browser?.process();
    const kill = setTimeout(() => child?.kill("SIGKILL"), 8000);
    try {
      await browser?.close();
      if (this.chrome?.pid && this.chrome.exitCode === null && this.chrome.signalCode === null) {
        const exited = new Promise<void>((resolve) => this.chrome!.once("exit", () => resolve()));
        if (this.quiet) await this.quiet.close();
        else this.chrome.kill("SIGTERM");
        await exited;
      }
    } finally {
      clearTimeout(kill);
      this.browser = null;
      if (this.display.name) protectedDisplays.delete(this.display.name);
      if (this.chromeGroup) this.chromeCleanup = await killChromeGroup(this.chromeGroup);
      await this.display.close();
      await this.proxyServer?.close(true);
      for (const client of this.cdpRelay.clients) client.terminate();
      this.cdpRelay.close();
      this.status = reason === "launch_failed" || reason === "chrome_exit" ? "failed" : "released";
      this.endedAt = Date.now();
      for (const hook of this.shutdownHooks) await hook(this.launchConfig ?? null);
      if (this.options.mode === "agent") await this.plugins.onShutdown(ShutdownReason.SESSION_END);
      if (this.launchConfig && this.options.mode === "agent") {
        await this.plugins.onSessionEnd(this.launchConfig);
        await this.plugins.onAfterSessionEnd(this.launchConfig);
      }
    }
  }
}
