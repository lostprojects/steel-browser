#!/usr/bin/env node
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ToolstackClient, ToolstackError, errorMessage, saveBytes, downloadDirectory } from "./index.mjs";
import { serveMcp } from "./mcp.mjs";

const help = `Toolstack local client (Node 22+, macOS / Windows / Linux)

  toolstack receive --session UUID --transfer UUID [--out DIRECTORY]
  toolstack receive --session UUID --file SESSION_FILE [--out DIRECTORY]
  toolstack receive --session UUID --source-url URL [--name FILENAME] [--out DIRECTORY]
  toolstack mcp [--out DIRECTORY]
  toolstack mcp-config [--out DIRECTORY]

Set STEEL_URL and STEEL_API_KEY (or STEEL_AGENT_KEY) in your secret environment.
STEEL_DOWNLOAD_DIR overrides Downloads under your home folder.
--timeout SECONDS sets the receive budget (default 600, maximum 3600).
Results are JSON; API keys are read from the environment.
`;

const controller = new AbortController();
const stop = () => controller.abort();
const signals = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  ...(process.platform === "win32" ? ["SIGBREAK"] : []),
];
for (const signal of signals) process.on(signal, stop);
process.stdout.on("error", stop);
process.stderr.on("error", stop);

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: "string" },
      transfer: { type: "string" },
      file: { type: "string" },
      "source-url": { type: "string" },
      name: { type: "string" },
      out: { type: "string" },
      timeout: { type: "string" },
      server: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals.length) process.stdout.write(help);
  else if (positionals.length !== 1)
    throw new ToolstackError("input", "Supply one command; use toolstack --help");
  else if (positionals[0] === "worker") {
    // An adapter keeps stdin open as its lifeline. EOF aborts local I/O even if
    // the parent is killed; no PID polling, inherited descriptors or OS timer.
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const options = await new Promise((resolve, reject) => {
      reader.once("line", (line) => {
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new ToolstackError("input", "Invalid worker request"));
        }
      });
      reader.once("close", () => {
        stop();
        reject(new ToolstackError("input", "Delivery caller ended"));
      });
    });
    let result;
    try {
      result =
        options.operation === "save"
          ? await saveBytes(Buffer.from(options.data, "base64"), options.name, options.directory, {
              signal: controller.signal,
            })
          : await new ToolstackClient(options).receive({ ...options, signal: controller.signal });
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally {
      reader.close();
    }
  } else if (positionals[0] === "mcp-config") {
    const url = values.server || process.env.STEEL_URL || "https://YOUR_TOOLSTACK_HOST";
    const origin = new ToolstackClient({ url, apiKey: "configuration-placeholder" }).origin;
    process.stdout.write(
      JSON.stringify(
        {
          mcpServers: {
            toolstack: {
              command: process.execPath,
              args: [
                fileURLToPath(import.meta.url),
                "mcp",
                ...(values.out ? ["--out", downloadDirectory(values.out)] : []),
              ],
              env: { STEEL_URL: origin, STEEL_API_KEY: "<your personal Toolstack key>" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const client = new ToolstackClient({ ...(values.server ? { url: values.server } : {}) });
    if (positionals[0] === "mcp")
      await serveMcp(client, { directory: values.out, signal: controller.signal });
    else if (positionals[0] === "receive") {
      const result = await client.receive({
        session: values.session,
        transfer: values.transfer,
        file: values.file,
        url: values["source-url"],
        name: values.name,
        directory: values.out,
        timeoutMs: values.timeout ? Number(values.timeout) * 1000 : 600_000,
        signal: controller.signal,
      });
      process.stdout.write(JSON.stringify(result) + "\n");
    } else throw new ToolstackError("input", "Unknown command; use toolstack --help");
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error: controller.signal.aborted ? "Local operation cancelled" : errorMessage(error),
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  for (const signal of signals) process.off(signal, stop);
}
