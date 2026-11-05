import { env } from "../env.js";
import { makePassthrough, PassthroughServer } from "./passthough-proxy.js";
import { Server } from "proxy-chain";

export interface IProxyServer {
  readonly url: string;
  readonly upstreamProxyUrl: string;
  readonly txBytes: number;
  readonly rxBytes: number;
  readonly traffic?: Array<{ hostname: string; txBytes: number; rxBytes: number }>;
  readonly directBytes?: number;
  listen(): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export type HostRoute = "residential" | "direct" | "refused";
// Measured on Bizapedia. Enforce at CONNECT, without pausing browser requests.
// Other identities retain their existing traffic policy.
export function identityHostRoute(host: string, identity?: string): HostRoute {
  if (
    identity === "bizapedia" &&
    ["adthrive.com", "adthrive.net", "gumgum.com", "btloader.com", "privacymanager.io"].some(
      (s) => host === s || host.endsWith(`.${s}`),
    )
  )
    return "refused";
  return "residential";
}
// Unknown hosts and challenge providers retain the session's residential exit.
export function hostRoute(host: string): HostRoute {
  if (
    [
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "cdnjs.cloudflare.com",
      "cdn.jsdelivr.net",
      "unpkg.com",
    ].includes(host)
  )
    return "direct";
  if (
    [
      "doubleclick.net",
      "googlesyndication.com",
      "google-analytics.com",
      "googletagmanager.com",
      "youtube.com",
    ].some((s) => host === s || host.endsWith(`.${s}`))
  )
    return "refused";
  return "residential";
}

export class ProxyServer extends Server implements IProxyServer {
  public url: string;
  public upstreamProxyUrl: string;
  private settledTxBytes = 0;
  private settledRxBytes = 0;
  private hostConnections = new Set<number>();
  private connectionHosts = new Map<number, string>();
  private settledHosts = new Map<string, { txBytes: number; rxBytes: number }>();
  private routes = new Map<number, HostRoute>();
  private settledDirect = 0;
  get directBytes() {
    let bytes = this.settledDirect;
    for (const [id, route] of this.routes)
      if (route === "direct") {
        const s = this.getConnectionStats(id);
        bytes += (s?.trgTxBytes ?? 0) + (s?.trgRxBytes ?? 0);
      }
    return bytes;
  }

  get traffic() {
    const totals = new Map([...this.settledHosts].map(([host, bytes]) => [host, { ...bytes }]));
    for (const [id, host] of this.connectionHosts) {
      if (this.routes.get(id) !== "residential") continue;
      const stats = this.getConnectionStats(id);
      const bytes = totals.get(host) ?? { txBytes: 0, rxBytes: 0 };
      bytes.txBytes += stats?.trgTxBytes ?? 0;
      bytes.rxBytes += stats?.trgRxBytes ?? 0;
      totals.set(host, bytes);
    }
    return [...totals]
      .map(([hostname, bytes]) => ({ hostname, ...bytes }))
      .sort((a, b) => b.rxBytes + b.txBytes - a.rxBytes - a.txBytes);
  }

  private openBytes(field: "trgTxBytes" | "trgRxBytes"): number {
    return this.getConnectionIds().reduce((total, id) => {
      if (this.hostConnections.has(id) || this.routes.get(id) !== "residential") return total;
      return total + (this.getConnectionStats(id)?.[field] ?? 0);
    }, 0);
  }

  get txBytes(): number {
    return this.settledTxBytes + this.openBytes("trgTxBytes");
  }

  get rxBytes(): number {
    return this.settledRxBytes + this.openBytes("trgRxBytes");
  }

  constructor(
    proxyUrl: string,
    split = false,
    allowed: () => boolean = () => true,
    identity?: string,
  ) {
    super({
      port: 0,
      host: "127.0.0.1",

      prepareRequestFunction: (options) => {
        const { connectionId, hostname } = options;
        if (!allowed()) throw new Error("Residential byte budget exhausted");

        const internalBypassTests = new Set(["0.0.0.0", process.env.HOST]);

        if (env.PROXY_INTERNAL_BYPASS) {
          for (const host of env.PROXY_INTERNAL_BYPASS.split(",")) {
            internalBypassTests.add(host.trim());
          }
        }

        const isInternalBypass = internalBypassTests.has(hostname);

        if (isInternalBypass) {
          this.hostConnections.add(connectionId);
          return {
            customConnectServer: PassthroughServer,
            customResponseFunction: makePassthrough(options),
          };
        }
        this.connectionHosts.set(connectionId, hostname);
        const siteRoute = identityHostRoute(hostname, identity);
        const route =
          siteRoute === "refused" ? siteRoute : split ? hostRoute(hostname) : "residential";
        this.routes.set(connectionId, route);
        if (route === "refused") throw new Error("Host refused by measured traffic policy");
        return {
          requestAuthentication: false,
          upstreamProxyUrl: route === "direct" ? undefined : proxyUrl,
        };
      },
    });

    this.on("connectionClosed", ({ connectionId, stats }) => {
      if (stats && this.routes.get(connectionId) === "direct")
        this.settledDirect += (stats.trgTxBytes ?? 0) + (stats.trgRxBytes ?? 0);
      if (
        stats &&
        !this.hostConnections.has(connectionId) &&
        this.routes.get(connectionId) === "residential"
      ) {
        this.settledTxBytes += stats.trgTxBytes ?? 0;
        this.settledRxBytes += stats.trgRxBytes ?? 0;
        const host = this.connectionHosts.get(connectionId);
        if (host) {
          const bytes = this.settledHosts.get(host) ?? { txBytes: 0, rxBytes: 0 };
          bytes.txBytes += stats.trgTxBytes ?? 0;
          bytes.rxBytes += stats.trgRxBytes ?? 0;
          this.settledHosts.set(host, bytes);
        }
      }
      this.connectionHosts.delete(connectionId);
      this.hostConnections.delete(connectionId);
      this.routes.delete(connectionId);
    });

    this.url = `http://127.0.0.1:${this.port}`;
    this.upstreamProxyUrl = proxyUrl;
  }

  async listen(): Promise<void> {
    await super.listen();
    this.url = `http://127.0.0.1:${this.port}`;
  }

  async close(force = false): Promise<void> {
    const socketsClosed = [...this.connections.values()].map(
      (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    await super.close(force);
    await Promise.all(socketsClosed);
  }
}
