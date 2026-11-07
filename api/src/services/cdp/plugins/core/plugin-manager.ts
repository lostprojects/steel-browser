import type { Browser, Page } from "puppeteer-core";
import type { BrowserSession } from "../../../browser-session.js";
import type { BasePlugin, ShutdownReason, TargetSessionContext } from "./base-plugin.js";
import type { FastifyBaseLogger } from "fastify";
import type { BrowserLauncherOptions } from "../../../../types/browser.js";

export class PluginManager {
  private readonly plugins = new Map<string, BasePlugin>();

  constructor(
    private readonly service: BrowserSession,
    private readonly logger: FastifyBaseLogger,
  ) {}

  register(plugin: BasePlugin): void {
    if (this.plugins.has(plugin.name))
      this.logger.warn(`Plugin with name ${plugin.name} is already registered. Overwriting.`);
    plugin.setService(this.service);
    this.plugins.set(plugin.name, plugin);
    this.logger.info(`Registered plugin: ${plugin.name}`);
  }

  unregister(name: string): boolean {
    const removed = this.plugins.delete(name);
    this.logger.info({ plugin: name, removed }, "Plugin unregister");
    return removed;
  }

  getPlugin<T extends BasePlugin>(name: string): T | undefined {
    return this.plugins.get(name) as T | undefined;
  }

  // Each hook receives the same plugin snapshot. A failing plugin cannot prevent
  // another plugin's hook from running, for either synchronous or async hooks.
  private async notify(hook: string, invoke: (plugin: BasePlugin) => unknown): Promise<void> {
    await Promise.all(
      [...this.plugins.values()].map(async (plugin) => {
        try {
          await invoke(plugin);
        } catch (error) {
          this.logger.error(
            { err: error, plugin: plugin.name, hook },
            "Browser plugin hook failed",
          );
        }
      }),
    );
  }

  onSessionStart(config: BrowserLauncherOptions): Promise<void> {
    return this.notify("onSessionStart", (plugin) => plugin.onSessionStart(config));
  }

  onBeforeSessionEnd(config: BrowserLauncherOptions): Promise<void> {
    return this.notify("onBeforeSessionEnd", (plugin) => plugin.onBeforeSessionEnd(config));
  }

  onAfterSessionEnd(config: BrowserLauncherOptions): Promise<void> {
    return this.notify("onAfterSessionEnd", (plugin) => plugin.onAfterSessionEnd(config));
  }

  onBrowserLaunch(browser: Browser): Promise<void> {
    return this.notify("onBrowserLaunch", (plugin) => plugin.onBrowserLaunch(browser));
  }

  onBrowserReady(config: BrowserLauncherOptions): Promise<void> {
    return this.notify("onBrowserReady", (plugin) => plugin.onBrowserReady(config));
  }

  onPageCreated(page: Page): Promise<void> {
    return this.notify("onPageCreated", (plugin) => plugin.onPageCreated(page));
  }

  onTargetSession(context: TargetSessionContext): Promise<void> {
    return this.notify("onTargetSession", (plugin) => plugin.onTargetSession(context));
  }

  onBrowserClose(browser: Browser): Promise<void> {
    return this.notify("onBrowserClose", (plugin) => plugin.onBrowserClose(browser));
  }

  onPageNavigate(page: Page): Promise<void> {
    return this.notify("onPageNavigate", (plugin) => plugin.onPageNavigate(page));
  }

  onPageUnload(page: Page): Promise<void> {
    return this.notify("onPageUnload", (plugin) => plugin.onPageUnload(page));
  }

  onBeforePageClose(page: Page): Promise<void> {
    return this.notify("onBeforePageClose", (plugin) => plugin.onBeforePageClose(page));
  }

  onShutdown(reason: ShutdownReason): Promise<void> {
    return this.notify("onShutdown", (plugin) => plugin.onShutdown(reason));
  }

  onSessionEnd(config: BrowserLauncherOptions): Promise<void> {
    return this.notify("onSessionEnd", (plugin) => plugin.onSessionEnd(config));
  }
}
