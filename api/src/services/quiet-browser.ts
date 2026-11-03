// A direct CDP client for the commands engine. It must not enable Runtime,
// instrument page scripts, pause new targets, or send synthetic CDP input.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { CDPSessionEvent, type Browser, type Page, type Protocol } from "puppeteer-core";
import { QuietInput } from "./quiet-input.js";

type Fields = Record<string, any>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class QuietConnection extends EventEmitter {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private sessions = new Map<string, QuietSession>();
  readonly root: QuietSession;
  readonly methods = new Set<string>();

  private constructor(
    private ws: WebSocket,
    readonly input: QuietInput,
  ) {
    super();
    this.root = this.add("", "");
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      const session = this.sessions.get(message.sessionId ?? "");
      if (message.method === "Target.attachedToTarget") {
        const child = this.add(message.params.sessionId, message.params.targetInfo.targetId);
        child.parent = session;
        this.emit(CDPSessionEvent.SessionAttached, child);
      }
      session?.emit(message.method, message.params);
      if (message.method === "Target.detachedFromTarget") {
        const child = this.sessions.get(message.params.sessionId);
        this.sessions.delete(message.params.sessionId);
        child?.emit("disconnected");
        if (child) this.emit(CDPSessionEvent.SessionDetached, child);
      }
    });
    ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Quiet CDP connection closed"));
      }
      this.pending.clear();
      for (const session of this.sessions.values()) session.emit("disconnected");
      this.emit("disconnected");
    });
    ws.on("error", () => ws.close());
  }

  static async connect(endpoint: string, input: QuietInput) {
    const ws = new WebSocket(endpoint);
    const connection = new QuietConnection(ws, input);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return connection;
  }
  get connected() {
    return this.ws.readyState === WebSocket.OPEN;
  }
  session(id: string) {
    return this.sessions.get(id);
  }
  private add(id: string, targetId: string) {
    let session = this.sessions.get(id);
    if (!session) {
      session = new QuietSession(this, id, targetId);
      this.sessions.set(id, session);
    }
    return session;
  }
  async attach(targetId: string) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return this.add(sessionId, targetId);
  }
  send(method: string, params: Fields = {}) {
    return this.root.send(method, params);
  }
  wire(method: string, params: Fields, sessionId = ""): Promise<any> {
    if (!this.connected) return Promise.reject(new Error("Quiet CDP connection is closed"));
    this.methods.add(method);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.ws.close();
  }
}

