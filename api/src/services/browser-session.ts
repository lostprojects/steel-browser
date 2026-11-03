// Owns one browser and its resources. Sessions must be created through SessionPool;
// this class must not launch an idle browser or reuse another session's profile.
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import puppeteer, { type Browser, type Page, type Target, type CDPSession } from "puppeteer-core";
import httpProxy from "http-proxy";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { getChromeExecutablePath, defaultPluginPreferences } from "../utils/browser.js";
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

export class BrowserSession extends EventEmitter {
  readonly createdAt = new Date().toISOString();
  readonly startedAt = Date.now();
  lastActivity = Date.now();
  clients = 0;
  status: "starting" | "live" | "released" | "failed" = "starting";
  endReason?: string;
  temporaryProfileRemoved = false;
  endedAt?: number;
  proxyServer?: IProxyServer;
  readonly filesPath: string;
  readonly engine: CommandEngine;
  private browser: Browser | null = null;
  private primary: Page | null = null;
  private endpoint = "";
  private userAgent = "";
  private stopping = false;
  private closing?: Promise<void>;
  private setups = new Map<string, Promise<void>>();
  private sockets = new Set<Duplex>();
  private launchConfig!: BrowserLauncherOptions;
  private storage = new InMemoryStorage(1000);
  private instrumentation;
  private targets;
  private plugins;
  private wsProxy = httpProxy.createProxyServer();
  private launchHooks: Array<(config: BrowserLauncherOptions) => Promise<void> | void> = [];
  private shutdownHooks: Array<(config: BrowserLauncherOptions | null) => Promise<void> | void> =
    [];
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
      browser: () => this.browser,
      waitForPageSetup: (page) => this.waitForPageSetup(page),
      endSession: async () => this.end("command"),
      filesRoot: () => this.filesPath,
      released: () => this.status !== "live",
      quickActionsDone: () => quickActionsDone(this.engine),
    });
    this.wsProxy.on("error", () => this.logger.warn({ sessionId: id }, "CDP proxy disconnected"));
  }

  async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.status !== "starting") throw new Error("Session cannot be relaunched");
    if (this.stopping) throw new Error("Session has ended");
    await mkdir(path.join(this.profilePath, "Default"), { recursive: true });
    await mkdir(this.filesPath, { recursive: true });
    await this.storage.initialize();
    if (this.options.proxyUrl) {
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
      JSON.stringify(deepMerge(preferences, defaultPluginPreferences())),
    );
    this.engine.prepare(this.id);
    await this.plugins.onSessionStart(this.launchConfig);
    const { width, height } = this.getDimensions();
    const debugPort = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => resolve(port));
      });
    });
    this.browser = await puppeteer.launch({
      executablePath: getChromeExecutablePath(),
      userDataDir: this.profilePath,
      defaultViewport: null,
      headless: this.launchConfig.options.headless,
      ignoreDefaultArgs: ["--enable-automation"],
      timeout: 30_000,
      env: { ...process.env, TZ: timezone, DISPLAY: env.DISPLAY },
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
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
      ],
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
    this.engine.browserReady();
    await this.plugins.onBrowserReady(this.launchConfig);
    this.touch();
    return this.browser;
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
    await this.setup(page.target());
  }
  touch() {
    this.lastActivity = Date.now();
  }
  getBrowserInstance() {
    return this.browser;
  }
  getBrowserProcess() {
    return this.browser?.process() ?? null;
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
    return this.status === "live" && this.browser?.connected === true;
  }
  getUserAgent() {
    return this.userAgent;
  }
  getDimensions() {
    return this.options.dimensions ?? { width: 1920, height: 1080 };
  }
  getAllPages() {
    return this.browser?.pages() ?? Promise.resolve([]);
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
    if (!this.browser) throw new Error("Browser is not running");
    const session = await this.browser.target().createCDPSession();
    try {
      return (await session.send("Storage.getCookies")).cookies;
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
    return getUrl(`v1/sessions/${this.id}/debug`);
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
    req.url = new URL(this.endpoint).pathname;
    this.wsProxy.ws(req, socket, head, {
      target: this.endpoint,
      ignorePath: true,
      changeOrigin: true,
    });
  }
  info() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      status: this.status,
      mode: this.options.mode,
      identity: this.options.identity,
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
      proxyTxBytes: this.proxyServer?.txBytes ?? 0,
      proxyRxBytes: this.proxyServer?.rxBytes ?? 0,
      eventCount: 0,
      creditsUsed: 0,
    };
  }
  close(reason: string): Promise<void> {
    this.closing ??= this.closeResources(reason);
    return this.closing;
  }
  private async closeResources(reason: string) {
    this.stopping = true;
    this.endReason = reason;
    this.engine.sessionEnded();
    for (const socket of this.sockets) socket.destroy();
    if (this.launchConfig) await this.plugins.onBeforeSessionEnd(this.launchConfig);
    const browser = this.browser;
    if (browser) await this.plugins.onBrowserClose(browser);
    const child = browser?.process();
    const kill = setTimeout(() => child?.kill("SIGKILL"), 8000);
    try {
      await browser?.close();
    } finally {
      clearTimeout(kill);
      this.browser = null;
      await this.proxyServer?.close(true);
      this.wsProxy.close();
      this.status = reason === "launch_failed" || reason === "chrome_exit" ? "failed" : "released";
      this.endedAt = Date.now();
      for (const hook of this.shutdownHooks) await hook(this.launchConfig ?? null);
      await this.plugins.onShutdown(ShutdownReason.SESSION_END);
      if (this.launchConfig) {
        await this.plugins.onSessionEnd(this.launchConfig);
        await this.plugins.onAfterSessionEnd(this.launchConfig);
      }
    }
  }
}
