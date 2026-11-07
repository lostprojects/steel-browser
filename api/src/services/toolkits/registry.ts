// Registers trusted server-side toolkits. Discovery and execution share access
// checks; client arguments must never supply the authenticated execution context.
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Agent } from "../proxy/service.js";
import { PublicError } from "../../utils/public-error.js";
import { storeName } from "../shared-store.js";
import type { ApiConnectionSettings } from "../connection-store.js";
import { contentHash, workflowSummary, type Workflow } from "./workflows.js";
import {
  canUseContent,
  contentAccess,
  contentSummary,
  type ContentAccess,
} from "../content-access.js";

export const discoveryToolNames = ["tools_search", "tools_describe", "tools_execute"] as const;
const identifier = /^[a-z][a-z0-9_]{0,63}$/;

export interface ToolContext {
  readonly agent: Readonly<Agent>;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly assertAuthorized?: () => void;
}

export interface ToolkitTool<Context extends ToolContext = ToolContext> {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  annotations?: Tool["annotations"];
  keywords?: readonly string[];
  authorize?: (context: Context) => boolean;
  execute: (
    args: Record<string, unknown>,
    context: Context,
  ) => CallToolResult | Promise<CallToolResult>;
}

export interface Toolkit<Context extends ToolContext = ToolContext> {
  id: string;
  name: string;
  version: string;
  description: string;
  authentication: string;
  content?: ContentAccess;
  authorize?: (context: Context) => boolean;
  connection?: {
    type: "api_key";
    credentialFields: readonly string[];
    verification?: { tool: string; arguments: Record<string, unknown>; estimatedCostUSD: number };
  };
  tools: readonly ToolkitTool<Context>[];
  workflows?: readonly Workflow<Context>[];
}

export class ToolRegistryError extends PublicError {
  constructor(code: "tool_unavailable" | "version_mismatch", message: string) {
    super(code, message, code === "version_mismatch" ? 409 : 404);
  }
}

type Entry<Context extends ToolContext> = {
  toolkit: Toolkit<Context>;
  tool: ToolkitTool<Context>;
  definition: Tool;
};

export class ToolRegistry<Context extends ToolContext = ToolContext> {
  private readonly entries = new Map<string, Entry<Context>>();
  private readonly toolkits = new Map<string, Toolkit<Context>>();
  private readonly workflows = new Map<
    string,
    { toolkit: Toolkit<Context>; workflow: Workflow<Context> }
  >();
  private releaseHash?: string;

  constructor(toolkits: readonly Toolkit<Context>[]) {
    for (const toolkit of toolkits) this.register(toolkit);
  }

  register(toolkit: Toolkit<Context>) {
    if (toolkit.content !== undefined)
      toolkit = { ...toolkit, content: contentAccess.parse(toolkit.content) };
    if (
      !identifier.test(toolkit.id) ||
      !toolkit.name.trim() ||
      !toolkit.version.trim() ||
      !toolkit.description.trim() ||
      !toolkit.authentication.trim() ||
      this.toolkits.has(toolkit.id)
    )
      throw new Error(`Invalid or duplicate toolkit: ${toolkit.id}`);
    if (
      toolkit.connection &&
      (toolkit.connection.type !== "api_key" ||
        !toolkit.connection.credentialFields.length ||
        toolkit.connection.credentialFields.some((field) => !storeName.safeParse(field).success))
    )
      throw new Error(`Invalid credential contract: ${toolkit.id}`);
    const names = new Set<string>();
    const entries = toolkit.tools.map((tool): Entry<Context> => {
      if (
        !identifier.test(tool.name) ||
        discoveryToolNames.some((name) => name === tool.name) ||
        this.entries.has(tool.name) ||
        names.has(tool.name) ||
        !tool.description.trim() ||
        typeof tool.execute !== "function"
      )
        throw new Error(`Invalid, reserved or duplicate tool: ${tool.name}`);
      names.add(tool.name);
      const inputSchema = z.toJSONSchema(tool.input, {
        target: "draft-07",
        io: "input",
        reused: "ref",
      });
      if (inputSchema.type !== "object")
        throw new Error(`Tool input must be an object: ${tool.name}`);
      return {
        toolkit,
        tool,
        definition: {
          name: tool.name,
          description: tool.description,
          inputSchema: inputSchema as Tool["inputSchema"],
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        },
      };
    });
    const verification = toolkit.connection?.verification;
    if (
      verification &&
      (!Number.isFinite(verification.estimatedCostUSD) ||
        verification.estimatedCostUSD < 0 ||
        !entries.some(
          (entry) =>
            entry.tool.name === verification.tool &&
            entry.tool.input.safeParse({
              ...verification.arguments,
              connection: "api:verification",
            }).success,
        ))
    )
      throw new Error(`Invalid verification operation: ${toolkit.id}`);
    const workflowIds = new Set<string>();
    for (const workflow of toolkit.workflows ?? []) {
      if (
        !identifier.test(workflow.id) ||
        this.workflows.has(workflow.id) ||
        workflowIds.has(workflow.id) ||
        !workflow.name.trim() ||
        !workflow.version.trim() ||
        !workflow.description.trim() ||
        !workflow.instructions.trim() ||
        Buffer.byteLength(workflow.instructions) > 256_000 ||
        !workflow.dependencies.length ||
        !workflow.outputs.length ||
        !workflow.checks.length ||
        !Number.isSafeInteger(workflow.policy.maxDurationMs) ||
        workflow.policy.maxDurationMs < 1 ||
        !workflow.policy.retry.trim() ||
        !workflow.policy.cancellation.trim() ||
        new Set(workflow.references.map((reference) => reference.id)).size !==
          workflow.references.length ||
        workflow.references.some(
          (reference) =>
            !identifier.test(reference.id) ||
            !reference.title.trim() ||
            Buffer.byteLength(reference.content) > 1_000_000,
        ) ||
        z.toJSONSchema(workflow.input, { target: "draft-07", io: "input" }).type !== "object"
      )
        throw new Error(`Invalid or duplicate workflow: ${workflow.id}`);
      workflowIds.add(workflow.id);
    }
    this.toolkits.set(toolkit.id, toolkit);
    for (const entry of entries) this.entries.set(entry.tool.name, entry);
    for (const workflow of toolkit.workflows ?? [])
      this.workflows.set(workflow.id, { toolkit, workflow });
    this.releaseHash = undefined;
  }

