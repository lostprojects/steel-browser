import type { SessionData } from "../services/context/types.js";

/** Configuration supplied to agent-mode lifecycle hooks. */
export interface BrowserLauncherOptions {
  options: BrowserServerOptions;
  sessionContext?: SessionData;
  timezone?: Promise<string>;
  dimensions?: { width: number; height: number } | null;
  userDataDir?: string;
  blockAds?: false;
}

export interface BrowserServerOptions {
  headless?: boolean;
  proxyUrl?: string;
}
