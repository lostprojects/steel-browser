// Discovery is a view of the same registry used by direct MCP calls. Generic
// execution cannot bypass authorization or execute another discovery operation.
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolRegistry, type ToolContext } from "../../services/toolkits/registry.js";
import { textResult } from "./tools.js";
import { scrubToolMetadata, scrubToolResult } from "./output.js";
import { PublicError } from "../../utils/public-error.js";

const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const schemas = {
  tools_search: z
    .object({
      query: z.string().trim().min(1).max(500),
      toolkit: name.optional(),
      limit: z.number().int().min(1).max(20).default(5),
      offset: z.number().int().min(0).max(100_000).default(0),
    })
    .strict(),
  tools_describe: z.object({ name }).strict(),
  tools_execute: z
    .object({
      name,
      arguments: z.record(z.string(), z.unknown()).default({}),
      version: z.string().min(1).max(100).optional(),
    })
    .strict(),
};
const descriptions = {
  tools_search:
    "Find tools available to your key by keywords, optionally within a toolkit. Returns versioned input schemas and authentication requirements. Continue with nextOffset as offset. Search uses local keyword matching.",
  tools_describe:
    "Get a tool's exact input schema, toolkit version and authentication requirements. Tool availability is checked for your authenticated key.",
  tools_execute:
    "Execute one registered tool with its arguments and optional toolkit version. Uses the same validation, permissions and result as calling the tool directly, including images, files, partial failures and running operations. Preserve the target tool's retry keys and recovery tokens. Cannot call discovery tools.",
};
export const discoveryDefinitions: Tool[] = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof schemas],
  inputSchema: z.toJSONSchema(schema, { target: "draft-07", io: "input" }) as Tool["inputSchema"],
  annotations: {
    readOnlyHint: name !== "tools_execute",
    destructiveHint: name === "tools_execute",
    openWorldHint: name === "tools_execute",
  },
}));

function discoveryResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(scrubToolMetadata(value)) }] };
}

export function toolError(error: unknown): CallToolResult {
  if (error instanceof PublicError)
    return textResult(
      {
        error: { code: error.code, message: error.message },
        statusCode: error.statusCode,
        ...(error.details ? { details: error.details } : {}),
      },
      true,
    );
  const invalid = error instanceof z.ZodError;
  return textResult(
    {
      error: {
        code: invalid ? "invalid_request" : "tool_error",
        message: invalid
          ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
          : "Tool execution failed",
      },
      statusCode: invalid ? 400 : 500,
    },
    true,
  );
}

export async function callRegisteredTool<Context extends ToolContext>(
  registry: ToolRegistry<Context>,
  tool: string,
  args: Record<string, unknown>,
  context: Context,
): Promise<CallToolResult> {
  try {
    if (tool === "tools_search")
      return discoveryResult(registry.search(schemas.tools_search.parse(args), context));
    if (tool === "tools_describe")
      return discoveryResult(registry.describe(schemas.tools_describe.parse(args).name, context));
    if (tool === "tools_execute") {
      const parsed = schemas.tools_execute.parse(args);
      return scrubToolResult(
        await registry.execute(parsed.name, parsed.arguments, context, parsed.version),
      );
    }
    return scrubToolResult(await registry.execute(tool, args, context));
  } catch (error) {
    return toolError(error);
  }
}
