import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { env } from "../env.js";

export const API_KEY_HEADER = "steel-api-key";
export const API_KEY_COOKIE = "steel_api_key";

// Paths that stay public so the platform health check works without a key
const publicPaths = new Set(["/v1/health", "/health"]);

function matches(candidate: string | undefined, key: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * Returns the key supplied by a request, from the header, the apiKey query
 * parameter or the cookie set when the UI was opened with ?apiKey=
 */
export function suppliedKey(req: IncomingMessage): { key?: string; fromQuery: boolean } {
  const header = req.headers[API_KEY_HEADER];
  if (typeof header === "string") return { key: header, fromQuery: false };
  const query = new URL(req.url ?? "", "http://localhost").searchParams.get("apiKey");
  if (query) return { key: query, fromQuery: true };
  return { key: readCookie(req.headers.cookie, API_KEY_COOKIE), fromQuery: false };
}

/**
 * Returns true when STEEL_API_KEY is unset, the path is public or the request
 * carries the key
 */
export function isAuthorized(req: IncomingMessage): boolean {
  if (!env.STEEL_API_KEY) return true;
  const path = new URL(req.url ?? "", "http://localhost").pathname;
  if (publicPaths.has(path)) return true;
  return matches(suppliedKey(req).key, env.STEEL_API_KEY);
}
