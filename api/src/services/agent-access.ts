import type { Agent } from "./proxy-manager.js";
import { PublicError } from "../utils/public-error.js";
import { sharedStoreConnection } from "./shared-store.js";
import { assertOrganizationMember, currentOrganization } from "./organization.js";

// Recheck the connected key when queued provider work starts. Fail closed on
// outages; a cached claim cannot authorize a revoked Toolstack connection.
export async function assertAgentCurrent(agent: Agent) {
  if (!agent.connectedApp) return;
  assertOrganizationMember(agent.connectedApp);
  const connection = sharedStoreConnection();
  if (!connection)
    throw new PublicError(
      "authorization_unavailable",
      "Connected-app authorization is unavailable",
      503,
    );
  let response: Response;
  try {
    response = await fetch(new URL("/internal/principal", connection.url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: `Bearer ${connection.key}`,
        "content-type": "application/json",
        "x-toolstack-org-id": currentOrganization().id,
      },
      body: JSON.stringify(agent.connectedApp),
    });
  } catch {
    throw new PublicError("authorization_unavailable", "Unable to verify the connected app", 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PublicError(
      "connection_revoked",
      "The Toolstack connection is no longer authorized",
      403,
    );
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("active" in result) || result.active !== true)
    throw new PublicError(
      "connection_revoked",
      "The Toolstack connection is no longer authorized",
      403,
    );
}