export class QuietSession extends EventEmitter {
  parent?: QuietSession;
  private worlds = new Set<number>();
  private objects = new Map<string, string>();
  constructor(
    private conn: QuietConnection,
    private sessionId: string,
    readonly targetId: string,
  ) {
    super();
    this.on("Page.frameNavigated", () => {
      this.worlds.clear();
      this.objects.clear();
    });
  }
  id() {
    return this.sessionId;
  }
  connection() {
    return this.conn;
  }
  private raw(method: string, params: Fields = {}) {
    return this.conn.wire(method, params, this.sessionId);
  }
  async detach() {
    if (this.sessionId && this.conn.connected)
      await this.conn.send("Target.detachFromTarget", { sessionId: this.sessionId });
  }
  private async world() {
    const { frameTree } = await this.raw("Page.getFrameTree");
    const { executionContextId } = await this.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "__mosaic_quiet",
    });
    return executionContextId;
  }
  private remember(value: any, group: string) {
    if (!value || typeof value !== "object") return;
    if (typeof value.objectId === "string") this.objects.set(value.objectId, group);
    for (const item of Object.values(value)) this.remember(item, group);
    if (this.objects.size > 100_000) throw new Error("Quiet CDP object limit reached");
  }
  private async pointer(params: Fields) {
    let session: QuietSession = this;
    let x = Number(params.x),
      y = Number(params.y);
    while (session.parent && session.parent.targetId) {
      const parent = session.parent;
      const { backendNodeId } = await parent.send("DOM.getFrameOwner", {
        frameId: session.targetId,
      });
      const { model } = await parent.send("DOM.getBoxModel", { backendNodeId });
      const { cssLayoutViewport } = await session.send("Page.getLayoutMetrics");
      const q = model.content;
      const px =
        q[0] +
        ((q[2] - q[0]) * x) / cssLayoutViewport.clientWidth +
        ((q[6] - q[0]) * y) / cssLayoutViewport.clientHeight;
      y =
        q[1] +
        ((q[3] - q[1]) * x) / cssLayoutViewport.clientWidth +
        ((q[7] - q[1]) * y) / cssLayoutViewport.clientHeight;
      x = px;
      session = parent;
    }
    const { result } = await session.send("Runtime.evaluate", {
      expression:
        "({x:screenX+(outerWidth-innerWidth)/2,y:screenY+outerHeight-innerHeight-(outerWidth-innerWidth)/2})",
      returnByValue: true,
    });
    return this.conn.input.mouse({ ...params, x, y }, result.value);
  }
  async send(method: string, original: Fields = {}): Promise<any> {
    const params = { ...original };
    if (
      !/^(Page|DOM|Accessibility|Runtime|Target|Browser|Storage)\./.test(method) ||
      [
        "Runtime.enable",
        "Runtime.addBinding",
        "Runtime.runIfWaitingForDebugger",
        "Page.addScriptToEvaluateOnNewDocument",
        "Page.setBypassCSP",
        "Page.startScreencast",
        "Page.printToPDF",
      ].includes(method)
    ) {
      if (method === "Input.dispatchMouseEvent") return this.pointer(params);
      if (method === "Input.dispatchKeyEvent") return this.conn.input.key(params);
      if (method === "Input.insertText") return this.conn.input.text(String(params.text));
      throw new Error(`Quiet policy refuses ${method}`);
    }
    if (
      method === "Target.setAutoAttach" &&
      (params.waitForDebuggerOnStart || !params.filter?.every((f: Fields) => f.type === "iframe"))
    )
      throw new Error("Quiet sessions may attach only to unpaused iframe targets");
    if (method === "Page.captureScreenshot") {
      if (params.clip || params.captureBeyondViewport)
        throw new Error(
          "Quiet screenshots capture the visible display; full-page and element crops are unavailable",
        );
      return this.conn.input.screenshot(params.format);
    }
    if (method === "Runtime.evaluate") {
      if (params.contextId === undefined) params.contextId = await this.world();
      if (!this.worlds.has(params.contextId))
        throw new Error("Quiet evaluation requires an isolated world");
    }
    if (method === "DOM.resolveNode") {
      if (params.executionContextId === undefined) params.executionContextId = await this.world();
      if (!this.worlds.has(params.executionContextId))
        throw new Error("Quiet DOM handles require an isolated world");
    }
    if (method === "Runtime.callFunctionOn") {
      if (
        params.objectId
          ? !this.objects.has(params.objectId)
          : !this.worlds.has(params.executionContextId)
      )
        throw new Error("Quiet function calls require an isolated-world object or context");
    }
    const result = await this.raw(method, params);
    if (method === "Page.createIsolatedWorld") this.worlds.add(result.executionContextId);
    if (
      method === "Runtime.evaluate" ||
      method === "Runtime.callFunctionOn" ||
      method === "DOM.resolveNode" ||
      method === "Runtime.getProperties"
    )
      this.remember(result, params.objectGroup ?? this.objects.get(params.objectId) ?? "");
    if (method === "Runtime.releaseObject") this.objects.delete(params.objectId);
    if (method === "Runtime.releaseObjectGroup")
      for (const [id, group] of this.objects)
        if (group === params.objectGroup) this.objects.delete(id);
    return result;
  }
}

class QuietTarget {
  private pageValue?: QuietPage;
  private opening?: Promise<QuietPage>;
  constructor(
    readonly owner: QuietBrowser,
    private info: Protocol.Target.TargetInfo,
  ) {}
  get _targetId() {
    return this.info.targetId;
  }
  _getTargetInfo() {
    return this.info;
  }
  _session() {
    return this.pageValue?._client();
  }
  update(info: Protocol.Target.TargetInfo) {
    this.info = info;
  }
  type() {
    return this.info.type;
  }
  url() {
    return this.info.url;
  }
  browserContext() {
    return this.owner.defaultBrowserContext();
  }
  opener() {
    return this.info.openerId ? this.owner.find(this.info.openerId) : undefined;
  }
  async createCDPSession() {
    return this.owner.connection.attach(this._targetId);
  }
  async page() {
    if (this.type() !== "page") return null;
    this.opening ??= (async () => {
      const client = await this.createCDPSession();
      const page = new QuietPage(this, client);
      await client.send("Page.enable");
      await client.send("Page.setLifecycleEventsEnabled", { enabled: true });
      this.pageValue = page;
      return page;
    })();
    return this.opening;
  }
}

