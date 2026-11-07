// The local delivery lifecycle belongs here. No project files, browser cookies,
// credential stores, shell commands or background services are required.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const CHUNK = 256 * 1024;
const STAGING = /^\.steel-delivery-(\d+)-[a-f0-9-]{36}$/;

export class ToolstackError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "ToolstackError";
    this.code = code;
    this.status = status;
  }
}

export function errorMessage(error) {
  if (error?.name === "TimeoutError") return "Delivery timed out; no receipt was confirmed";
  if (error?.name === "AbortError") return "Local operation cancelled";
  return error instanceof ToolstackError
    ? error.message
    : `Local operation failed (${error?.code ?? error?.name ?? "unknown error"})`;
}

function identifier(value) {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ToolstackError("input", "Supply a valid session and delivery UUID");
  return value;
}

function duration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000)
    throw new ToolstackError("input", "Timeout must be between 1 ms and one hour");
  return value;
}

function bounded(signal, milliseconds) {
  const timeout = AbortSignal.timeout(duration(milliseconds));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function downloadDirectory(directory = process.env.STEEL_DOWNLOAD_DIR) {
  if (directory === "~") return homedir();
  if (typeof directory === "string" && /^~[/\\]/.test(directory))
    return path.join(homedir(), directory.slice(2));
  return path.resolve(directory || path.join(homedir(), "Downloads"));
}

// Use one portable filename on every OS, including Windows device names and
// alternate data stream syntax. Retain room for a collision's checksum suffix.
export function portableName(raw) {
  if (typeof raw !== "string") throw new ToolstackError("input", "Invalid download filename");
  let name = path.posix
    .basename(raw.replaceAll("\\", "/"))
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name.split(".")[0].trimEnd()))
    name = "_" + name;
  if (!name || name === "." || name === "..") name = "download";
  let result = "";
  for (const character of name) {
    if (Buffer.byteLength(result + character) > 160) break;
    result += character;
  }
  return result.replace(/[. ]+$/g, "") || "download";
}

async function syncDirectory(directory) {
  // Node cannot open a directory for fsync on Windows. FileHandle.sync still
  // flushes the completed file there; report this distinction to the caller.
  if (process.platform === "win32") return false;
  const file = await open(directory, "r");
  try {
    await file.sync();
    return true;
  } catch (error) {
    if (["EINVAL", "ENOTSUP"].includes(error.code)) return false;
    throw error;
  } finally {
    await file.close();
  }
}

async function matches(target, delivery, signal) {
  let file;
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.size !== delivery.bytes) return false;
    file = await open(
      target,
      (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size !== delivery.bytes
    )
      return false;
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    let position = 0;
    while (position < info.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - position),
        position,
      );
      if (!bytesRead) return false;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (digest.digest("hex") !== delivery.sha256) return false;
    await file.sync();
    return true;
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error.code)) return false;
    throw error;
  } finally {
    await file?.close();
  }
}

async function targetFor(directory, delivery, signal) {
  const name = portableName(delivery.name);
  const extension = path.extname(name),
    stem = name.slice(0, name.length - extension.length);
  for (const suffix of ["", "-" + delivery.sha256.slice(0, 12), "-" + delivery.sha256]) {
    const target = path.join(directory, stem + suffix + extension);
    try {
      await lstat(target);
      if (await matches(target, delivery, signal)) return { target, exists: true };
    } catch (error) {
      if (error.code === "ENOENT") return { target, exists: false };
      throw error;
    }
  }
  throw new ToolstackError("collision", "The destination contains conflicting files");
}

async function reap(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const owner = STAGING.exec(entry.name);
    if (!entry.isDirectory() || !owner) continue;
    const temporary = path.join(directory, entry.name);
    const info = await lstat(temporary).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info || info.isSymbolicLink() || Date.now() - info.mtimeMs < 60_000) continue;
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if (error.code === "ESRCH")
        await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
      else if (error.code !== "EPERM") throw error;
    }
  }
}

async function writeAll(file, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (!bytesWritten) throw new ToolstackError("disk", "The destination stopped accepting data");
    offset += bytesWritten;
  }
}

