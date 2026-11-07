import { z } from "zod";
import type { Toolkit, ToolRegistry } from "../../services/toolkits/registry.js";
import { textResult } from "./tools.js";

const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const version = z.string().min(1).max(100);
export function workflowToolkit(catalog: () => ToolRegistry): Toolkit {
  return {
    id: "workflows",
    name: "Working methods",
    version: "1.0.0",
    description: "Versioned instructions and permitted reference material for your capabilities",
    authentication: "Uses your Toolstack key and the permissions of each required tool.",
    tools: [
      {
        name: "workflows_list",
        description:
          "List available workflows and their exact tool dependencies, authority, outputs and reference hashes. Fetch instructions with workflows_get before using a workflow.",
        input: z.object({}).strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
        execute: (_args, context) => textResult(catalog().listWorkflows(context)),
      },
      {
        name: "workflows_get",
        description:
          "Fetch the instructions, input schema, checks and execution policy for a permitted workflow. Supply version to require an exact release. This reads the method; it does not execute its tools or grant authority to act.",
        input: z.object({ id, version: version.optional() }).strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
        execute: (args, context) =>
          textResult(
            catalog().getWorkflow(args.id as string, context, args.version as string | undefined),
          ),
      },
      {
        name: "workflows_reference",
        description:
          "Fetch one declared reference from an exact workflow version. IDs come from workflows_get; filesystem paths and arbitrary URLs are not accepted. Validate its returned SHA-256 against the workflow manifest.",
        input: z.object({ id, reference: id, version }).strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
        execute: (args, context) =>
          textResult(
            catalog().workflowReference(
              args.id as string,
              args.reference as string,
              args.version as string,
              context,
            ),
          ),
      },
    ],
  };
}
