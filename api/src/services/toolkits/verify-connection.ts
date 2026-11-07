import type { BrowserConnections } from "../connections.js";
import type { ToolContext, ToolRegistry } from "./registry.js";
import { PublicError } from "../../utils/public-error.js";

// Verification is an ordinary bounded provider operation. It has the same
// allowances and retry protection, and returns its original acquisition time.
export async function verifyConnection<Context extends ToolContext>(
  registry: ToolRegistry<Context>,
  catalog: BrowserConnections,
  id: string,
  context: Context,
) {
  const connection = await catalog.get(id, context.agent);
  if (connection.type !== "api" || !connection.verification)
    throw new PublicError(
      "verification_unsupported",
      "Open this browser profile or run a permitted tool to check the account",
      409,
    );
  const policy = await catalog.authorizeApi(id, connection.verification.tool, context.agent);
  const verification = registry.apiBinding(policy, context).verification!;
  const tool = registry.describe(verification.tool, context);
  return registry.execute(
    verification.tool,
    {
      ...verification.arguments,
      connection: id,
      idempotencyKey: context.requestId,
    },
    context,
    tool.version,
  );
}