async function publish(delivery, directory, write, signal) {
  directory = downloadDirectory(directory);
  await mkdir(directory, { recursive: true });
  await reap(directory);
  let chosen = await targetFor(directory, delivery, signal);
  if (chosen.exists)
    return { path: chosen.target, directorySynced: await syncDirectory(directory) };
  const temporary = path.join(directory, `.steel-delivery-${process.pid}-${randomUUID()}`);
  let created = false;
  try {
    signal?.throwIfAborted();
    // Set the path before creation, so cancellation has no unowned-file window.
    await mkdir(temporary, { mode: 0o700 });
    created = true;
    const payload = path.join(temporary, "payload");
    const file = await open(payload, "wx+", 0o600);
    try {
      await write(file);
      signal?.throwIfAborted();
      await file.sync();
    } finally {
      await file.close();
    }
    while (!chosen.exists) {
      signal?.throwIfAborted();
      try {
        await link(payload, chosen.target);
        break;
      } catch (error) {
        if (error.code === "EEXIST") {
          chosen = await targetFor(directory, delivery, signal);
          continue;
        }
        if (["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"].includes(error.code))
          throw new ToolstackError(
            "filesystem",
            "Atomic publication needs hard-link support; select a local APFS or NTFS destination",
          );
        throw error;
      }
    }
    const published = await open(chosen.target, process.platform === "win32" ? "r+" : "r");
    try {
      await published.sync();
    } finally {
      await published.close();
    }
    return { path: chosen.target, directorySynced: await syncDirectory(directory) };
  } finally {
    if (created) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    await syncDirectory(directory);
  }
}

export async function saveBytes(data, name, directory, { signal } = {}) {
  const bytes = Buffer.from(data);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const output = await publish(
    { name, bytes: bytes.length, sha256 },
    directory,
    (file) => writeAll(file, bytes, 0),
    signal,
  );
  return { ...output, bytes: bytes.length, sha256, legacy: true };
}

