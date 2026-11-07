import { type Target, type CDPSession, TargetType } from "puppeteer-core";
import type { FastifyBaseLogger } from "fastify";

import { attachPageEvents, type AttachPageEventsOptions } from "./page-events.js";
import { attachCDPEvents } from "./cdp-events.js";
import { attachBrowserInteractionEvents } from "./browser-interaction-events.js";
import { attachExtensionEvents } from "./extension-events.js";
import { attachWorkerEvents } from "./worker-events.js";
import type { BrowserLogger } from "./browser-logger.js";
import { extractTargetId } from "./utils.js";
import { env } from "../../../env.js";
import type { TargetSessionContext } from "../plugins/core/base-plugin.js";

export interface TargetInstrumentationOptions extends AttachPageEventsOptions {
  captureWorkerNetwork?: boolean;
}

type Domain = "Runtime" | "Page" | "Log" | "Network";

interface Attachment {
  ready: Promise<void>;
  session?: CDPSession;
  owned: boolean;
}

export class TargetInstrumentationManager {
  private readonly attachments = new Map<string, Attachment>();

  constructor(
    private readonly logger: BrowserLogger,
    private readonly appLogger: FastifyBaseLogger,
    private readonly instrumentationOptions: TargetInstrumentationOptions = {},
    private readonly onTargetSession?: (context: TargetSessionContext) => Promise<void>,
  ) {}

  async attach(target: Target, type: TargetType): Promise<void> {
    const id = extractTargetId(target);
    const existing = this.attachments.get(id);
    if (existing) return existing.ready;

    // Publish the pending attachment before setup starts, including synchronous
    // worker hooks. Concurrent callers wait for the same setup or failure.
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const attachment: Attachment = { ready: promise, owned: false };
    this.attachments.set(id, attachment);
    void this.initialize(target, type, id, attachment).then(resolve, (error) => {
      if (this.attachments.get(id) === attachment) this.detach(id);
      reject(error);
    });
    return promise;
  }

  detach(targetId: string): void {
    const attachment = this.attachments.get(targetId);
    if (!attachment) return;
    this.attachments.delete(targetId);
    this.release(attachment);
  }

  clear(): void {
    for (const id of this.attachments.keys()) this.detach(id);
  }

  private release(attachment: Attachment): void {
    const session = attachment.session;
    attachment.session = undefined;
    if (session && attachment.owned) {
      void session.detach().catch(() => {
        // A destroyed target may already have closed the session.
      });
    }
  }

  private async initialize(target: Target, type: TargetType, id: string, attachment: Attachment) {
    const isExtension = target.url().startsWith("chrome-extension://");
    const isPage = type === TargetType.PAGE || type === TargetType.BACKGROUND_PAGE;
    const internals = target as Target & {
      _getTargetInfo?(): { type: string };
      _session?(): CDPSession | undefined;
    };
    const isDedicatedWorker =
      type === TargetType.OTHER && internals._getTargetInfo?.().type === "worker";
    const pausedSession = isDedicatedWorker ? internals._session?.() : undefined;
    if (isDedicatedWorker && !pausedSession) {
      this.appLogger.warn(
        "[TargetManager] Puppeteer's paused dedicated-worker session was unavailable; falling back to createCDPSession(), which may miss initial worker activity",
      );
    }

    const session = pausedSession ?? (await target.createCDPSession());
    attachment.session = session;
    attachment.owned = !pausedSession;
    const active = () => this.attachments.get(id) === attachment;
    if (!active()) {
      this.release(attachment);
      return;
    }

    const targetSession =
      isDedicatedWorker && !isExtension
        ? this.onTargetSession?.({
            target,
            type,
            session,
            isDedicatedWorker,
            isPuppeteerPaused: Boolean(pausedSession),
          })
        : undefined;
    const workerOptions = {
      dangerouslyLogRequestDetails: this.instrumentationOptions.dangerouslyLogRequestDetails,
      captureNetwork: this.instrumentationOptions.captureWorkerNetwork === true,
    };

    if (pausedSession && !isExtension) {
      attachCDPEvents(session, this.logger);
      attachWorkerEvents(target, session, this.logger, type, workerOptions);
      // Queue Network.enable before yielding: Puppeteer resumes this worker
      // when targetcreated returns, even if a plugin hook is still pending.
      await Promise.all([
        workerOptions.captureNetwork ? this.enable(session, "Network", type) : undefined,
        this.enableDomains(session, type, isExtension, isDedicatedWorker, true),
        targetSession,
      ]);
      return;
    }

    await Promise.all([
      this.enableDomains(session, type, isExtension, isDedicatedWorker),
      targetSession,
    ]);
    if (!active()) return;

    if (isPage) {
      const page = await target.page();
      if (!active()) return;
      if (page) {
        await attachPageEvents(page, session, this.logger, type, this.instrumentationOptions);
        if (!active()) return;
        if (!isExtension) {
          await attachBrowserInteractionEvents(session, page, this.logger, type, id);
          if (!active()) return;
        }
      }
    }

    attachCDPEvents(session, this.logger);
    if (isExtension) {
      attachExtensionEvents(target, session, this.logger);
    } else if (
      isDedicatedWorker ||
      type === TargetType.SERVICE_WORKER ||
      type === TargetType.SHARED_WORKER ||
      type === TargetType.WEBVIEW
    ) {
      attachWorkerEvents(
        target,
        session,
        this.logger,
        type,
        type === TargetType.WEBVIEW ? undefined : workerOptions,
      );
    }
  }

  private async enableDomains(
    session: CDPSession,
    type: TargetType,
    isExtension: boolean,
    isDedicatedWorker: boolean,
    networkAlreadyEnabled = false,
  ): Promise<void> {
    let domains: Domain[] = [];
    if (type === TargetType.PAGE || type === TargetType.BACKGROUND_PAGE) {
      domains = ["Runtime", "Page", "Log", "Network"];
    } else if (
      type === TargetType.SERVICE_WORKER ||
      type === TargetType.SHARED_WORKER ||
      ((type === TargetType.WEBVIEW || type === TargetType.OTHER) &&
        (isExtension || isDedicatedWorker))
    ) {
      domains = ["Runtime", "Log"];
      if (isExtension || this.instrumentationOptions.captureWorkerNetwork === true) {
        domains.push("Network");
      }
    }
    for (const domain of domains) {
      if (domain === "Network" && networkAlreadyEnabled) continue;
      await this.enable(session, domain, type);
    }
  }

  private async enable(session: CDPSession, domain: Domain, type: TargetType): Promise<void> {
    if (!env.CAPTURE_CONSOLE_EVENTS && (domain === "Runtime" || domain === "Log")) return;
    try {
      await session.send(`${domain}.enable`);
    } catch (err) {
      this.appLogger.error({ err }, `[TargetManager] Failed to enable ${domain} for ${type}:`);
    }
  }
}
