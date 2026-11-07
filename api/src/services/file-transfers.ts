import { operations, type Operation } from "./operations.js";
// Own temporary deliveries for one browser. Payloads stay outside the public
// files tree; only a matching checksum acknowledgement consumes a delivery.
import { createHash, randomUUID } from "node:crypto";
import { constants, type ReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile } from "./http-fetch.js";
import type { BrowserSession } from "./browser-session.js";
import { getUrl } from "../utils/url.js";

export function deliveryInfo(value: any) {
  const endpoint = `v1/sessions/${value.session}/transfers/${value.id}`;
  return {
    ...value,
    statusUri: getUrl(endpoint),
    ...(value.handoff ? { webUri: getUrl(`downloads/${value.session}/${value.id}`) } : {}),
    requiresAuthentication: true,
    ...(["ready", "acknowledged"].includes(value.state)
      ? { acknowledgeUri: getUrl(`${endpoint}/ack`) }
      : {}),
    ...(value.state === "ready"
      ? {
          uri: getUrl(`${endpoint}/content`),
        }
      : {}),
  };
}

export const DELIVERY_TTL_MS = 30 * 60_000;
const ORPHAN_TTL_MS = 24 * 60 * 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
function limit(key: string, fallback: number) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
  return value;
}
function safeName(raw: string) {
  const name = path
    .basename(raw.replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\.+/, "");
  let result = "";
  for (const character of name || "download") {
    if (Buffer.byteLength(result + character) > 160) break;
    result += character;
  }
  return result;
}
type State = "receiving" | "ready" | "acknowledged" | "failed" | "cancelled" | "expired";
type Delivery = {
  id: string;
  state: State;
  name: string;
  source?: string;
  bytes?: number;
  sha256?: string;
  route?: string;
  expiresAt: number;
  operation?: Operation<void>;
  task?: Promise<void>;
  error?: string;
  handoff?: boolean;
  readers: Set<ReadStream>;
};