export class ToolstackClient {
  constructor({
    url = process.env.STEEL_URL,
    apiKey = process.env.STEEL_AGENT_KEY || process.env.STEEL_API_KEY,
  } = {}) {
    let origin;
    try {
      origin = new URL(url);
    } catch {
      /* Report configuration without echoing secrets. */
    }
    if (
      !origin ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !["/", "/mcp"].includes(origin.pathname) ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
      )
    )
      throw new ToolstackError(
        "configuration",
        "STEEL_URL must be an HTTPS origin (local development may use loopback HTTP)",
      );
    if (typeof apiKey !== "string" || !apiKey || /[\r\n]/.test(apiKey))
      throw new ToolstackError(
        "configuration",
        "Set STEEL_API_KEY or STEEL_AGENT_KEY in your secret environment",
      );
    this.origin = origin.origin;
    this.apiKey = apiKey;
  }

  async fetch(endpoint, { signal, headers, ...options } = {}) {
    signal?.throwIfAborted();
    const target = new URL(endpoint, this.origin);
    if (
      !endpoint.startsWith("/") ||
      target.origin !== this.origin ||
      target.username ||
      target.password
    )
      throw new ToolstackError("input", "Toolstack requests must stay on the configured origin");
    try {
      return await fetch(target, {
        ...options,
        signal,
        redirect: "error",
        headers: { "steel-api-key": this.apiKey, ...headers },
      });
    } catch {
      signal?.throwIfAborted();
      throw new ToolstackError("transport", "Toolstack connection failed; redirects are refused");
    }
  }

  async json(endpoint, { method = "GET", body, signal, requestId = randomUUID() } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetch(endpoint, {
          method,
          signal: bounded(signal, 20_000),
          headers: {
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {}),
            ...(method === "POST" ? { "idempotency-key": requestId } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ToolstackError(
            [502, 503, 504].includes(response.status) ? "transport" : "http",
            `Toolstack request failed (HTTP ${response.status})`,
            response.status,
          );
        }
        return await readJson(response, 1_000_000);
      } catch (error) {
        signal?.throwIfAborted();
        if (
          attempt === 2 ||
          (error instanceof ToolstackError && error.code !== "transport") ||
          error.name === "SyntaxError"
        )
          throw error;
        await delay(100 * (attempt + 1), undefined, { signal });
      }
    }
  }

  async prepare(session, { file, url, name, referer, signal } = {}) {
    identifier(session);
    if (!!file === !!url) throw new ToolstackError("input", "Supply one session file or source URL");
    return this.json(`/v1/sessions/${session}/transfers`, {
      method: "POST",
      signal,
      body: {
        ...(file ? { file } : { url }),
        ...(name ? { name } : {}),
        ...(referer ? { referer } : {}),
      },
    });
  }

  async ready(value, signal) {
    const session = identifier(value?.session),
      id = identifier(value?.id);
    while (value.state === "receiving") {
      await delay(200, undefined, { signal });
      value = await this.json(`/v1/sessions/${session}/transfers/${id}`, { signal });
    }
    if (!["ready", "acknowledged"].includes(value.state))
      throw new ToolstackError(
        "delivery",
        `Delivery is ${["failed", "cancelled", "expired"].includes(value.state) ? value.state : "unavailable"}`,
      );
    if (
      value.session !== session ||
      value.id !== id ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      !SHA.test(value.sha256)
    )
      throw new ToolstackError("protocol", "Invalid delivery integrity metadata");
    portableName(value.name);
    return value;
  }

  async copy(delivery, file, signal) {
    let position = 0,
      digest = createHash("sha256");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetch(
          `/v1/sessions/${delivery.session}/transfers/${delivery.id}/content`,
          {
            signal,
            headers: {
              accept: "application/octet-stream",
              "accept-encoding": "identity",
              "if-match": `"${delivery.sha256}"`,
              ...(position ? { range: `bytes=${position}-` } : {}),
            },
          },
        );
        try {
          if (![200, 206].includes(response.status))
            throw new ToolstackError(
              [502, 503, 504].includes(response.status) ? "transport" : "http",
              `Delivery read failed (HTTP ${response.status})`,
              response.status,
            );
          if (response.headers.get("x-content-sha256") !== delivery.sha256)
            throw new ToolstackError("integrity", "Delivery checksum header does not match");
          if (response.status === 206) {
            if (
              response.headers.get("content-range") !==
              `bytes ${position}-${delivery.bytes - 1}/${delivery.bytes}`
            )
              throw new ToolstackError("integrity", "Delivery byte range does not match");
          } else {
            position = 0;
            digest = createHash("sha256");
            await file.truncate(0);
          }
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            if (position + chunk.length > delivery.bytes)
              throw new ToolstackError("integrity", "Delivery exceeds its declared size");
            await writeAll(file, chunk, position);
            digest.update(chunk);
            position += chunk.length;
          }
        } finally {
          await response.body?.cancel().catch(() => {});
        }
        if (position === delivery.bytes) {
          if (digest.digest("hex") !== delivery.sha256)
            throw new ToolstackError("integrity", "Delivery checksum does not match");
          return;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (
          attempt === 2 ||
          (error instanceof ToolstackError && error.code !== "transport") ||
          (error.code && !error.code.startsWith("UND_"))
        )
          throw error;
      }
    }
    throw new ToolstackError("transport", "Delivery ended before its declared size");
  }

  async receive({
    delivery,
    session,
    transfer,
    file,
    url,
    name,
    referer,
    directory,
    timeoutMs = 600_000,
    signal,
  } = {}) {
    signal = bounded(signal, timeoutMs);
    if (!delivery) {
      identifier(session);
      if ([transfer, file, url].filter(Boolean).length !== 1)
        throw new ToolstackError("input", "Supply one transfer ID, session file or source URL");
      delivery = transfer
        ? await this.json(`/v1/sessions/${session}/transfers/${identifier(transfer)}`, { signal })
        : await this.prepare(session, { file, url, name, referer, signal });
    }
    delivery = await this.ready(delivery, signal);
    const output = await publish(
      { ...delivery, name: name ?? delivery.name },
      directory,
      async (destination) => {
        if (delivery.state === "acknowledged")
          throw new ToolstackError(
            "consumed",
            "Delivery was already consumed; use its previously saved local file",
          );
        await this.copy(delivery, destination, signal);
      },
      signal,
    );
    let acknowledged = delivery.state === "acknowledged";
    if (!acknowledged && !signal.aborted) {
      try {
        const receipt = await this.json(
          `/v1/sessions/${delivery.session}/transfers/${delivery.id}/ack`,
          {
            method: "POST",
            signal: bounded(signal, 10_000),
            body: { sha256: delivery.sha256 },
          },
        );
        acknowledged = receipt.state === "acknowledged";
      } catch {
        /* Keep the verified local file; an offline receipt can be retried. */
      }
    }
    return {
      ...output,
      bytes: delivery.bytes,
      sha256: delivery.sha256,
      session: delivery.session,
      transfer: delivery.id,
      acknowledged,
    };
  }
}

export async function readJson(response, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes)
      throw new ToolstackError("protocol", "Toolstack metadata exceeds the response limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ToolstackError("protocol", "Toolstack returned invalid JSON");
  }
}

// Compatibility exports for existing client integrations.
export { ToolstackClient as SteelClient, ToolstackError as SteelError };
