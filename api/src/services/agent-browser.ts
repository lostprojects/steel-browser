// Puppeteer integration is confined to the agent backend. Its private target
// hooks are used here for early dialog observation, before page setup completes.
import { EventEmitter } from "node:events";
import {
  CDPSessionEvent,
  ProtocolError,
  type Browser,
  type Page,
  type Target,
  type CDPSession,
  type Connection,
  type EvaluateFunc,
  type Protocol,
} from "puppeteer-core";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import {
  AGENT_CAPABILITIES,
  BrowserProtocolError,
  type BrowserControl,
  type BrowserConnection,
  type BrowserTarget,
  type ControlSession,
  type PageRead,
  type NavigationOptions,
} from "./browser-control.js";

type InternalTarget = Target & {
  _targetId: string;
  _session?(): CDPSession | undefined;
  _getTargetInfo(): Protocol.Target.TargetInfo;
};

class AgentSession implements ControlSession {
  constructor(
    private raw: CDPSession,
    private owner: AgentConnection,
  ) {}
  id() {
    return this.raw.id();
  }
  childSession(id: string) {
    return this.owner.session(id);
  }
  send: ControlSession["send"] = (method, ...params) =>
    this.raw.send(method, ...params).catch((error: unknown) => {
      if (error instanceof ProtocolError)
        throw new BrowserProtocolError(error.message, { cause: error });
      throw error;
    });
  on<E extends keyof ProtocolMapping.Events>(
    event: E,
    listener: (...args: ProtocolMapping.Events[E]) => void,
  ) {
    this.raw.on(event, listener as never);
  }
  off<E extends keyof ProtocolMapping.Events>(
    event: E,
    listener: (...args: ProtocolMapping.Events[E]) => void,
  ) {
    this.raw.off(event, listener as never);
  }
  detach() {
    return this.raw.detach();
  }
  readonly input = {
    mouse: (params: Protocol.Input.DispatchMouseEventRequest) =>
      this.raw.send("Input.dispatchMouseEvent", params),
    key: (params: Protocol.Input.DispatchKeyEventRequest) =>
      this.raw.send("Input.dispatchKeyEvent", params),
    text: (text: string) => this.raw.send("Input.insertText", { text }),
  };
  domSnapshot = (options: Protocol.DOMSnapshot.CaptureSnapshotRequest) =>
    this.raw.send("DOMSnapshot.captureSnapshot", options);
  capture(options: Protocol.Page.CaptureScreenshotRequest) {
    return this.raw.send("Page.captureScreenshot", options);
  }
  print = (options: Protocol.Page.PrintToPDFRequest) => this.raw.send("Page.printToPDF", options);
}
class AgentConnection extends EventEmitter implements BrowserConnection {
  private wrapped = new WeakMap<CDPSession, AgentSession>();
  private readonly targetIds = new Map<string, string>();
  constructor(private raw: Connection) {
    super();
    raw.on(CDPSessionEvent.SessionAttached, (session) =>
      this.emit("sessionattached", this.wrap(session)),
    );
    raw.on(CDPSessionEvent.SessionDetached, (session) => {
      this.emit("sessiondetached", this.wrap(session));
      this.targetIds.delete(session.id());
    });
    raw.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
      const session = raw.session(sessionId);
      if (session) this.wrap(session, targetInfo.targetId);
    });
    raw.on("Target.targetCrashed", ({ targetId }) => this.emit("targetcrashed", targetId));
  }
  wrap(raw: CDPSession, targetId?: string) {
    if (targetId) this.targetIds.set(raw.id(), targetId);
    let session = this.wrapped.get(raw);
    if (!session) {
      session = new AgentSession(raw, this);
      this.wrapped.set(raw, session);
      raw.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
        const child = this.raw.session(sessionId);
        if (child) this.wrap(child, targetInfo.targetId);
      });
      raw.on("Inspector.targetCrashed", () => {
        const target = this.targetIds.get(raw.id());
        if (target) this.emit("targetcrashed", target);
      });
    }
    return session;
  }
  session(id: string) {
    const raw = this.raw.session(id);
    return raw ? this.wrap(raw) : undefined;
  }
  send: BrowserConnection["send"] = (method, ...params) => this.raw.send(method, ...params);
}
class AgentPage implements PageRead {
  constructor(
    private raw: Page,
    private owner: AgentBrowser,
  ) {}
  get targetId() {
    return this.owner.target(this.raw.target()).id;
  }
  get client() {
    return this.owner.connection.wrap(
      (this.raw as Page & { _client(): CDPSession })._client(),
      this.targetId,
    );
  }
  ready() {
    return this.owner.setup(this.raw);
  }
  url() {
    return this.raw.url();
  }
  isClosed() {
    return this.raw.isClosed();
  }
  async evaluate<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
    ...args: Args
  ): Promise<Awaited<Result>> {
    return this.raw.evaluate(fn as EvaluateFunc<Args>, ...args) as Promise<Awaited<Result>>;
  }
  goto(url: string, options?: NavigationOptions) {
    return this.raw.goto(url, options);
  }
  reload(options?: NavigationOptions) {
    return this.raw.reload(options);
  }
  waitForNavigation(options?: NavigationOptions) {
    return this.raw.waitForNavigation(options);
  }
  waitForNetworkIdle = (options: { idleTime: number; timeout: number; signal: AbortSignal }) =>
    this.raw.waitForNetworkIdle(options);
  async createSession() {
    return this.owner.connection.wrap(await this.raw.createCDPSession());
  }
  close() {
    return this.raw.close();
  }
}
class AgentTarget implements BrowserTarget {
  constructor(
    private raw: InternalTarget,
    private owner: AgentBrowser,
  ) {}
  get id() {
    return this.raw._targetId;
  }
  get info() {
    return this.raw._getTargetInfo();
  }
  get defaultContext() {
    return this.raw.browserContext() === this.owner.raw.defaultBrowserContext();
  }
  get client() {
    const raw = this.raw._session?.();
    return raw ? this.owner.connection.wrap(raw, this.id) : undefined;
  }
  async page() {
    const raw = await this.raw.page();
    return raw ? this.owner.page(raw) : null;
  }
}
export class AgentBrowser extends EventEmitter implements BrowserControl {
  readonly capabilities = AGENT_CAPABILITIES;
  readonly connection: AgentConnection;
  private targetsByObject = new WeakMap<Target, AgentTarget>();
  private pagesByObject = new WeakMap<Page, AgentPage>();
  private constructor(
    readonly raw: Browser,
    connection: Connection,
    readonly setup: (page: Page) => Promise<void>,
  ) {
    super();
    this.connection = new AgentConnection(connection);
    this.connection.on("targetcrashed", (targetId: string) => this.emit("targetcrashed", targetId));
    raw.on("targetcreated", (target) => this.emit("targetcreated", this.target(target)));
    raw.on("targetdestroyed", (target) => this.emit("targetdestroyed", this.target(target)));
  }
  static async connect(browser: Browser, setup: (page: Page) => Promise<void> = async () => {}) {
    const root = await browser.target().createCDPSession();
    try {
      const connection = root.connection();
      if (!connection) throw new Error("Agent browser connection is unavailable");
      return new AgentBrowser(browser, connection, setup);
    } finally {
      await root.detach();
    }
  }
  target(raw: Target) {
    let target = this.targetsByObject.get(raw);
    if (!target) {
      target = new AgentTarget(raw as InternalTarget, this);
      this.targetsByObject.set(raw, target);
      const client = (raw as InternalTarget)._session?.();
      if (client) this.connection.wrap(client, target.id);
    }
    return target;
  }
  page(raw: Page) {
    let page = this.pagesByObject.get(raw);
    if (!page) {
      page = new AgentPage(raw, this);
      this.pagesByObject.set(raw, page);
    }
    return page;
  }
  targets() {
    return this.raw.targets().map((target) => this.target(target));
  }
  async pages() {
    return (await this.raw.pages()).map((page) => this.page(page));
  }
  async newPage() {
    return this.page(await this.raw.newPage());
  }
  // Each caller owns its control session and may detach without disrupting peers.
  async controlSession() {
    return this.connection.wrap(await this.raw.target().createCDPSession());
  }
}