  private allowed(entry: Entry<Context>, context: Context) {
    try {
      return (
        canUseContent(entry.toolkit.content, context) &&
        (!entry.toolkit.authorize || entry.toolkit.authorize(context) === true) &&
        (!entry.tool.authorize || entry.tool.authorize(context) === true)
      );
    } catch {
      // A broken policy denies access. Its exception must not escape through
      // tools/list, where the MCP SDK would publish the exception's message.
      return false;
    }
  }

  private visible(context: Context) {
    return [...this.entries.values()]
      .filter((entry) => this.allowed(entry, context))
      .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
  }

  private resolve(name: string, context: Context) {
    const entry = this.entries.get(name);
    if (!entry || !this.allowed(entry, context))
      throw new ToolRegistryError("tool_unavailable", "Tool is unavailable for this key");
    return entry;
  }

  private describeEntry(entry: Entry<Context>) {
    return {
      ...entry.definition,
      toolkit: entry.toolkit.id,
      version: entry.toolkit.version,
      authentication: entry.toolkit.authentication,
      ...(entry.toolkit.content ? { content: contentSummary(entry.toolkit.content) } : {}),
    };
  }

  list(context: Context): Tool[] {
    return this.visible(context).map((entry) => entry.definition);
  }

  catalog(context: Context) {
    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        version: string;
        description: string;
        authentication: string;
        content?: ReturnType<typeof contentSummary>;
        connection: { type: "api_key"; credentialFields: readonly string[] } | null;
        tools: ReturnType<ToolRegistry<Context>["describeEntry"]>[];
        workflows: ReturnType<typeof workflowSummary>[];
      }
    >();
    const group = (toolkit: Toolkit<Context>) => {
      let item = grouped.get(toolkit.id);
      if (!item) {
        item = {
          id: toolkit.id,
          name: toolkit.name,
          version: toolkit.version,
          description: toolkit.description,
          authentication: toolkit.authentication,
          ...(toolkit.content ? { content: contentSummary(toolkit.content) } : {}),
          connection: toolkit.connection
            ? {
                type: toolkit.connection.type,
                credentialFields: toolkit.connection.credentialFields,
              }
            : null,
          tools: [],
          workflows: [],
        };
        grouped.set(toolkit.id, item);
      }
      return item;
    };
    for (const entry of this.visible(context))
      group(entry.toolkit).tools.push(this.describeEntry(entry));
    for (const summary of this.listWorkflows(context).workflows)
      group(this.workflows.get(summary.id)!.toolkit).workflows.push(summary);
    return {
      release: this.release,
      toolkits: [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  get release() {
    return (this.releaseHash ??= contentHash(
      JSON.stringify({
        tools: [...this.entries.values()]
          .map((entry) => this.describeEntry(entry))
          .sort((a, b) => a.name.localeCompare(b.name)),
        workflows: [...this.workflows.values()]
          .map(({ toolkit, workflow }) => workflowSummary(workflow, toolkit.id))
          .sort((a, b) => a.id.localeCompare(b.id)),
        content: [...this.toolkits.values()]
          .map((toolkit) => ({ toolkit: toolkit.id, access: toolkit.content }))
          .sort((a, b) => a.toolkit.localeCompare(b.toolkit)),
      }),
    ));
  }

  private resolveWorkflow(id: string, context: Context, version?: string) {
    const entry = this.workflows.get(id);
    try {
      if (
        !entry ||
        !canUseContent(entry.toolkit.content, context) ||
        (entry.toolkit.authorize && entry.toolkit.authorize(context) !== true) ||
        (entry.workflow.authorize && entry.workflow.authorize(context) !== true)
      )
        throw new Error();
      for (const dependency of entry.workflow.dependencies) {
        const tool = this.resolve(dependency.tool, context);
        if (tool.toolkit.version !== dependency.version) throw new Error();
      }
    } catch {
      throw new PublicError(
        "workflow_unavailable",
        "Workflow is unavailable for this key or release",
        404,
      );
    }
    if (version !== undefined && entry.workflow.version !== version)
      throw new PublicError(
        "version_mismatch",
        "Workflow version changed; fetch its instructions again",
        409,
      );
    return entry;
  }

  listWorkflows(context: Context) {
    const workflows: ReturnType<typeof workflowSummary>[] = [];
    for (const [id] of this.workflows) {
      try {
        const entry = this.resolveWorkflow(id, context);
        workflows.push({
          ...workflowSummary(entry.workflow, entry.toolkit.id),
          ...(entry.toolkit.content ? { content: contentSummary(entry.toolkit.content) } : {}),
        });
      } catch (error) {
        if (!(error instanceof PublicError && error.code === "workflow_unavailable")) throw error;
      }
    }
    return {
      release: this.release,
      workflows: workflows.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  getWorkflow(id: string, context: Context, version?: string) {
    const { toolkit, workflow } = this.resolveWorkflow(id, context, version);
    return {
      release: this.release,
      ...workflowSummary(workflow, toolkit.id),
      ...(toolkit.content ? { content: contentSummary(toolkit.content) } : {}),
      inputSchema: z.toJSONSchema(workflow.input, { target: "draft-07", io: "input" }),
      instructions: workflow.instructions,
      outputs: workflow.outputs,
      checks: workflow.checks,
    };
  }

  workflowReference(id: string, referenceId: string, version: string, context: Context) {
    const { workflow } = this.resolveWorkflow(id, context, version);
    const reference = workflow.references.find((item) => item.id === referenceId);
    if (!reference) throw new PublicError("reference_unavailable", "Reference is unavailable", 404);
    return {
      workflow: id,
      version: workflow.version,
      ...reference,
      bytes: Buffer.byteLength(reference.content),
      sha256: contentHash(reference.content),
    };
  }

  apiTools(provider: string, context: Context) {
    return this.visible(context)
      .filter((entry) => entry.toolkit.id === provider && entry.toolkit.connection)
      .map((entry) => entry.tool.name);
  }
  apiBinding(settings: ApiConnectionSettings, context: Context, requestedTool?: string) {
    const entries = settings.allowedTools.map((name) => this.entries.get(name));
    const toolkit = entries[0]?.toolkit;
    if (
      !toolkit?.connection ||
      toolkit.id !== settings.provider ||
      !toolkit.connection.credentialFields.includes(settings.credentialField) ||
      entries.some((entry) => entry?.toolkit.id !== toolkit.id)
    )
      throw new PublicError(
        "invalid_connection",
        "Select tools and a credential field from the registered API toolkit",
        400,
      );
    if (requestedTool) this.resolve(requestedTool, context);
    else if (!entries.some((entry) => entry && this.allowed(entry, context)))
      throw new ToolRegistryError("tool_unavailable", "API toolkit is unavailable for this key");
    return toolkit.connection;
  }

  describe(name: string, context: Context) {
    return this.describeEntry(this.resolve(name, context));
  }

  search(
    options: { query: string; toolkit?: string; limit: number; offset: number },
    context: Context,
  ) {
    const tokens = [...new Set(options.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
    const ranked = this.visible(context)
      .filter((entry) => !options.toolkit || entry.toolkit.id === options.toolkit)
      .map((entry) => {
        const name = entry.tool.name.toLowerCase();
        const toolkit = `${entry.toolkit.id} ${entry.toolkit.name}`.toLowerCase();
        const keywords = (entry.tool.keywords ?? []).join(" ").toLowerCase();
        const description = entry.tool.description.toLowerCase();
        const score = tokens.reduce(
          (sum, token) =>
            sum +
            (name.includes(token) ? 8 : 0) +
            (keywords.includes(token) ? 4 : 0) +
            (toolkit.includes(token) ? 2 : 0) +
            (description.includes(token) ? 1 : 0),
          0,
        );
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.tool.name.localeCompare(b.entry.tool.name));
    const end = options.offset + options.limit;
    return {
      query: options.query,
      total: ranked.length,
      offset: options.offset,
      nextOffset: end < ranked.length ? end : null,
      tools: ranked.slice(options.offset, end).map(({ entry }) => this.describeEntry(entry)),
    };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: Context,
    version?: string,
  ): Promise<CallToolResult> {
    const entry = this.resolve(name, context);
    if (version !== undefined && version !== entry.toolkit.version)
      throw new ToolRegistryError("version_mismatch", "Tool version changed; describe it again");
    const input = entry.tool.input.parse(args);
    context.signal.throwIfAborted();
    return entry.tool.execute(input, {
      ...context,
      assertAuthorized: () => {
        this.resolve(name, context);
      },
    });
  }
}
