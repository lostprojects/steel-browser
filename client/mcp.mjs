// Bridge Toolstack's stateless HTTP MCP endpoint to a local stdio client. Only the
// extra browser_save tool touches this machine's filesystem.
import { createInterface } from "node:readline";
import { once } from "node:events";
import { ToolstackError, downloadDirectory, errorMessage, readJson } from "./index.mjs";

const localTool = {
  name: "browser_save",
  description:
    "Save a Toolstack delivery on THIS machine. Use the session and transfer IDs returned by browser_download or PDF output. Streams to Downloads by default, verifies SHA-256 and size, then publishes without replacing existing content. Only a completed local save acknowledges remote deletion. Returns the local path and acknowledgement state. Never send this local path to the remote browser's upload command.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      session: { type: "string", format: "uuid" },
      transfer: { type: "string", format: "uuid" },
      directory: {
        type: "string",
        description:
          "Optional local directory; defaults to STEEL_DOWNLOAD_DIR or Downloads under your home folder.",
      },
      name: {
        type: "string",
        description: "Optional local filename; portable characters are substituted when necessary.",
      },
      timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000, default: 600_000 },
    },
    required: ["session", "transfer"],
  },
};

async function remote(client, message, signal, state, notify) {
  const response = await client.fetch("/mcp", {
    method: "POST",
    signal,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(state.version ? { "mcp-protocol-version": state.version } : {}),
      ...(state.session ? { "mcp-session-id": state.session } : {}),
    },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolstackError(
      "http",
      `Toolstack MCP request failed (HTTP ${response.status})`,
      response.status,
    );
  }
  if (response.headers.get("mcp-session-id"))
    state.session = response.headers.get("mcp-session-id");
  if (response.status === 202) return undefined;
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return readJson(response, 32_000_000);
  let pending = "",
    size = 0;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32_000_000)
        throw new ToolstackError("protocol", "Toolstack MCP response exceeds the size limit");
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let value;
        try {
          value = JSON.parse(data);
        } catch {
          throw new ToolstackError("protocol", "Toolstack sent invalid MCP event data");
        }
        if (value.id === message.id && !value.method) return value;
        if (!Object.hasOwn(value, "id")) await notify(value);
        else
          throw new ToolstackError(
            "protocol",
            "This Toolstack bridge does not accept server-initiated requests",
          );
      }
    }
  } finally {
    await response.body?.cancel().catch(() => {});
  }
  throw new ToolstackError("protocol", "Toolstack MCP ended before returning a response");
}

export async function serveMcp(
  client,
  { directory, signal, input = process.stdin, output = process.stdout } = {},
) {
  const reader = createInterface({ input, crlfDelay: Infinity });
  const active = new Map(),
    state = {};
  const directoryPath = downloadDirectory(directory);
  let writing = Promise.resolve();
  const send = (value) => {
    writing = writing.then(async () => {
      if (!output.write(JSON.stringify(value) + "\n")) await once(output, "drain");
    });
    return writing;
  };
  const stop = () => {
    for (const task of active.values()) task.controller.abort();
    reader.close();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const brokenPipe = () => stop();
  output.on("error", brokenPipe);
  const run = async (message, controller) => {
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal, AbortSignal.timeout(3_600_000)])
      : AbortSignal.any([controller.signal, AbortSignal.timeout(3_600_000)]);
    const hasId = Object.hasOwn(message, "id");
    try {
      if (message.method === "notifications/cancelled") {
        active.get(message.params?.requestId)?.controller.abort();
      }
      if (message.method === "tools/call" && message.params?.name === "browser_save") {
        const args = message.params.arguments ?? {};
        const allowed = ["session", "transfer", "directory", "name", "timeoutMs"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          throw new ToolstackError("input", "Unknown browser_save option");
        const result = await client.receive({
          ...args,
          directory: args.directory ?? directoryPath,
          signal: requestSignal,
        });
        await send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        });
        return;
      }
      const result = await remote(client, message, requestSignal, state, send);
      if (!hasId) return;
      if (!result || result.id !== message.id)
        throw new ToolstackError("protocol", "Toolstack returned a mismatched MCP response");
      if (message.method === "initialize" && result.result) {
        state.version = result.result.protocolVersion;
        result.result.instructions =
          (result.result.instructions ?? "") +
          ` Local browser_save saves a ready or receiving delivery on this machine in ${directoryPath}. Use it before closing the session. Remote file links alone do not create a local file.`;
      }
      if (message.method === "tools/list" && result.result?.tools) {
        if (result.result.tools.some((tool) => tool.name === localTool.name))
          throw new ToolstackError("protocol", "Remote tool conflicts with local browser_save");
        result.result.tools.push(localTool);
      }
      await send(result);
    } catch (error) {
      if (!hasId || signal?.aborted) return;
      const messageText = requestSignal.aborted
        ? "Local request cancelled or timed out"
        : errorMessage(error);
      if (message.method === "tools/call")
        await send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: messageText }) }],
          },
        });
      else
        await send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: messageText },
        });
    }
  };
  try {
    for await (const line of reader) {
      if (signal?.aborted) break;
      if (!line.trim()) continue;
      let message;
      try {
        if (Buffer.byteLength(line) > 2_000_000) throw new Error();
        message = JSON.parse(line);
        if (message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new Error();
      } catch {
        await send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid MCP request" },
        });
        continue;
      }
      if (message.method !== "notifications/cancelled" && active.size >= 8) {
        if (Object.hasOwn(message, "id"))
          await send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "Too many active local requests" },
          });
        continue;
      }
      const id = message.id ?? Symbol(),
        controller = new AbortController();
      if (active.has(id)) {
        await send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32600, message: "Duplicate active request ID" },
        });
        continue;
      }
      const task = { controller };
      active.set(id, task);
      task.promise = run(message, controller).finally(() => active.delete(id));
      task.promise.catch(() => stop());
    }
  } finally {
    stop();
    await Promise.allSettled([...active.values()].map((task) => task.promise));
    await writing.catch(() => {});
    signal?.removeEventListener("abort", stop);
    output.off("error", brokenPipe);
  }
}
