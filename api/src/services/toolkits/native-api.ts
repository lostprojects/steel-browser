// Trusted adapters declare credentials, schemas and provider work here. The
// shared executor owns admission, accounting and replay protection for each one.
import type { ApiAction, ApiExecutor } from "../api-execution.js";
import type { Toolkit } from "./registry.js";

export interface NativeApiToolkit extends Omit<Toolkit, "tools" | "connection"> {
  credentialFields: readonly string[];
  actions: readonly ApiAction[];
  verification?: { tool: string; arguments: Record<string, unknown>; estimatedCostUSD: number };
}

export function nativeApiToolkit(
  definition: NativeApiToolkit,
  executor: () => ApiExecutor,
): Toolkit {
  const { actions, credentialFields, verification, ...metadata } = definition;
  if (actions.some((action) => action.provider !== definition.id))
    throw new Error("API actions must belong to their declared toolkit");
  return {
    ...metadata,
    connection: { type: "api_key", credentialFields, verification },
    tools: actions.map((action) => ({
      name: action.name,
      description: action.description,
      input: action.input,
      annotations: action.annotations,
      authorize: action.authorize,
      execute: async (args, context) => {
        const result = await executor().execute(action, args, context, definition.version);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
      },
    })),
  };
}
