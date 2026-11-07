import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";

vi.mock("../env.js", () => ({ env: {} }));

import { ProxyServer, identityHostRoute, proxyHostAllowed } from "./proxy.js";

it("refuses private literal destinations and local metadata names", () => {
  for (const host of [
    "localhost",
    "LOCALHOST.",
    "api.localhost",
    "metadata.google.internal",
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "[::1]",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])
    expect(proxyHostAllowed(host), host).toBe(false);
  for (const host of ["example.com", "1.1.1.1", "2606:4700:4700::1111"])
    expect(proxyHostAllowed(host), host).toBe(true);
});

it("refuses Bizapedia ad hosts only and retains Cloudflare challenge traffic", () => {
  for (const host of [
    "ads.adthrive.com",
    "prebid.production.adthrive.com",
    "g2.gumgum.com",
    "btloader.com",
    "launchpad.privacymanager.io",
    "www.googletagmanager.com",
    "www.google-analytics.com",
    "analytics.google.com",
    "stats.g.doubleclick.net",
  ]) {
    expect(identityHostRoute(host, "bizapedia")).toBe("refused");
    expect(identityHostRoute(host, "ancestry")).toBe("residential");
    expect(identityHostRoute(host)).toBe("residential");
  }
  for (const host of ["challenges.cloudflare.com", "www.bizapedia.com", "adthrive.com.example"])
    expect(identityHostRoute(host, "bizapedia")).toBe("residential");
});

describe("ProxyServer close", () => {
  async function listen(server: net.Server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as net.AddressInfo).port;
  }

  async function tunnel(proxyPort: number, target: string, size: number) {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: target,
      agent: false,
    });
    req.end();
    const [, socket] = (await once(req, "connect")) as [http.IncomingMessage, net.Socket];
    socket.on("error", () => undefined);
    let echoed = 0;
    socket.on("data", (chunk: Buffer) => {
      echoed += chunk.length;
    });
    socket.write(Buffer.alloc(size));
    await vi.waitFor(() => expect(echoed).toBe(size), { timeout: 5_000 });
    return socket;
  }

  it("includes open tunnel bytes and settles them once when force-closing", async () => {
    const echo = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.pipe(socket);
    });
    const echoPort = await listen(echo);
    const upstream = http.createServer();
    upstream.on("connect", (_req, client) => {
      client.on("error", () => undefined);
      const target = net.connect(echoPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        target.pipe(client).pipe(target);
      });
      target.on("error", () => client.destroy());
    });
    const upstreamPort = await listen(upstream);
    const server = new ProxyServer(`http://user:pass@127.0.0.1:${upstreamPort}`);
    await server.listen();

    try {
      await tunnel(server.port, "example.com:443", 1_000);
      const stats = server.getConnectionStats(server.getConnectionIds()[0])!;
      expect(stats.trgRxBytes).toBeGreaterThan(1_000);
      const traffic = [
        { hostname: "example.com", txBytes: stats.trgTxBytes, rxBytes: stats.trgRxBytes },
      ];
      expect(server.traffic).toEqual(traffic);
      expect({ tx: server.txBytes, rx: server.rxBytes }).toEqual({
        tx: stats.trgTxBytes,
        rx: stats.trgRxBytes,
      });
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => server.close(true).then(resolve, reject), 0);
      });

      expect({ tx: server.txBytes, rx: server.rxBytes }).toEqual({
        tx: stats.trgTxBytes,
        rx: stats.trgRxBytes,
      });
      expect(server.traffic).toEqual(traffic);
    } finally {
      await server.close(true).catch(() => undefined);
      upstream.close();
      echo.close();
    }
  });

  it("cuts an already open tunnel when its lease policy is revoked", async () => {
    const echo = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.pipe(socket);
    });
    const echoPort = await listen(echo);
    const upstream = http.createServer();
    upstream.on("connect", (_req, client) => {
      client.on("error", () => undefined);
      const target = net.connect(echoPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        target.pipe(client).pipe(target);
      });
      target.on("error", () => client.destroy());
    });
    const port = await listen(upstream);
    let permitted = true;
    const server = new ProxyServer(`http://user:pass@127.0.0.1:${port}`, false, () => permitted);
    await server.listen();
    try {
      const socket = await tunnel(server.port, "example.com:443", 1000);
      const before = server.rxBytes + server.txBytes;
      permitted = false;
      await vi.waitFor(() => expect(socket.destroyed).toBe(true), { timeout: 2000 });
      await server.close(true);
      expect(server.rxBytes + server.txBytes).toBeGreaterThanOrEqual(before);
    } finally {
      await server.close(true);
      upstream.close();
      echo.close();
    }
  });
});
