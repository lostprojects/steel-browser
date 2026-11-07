// Workflow packages are trusted release content. Reference IDs select declared
// content only; neither paths nor arbitrary URLs are accepted from a caller.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { ToolContext } from "./registry.js";

export interface Workflow<Context extends ToolContext = ToolContext> {
  id: string;
  name: string;
  version: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  instructions: string;
  dependencies: readonly { tool: string; version: string }[];
  references: readonly {
    id: string;
    title: string;
    mediaType: "text/plain" | "text/markdown" | "application/json";
    content: string;
  }[];
  outputs: readonly string[];
  checks: readonly string[];
  policy: {
    runtime: "worker" | "compute";
    authority: "read" | "write";
    maxDurationMs: number;
    retry: string;
    cancellation: string;
  };
  authorize?: (context: Context) => boolean;
}
export const contentHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function workflowSummary(workflow: Workflow<any>, toolkit: string) {
  return {
    id: workflow.id,
    toolkit,
    name: workflow.name,
    version: workflow.version,
    description: workflow.description,
    instructionHash: contentHash(workflow.instructions),
    dependencies: workflow.dependencies,
    policy: workflow.policy,
    references: workflow.references.map(({ content, ...reference }) => ({
      ...reference,
      bytes: Buffer.byteLength(content),
      sha256: contentHash(content),
    })),
  };
}
