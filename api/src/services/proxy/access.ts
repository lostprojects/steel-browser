import type { SessionPool } from "../session-pool.js";
import { identityVault } from "../login.js";
import { ProxyError, type Agent, type LeaseInput } from "./types.js";

export async function requireProxyIdentity(pool: SessionPool, input: LeaseInput, agent: Agent) {
  if (!input.identity) return;
  if (identityVault(input.identity))
    throw new ProxyError("protected_identity_requires_browser", 403);
  if (pool.identityBusy(input.identity)) throw new ProxyError("proxy_identity_in_use");
  await pool.connectionStore.assertProfile(input.identity, agent);
}
