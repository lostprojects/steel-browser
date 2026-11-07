// The command boundary owns these capabilities. Protocol messages serve DOM and
// accessibility algorithms; input and image capture use explicit backend methods.
import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

export interface BrowserCapabilities {
  readonly input: "native" | "cdp";
  readonly capture: "display" | "page";
  readonly fullPageCapture: boolean;
  readonly elementCapture: boolean;
  readonly captureQuality: boolean;
  readonly pdf: boolean;
  readonly networkIdle: boolean;
}

export const AGENT_CAPABILITIES: BrowserCapabilities = Object.freeze({
  input: "cdp",
  capture: "page",
  fullPageCapture: true,
  elementCapture: true,
  captureQuality: true,
  pdf: true,
  networkIdle: true,
});
export const QUIET_CAPABILITIES: BrowserCapabilities = Object.freeze({
  input: "native",
  capture: "display",
  fullPageCapture: false,
  elementCapture: false,
  captureQuality: false,
  pdf: false,
  networkIdle: false,
});

// Protocol primitives used by locator, snapshot and lifecycle algorithms.
// Input, capture and instrumentation are separate from this surface.
type ProtocolMethod =
  | "Accessibility.enable"
  | "Accessibility.getFullAXTree"
  | "Accessibility.getChildAXNodes"
  | "Accessibility.getPartialAXTree"
  | "Browser.cancelDownload"
  | "Browser.setDownloadBehavior"
  | "DOM.describeNode"
  | "DOM.enable"
  | "DOM.focus"
  | "DOM.getBoxModel"
  | "DOM.getContentQuads"
  | "DOM.getFrameOwner"
  | "DOM.getNodeForLocation"
  | "DOM.resolveNode"
  | "DOM.scrollIntoViewIfNeeded"
  | "DOM.setFileInputFiles"
  | "Page.bringToFront"
  | "Page.createIsolatedWorld"
  | "Page.enable"
  | "Page.getFrameTree"
  | "Page.getLayoutMetrics"
  | "Page.getNavigationHistory"
  | "Page.handleJavaScriptDialog"
  | "Page.navigate"
  | "Page.navigateToHistoryEntry"
  | "Page.reload"
  | "Page.setLifecycleEventsEnabled"
  | "Page.stopLoading"
  | "Runtime.callFunctionOn"
  | "Runtime.evaluate"
  | "Runtime.getProperties"
  | "Runtime.releaseObject"
  | "Runtime.releaseObjectGroup"
  | "Runtime.terminateExecution"
  | "Storage.getCookies"
  | "Storage.setCookies"
  | "Target.closeTarget"
  | "Target.getBrowserContexts"
  | "Target.getTargetInfo"
  | "Target.getTargets"
  | "Target.setAutoAttach";

export class BrowserProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserProtocolError";
  }
}
export interface BrowserInput {
  mouse(params: Protocol.Input.DispatchMouseEventRequest): Promise<unknown>;
  key(params: Protocol.Input.DispatchKeyEventRequest): Promise<unknown>;
  text(text: string): Promise<unknown>;
}
export interface ControlSession {
  id(): string;
  childSession(id: string): ControlSession | undefined;
  send<M extends ProtocolMethod>(
    method: M,
    ...params: ProtocolMapping.Commands[M]["paramsType"]
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
  on<E extends keyof ProtocolMapping.Events>(
    event: E,
    listener: (...args: ProtocolMapping.Events[E]) => void,
  ): unknown;
  off<E extends keyof ProtocolMapping.Events>(
    event: E,
    listener: (...args: ProtocolMapping.Events[E]) => void,
  ): unknown;
  detach(): Promise<void>;
  readonly input: BrowserInput;
  // Backends may offer the bulk DOM read used to speed up snapshots. Readers
  // fall back to per-node reads when this capability is absent.
  domSnapshot?: (
    options: Protocol.DOMSnapshot.CaptureSnapshotRequest,
  ) => Promise<Protocol.DOMSnapshot.CaptureSnapshotResponse>;
  capture(
    options: Protocol.Page.CaptureScreenshotRequest,
  ): Promise<Protocol.Page.CaptureScreenshotResponse>;
  print?: (options: Protocol.Page.PrintToPDFRequest) => Promise<Protocol.Page.PrintToPDFResponse>;
}
export interface BrowserConnection {
  send<M extends ProtocolMethod>(
    method: M,
    ...params: ProtocolMapping.Commands[M]["paramsType"]
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
  on(
    event: "sessionattached" | "sessiondetached",
    listener: (session: ControlSession) => void,
  ): unknown;
  off(
    event: "sessionattached" | "sessiondetached",
    listener: (session: ControlSession) => void,
  ): unknown;
}
export interface NavigationOptions {
  timeout?: number;
  waitUntil?: "load" | "domcontentloaded";
}
export interface PageRead {
  readonly targetId: string;
  readonly client: ControlSession;
  ready(): Promise<void>;
  url(): string;
  isClosed(): boolean;
  evaluate<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
    ...args: Args
  ): Promise<Awaited<Result>>;
  goto(url: string, options?: NavigationOptions): Promise<{ status(): number } | null>;
  reload(options?: NavigationOptions): Promise<unknown>;
  waitForNavigation(options?: NavigationOptions): Promise<unknown>;
  waitForNetworkIdle?: (options: {
    idleTime: number;
    timeout: number;
    signal: AbortSignal;
  }) => Promise<void>;
  createSession(): Promise<ControlSession>;
  close(): Promise<void>;
}
export interface BrowserTarget {
  readonly id: string;
  readonly info: Protocol.Target.TargetInfo;
  readonly defaultContext: boolean;
  readonly client: ControlSession | undefined;
  page(): Promise<PageRead | null>;
}
export interface BrowserControl {
  readonly capabilities: BrowserCapabilities;
  readonly connection: BrowserConnection;
  targets(): BrowserTarget[];
  pages(): Promise<PageRead[]>;
  newPage(): Promise<PageRead>;
  controlSession(): Promise<ControlSession>;
  on(
    event: "targetcreated" | "targetdestroyed",
    listener: (target: BrowserTarget) => void,
  ): unknown;
  on(event: "targetcrashed", listener: (targetId: string) => void): unknown;
  off(
    event: "targetcreated" | "targetdestroyed",
    listener: (target: BrowserTarget) => void,
  ): unknown;
  off(event: "targetcrashed", listener: (targetId: string) => void): unknown;
}