export class FileTransfers {
  private static handoffBytes = 0;
  private static handoffCount = 0;
  private readonly maxHandoffBytes = limit("DOWNLOAD_HANDOFF_BYTES", 2 * 1024 * 1024 * 1024);
  cancelBrowserDownload?: (guid: string) => Promise<void>;
  readonly maxBytes = limit("DOWNLOAD_MAX_BYTES", 512 * 1024 * 1024);
  private readonly pendingBytes = limit("DOWNLOAD_PENDING_BYTES", 1024 * 1024 * 1024);
  private readonly entries = new Map<string, Delivery>();
  private readonly sources = new Map<string, Delivery>();
  private readonly downloads = new Map<
    string,
    { name: string; at: number; bytes: number; cancelled: boolean; completed: boolean }
  >();
  private readonly root: string;
  private closed = false;
  constructor(
    readonly sessionId: string,
    readonly filesPath: string,
    private resource: object = {},
  ) {
    this.root = path.join(path.dirname(filesPath), ".deliveries", sessionId);
  }
  rawReady(file: string) {
    const item = this.downloads.get(file);
    return !file.endsWith(".crdownload") && (!item || (item.completed && !item.cancelled));
  }
  nameFor(file: string) {
    return this.downloads.get(file)?.name;
  }
  noteDownload(guid: string, name: string) {
    if (uuid.test(guid))
      this.downloads.set(guid, {
        name: safeName(name),
        at: Date.now(),
        bytes: 0,
        cancelled: false,
        completed: false,
      });
  }
  noteProgress(guid: string, state: string, bytes: number) {
    const item = this.downloads.get(guid);
    if (!item) return false;
    const wasCancelled = item.cancelled;
    item.bytes = bytes;
    if (state === "canceled") item.cancelled = true;
    if (state === "completed") item.completed = true;
    if (bytes > this.maxBytes || this.reservedBytes() > this.pendingBytes) item.cancelled = true;
    return item.cancelled && !wasCancelled && state !== "canceled";
  }
  private payload(id: string) {
    return path.join(this.root, id);
  }
  private reservedBytes(excludeSource?: string) {
    let reserved = 0;
    for (const item of this.entries.values()) {
      if (item.state === "ready") reserved += item.bytes ?? 0;
      else if (item.state === "receiving") reserved += this.maxBytes;
    }
    for (const [guid, item] of this.downloads)
      if (!item.cancelled && `file:${guid}` !== excludeSource && !this.sources.has(`file:${guid}`))
        reserved += item.bytes;
    return reserved;
  }
  private allocate(name: string, source?: string) {
    if (this.closed) throw failure(410, "Session delivery store is closed");
    if (this.entries.size >= 256)
      for (const [id, item] of this.entries) {
        if (["acknowledged", "failed", "cancelled", "expired"].includes(item.state)) {
          this.entries.delete(id);
          if (item.source) this.sources.delete(item.source);
          break;
        }
      }
    if (this.reservedBytes(source) + this.maxBytes > this.pendingBytes || this.entries.size >= 256)
      throw failure(429, "Acknowledge or cancel an outstanding delivery before creating another");
    const entry: Delivery = {
      id: randomUUID(),
      state: "receiving",
      name: safeName(name),
      source,
      expiresAt: Date.now() + DELIVERY_TTL_MS,
      readers: new Set(),
    };
    this.entries.set(entry.id, entry);
    if (source) this.sources.set(source, entry);
    return entry;
  }
  private public(entry: Delivery) {
    return deliveryInfo({
      id: entry.id,
      session: this.sessionId,
      state: entry.state,
      name: entry.name,
      bytes: entry.bytes,
      sha256: entry.sha256,
      route: entry.route,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      error: entry.error,
      handoff: !!entry.handoff,
    });
  }
  private get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw failure(410, "Delivery is unavailable or expired");
    return entry;
  }
  status(id: string) {
    return this.public(this.get(id));
  }
  list() {
    return [...this.entries.values()].map((entry) => this.public(entry));
  }
  get retained() {
    return [...this.entries.values()].some((entry) => entry.handoff && entry.state === "ready");
  }
  share(id: string) {
    const entry = this.get(id);
    if (entry.state !== "ready" || entry.expiresAt <= Date.now())
      throw failure(409, "Wait for the file to be ready before sharing it");
    if (!entry.handoff) {
      if (
        FileTransfers.handoffBytes + entry.bytes! > this.maxHandoffBytes ||
        FileTransfers.handoffCount >= 1024
      )
        throw failure(429, "Remove an unused download before preparing another handoff");
      FileTransfers.handoffBytes += entry.bytes!;
      FileTransfers.handoffCount++;
      entry.handoff = true;
      entry.expiresAt = Date.now() + DELIVERY_TTL_MS;
    }
    return this.public(entry);
  }
  private releaseHandoff(entry: Delivery) {
    if (entry.handoff) {
      FileTransfers.handoffBytes -= entry.bytes ?? 0;
      FileTransfers.handoffCount--;
    }
    entry.handoff = false;
  }
  private run(entry: Delivery, work: () => Promise<void>) {
    entry.operation = operations.start(
      {
        id: entry.id,
        resource: this.resource,
        deadline: entry.expiresAt,
        onStop: () => {
          entry.state = "cancelled";
        },
      },
      async (operation) => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        operation.check();
        operation.markActed();
        try {
          await work();
          operation.check();
          entry.state = "ready";
        } finally {
          if (operation.signal.aborted || entry.state !== "ready") {
            const cleanup = await Promise.allSettled(
              [this.payload(entry.id), this.payload(entry.id) + ".part"].map((file) =>
                rm(file, { force: true }),
              ),
            );
            if (cleanup.some((item) => item.status === "rejected"))
              entry.error = "File cleanup failed; retry cancellation";
          }
        }
      },
    );
    void entry.operation.promise.catch(() => {
      entry.state = entry.operation!.signal.aborted ? "cancelled" : "failed";
      entry.error ??= entry.state === "failed" ? "File preparation failed" : undefined;
    });
    entry.task = entry.operation.done;
  }
  async fromFile(file: string, name?: string) {
    if (path.basename(file) !== file || file === "." || file === ".." || file.includes("\\"))
      throw failure(400, "Use one session file name");
    const source = `file:${file}`;
    const previous = this.sources.get(source);
    if (previous) {
      await previous.task;
      return this.public(previous);
    }
    if (!this.rawReady(file)) throw failure(409, "Browser download is not complete");
    const entry = this.allocate(name ?? this.nameFor(file) ?? file, source);
    this.run(entry, async () => {
      const input = await open(
        path.join(this.filesPath, file),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await input.stat();
        if (!info.isFile() || info.size > this.maxBytes)
          throw failure(413, "File exceeds the delivery limit or is not regular");
        await rename(path.join(this.filesPath, file), this.payload(entry.id));
        const digest = createHash("sha256");
        let bytes = 0;
        for await (const chunk of input.createReadStream({ signal: entry.operation!.signal })) {
          bytes += chunk.length;
          if (bytes > this.maxBytes) throw failure(413, "File exceeds the delivery limit");
          digest.update(chunk);
        }
        entry.bytes = bytes;
        entry.sha256 = digest.digest("hex");
        this.downloads.delete(file);
      } finally {
        await input.close();
      }
    });
    await entry.task;
    return this.public(entry);
  }
  async fromBytes(source: string, name: string, data: Buffer) {
    source = `bytes:${source}`;
    const previous = this.sources.get(source);
    if (previous) {
      await previous.task;
      return this.public(previous);
    }
    if (data.length > this.maxBytes) throw failure(413, "File exceeds the delivery limit");
    const entry = this.allocate(name, source);
    this.run(entry, async () => {
      await writeFile(this.payload(entry.id), data, { flag: "wx", mode: 0o600 });
      entry.bytes = data.length;
      entry.sha256 = createHash("sha256").update(data).digest("hex");
    });
    await entry.task;
    return this.public(entry);
  }
  fromUrl(browser: BrowserSession, url: string, name?: string, referer?: string) {
    let guessed = path.posix.basename(new URL(url).pathname);
    try {
      guessed = decodeURIComponent(guessed);
    } catch {
      /* Keep malformed escapes as filename text. */
    }
    const entry = this.allocate(name ?? guessed);
    this.run(entry, async () => {
      const result = await downloadFile(browser, url, referer, {
        path: this.payload(entry.id) + ".part",
        maxBytes: this.maxBytes,
        signal: entry.operation!.signal,
      });
      if (
        result.status < 200 ||
        result.status >= 300 ||
        !result.sha256 ||
        result.bytes === undefined
      )
        throw new Error("Missing streamed file metadata");
      await rename(this.payload(entry.id) + ".part", this.payload(entry.id));
      entry.bytes = result.bytes;
      entry.sha256 = result.sha256;
      entry.route = result.route;
    });
    return this.public(entry);
  }
  async read(id: string, start = 0, end?: number) {
    const entry = this.get(id);
    if (entry.state !== "ready")
      throw failure(entry.state === "receiving" ? 409 : 410, "Delivery is not ready");
    if (Date.now() >= entry.expiresAt) throw failure(410, "Delivery expired");
    const input = await open(this.payload(id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw failure(410, "Delivery is no longer available");
        throw error;
      },
    );
    try {
      const info = await input.stat();
      if (!info.isFile() || info.size !== entry.bytes) throw failure(409, "Delivery changed");
      const stream = input.createReadStream({ start, ...(end !== undefined ? { end } : {}) });
      entry.readers.add(stream);
      stream.once("close", () => entry.readers.delete(stream));
      return { stream, ...this.public(entry) };
    } catch (error) {
      await input.close();
      throw error;
    }
  }
  async acknowledge(id: string, sha256: string) {
    const entry = this.get(id);
    if (sha256 !== entry.sha256) throw failure(409, "Delivery checksum does not match");
    if (!["ready", "acknowledged"].includes(entry.state))
      throw failure(409, "Delivery cannot be acknowledged");
    await rm(this.payload(id), { force: true });
    this.releaseHandoff(entry);
    entry.state = "acknowledged";
    return this.public(entry);
  }
  async cancel(id: string) {
    const entry = this.get(id);
    entry.operation?.cancel();
    for (const reader of entry.readers) reader.destroy();
    await entry.task;
    await rm(this.payload(id), { force: true });
    this.releaseHandoff(entry);
    entry.state = "cancelled";
    return this.public(entry);
  }
  async expire(now = Date.now()) {
    for (const entry of this.entries.values())
      if (entry.expiresAt <= now && !entry.readers.size) {
        await this.cancel(entry.id);
        this.entries.delete(entry.id);
        if (entry.source) this.sources.delete(entry.source);
      }
    for (const [guid, entry] of this.downloads)
      if (entry.cancelled || now - entry.at >= DELIVERY_TTL_MS) {
        if (!entry.completed) await this.cancelBrowserDownload?.(guid);
        await rm(path.join(this.filesPath, guid), { force: true });
        await rm(path.join(this.filesPath, guid + ".crdownload"), { force: true });
        this.downloads.delete(guid);
      }
    if (this.closed && !this.retained) {
      this.entries.clear();
      await rm(this.root, { recursive: true, force: true });
    }
  }
  stop(retainHandoffs = true) {
    this.closed = true;
    for (const entry of this.entries.values())
      if (!(retainHandoffs && entry.handoff && entry.state === "ready")) {
        entry.operation?.cancel();
        for (const reader of entry.readers) reader.destroy();
        if (entry.state === "ready") entry.state = "cancelled";
      }
  }
  async close(retainHandoffs = true) {
    this.stop(retainHandoffs);
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.task));
    for (const [id, entry] of this.entries) {
      if (
        retainHandoffs &&
        entry.handoff &&
        entry.state === "ready" &&
        entry.expiresAt > Date.now()
      ) {
        entry.operation = undefined;
        entry.task = undefined;
      } else {
        await rm(this.payload(id), { force: true });
        this.releaseHandoff(entry);
        this.entries.delete(id);
      }
    }
    const cleanup = await Promise.allSettled(
      [
        this.filesPath,
        ...(!this.retained ? [this.root] : []),
        path.join(path.dirname(this.filesPath), ".archives", this.sessionId),
      ].map((dir) => rm(dir, { recursive: true, force: true })),
    );
    this.sources.clear();
    this.downloads.clear();
    this.resource = {};
    const errors = cleanup.filter((item) => item.status === "rejected").map((item) => item.reason);
    if (errors.length) throw new AggregateError(errors, "Session files cleanup failed");
  }
  static async reap(root: string, active: Set<string>, now = Date.now()) {
    for (const base of [root, path.join(root, ".deliveries"), path.join(root, ".archives")]) {
      for (const item of await readdir(base, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      )) {
        if (!item.isDirectory() || !uuid.test(item.name) || active.has(item.name)) continue;
        const dir = path.join(base, item.name);
        const info = await stat(dir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (info && now - info.mtimeMs >= ORPHAN_TTL_MS)
          await rm(dir, { recursive: true, force: true });
      }
    }
  }
}