class QuietPage {
  private closed = false;
  constructor(
    private targetValue: QuietTarget,
    private client: QuietSession,
  ) {
    client.on("disconnected", () => {
      this.closed = true;
    });
  }
  _client() {
    return this.client;
  }
  target() {
    return this.targetValue;
  }
  url() {
    return this.targetValue.url();
  }
  isClosed() {
    return this.closed;
  }
  createCDPSession() {
    return this.targetValue.createCDPSession();
  }
  async title() {
    return (await this.evaluate(() => document.title)) as string;
  }
  async evaluate(fn: Function | string, ...args: unknown[]): Promise<any> {
    const expression =
      typeof fn === "string" ? fn : `(${fn.toString()})(...${JSON.stringify(args)})`;
    const result = await this.client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  waitForNavigation(options: { timeout?: number; waitUntil?: string } = {}) {
    const event =
      options.waitUntil === "domcontentloaded"
        ? "Page.domContentEventFired"
        : "Page.loadEventFired";
    return new Promise<null>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.client.off(event, done);
        resolve(null);
      };
      const timer = setTimeout(() => {
        this.client.off(event, done);
        reject(new Error("Navigation timeout"));
      }, options.timeout ?? 30_000);
      this.client.once(event, done);
    });
  }
  async goto(url: string, options: { timeout?: number; waitUntil?: string } = {}) {
    const waiting = this.waitForNavigation(options);
    waiting.catch(() => undefined);
    const result = await this.client.send("Page.navigate", { url });
    if (result.errorText) throw new Error(result.errorText);
    if (!result.loaderId) return null;
    return waiting;
  }
  async reload(options: { timeout?: number; waitUntil?: string } = {}) {
    const waiting = this.waitForNavigation(options);
    waiting.catch(() => undefined);
    await this.client.send("Page.reload");
    return waiting;
  }
  async close() {
    await this.targetValue.owner.connection.send("Target.closeTarget", {
      targetId: this.targetValue._targetId,
    });
    this.closed = true;
  }
}

export class QuietBrowser extends EventEmitter {
  private items = new Map<string, QuietTarget>();
  private readonly context = {};
  private constructor(
    readonly connection: QuietConnection,
    private metadata: Fields,
  ) {
    super();
    connection.root.on("Target.targetCreated", ({ targetInfo }) => this.update(targetInfo, true));
    connection.root.on("Target.targetInfoChanged", ({ targetInfo }) =>
      this.update(targetInfo, false),
    );
    connection.root.on("Target.targetDestroyed", ({ targetId }) => {
      const target = this.items.get(targetId);
      this.items.delete(targetId);
      if (target) this.emit("targetdestroyed", target);
    });
    connection.on("disconnected", () => this.emit("disconnected"));
  }
  static async connect(endpoint: string, input: QuietInput) {
    const connection = await QuietConnection.connect(endpoint, input);
    const browser = new QuietBrowser(connection, await connection.send("Browser.getVersion"));
    await connection.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await connection.send("Target.getTargets");
    for (const info of targetInfos) browser.update(info, false);
    await browser.pages();
    return browser;
  }
  // The legacy engine uses Puppeteer types for this small browser/page surface.
  // No Puppeteer connection is created; unsupported action routes reject quiet mode.
  asBrowser(): Browser {
    return this as unknown as Browser;
  }
  get connected() {
    return this.connection.connected;
  }
  find(id: string) {
    return this.items.get(id);
  }
  private update(info: Protocol.Target.TargetInfo, announce: boolean) {
    if (info.type !== "page") return;
    const existing = this.items.get(info.targetId);
    if (existing) {
      existing.update(info);
      return;
    }
    const target = new QuietTarget(this, info);
    this.items.set(info.targetId, target);
    if (announce) this.emit("targetcreated", target);
  }
  targets() {
    return [...this.items.values()];
  }
  defaultBrowserContext() {
    return this.context;
  }
  target() {
    return { createCDPSession: async () => this.connection.root };
  }
  async pages(): Promise<Page[]> {
    const pages = await Promise.all(this.targets().map((target) => target.page()));
    return pages.filter(Boolean) as unknown as Page[];
  }
  async newPage(): Promise<Page> {
    const { targetId } = await this.connection.send("Target.createTarget", { url: "about:blank" });
    for (let i = 0; i < 100 && !this.find(targetId); i++) await sleep(10);
    const page = await this.find(targetId)?.page();
    if (!page) throw new Error("Quiet tab did not open");
    return page as unknown as Page;
  }
  version() {
    return Promise.resolve(this.metadata.product as string);
  }
  userAgent() {
    return Promise.resolve(this.metadata.userAgent as string);
  }
  process() {
    return null;
  }
  async close() {
    await this.connection.send("Browser.close").catch(() => undefined);
    this.connection.close();
  }
}
