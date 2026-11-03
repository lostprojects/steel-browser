import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { QuietBrowser, QuietSession, type QuietConnection } from "./quiet-browser.js";
import { QuietInput } from "./quiet-input.js";
import { unusedPort } from "./session-display.js";
import { CommandEngine } from "./commands/engine.js";

test("quiet policy rejects instrumentation, paused targets and foreign execution contexts", async () => {
  const wire = vi.fn(async () => ({}));
  const session = new QuietSession({ wire } as unknown as QuietConnection, "session", "page");
  for (const method of [
    "Runtime.enable",
    "Runtime.addBinding",
    "Network.enable",
    "Log.enable",
    "Fetch.enable",
    "Page.addScriptToEvaluateOnNewDocument",
  ])
    await expect(session.send(method)).rejects.toThrow("Quiet policy");
  await expect(
    session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true }),
  ).rejects.toThrow("unpaused");
  await expect(
    session.send("Runtime.evaluate", { expression: "1", contextId: 99 }),
  ).rejects.toThrow("isolated");
  await expect(session.send("Runtime.callFunctionOn", { objectId: "foreign" })).rejects.toThrow(
    "isolated",
  );
  expect(wire).not.toHaveBeenCalled();
});

test("releasing a nested object group preserves other isolated-world handles", async () => {
  let object = 0;
  const wire = vi.fn(async (method: string) => {
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "DOM.resolveNode") return { object: { objectId: `o${++object}` } };
    return {};
  });
  const session = new QuietSession({ wire } as unknown as QuietConnection, "session", "page");
  await session.send("Page.createIsolatedWorld", { frameId: "f" });
  await session.send("DOM.resolveNode", {
    backendNodeId: 1,
    executionContextId: 7,
    objectGroup: "command",
  });
  await session.send("DOM.resolveNode", {
    backendNodeId: 2,
    executionContextId: 7,
    objectGroup: "secrets",
  });
  await session.send("Runtime.releaseObjectGroup", { objectGroup: "secrets" });
  await expect(
    session.send("Runtime.callFunctionOn", {
      objectId: "o1",
      functionDeclaration: "function(){return true}",
    }),
  ).resolves.toEqual({});
  await expect(session.send("Runtime.callFunctionOn", { objectId: "o2" })).rejects.toThrow(
    "isolated",
  );
});

test("iframe navigation preserves the main frame's isolated contexts and handles", async () => {
  const wire = vi.fn(async (method: string, params: Record<string, any>) => {
    if (method === "Page.createIsolatedWorld")
      return { executionContextId: params.frameId === "main" ? 7 : 8 };
    if (method === "DOM.resolveNode")
      return { object: { objectId: `object-${params.executionContextId}` } };
    return {};
  });
  const session = new QuietSession({ wire } as unknown as QuietConnection, "session", "main");
  for (const [frameId, contextId] of [
    ["main", 7],
    ["child", 8],
  ] as const) {
    await session.send("Page.createIsolatedWorld", { frameId });
    await session.send("DOM.resolveNode", {
      backendNodeId: contextId,
      executionContextId: contextId,
    });
  }
  session.emit("Page.frameNavigated", { frame: { id: "child", parentId: "main" } });
  await expect(
    session.send("Runtime.evaluate", { contextId: 7, expression: "1" }),
  ).resolves.toEqual({});
  await expect(session.send("Runtime.callFunctionOn", { objectId: "object-7" })).resolves.toEqual(
    {},
  );
  await expect(session.send("Runtime.evaluate", { contextId: 8, expression: "1" })).rejects.toThrow(
    "isolated",
  );
  await expect(session.send("Runtime.callFunctionOn", { objectId: "object-8" })).rejects.toThrow(
    "isolated",
  );
  session.emit("Page.frameNavigated", { frame: { id: "main" } });
  await expect(session.send("Runtime.callFunctionOn", { objectId: "object-7" })).rejects.toThrow(
    "isolated",
  );
});

test("native input keeps text on stdin and applies display coordinates", async () => {
  const run = vi.fn(async (_args: string[], _text?: string) => Buffer.alloc(0));
  const input = new QuietInput(":101", 1920, 1080, run);
  const text = "quotes ' \" $(secret)\n";
  await input.text(text);
  expect(run).toHaveBeenCalledWith(["type", "--delay", "25", "--file", "-"], text);
  await input.mouse({ type: "mousePressed", x: 100, y: 100, button: "left" }, { x: 1, y: 88 });
  expect(run).toHaveBeenCalledWith(["mousemove", "101", "188"]);
  expect(run).toHaveBeenCalledWith(["mousedown", "1"]);
  await expect(input.mouse({ type: "mouseMoved", x: 2000, y: 0 }, { x: 0, y: 0 })).rejects.toThrow(
    "outside",
  );
});

