// Runs a bounded HTTP client with Chrome TLS. Secrets travel on stdin only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserSession } from "./browser-session.js";
import { challengeMarker } from "./challenge-service.js";
import { browserProcessEnv } from "../utils/browser.js";
import { env } from "../env.js";
import { availableParallelism, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

export type HttpResult = {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  bytes?: number;
  sha256?: string;
};
export class HttpFetchError extends Error {
  constructor(readonly code: "limit" | "timeout" | "transport" | "protocol" | "busy" | "capacity") {
    super(
      code === "capacity"
        ? "Request exceeds the HTTP memory budget; use streamed delivery for large files"
        : `HTTP read failed (${code})`,
    );
    this.name = "HttpFetchError";
  }
  get statusCode() {
    return this.code === "busy" ? 429 : this.code === "capacity" ? 413 : 502;
  }
  get headers() {
    return this.code === "busy" ? { "retry-after": "1" } : undefined;
  }
}
type HttpFetchOptions = {
  url: string;
  method?: "GET" | "POST";
  data?: string;
  headers?: Record<string, string>;
  cookies?: unknown[];
  userAgent?: string;
  proxy?: string;
  referer?: string;
  maxBytes?: number;
  timeout?: number;
  signal?: AbortSignal;
  outputPath?: string;
};

const MiB = 1024 * 1024;
const workerMemory = process.constrainedMemory();
const memoryLimit = Math.min(workerMemory || totalmem(), totalmem());
const group =
  process.platform === "linux"
    ? readFileSync("/proc/self/cgroup", "utf8").match(/^0::\/(.*)$/m)?.[1]
    : undefined;
const groupStats =
  group === undefined ? undefined : path.resolve("/sys/fs/cgroup", group, "memory.stat");
const maxFetches = env.MAX_HTTP_FETCHES ?? Math.min(64, availableParallelism() * 4);
const memoryBudget = env.HTTP_MEMORY_BUDGET_MB
  ? env.HTTP_MEMORY_BUDGET_MB * MiB
  : Math.floor(memoryLimit / 4);
// A local sample used ~35 MiB per helper. Reserve 64 MiB plus eight times the
// buffered body limit for Python chunks, base64/JSON and Node's response copies.
// Streamed files retain a small prefix instead of the complete body.
const helperMemory = 64 * MiB;
const maxQueued = 2 * maxFetches;
let activeFetches = 0,
  reservedBytes = 0,
  reservedHeapBytes = 0;
const totals = { started: 0, waited: 0, rejected: 0, waitMs: 0, peakActive: 0 };
type Waiter = {
  bytes: number;
  heapBytes: number;
  until: number;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
};
const waiting: Waiter[] = [];
let admissionTimer: NodeJS.Timeout | undefined;

export function httpCapacity() {
  return {
    maxConcurrent: maxFetches,
    active: activeFetches,
    queued: waiting.length,
    maxQueued,
    cpuParallelism: availableParallelism(),
    memoryLimitBytes: memoryLimit,
    memoryBudgetBytes: memoryBudget,
    reservedBytes,
    reservedHeapBytes,
    ...totals,
  };
}

function memoryAvailable() {
  const system =
    Number(readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]) * 1024;
  if (!Number.isFinite(system)) throw new Error("Linux did not report available memory");
  if (!workerMemory || workerMemory > totalmem()) return system;
  let reclaimable = 0;
  if (groupStats?.startsWith("/sys/fs/cgroup/")) {
    try {
      reclaimable = Number(
        readFileSync(groupStats, "utf8").match(/^inactive_file (\d+)$/m)?.[1] ?? 0,
      );
    } catch (error) {
      if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return Math.min(system, process.availableMemory() + reclaimable);
}

function fits(bytes: number, heapBytes: number, available: number) {
  if (activeFetches >= maxFetches || reservedBytes + bytes > memoryBudget) return false;
  const heap = getHeapStatistics();
  if (heap.heap_size_limit - heap.used_heap_size < reservedHeapBytes + heapBytes + 2 * helperMemory)
    return false;
  return available >= reservedBytes + bytes + Math.max(helperMemory, memoryLimit / 10);
}

function admit() {
  clearTimeout(admissionTimer);
  admissionTimer = undefined;
  for (const item of [...waiting]) {
    if (item.until > performance.now()) continue;
    waiting.splice(waiting.indexOf(item), 1);
    item.signal?.removeEventListener("abort", item.abort);
    totals.rejected++;
    item.reject(new HttpFetchError("busy"));
  }
  if (!waiting.length) return;
  let available = Infinity;
  try {
    // Sample once per admission pass. Linux reports reclaimable cache;
    // bare-host free-memory readings on macOS do not.
    if (process.platform === "linux") available = memoryAvailable();
  } catch (error) {
    // Preserve the original error on requests. A pressure-probe failure must
    // not escape a timer callback and stop the service or start new work.
    for (const item of waiting.splice(0)) {
      item.signal?.removeEventListener("abort", item.abort);
      item.reject(error);
    }
    return;
  }
  while (waiting.length && fits(waiting[0].bytes, waiting[0].heapBytes, available)) {
    const item = waiting.shift()!;
    item.signal?.removeEventListener("abort", item.abort);
    activeFetches++;
    reservedBytes += item.bytes;
    reservedHeapBytes += item.heapBytes;
    totals.started++;
    totals.peakActive = Math.max(totals.peakActive, activeFetches);
    item.resolve(() => {
      activeFetches--;
      reservedBytes -= item.bytes;
      reservedHeapBytes -= item.heapBytes;
      admit();
    });
  }
  // This timer belongs only to waiting requests. Recheck when Chrome or other
  // work frees memory, even if no HTTP helper finishes during that interval.
  if (waiting.length)
    admissionTimer = setTimeout(
      admit,
      Math.min(100, ...waiting.map((item) => Math.max(0, item.until - performance.now()))),
    );
}

function acquire(bytes: number, heapBytes: number, deadline: number, signal?: AbortSignal) {
  admit();
  if (bytes > memoryBudget) {
    totals.rejected++;
    throw new HttpFetchError("capacity");
  }
  if (waiting.length >= maxQueued) {
    totals.rejected++;
    throw new HttpFetchError("busy");
  }
  const began = performance.now();
  let immediate = true;
  return new Promise<() => void>((resolve, reject) => {
    const item: Waiter = {
      bytes,
      heapBytes,
      until: Math.min(deadline, began + 5000),
      signal,
      reject,
      resolve: (release) => {
        if (!immediate) {
          totals.waited++;
          totals.waitMs += performance.now() - began;
        }
        resolve(release);
      },
      abort: () => {
        const index = waiting.indexOf(item);
        if (index < 0) return;
        waiting.splice(index, 1);
        signal?.removeEventListener("abort", item.abort);
        reject(signal?.reason ?? new Error("HTTP read aborted"));
        admit();
      },
    };
    signal?.addEventListener("abort", item.abort, { once: true });
    waiting.push(item);
    admit();
    immediate = false;
  });
}

// Admission and transfer share one deadline. Slots stay reserved until the
// helper exits, including after cancellation; retries cannot multiply work.
export async function httpFetch(options: HttpFetchOptions): Promise<HttpResult> {
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid HTTP URL");
  options.signal?.throwIfAborted();
  const deadline = performance.now() + (options.timeout ?? 30) * 1000;
  const bodyLimit = options.maxBytes ?? 2_000_000;
  const requestMemory = (options.data?.length ?? 0) * 4;
  const bytes = helperMemory + requestMemory + (options.outputPath ? 100_000 : bodyLimit * 8);
  const heapBytes = requestMemory + (options.outputPath ? 100_000 : bodyLimit * 4);
  const release = await acquire(bytes, heapBytes, deadline, options.signal);
  try {
    options.signal?.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new HttpFetchError("timeout");
    return await runHttpFetch({ ...options, timeout: remaining / 1000 });
  } finally {
    release();
  }
}

function runHttpFetch(options: HttpFetchOptions): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.FETCH_PYTHON ?? "/opt/browser-fetch/bin/python",
      [fileURLToPath(new URL("../../fetch.py", import.meta.url))],
      { stdio: ["pipe", "pipe", "ignore"], env: browserProcessEnv() },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: unknown;
    const stop = (error: unknown) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(new HttpFetchError("timeout")),
      (options.timeout ?? 30) * 1000,
    );
    const aborted = () => stop(options.signal?.reason ?? new Error("HTTP read aborted"));
    options.signal?.addEventListener("abort", aborted, { once: true });
    // The signal remains local; it is never passed to the Python subprocess.
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.outputPath ? 100_000 : (options.maxBytes ?? 2_000_000) * 1.4 + 100_000))
        stop(new HttpFetchError("limit"));
      else chunks.push(chunk);
    });
    child.once("error", () => {
      failure ??= new HttpFetchError("transport");
    });
    child.once("close", (code) => {
      cleanup();
      if (failure) return reject(failure);
      if (options.signal?.aborted)
        return reject(options.signal.reason ?? new Error("HTTP read aborted"));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString());
        if (code !== 0)
          return reject(new HttpFetchError(result.error === "limit" ? "limit" : "transport"));
        if (
          !Number.isInteger(result.status) ||
          typeof result.url !== "string" ||
          typeof result.body !== "string" ||
          !result.headers ||
          typeof result.headers !== "object"
        )
          throw new Error("Invalid response");
        if (
          options.outputPath &&
          (!Number.isSafeInteger(result.bytes) ||
            result.bytes < 0 ||
            !/^[a-f0-9]{64}$/.test(result.sha256))
        )
          throw new Error("Invalid streamed file metadata");
        result.headers = Object.fromEntries(
          Object.entries(result.headers).map(([name, value]) => [
            name.toLowerCase(),
            String(value),
          ]),
        );
        resolve(result);
      } catch {
        reject(new HttpFetchError("protocol"));
      }
    });
    child.stdin.on("error", () => undefined);
    const { signal: _signal, ...request } = options;
    child.stdin.end(JSON.stringify(request));
  });
}

