import { Server } from "proxy-chain";
import { BlockList, isIP } from "node:net";

const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  privateNetworks.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  privateNetworks.addSubnet(address, prefix, "ipv6");
export function proxyHostAllowed(host: string) {
  host = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !host ||
    ["localhost", "metadata.google.internal"].includes(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return false;
  const family = isIP(host);
  if (family === 6 && host.startsWith("::ffff:")) return false;
  return !family || !privateNetworks.check(host, family === 4 ? "ipv4" : "ipv6");
}

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
    (hostRoute(host) === "refused" ||
      [
        "adthrive.com",
        "adthrive.net",
        "gumgum.com",
        "btloader.com",
        "privacymanager.io",
        "analytics.google.com",
      ].some((s) => host === s || host.endsWith(`.${s}`)))
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
  private budgetTimer?: NodeJS.Timeout;
  private admission: () => boolean;
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
      if (this.routes.get(id) !== "residential") return total;
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
        if (!proxyHostAllowed(hostname)) throw new Error("Private proxy destination refused");
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
      if (stats && this.routes.get(connectionId) === "residential") {
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
      this.routes.delete(connectionId);
    });

    this.url = `http://127.0.0.1:${this.port}`;
    this.upstreamProxyUrl = proxyUrl;
    this.admission = allowed;
  }

  async listen(): Promise<void> {
    await super.listen();
    this.url = `http://127.0.0.1:${this.port}`;
    this.budgetTimer = setInterval(() => {
      if (!this.admission()) for (const socket of this.connections.values()) socket.destroy();
    }, 50);
    this.budgetTimer.unref();
  }

  async close(force = false): Promise<void> {
    clearInterval(this.budgetTimer);
    const socketsClosed = [...this.connections.values()].map(
      (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    await super.close(force);
    await Promise.all(socketsClosed);
  }
}
