import { ExaClient } from "../exa.js";
import type { NativeApiToolkit } from "./native-api.js";

// The transport knows only this catalog. Additional integrations use the plugin's
// apiToolkits registration option and do not change core schemas or handlers.
export function builtInApiToolkits(): NativeApiToolkit[] {
  return [
    {
      id: "exa",
      name: "Exa Search",
      version: "1.1.0",
      description: "Web search and bounded source text through your own Exa account",
      authentication: "Select a permitted api: connection backed by the existing Toolstack vault.",
      credentialFields: ["apiKey"],
      verification: {
        tool: "exa_search",
        arguments: { query: "Toolstack connection check", mode: "lite", numResults: 1 },
        estimatedCostUSD: 0.01,
      },
      actions: new ExaClient().actions(),
    },
  ];
}
