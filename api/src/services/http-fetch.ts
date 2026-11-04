// Runs a bounded HTTP client with Chrome TLS. Secrets travel on stdin only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BrowserSession } from "./browser-session.js";
import { challengeMarker } from "./challenge-service.js";

export type HttpResult = {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
};
export function httpFetch(options: {
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
}): Promise<HttpResult> {
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid HTTP URL");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.FETCH_PYTHON ?? "/opt/browser-fetch/bin/python",
      [fileURLToPath(new URL("../../fetch.py", import.meta.url))],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), ((options.timeout ?? 30) + 5) * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 2_000_000) * 1.4 + 100_000) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("HTTP read failed or exceeded its limit"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid HTTP reader response"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(options));
  });
}

export async function downloadFile(session: BrowserSession, url: string, referer?: string) {
  const options = {
    url,
    referer,
    cookies: await session.getCookies(),
    userAgent: session.getUserAgent(),
    maxBytes: 64_000_000,
    timeout: 120,
  };
  // Logged-in first-party reads keep the identity exit. Only signed CDN assets
  // may try direct when the browser supplied a reusable signature.
  const parsed = new URL(url);
  const signedAsset =
    /^(?:img\.newspapers\.com|img\d*\.fold3\.com|.*\.cloudfront\.net)$/.test(parsed.hostname) &&
    [...parsed.searchParams.keys()].some((k) => /signature|token|^sig$|^h$|^auth$/i.test(k));
  const identityPage = !!session.options.identity && !signedAsset;
  if (identityPage && session.proxyServer) {
    const response = await httpFetch({ ...options, proxy: session.proxyServer.url });
    return { ...response, route: "residential" };
  }
  let directError: unknown;
  const valid = (r: HttpResult) =>
    r.status >= 200 &&
    r.status < 300 &&
    !challengeMarker(Buffer.from(r.body, "base64").subarray(0, 5000).toString());
  try {
    const response = await httpFetch(options);
    if (valid(response)) return { ...response, route: "direct" };
    directError = response.status;
  } catch {
    directError = "transport";
  }
  if (!session.proxyServer) throw new Error(`Direct file read failed (${directError})`);
  const response = await httpFetch({ ...options, proxy: session.proxyServer.url });
  if (!valid(response)) throw new Error(`Residential file read failed (${response.status})`);
  return { ...response, route: "residential" };
}
