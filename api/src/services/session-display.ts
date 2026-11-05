// Each session owns its X server and VNC endpoint. Sharing a display would
// send keyboard input and screenshots to another profile.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import type { WebSocket } from "ws";
import { browserProcessEnv } from "../utils/browser.js";

const displays = new Set<number>();
export async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
export class SessionDisplay {
  private number?: number;
  private x?: ChildProcess;
  private vnc?: ChildProcess;
  private port = 0;
  private closing = false;
  private viewers = new Set<WebSocket>();
  get name() {
    return this.number === undefined ? undefined : `:${this.number}`;
  }
  async start(width: number, height: number, onExit: () => void) {
    if (process.platform !== "linux") return;
    let n = 100;
    while (displays.has(n) || existsSync(`/tmp/.X${n}-lock`)) n++;
    displays.add(n);
    this.number = n;
    const launch = (command: string, args: string[]) => {
      const child = spawn(command, args, { stdio: "ignore", env: browserProcessEnv() });
      child.once("error", () => {
        if (!this.closing) onExit();
      });
      child.once("exit", () => {
        if (!this.closing) onExit();
      });
      return child;
    };
    this.x = launch("Xvfb", [
      this.name!,
      "-screen",
      "0",
      `${width}x${height}x24`,
      "-nolisten",
      "tcp",
      "-ac",
    ]);
    for (let i = 0; !existsSync(`/tmp/.X11-unix/X${n}`); i++) {
      if (i === 100 || this.x.exitCode !== null) throw new Error("Session X display did not start");
      await new Promise((r) => setTimeout(r, 50));
    }
    this.port = await unusedPort();
    this.vnc = launch("x11vnc", [
      "-display",
      this.name!,
      "-localhost",
      "-rfbport",
      String(this.port),
      "-forever",
      "-shared",
      "-nopw",
      "-quiet",
    ]);
    for (let i = 0; i < 100; i++) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = connect(this.port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      if (ready) return;
      if (this.vnc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Session VNC endpoint did not start");
  }
  attach(ws: WebSocket) {
    if (!this.port || this.closing) {
      ws.close(1011, "Display unavailable");
      return;
    }
    this.viewers.add(ws);
    const tcp = connect(this.port, "127.0.0.1");
    tcp.on("data", (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    tcp.on("error", () => ws.close(1011, "Display disconnected"));
    tcp.on("close", () => ws.close());
    ws.on("message", (data) => tcp.write(data as Buffer));
    ws.on("error", () => tcp.destroy());
    ws.on("close", () => {
      this.viewers.delete(ws);
      tcp.destroy();
    });
  }
  async close() {
    this.closing = true;
    for (const ws of this.viewers) ws.terminate();
    await stop(this.vnc);
    await stop(this.x);
    if (this.number !== undefined) displays.delete(this.number);
  }
}
