import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { env } from "../env.js";
import { DAILY_BUDGET, type Agent } from "../services/proxy-manager.js";
import { protect } from "../services/vault.js";
import { getBaseUrl } from "./url.js";

export const API_KEY_HEADER = "steel-api-key";
export const API_KEY_COOKIE = "steel_api_key";

// Native API/CDP clients do not send Origin. Browsers must use the configured
// service origin, so another website cannot drive a cookie-authenticated session.
export function browserOriginAllowed(req: IncomingMessage): boolean {
  return !req.headers.origin || req.headers.origin === new URL(getBaseUrl()).origin;
}

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
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Returns the key from steel-api-key, Authorization: Bearer, the apiKey query
 * parameter or the cookie set when the UI was opened with ?apiKey=
 */
export function suppliedKey(req: IncomingMessage): { key?: string; fromQuery: boolean } {
  const header = req.headers[API_KEY_HEADER];
  if (typeof header === "string") return { key: header, fromQuery: false };
  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (bearer) return { key: bearer, fromQuery: false };
  const query = new URL(req.url ?? "", "http://localhost").searchParams.get("apiKey");
  if (query) return { key: query, fromQuery: true };
  return { key: readCookie(req.headers.cookie, API_KEY_COOKIE), fromQuery: false };
}

// Missing configuration must not turn an anonymous caller into an administrator.
export function requireApiKey() {
  if (!env.STEEL_API_KEY?.trim()) throw new Error("STEEL_API_KEY must be configured");
  protect(env.STEEL_API_KEY);
  const entries = agentKeys();
  for (const entry of entries) protect(entry.key);
}

function agentKeys(): Array<{ name: string; key: string; dailyBudgetBytes?: number }> {
  try {
    const entries = JSON.parse(process.env.STEEL_AGENT_KEYS ?? "[]");
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry.key !== "string" ||
          !entry.key.trim() ||
          typeof entry.name !== "string" ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(entry.name) ||
          entry.name === "admin" ||
          (entry.dailyBudgetBytes !== undefined &&
            (!Number.isSafeInteger(entry.dailyBudgetBytes) || entry.dailyBudgetBytes < 1)),
      )
    )
      throw new Error();
    return entries;
  } catch {
    throw new Error("Invalid STEEL_AGENT_KEYS configuration");
  }
}

export function isAuthorized(req: IncomingMessage): boolean {
  const path = new URL(req.url ?? "", "http://localhost").pathname;
  if (publicPaths.has(path)) return true;
  return agentFor(req) !== undefined;
}

export function agentFor(req: IncomingMessage): Agent | undefined {
  if (!env.STEEL_API_KEY?.trim()) return undefined;
  const key = suppliedKey(req).key;
  const dailyBudgetBytes = Number(process.env.RESIDENTIAL_DAILY_BUDGET_BYTES ?? DAILY_BUDGET);
  if (!Number.isSafeInteger(dailyBudgetBytes) || dailyBudgetBytes < 1)
    throw new Error("Invalid residential budget");
  if (matches(key, env.STEEL_API_KEY)) return { name: "admin", admin: true, dailyBudgetBytes };
  const entries = agentKeys();
  const entry = entries.find((v) => matches(key, v.key));
  if (!entry) return undefined;
  const budget = entry.dailyBudgetBytes ?? dailyBudgetBytes;
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("Invalid agent budget");
  return { name: entry.name, dailyBudgetBytes: budget };
}