test("native chords release temporary modifiers and retain explicitly held keys", async () => {
  const run = vi.fn(async (_args: string[], _text?: string) => Buffer.alloc(0));
  const input = new QuietInput(":102", 1920, 1080, run);
  await input.key({ type: "keyDown", key: "a", modifiers: 2 });
  await input.key({ type: "keyUp", key: "a", modifiers: 2 });
  expect(run.mock.calls.map((c) => c[0])).toEqual([
    ["keydown", "Control_L"],
    ["keydown", "a"],
    ["keyup", "a"],
    ["keyup", "Control_L"],
  ]);
});

describe.skipIf(!process.env.CHROME_EXECUTABLE_PATH)(
  "quiet commands on a plain Chrome process",
  () => {
    let child: ChildProcess;
    let browser: QuietBrowser;
    let profile: string;
    let server: Server;
    let url: string;
    let engine: CommandEngine;
    const native = vi.fn(async (_args: string[], _text?: string) => Buffer.alloc(0));
    beforeAll(async () => {
      server = createServer((_req, res) =>
        res.end(
          '<!doctype html><title>Quiet test</title><script>window.mainMarker=123</script><h1>Page text</h1><button>Press me</button><input type="password" value="hidden-secret">',
        ),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      profile = await mkdtemp(path.join(tmpdir(), "quiet-test-"));
      const port = await unusedPort();
      child = spawn(
        process.env.CHROME_EXECUTABLE_PATH!,
        [
          "--headless=new",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${port}`,
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      let endpoint = "";
      for (let i = 0; i < 100 && !endpoint; i++) {
        try {
          endpoint = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any)
            .webSocketDebuggerUrl;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      browser = await QuietBrowser.connect(endpoint, new QuietInput(":test", 1920, 1080, native));
      engine = new CommandEngine({
        browser: () => browser.asBrowser(),
        waitForPageSetup: async () => {},
        endSession: async () => {},
        filesRoot: () => profile,
        released: () => false,
        quickActionsDone: async () => {},
      });
      engine.prepare("quiet-test");
      engine.browserLaunched(browser.asBrowser());
      engine.browserReady();
    });
    afterAll(async () => {
      engine?.sessionEnded();
      const exited =
        child && child.exitCode === null && child.signalCode === null
          ? new Promise<void>((resolve) => child.once("exit", () => resolve()))
          : Promise.resolve();
      await browser?.close();
      child?.kill("SIGTERM");
      await exited;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (profile) await rm(profile, { recursive: true, force: true });
    });
    test("navigates, masks a full snapshot and evaluates in an isolated world", async () => {
      const response = await engine.handle({
        sessionId: "quiet-test",
        body: {
          commands: [
            { command: "navigate", url },
            { command: "snapshot" },
            {
              command: "eval",
              script:
                "({marker:typeof window.mainMarker,text:document.querySelector('h1').textContent})",
            },
          ],
        },
      });
      expect(response.body.execution, JSON.stringify(response.body)).toMatchObject({
        state: "completed",
      });
      expect(JSON.stringify(response.body)).not.toContain("hidden-secret");
      expect((response.body.results as any[])[2].value).toEqual({
        marker: "undefined",
        text: "Page text",
      });
      expect(browser.connection.methods.has("Accessibility.getFullAXTree")).toBe(true);
      expect(browser.connection.methods.has("Runtime.enable")).toBe(false);
    });
    test("routes commands clicks to the native display", async () => {
      const response = await engine.handle({
        sessionId: "quiet-test",
        body: { commands: [{ command: "click", target: "button" }] },
      });
      expect(response.body.execution, JSON.stringify(response.body)).toMatchObject({
        state: "completed",
      });
      expect(native).toHaveBeenCalledWith(["mousedown", "1"]);
      expect(native).toHaveBeenCalledWith(["mouseup", "1"]);
      expect([...browser.connection.methods].some((m) => m.startsWith("Input."))).toBe(false);
    });
  },
);
