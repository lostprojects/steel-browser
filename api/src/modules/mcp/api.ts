import { ApiExecutor, apiHistoryInput } from "../../services/api-execution.js";
import type { Toolkit } from "../../services/toolkits/registry.js";
import { textResult } from "./tools.js";

export function apiToolkit(executor: () => ApiExecutor): Toolkit {
  return {
    id: "api",
    name: "Toolstack API Usage",
    version: "1.0.0",
    description: "Connection allowances and private API execution history",
    authentication: "Uses your Toolstack key and connection permissions.",
    tools: [
      {
        name: "api_usage",
        description:
          "Read daily usage and seven days of execution metadata for a permitted API connection. Daily totals cover all agents sharing the connection; history is restricted to your executions unless you are admin. Amounts are provider estimates or conservative reservations, not invoices. Search queries, fetched text and credentials are excluded.",
        input: apiHistoryInput,
        annotations: { readOnlyHint: true, openWorldHint: false },
        execute: async (args, context) => textResult(await executor().history(args, context)),
      },
    ],
  };
}
