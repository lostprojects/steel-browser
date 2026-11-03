import { env } from "../env.js";
import { makePassthrough, PassthroughServer } from "./passthough-proxy.js";
import { Server } from "proxy-chain";

export interface IProxyServer {
  readonly url: string;
  readonly upstreamProxyUrl: string;
  readonly txBytes: number;
  readonly rxBytes: number;
  readonly traffic?: Array<{ hostname: string; txBytes: number; rxBytes: number }>;
  listen(): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export class ProxyServer extends Server implements IProxyServer {
  public url: string;
  public upstreamProxyUrl: string;
  private settledTxBytes = 0;
  private settledRxBytes = 0;
  private hostConnections = new Set<number>();
  private connectionHosts = new Map<number, string>();
  private settledHosts = new Map<string, { txBytes: number; rxBytes: number }>();

  get traffic() {
    const totals = new Map([...this.settledHosts].map(([host, bytes]) => [host, { ...bytes }]));
    for (const [id, host] of this.connectionHosts) {
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
      if (this.hostConnections.has(id)) return total;
      return total + (this.getConnectionStats(id)?.[field] ?? 0);
    }, 0);
  }

  get txBytes(): number {
    return this.settledTxBytes + this.openBytes("trgTxBytes");
  }

  get rxBytes(): number {
    return this.settledRxBytes + this.openBytes("trgRxBytes");
  }

  constructor(proxyUrl: string) {
    super({
      port: 0,

      prepareRequestFunction: (options) => {
        const { connectionId, hostname } = options;

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
        return {
          requestAuthentication: false,
          upstreamProxyUrl: proxyUrl,
        };
      },
    });

    this.on("connectionClosed", ({ connectionId, stats }) => {
      if (stats && !this.hostConnections.has(connectionId)) {
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
