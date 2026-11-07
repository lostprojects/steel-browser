import { z } from "zod";
import type { ConnectedPrincipal } from "../gateway-principal.js";
import { PublicError } from "../../utils/public-error.js";

export const DAILY_BUDGET = 1_000_000_000;
export type Agent = {
  name: string;
  dailyBudgetBytes: number;
  admin?: boolean;
  connectedApp?: ConnectedPrincipal;
};
export type Exit = { ip: string; timezone: string; country: string; region: string };
export const proxyName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const wire = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9 .,-]+$/);
export const targeting = z
  .object({
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default("US"),
    region: wire.optional(),
    city: wire.optional(),
    zip: wire.optional(),
    asn: z
      .string()
      .regex(/^AS[0-9]{1,10}$/)
      .optional(),
    isp: wire.optional(),
  })
  .strict();
export const proxyProfile = z
  .object({
    provider: z.enum(["evomi", "custom"]).default("evomi"),
    product: z.enum(["core", "premium", "mobile", "datacenter"]).default("core"),
    protocol: z.enum(["http", "https", "socks5"]).default("http"),
    credentialEnv: z
      .string()
      .regex(/^(?:EVOMI_[A-Z_]+_PROXY_URL|TOOLSTACK_PROXY_[A-Z0-9_]+)$/)
      .optional(),
    target: targeting.default({ country: "US" }),
    session: z.enum(["rotating", "sticky", "hard", "locked"]).default("hard"),
    lifetimeMinutes: z.number().int().min(1).max(1440).optional(),
    pool: z.enum(["standard", "speed", "quality"]).default("standard"),
    geosource: z.enum(["ipapi", "maxmind"]).default("ipapi"),
    maxLatencyMs: z.number().int().min(1).max(10000).optional(),
    maxFraudscore: z.number().int().min(0).max(100).optional(),
    activeSinceMinutes: z.number().int().min(1).max(10080).optional(),
    device: z.enum(["windows", "unix", "apple"]).optional(),
    extendedPool: z.boolean().default(false),
    adblock: z.boolean().default(false),
    ttlSeconds: z.number().int().min(30).max(86400).default(10800),
    budgetBytes: z.number().int().min(1).max(100_000_000_000).optional(),
    allowedAgents: z.array(z.string().min(1).max(512)).min(1).max(64).default(["*"]),
    allowedCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(250)
      .optional(),
    fallback: z.array(proxyName).max(3).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();
export type ProxyProfile = z.infer<typeof proxyProfile>;
export const leaseInput = z
  .object({
    profile: proxyName.default("core"),
    target: targeting
      .partial()
      .extend({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
      })
      .optional(),
    host: z
      .string()
      .regex(/^[A-Za-z0-9.-]{1,253}$/)
      .optional(),
    identity: proxyName.optional(),
    budgetBytes: z.number().int().min(1).max(100_000_000_000).optional(),
    ttlSeconds: z.number().int().min(1).max(86400).optional(),
  })
  .strict();
export type LeaseInput = z.infer<typeof leaseInput>;
export const leaseFetchInput = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
      }),
    method: z.enum(["GET", "POST"]).default("GET"),
    data: z.string().max(2_000_000).optional(),
    headers: z
      .record(
        z.string().regex(/^(?:accept|accept-language|content-type|referer)$/i),
        z.string().max(8192),
      )
      .optional(),
    maxBytes: z.number().int().min(1).max(64_000_000).optional(),
    timeout: z.number().min(0.1).max(120).optional(),
  })
  .strict();
export const proxyOutcome = z
  .object({
    host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
    outcome: z.enum(["ok", "blocked", "rate_limited", "transport_failed"]),
  })
  .strict();
export type Identity = {
  country: string;
  stickyId: string;
  lastExit?: Exit;
  profile?: string;
  binding?: string;
  session?: ProxyProfile["session"];
};
export type LeaseRecord = {
  id: string;
  owner: string;
  agent: string;
  profile: string;
  product: string;
  session: ProxyProfile["session"];
  identity?: string;
  country: string;
  createdAt: number;
  expiresAt: number;
  status: "preparing" | "active" | "closed";
  reason?: string;
  exit?: Exit;
  txBytes: number;
  rxBytes: number;
  directBytes: number;
  budgetBytes?: number;
};
export type Health = {
  attempts: number;
  successes: number;
  failures: number;
  lastFailure?: string;
  lastSuccessAt?: number;
};
export type ProxyState = {
  version: 2;
  organization: string;
  days: Record<string, Record<string, number>>;
  total: number;
  lifetime: Record<string, number>;
  products: Record<string, number>;
  identities: Record<string, Identity>;
  profiles: Record<string, ProxyProfile>;
  leases: Record<string, LeaseRecord>;
  bad: Record<string, Record<string, number>>;
  health: Record<string, Health>;
};
export class ProxyError extends PublicError {
  constructor(code: string, status = 409) {
    super(code, code.replaceAll("_", " "), status);
  }
}
export const actor = (agent: Agent) =>
  agent.connectedApp
    ? `app:${agent.connectedApp.orgId}:${agent.connectedApp.membershipId}:${agent.connectedApp.keyId}`
    : Object.hasOwn(Object.prototype, agent.name) || agent.name === "prototype"
      ? `agent:${agent.name}`
      : agent.name;
export const proxyAdmin = (agent: Agent) =>
  Boolean(agent.admin && (!agent.connectedApp || agent.connectedApp.admin));
export const utcDay = () => new Date().toISOString().slice(0, 10);
