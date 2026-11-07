// A direct CDP client for the commands engine. It must not enable Runtime,
// instrument page scripts, pause new targets, or send synthetic CDP input.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Protocol } from "devtools-protocol";
import {
  QUIET_CAPABILITIES,
  BrowserProtocolError,
  type BrowserControl,
  type BrowserConnection,
  type BrowserTarget,
  type PageRead,
  type ControlSession,
} from "./browser-control.js";
import { QuietInput } from "./quiet-input.js";

type Fields = Record<string, any>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class QuietConnection extends EventEmitter implements BrowserConnection {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      sessionId: string;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
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
        if (message.error) pending.reject(new BrowserProtocolError(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      const session = this.sessions.get(message.sessionId ?? "");
      if (message.method === "Target.attachedToTarget") {
        const child = this.add(message.params.sessionId, message.params.targetInfo.targetId);
        child.parent = session;
        this.emit("sessionattached", child);
      }
      session?.emit(message.method, message.params);
      if (message.method === "Inspector.targetCrashed" && session?.targetId)
        this.emit("targetcrashed", session.targetId);
      if (message.method === "Target.targetCrashed")
        this.emit("targetcrashed", message.params.targetId);
      if (message.method === "Target.detachedFromTarget") {
        const child = this.sessions.get(message.params.sessionId);
        this.sessions.delete(message.params.sessionId);
        this.rejectPending(new Error("Quiet CDP session detached"), message.params.sessionId);
        child?.emit("disconnected");
        if (child) this.emit("sessiondetached", child);
      }
    });
    ws.on("close", () => {
      this.rejectPending(new Error("Quiet CDP connection closed"));
      for (const session of this.sessions.values()) session.emit("disconnected");
      this.sessions.clear();
      this.emit("disconnected");
    });
    ws.on("error", () => ws.close());
  }

  private rejectPending(error: Error, sessionId?: string) {
    for (const [id, pending] of this.pending) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  static async connect(endpoint: string, input: QuietInput) {
    const ws = new WebSocket(endpoint, { handshakeTimeout: 10_000 });
    const connection = new QuietConnection(ws, input);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off("open", opened);
        ws.off("error", failed);
        ws.off("close", closed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => failed(new Error("Quiet CDP connection closed before opening"));
      ws.once("open", opened);
      ws.once("error", failed);
      ws.once("close", closed);
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
  async attachBrowser() {
    const { sessionId } = await this.send("Target.attachToBrowserTarget");
    return this.add(sessionId, "");
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
      this.pending.set(id, { sessionId, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.ws.close();
  }
}

export class QuietSession extends EventEmitter implements ControlSession {
  parent?: QuietSession;
  private disconnected = false;
  private worlds = new Map<number, string>();
  private objects = new Map<string, { group: string; contextId: number }>();
  constructor(
    private conn: QuietConnection,
    private sessionId: string,
    readonly targetId: string,
  ) {
    super();
    this.on("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId) {
        this.worlds.clear();
        this.objects.clear();
      } else this.invalidateFrame(frame.id);
    });
    this.on("Page.frameDetached", ({ frameId }) => this.invalidateFrame(frameId));
    this.once("disconnected", () => {
      this.disconnected = true;
      this.worlds.clear();
      this.objects.clear();
    });
  }
  private invalidateFrame(frameId: string) {
    for (const [contextId, owner] of this.worlds)
      if (owner === frameId) this.worlds.delete(contextId);
    for (const [id, object] of this.objects)
      if (!this.worlds.has(object.contextId)) this.objects.delete(id);
  }
  id() {
    return this.sessionId;
  }
  childSession(id: string) {
    return this.conn.session(id);
  }
  private raw(method: string, params: Fields = {}) {
    if (this.disconnected) return Promise.reject(new Error("Quiet CDP session detached"));
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
  private remember(value: any, group: string, contextId: number) {
    if (!value || typeof value !== "object") return;
    if (typeof value.objectId === "string") this.objects.set(value.objectId, { group, contextId });
    for (const item of Object.values(value)) this.remember(item, group, contextId);
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
  readonly input = {
    mouse: (params: Protocol.Input.DispatchMouseEventRequest) => this.pointer(params),
    key: (params: Protocol.Input.DispatchKeyEventRequest) => this.conn.input.key(params),
    text: (text: string) => this.conn.input.text(text),
  };
  async capture(options: Protocol.Page.CaptureScreenshotRequest) {
    if (options.clip || options.captureBeyondViewport || options.quality !== undefined)
      throw new Error("Quiet capture supports the visible display at its native quality");
    return this.conn.input.screenshot(options.format);
  }
  async send(method: string, original: Fields = {}): Promise<any> {
    if (this.disconnected) throw new Error("Quiet CDP session detached");
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
        "Page.captureScreenshot",
      ].includes(method)
    ) {
      throw new Error(`Quiet policy refuses ${method}`);
    }
    if (
      method === "Target.setAutoAttach" &&
      (params.waitForDebuggerOnStart || !params.filter?.every((f: Fields) => f.type === "iframe"))
    )
      throw new Error("Quiet sessions may attach only to unpaused iframe targets");
    if (method === "Runtime.evaluate") {
      if (params.contextId === undefined)
        for (let attempt = 0; attempt < 3; attempt++) {
          params.contextId = await this.world();
          if (this.worlds.has(params.contextId)) break;
        }
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
    if (method === "Page.createIsolatedWorld")
      this.worlds.set(result.executionContextId, params.frameId);
    if (
      method === "Runtime.evaluate" ||
      method === "Runtime.callFunctionOn" ||
      method === "DOM.resolveNode" ||
      method === "Runtime.getProperties"
    )
      this.remember(
        result,
        params.objectGroup ?? this.objects.get(params.objectId)?.group ?? "",
        params.contextId ??
          params.executionContextId ??
          this.objects.get(params.objectId)?.contextId,
      );
    if (method === "Runtime.releaseObject") this.objects.delete(params.objectId);
    if (method === "Runtime.releaseObjectGroup")
      for (const [id, object] of this.objects)
        if (object.group === params.objectGroup) this.objects.delete(id);
    return result;
  }
}

class QuietTarget implements BrowserTarget {
  private pageValue?: QuietPage;
  private opening?: Promise<QuietPage>;
  constructor(
    readonly owner: QuietBrowser,
    public info: Protocol.Target.TargetInfo,
  ) {}
  get id() {
    return this.info.targetId;
  }
  get client() {
    return this.pageValue?.client;
  }
  get defaultContext() {
    return true;
  }
  update(info: Protocol.Target.TargetInfo) {
    this.info = info;
  }
  async createSession() {
    return this.owner.connection.attach(this.id);
  }
  async page() {
    if (this.info.type !== "page") return null;
    this.opening ??= (async () => {
      const client = await this.createSession();
      const page = new QuietPage(this, client);
      await client.send("Page.enable");
      await client.send("Page.setLifecycleEventsEnabled", { enabled: true });
      this.pageValue = page;
      return page;
    })();
    return this.opening;
  }
}

class QuietPage implements PageRead {
  private closed = false;
  constructor(
    private targetValue: QuietTarget,
    readonly client: QuietSession,
  ) {
    client.on("disconnected", () => {
      this.closed = true;
    });
  }
  get targetId() {
    return this.targetValue.id;
  }
  async ready() {}
  url() {
    return this.targetValue.info.url;
  }
  isClosed() {
    return this.closed;
  }
  createSession() {
    return this.targetValue.createSession();
  }
  async evaluate<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
    ...args: Args
  ): Promise<Awaited<Result>> {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const result = await this.client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  waitForNavigation(options: { timeout?: number; waitUntil?: string } = {}, signal?: AbortSignal) {
    const event =
      options.waitUntil === "domcontentloaded"
        ? "Page.domContentEventFired"
        : "Page.loadEventFired";
    return new Promise<null>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.client.off(event, done);
        this.client.off("disconnected", closed);
        signal?.removeEventListener("abort", aborted);
      };
      const finish = (error?: Error) => {
        cleanup();
        if (error) reject(error);
        else resolve(null);
      };
      const done = () => finish();
      const closed = () => finish(new Error("Quiet page closed during navigation"));
      const aborted = () => finish(new Error("Navigation wait stopped"));
      const timer = setTimeout(
        () => finish(new Error("Navigation timeout")),
        options.timeout ?? 30_000,
      );
      this.client.once(event, done);
      this.client.once("disconnected", closed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (this.closed) closed();
      else if (signal?.aborted) aborted();
    });
  }
  async goto(url: string, options: { timeout?: number; waitUntil?: string } = {}) {
    const controller = new AbortController();
    const waiting = this.waitForNavigation(options, controller.signal);
    waiting.catch(() => undefined);
    try {
      const result = await this.client.send("Page.navigate", { url });
      if (result.errorText) throw new Error(result.errorText);
      if (!result.loaderId) return null;
      return await waiting;
    } finally {
      controller.abort();
    }
  }
  async reload(options: { timeout?: number; waitUntil?: string } = {}) {
    const controller = new AbortController();
    const waiting = this.waitForNavigation(options, controller.signal);
    waiting.catch(() => undefined);
    try {
      await this.client.send("Page.reload");
      return await waiting;
    } finally {
      controller.abort();
    }
  }
  async close() {
    await this.targetValue.owner.connection.send("Target.closeTarget", {
      targetId: this.targetValue.id,
    });
    this.closed = true;
  }
}

export class QuietBrowser extends EventEmitter implements BrowserControl {
  readonly capabilities = QUIET_CAPABILITIES;
  private items = new Map<string, QuietTarget>();
  private constructor(readonly connection: QuietConnection) {
    super();
    connection.on("targetcrashed", (targetId: string) => this.emit("targetcrashed", targetId));
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
    try {
      const browser = new QuietBrowser(connection);
      await connection.send("Target.setDiscoverTargets", { discover: true });
      const { targetInfos } = await connection.send("Target.getTargets");
      for (const info of targetInfos) browser.update(info, false);
      await browser.pages();
      return browser;
    } catch (error) {
      connection.close();
      throw error;
    }
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
  async controlSession() {
    // A browser-scoped session with independent lifetime, like the agent backend.
    return this.connection.attachBrowser();
  }
  async pages(): Promise<PageRead[]> {
    const pages = await Promise.all(this.targets().map((target) => target.page()));
    return pages.filter((page): page is QuietPage => page !== null);
  }
  async newPage(): Promise<PageRead> {
    const { targetId } = await this.connection.send("Target.createTarget", { url: "about:blank" });
    for (let i = 0; i < 100 && !this.find(targetId); i++) await sleep(10);
    const page = await this.find(targetId)?.page();
    if (!page) throw new Error("Quiet tab did not open");
    return page;
  }
  async close() {
    await this.connection.send("Browser.close").catch(() => undefined);
    this.connection.close();
  }
}
