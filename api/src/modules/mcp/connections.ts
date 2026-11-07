import { z } from "zod";
import { connectionPagination, type BrowserConnections } from "../../services/connections.js";
import { connectionConfigureInput, connectionId } from "../../services/connection-store.js";
import type { Toolkit } from "../../services/toolkits/registry.js";
import { textResult } from "./tools.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../../services/toolkits/registry.js";

export function connectionToolkit(
  catalog: () => BrowserConnections,
  verify?: (id: string, context: ToolContext) => Promise<CallToolResult>,
): Toolkit {
  return {
    id: "connections",
    name: "Toolstack Connections",
    version: "1.2.0",
    description: "Discover private browser and API accounts and manage their access",
    authentication:
      "Uses your Toolstack key; passwords, cookies and tokens stay in the existing stores.",
    tools: [
      ...(verify
        ? [
            {
              name: "connections_verify",
              description:
                "Check an API account using its declared bounded verification operation. Read the connection's verification estimate first; verification consumes its normal call and spend allowance. Results retain their original acquisition time on retry. Browser profiles require their supported browser login checks or manual inspection.",
              input: z.object({ id: connectionId }).strict(),
              annotations: { readOnlyHint: true, openWorldHint: true },
              execute: (args: Record<string, unknown>, context: ToolContext) =>
                verify(args.id as string, context),
            },
          ]
        : []),
      {
        name: "connections_list",
        description:
          "List accounts available to your key from saved browser profiles, configured API connections and permitted vault entries. Returns metadata only. last_verified describes a past observation; saved cookies do not establish a current login. Pass browser IDs to browser_open and API IDs to the matching provider tool. Continue with nextOffset as offset.",
        input: connectionPagination,
        annotations: { readOnlyHint: true, openWorldHint: false },
        execute: async (args, context) => textResult(await catalog().page(context.agent, args)),
      },
      {
        name: "connections_get",
        description:
          "Read one permitted connection's metadata, site mappings, profile availability and last recorded authentication status. Does not launch a browser or verify a live login.",
        input: z.object({ id: connectionId }).strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
        execute: async (args, context) =>
          textResult(await catalog().get(args.id as string, context.agent)),
      },
      {
        name: "connections_access",
        description:
          "Enable, disable or disconnect a permitted account binding. Admin only. Disconnect prevents new use and preserves credentials, saved profiles and provider-issued sessions. Delete credentials, delete profiles and revoke provider access through their separate operations. Running work may already have acted.",
        input: z
          .object({ id: connectionId, action: z.enum(["enable", "disable", "disconnect"]) })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        authorize: (context) => !!context.agent.admin,
        execute: async (args, context) =>
          textResult(
            await catalog().access(
              args.id as string,
              args.action === "enable",
              args.action === "disconnect",
              context.agent,
            ),
          ),
      },
      {
        name: "connections_configure",
        description:
          "Configure a browser profile or a vault-backed API connection. Requires an admin key. Browser labels, sites and grants update in place. API IDs require the full api binding and allowedAgents; omitted grants default to admin. API bindings specify provider, vault, credentialField, allowedTools, dailyCalls, dailyBudgetUSD and enabled. Credentials stay in the vault. Existing browser sessions remain open.",
        input: connectionConfigureInput.extend({ id: connectionId }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        authorize: (context) => !!context.agent.admin,
        execute: async (args, context) => {
          const { id, ...input } = args;
          return textResult(await catalog().configure(id as string, input, context.agent));
        },
      },
    ],
  };
}
