import { createHash } from "node:crypto";
import { ProxyError, proxyProfile, type ProxyProfile } from "./types.js";

const products = {
  core: { env: "EVOMI_RESIDENTIAL_PROXY_URL", host: "core-residential.evomi.com", port: 1000 },
  premium: { env: "EVOMI_PREMIUM_PROXY_URL", host: "premium-residential.evomi.com", port: 1000 },
  mobile: { env: "EVOMI_MOBILE_PROXY_URL", host: "mp.evomi.com", port: 3000 },
  datacenter: { env: "EVOMI_DATACENTER_PROXY_URL", host: "dcp.evomi.com", port: 2000 },
} as const;
export function validateProfile(input: unknown): ProxyProfile {
  const p = proxyProfile.parse(input);
  if (p.session !== "sticky" && p.lifetimeMinutes !== undefined)
    throw new ProxyError("lifetime_requires_sticky_session", 400);
  if (p.allowedCountries && !p.allowedCountries.includes(p.target.country))
    throw new ProxyError("profile_country_not_allowed", 400);
  if (p.provider === "custom") {
    if (!p.credentialEnv?.startsWith("TOOLSTACK_PROXY_"))
      throw new ProxyError("custom_proxy_requires_credential_reference", 400);
    if (
      p.session !== "hard" ||
      Object.keys(p.target).length > 1 ||
      p.extendedPool ||
      p.adblock ||
      p.device ||
      p.maxLatencyMs ||
      p.maxFraudscore !== undefined ||
      p.activeSinceMinutes ||
      p.pool !== "standard" ||
      p.geosource !== "ipapi"
    )
      throw new ProxyError("custom_proxy_does_not_support_evomi_filters", 400);
    return p;
  }
  if (p.credentialEnv && p.credentialEnv !== products[p.product].env)
    throw new ProxyError("proxy_credential_product_mismatch", 400);
  if (p.product === "core" && (p.protocol === "https" || p.target.isp || p.adblock))
    throw new ProxyError("unsupported_core_proxy_option", 400);
  if (
    p.product !== "premium" &&
    (p.extendedPool ||
      p.device ||
      p.maxLatencyMs ||
      p.maxFraudscore !== undefined ||
      p.activeSinceMinutes)
  )
    throw new ProxyError("premium_proxy_filter_required", 400);
  if (p.product !== "premium" && p.pool !== "standard")
    throw new ProxyError("premium_proxy_pool_required", 400);
  if (
    p.product === "datacenter" &&
    (p.target.region || p.target.city || p.target.zip || p.target.asn || p.target.isp)
  )
    throw new ProxyError("unsupported_datacenter_target", 400);
  if (p.product === "mobile" && (p.target.zip || p.target.asn))
    throw new ProxyError("unsupported_mobile_target", 400);
  if (
    p.extendedPool &&
    (p.device || p.maxLatencyMs || p.maxFraudscore !== undefined || p.activeSinceMinutes)
  )
    throw new ProxyError("extended_pool_conflicts_with_expert_filters", 400);
  return p;
}
export function credentialName(p: ProxyProfile) {
  return p.credentialEnv ?? products[p.product].env;
}
export function configured(p: ProxyProfile) {
  return Boolean(process.env[credentialName(p)]);
}
export function binding(p: ProxyProfile) {
  const { allowedAgents, allowedCountries, fallback, enabled, budgetBytes, ttlSeconds, ...route } =
    p;
  return createHash("sha256").update(JSON.stringify(route)).digest("hex");
}
export function upstream(p: ProxyProfile, stickyId: string): string {
  validateProfile(p);
  const raw = process.env[credentialName(p)];
  if (!raw) throw new ProxyError("proxy_credentials_unavailable", 503);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyError("invalid_proxy_credentials", 503);
  }
  if (
    !["http:", "https:", "socks5:"].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new ProxyError("invalid_proxy_credentials", 503);
  if (p.provider === "custom") {
    if (url.protocol !== `${p.protocol}:`) throw new ProxyError("proxy_protocol_mismatch", 503);
    return url.toString();
  }
  const spec = products[p.product];
  if (url.hostname !== spec.host || (url.port && Number(url.port) !== spec.port))
    throw new ProxyError("proxy_gateway_product_mismatch", 503);
  const host =
    p.protocol === "https"
      ? { premium: "rp", mobile: "mp", datacenter: "dcp", core: "rp" }[p.product] +
        ".evomi-proxy.com"
      : spec.host;
  const port = spec.port + (p.protocol === "https" ? 1 : p.protocol === "socks5" ? 2 : 0);
  const target = new URL(`${p.protocol}://${host}:${port}`);
  target.username = decodeURIComponent(url.username);
  const modifiers = [`country-${p.target.country}`];
  for (const key of ["region", "city", "zip", "asn", "isp"] as const) {
    const value = p.target[key];
    if (value)
      modifiers.push(`${key}-${key === "asn" ? value : value.toLowerCase().replaceAll(" ", ".")}`);
  }
  if (p.session !== "rotating")
    modifiers.push(
      `${{ sticky: "session", hard: "hardsession", locked: "lockedsession" }[p.session]}-${stickyId}`,
    );
  if (p.lifetimeMinutes) modifiers.push(`lifetime-${p.lifetimeMinutes}`);
  if (p.pool !== "standard") modifiers.push(`mode-${p.pool}`);
  if (p.geosource !== "ipapi") modifiers.push(`geosource-${p.geosource}`);
  for (const [key, value] of [
    ["device", p.device],
    ["latency", p.maxLatencyMs],
    ["fraudscore", p.maxFraudscore],
    ["activesince", p.activeSinceMinutes],
  ] as const)
    if (value !== undefined) modifiers.push(`${key}-${value}`);
  if (p.extendedPool) modifiers.push("extended-1");
  if (p.adblock) modifiers.push("adblock-1");
  target.password = decodeURIComponent(url.password) + "_" + modifiers.join("_");
  return target.toString();
}
export const defaults: Record<string, ProxyProfile> = {
  core: validateProfile({ product: "core", session: "locked" }),
  premium: validateProfile({ product: "premium", session: "locked", allowedAgents: ["admin"] }),
  mobile: validateProfile({ product: "mobile", session: "locked", allowedAgents: ["admin"] }),
  datacenter: validateProfile({
    product: "datacenter",
    session: "locked",
    allowedAgents: ["admin"],
  }),
};
