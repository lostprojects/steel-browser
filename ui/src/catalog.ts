// Public metadata only. Credentials and provider response bodies stay out of
// browser storage; request state is held in memory for the current page.
import { request } from "./api";

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
};
export type Tool = {
  name: string;
  description: string;
  toolkit: string;
  version: string;
  authentication: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
};
export type Toolkit = {
  id: string;
  name: string;
  version: string;
  description: string;
  authentication: string;
  content?: { id: string; owner: string; visibility: "private" | "assigned" | "global" };
  connection: { type: "api_key"; credentialFields: string[] } | null;
  tools: Tool[];
  workflows?: WorkflowSummary[];
};
export type WorkflowSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  toolkit: string;
  dependencies: { tool: string; version: string }[];
  references: { id: string; title: string; bytes: number; sha256: string }[];
  policy: { authority: string; runtime: string; retry: string; cancellation: string };
};
export type Workflow = WorkflowSummary & {
  instructions: string;
  outputs: string[];
  checks: string[];
};
export type Connection = {
  id: string;
  type: "browser" | "api" | "vault";
  toolkit: string | null;
  label: string;
  status: string;
  scope?: "personal" | "global";
  identity?: string;
  defaultSite?: string | null;
  profileSaved?: boolean;
  busy?: boolean;
  credential?: { name: string; scope: "personal" | "global" | null; available: boolean } | null;
  observations?: { site: string; status: string; observedAt: string }[];
  allowedTools?: string[];
  limits?: { dailyCalls: number; dailyBudgetUSD: number };
  verification?: { tool: string; estimatedCostUSD: number } | null;
  permissions: {
    canUse: boolean;
    canConfigure: boolean;
    canVerify?: boolean;
    allowedAgents?: string[];
  };
};
export type ConnectionPage = {
  connections: Connection[];
  total: number;
  nextOffset: number | null;
  sharedStoreAvailable: boolean;
};
export type ToolResult = {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
  }>;
  isError?: boolean;
};
export type Execution = {
  id: string;
  owner: string;
  connection: string;
  tool: string;
  capabilityVersion?: string;
  state: string;
  startedAt: string;
  finishedAt?: string;
  accountedMicros: number;
  costBasis: string;
  errorCode?: string;
};
export type Activity = {
  executions: Execution[];
  total: number;
  nextOffset: number | null;
  sessions: Array<{
    id: string;
    status: string;
    identity?: string;
    site?: string;
    mode?: string;
    createdAt?: string;
    endReason?: string;
  }>;
};
export type Usage = {
  day: string;
  calls: number;
  accountedUSD: number;
  limits: { dailyCalls: number; dailyBudgetUSD: number };
  remainingCalls: number;
  remainingEstimatedUSD: number;
};

export const getCatalog = (signal: AbortSignal) =>
  request<{ toolkits: Toolkit[] }>("/v1/toolkits", { signal });
export const getWorkflow = (workflow: WorkflowSummary, signal: AbortSignal) =>
  request<Workflow>(
    `/v1/workflows/${encodeURIComponent(workflow.id)}?version=${encodeURIComponent(workflow.version)}`,
    { signal },
  );
export const getWorkflowReference = (workflow: WorkflowSummary, id: string, signal: AbortSignal) =>
  request<{ content: string; sha256: string }>(
    `/v1/workflows/${encodeURIComponent(workflow.id)}/references/${encodeURIComponent(id)}?version=${encodeURIComponent(workflow.version)}`,
    { signal },
  );
export const verifyAccount = (id: string, retryKey: string) =>
  request<ToolResult>(`/v1/connections/${encodeURIComponent(id)}/verify`, {
    method: "POST",
    headers: { "idempotency-key": retryKey },
  });
export async function getConnections(signal: AbortSignal) {
  const connections: Connection[] = [];
  let offset: number | null = 0;
  let sharedStoreAvailable = true;
  do {
    const page: ConnectionPage = await request(`/v1/connections?limit=100&offset=${offset}`, {
      signal,
    });
    connections.push(...page.connections);
    sharedStoreAvailable &&= page.sharedStoreAvailable;
    offset = page.nextOffset;
  } while (offset !== null);
  return { connections, sharedStoreAvailable };
}
export const runTool = (tool: Tool, args: Record<string, unknown>, signal: AbortSignal) =>
  request<ToolResult>(`/v1/tools/${encodeURIComponent(tool.name)}/execute`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: tool.version, arguments: args }),
  });
export const getUsage = (id: string, signal: AbortSignal) =>
  request<Usage>(`/v1/connections/${encodeURIComponent(id)}/usage?limit=1`, { signal });
export const getActivity = (offset: number, signal: AbortSignal) =>
  request<Activity>(`/v1/activity?limit=50&offset=${offset}`, { signal });
export const configureConnection = (id: string, body: unknown) =>
  request<Connection>(`/v1/connections/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
export const changeAccess = (id: string, action: "enable" | "disable" | "disconnect") =>
  request<Connection>(
    `/v1/connections/${encodeURIComponent(id)}${action === "disconnect" ? "" : "/access"}`,
    {
      method: action === "disconnect" ? "DELETE" : "POST",
      ...(action === "disconnect"
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: action === "enable" }),
          }),
    },
  );
export const putCredential = (name: string, field: string, value: string) =>
  request(`/v1/vault/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: { [field]: value }, allowedAgents: ["admin"] }),
  });
export function accountScope(connection: Connection) {
  const scope = connection.type === "vault" ? connection.scope : connection.credential?.scope;
  return scope === "global"
    ? "Shared account"
    : scope === "personal"
      ? "Personal account"
      : connection.type === "browser"
        ? "Private profile"
        : "No credential";
}
export function statusLabel(status: string) {
  return (
    (
      {
        last_verified: "Previously verified",
        unverified: "Not checked",
        needs_login: "Sign in needed",
        verification_required: "Verification needed",
        credential_missing: "Add credential",
        configured: "Configured",
        credentials_available: "Credential saved",
        unknown: "Outcome uncertain",
      } as Record<string, string>
    )[status] ?? status.replaceAll("_", " ")
  );
}
const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});
export const money = (amount: number) => currency.format(amount);