export async function downloadFile(
  session: BrowserSession,
  url: string,
  referer?: string,
  file?: { path: string; maxBytes: number; signal: AbortSignal },
) {
  const options = {
    url,
    referer,
    cookies: await session.getCookies(),
    userAgent: session.getUserAgent(),
    maxBytes: file?.maxBytes ?? 64_000_000,
    timeout: 120,
    ...(file ? { outputPath: file.path, signal: file.signal } : {}),
  };
  // Logged-in first-party reads keep the identity exit. Only signed CDN assets
  // may try direct when the browser supplied a reusable signature.
  const parsed = new URL(url);
  const signedAsset =
    /^(?:img\.newspapers\.com|img\d*\.fold3\.com|.*\.cloudfront\.net)$/.test(parsed.hostname) &&
    [...parsed.searchParams.keys()].some((k) => /signature|token|^sig$|^h$|^auth$/i.test(k));
  const identityPage = !!session.options.identity && !signedAsset;
  const read = async (proxy?: string) => {
    file?.signal.throwIfAborted();
    if (file) await rm(file.path, { force: true });
    return httpFetch({ ...options, ...(proxy ? { proxy } : {}) });
  };
  const valid = (r: HttpResult) =>
    r.status >= 200 &&
    r.status < 300 &&
    !challengeMarker(Buffer.from(r.body, "base64").subarray(0, 5000).toString());
  if (identityPage && session.proxyServer) {
    const response = await read(session.proxyServer.url);
    if (!valid(response)) throw new Error(`Identity file read failed (${response.status})`);
    return { ...response, route: "residential" };
  }
  let directError: unknown;
  try {
    const response = await read();
    if (valid(response)) return { ...response, route: "direct" };
    directError = response.status;
  } catch (error) {
    file?.signal.throwIfAborted();
    if (error instanceof HttpFetchError && ["busy", "capacity"].includes(error.code)) throw error;
    directError = "transport";
  }
  if (!session.proxyServer) throw new Error(`Direct file read failed (${directError})`);
  const response = await read(session.proxyServer.url);
  if (!valid(response)) throw new Error(`Residential file read failed (${response.status})`);
  return { ...response, route: "residential" };
}
