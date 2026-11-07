import type { Page } from "puppeteer-core";
import { httpFetch, HttpFetchError } from "../../services/http-fetch.js";

export const PDF_FETCH_TIMEOUT_MS = 30_000;
export const PDF_MAX_MEGABYTES = 50;

export interface FetchPdfOptions {
  proxyUrl?: string;
  timeoutMs?: number;
  maxMegabytes?: number;
}

export async function fetchPdf(page: Page, targetUrl: string, options: FetchPdfOptions = {}) {
  const { proxyUrl, timeoutMs = PDF_FETCH_TIMEOUT_MS, maxMegabytes = PDF_MAX_MEGABYTES } = options;
  const signal = AbortSignal.timeout(timeoutMs);

  const [cookies, userAgent] = await beforeDeadline(
    Promise.all([
      page.cookies(targetUrl),
      page.evaluate(() => navigator.userAgent).catch(() => page.browser().userAgent()),
    ]),
    signal,
  ).catch((error: unknown) => {
    throw signal.aborted ? downloadTimedOut(timeoutMs) : error;
  });
  const response = await httpFetch({
    url: targetUrl,
    cookies,
    userAgent,
    referer: new URL(targetUrl).origin + "/",
    proxy: proxyUrl,
    signal,
    timeout: timeoutMs / 1000,
    maxBytes: maxMegabytes * 1024 * 1024,
  }).catch((error: unknown) => {
    throw downloadError(error, signal.aborted, timeoutMs, maxMegabytes);
  });

  const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
  if (response.status < 200 || response.status >= 300 || !contentType.includes("application/pdf")) {
    throw new Error(`Expected PDF; got status ${response.status} content-type ${contentType}`);
  }

  return {
    buffer: Buffer.from(response.body, "base64"),
    status: response.status,
    headers: response.headers,
    contentType,
  };
}

function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function downloadTimedOut(timeoutMs: number): Error {
  return new Error(`PDF download timed out after ${timeoutMs} ms`);
}

function downloadError(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number,
  maxMegabytes: number,
): Error {
  if (timedOut || (error instanceof HttpFetchError && error.code === "timeout"))
    return downloadTimedOut(timeoutMs);
  if (error instanceof HttpFetchError && error.code === "limit") {
    return new Error(`PDF is larger than ${maxMegabytes} MB`);
  }
  return new Error(
    `PDF download failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
