// Shared API execution policy. Provider adapters supply validated retrieval;
// this service owns authorization, retry identity, cancellation and accounting.
import { createHmac } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ApiLedger, executionMetadata, type ApiExecutionRecord } from "./api-ledger.js";
import { connectionPagination, type BrowserConnections } from "./connections.js";
import { connectionId, type ApiToolName } from "./connection-store.js";
import { OperationRunner, type Operation } from "./operations.js";
import { vault, type Vault } from "./vault.js";
import type { ToolContext } from "./toolkits/registry.js";
import { PublicError } from "../utils/public-error.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { assertAgentCurrent } from "./agent-access.js";

export interface ProviderReply<Data = unknown> {
  state: "succeeded" | "partial" | "failed";
  data: Data;
  estimatedCostMicros?: number;
  providerRequestId?: string;
}
export interface ApiAction {
  name: ApiToolName;
  provider: string;
  description: string;
  annotations?: Tool["annotations"];
  authorize?: (context: ToolContext) => boolean;
  input: z.ZodType<Record<string, unknown>>;
  reserveMicros: (args: Record<string, unknown>) => number;
  run: (
    args: Record<string, unknown>,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<ProviderReply>;
}
const retryKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const apiHistoryInput = connectionPagination.extend({
  connection: connectionId.refine((value) => value.startsWith("api:")),
});
const refusedCodes = new Set([
  "provider_auth_required",
  "provider_quota",
  "provider_rate_limited",
  "provider_rejected",
]);

export class ApiExecutor {
  readonly ledger: ApiLedger;
  private readonly runner = new OperationRunner(() => Date.now(), 64, 300_000);
  private readonly resources = new Map<string, object>();
  private readonly active = new Set<Pick<Operation<unknown>, "cancel" | "done">>();
  private closing = false;
  constructor(
    root: string,
    private readonly connections: BrowserConnections,
    private readonly credentials: Pick<Vault, "use"> = vault,
    private readonly signingKey = process.env.VAULT_KEY,
  ) {
    this.ledger = new ApiLedger(path.join(root, "api-executions.jsonl"));
  }
  private hash(value: unknown) {
    if (!this.signingKey || !/^[a-fA-F0-9]{64}$/.test(this.signingKey))
      throw new PublicError(
        "execution_locked",
        "Configure the worker vault key before using API tools",
        503,
      );
    return createHmac("sha256", Buffer.from(this.signingKey, "hex"))
      .update(JSON.stringify(value))
      .digest("hex");
  }
  async execute(action: ApiAction, input: unknown, context: ToolContext, version = "1.0.0") {
    if (this.closing)
      throw new PublicError("execution_unavailable", "API execution is shutting down", 503);
    const args = action.input.parse(input);
    const connection = connectionId.parse(args.connection);
    const token = retryKey.parse(args.idempotencyKey ?? context.requestId);
    const timeoutMs = z
      .number()
      .int()
      .min(1000)
      .max(60_000)
      .parse(args.timeoutMs ?? 30_000);
    context.signal.throwIfAborted();
    await assertAgentCurrent(context.agent);
    const policy = await this.connections.authorizeApi(connection, action.name, context.agent);
    if (policy.provider !== action.provider)
      throw new PublicError(
        "provider_mismatch",
        "This tool requires a different API provider",
        409,
      );
    const { idempotencyKey: _token, timeoutMs: _timeout, ...payload } = args;
    const key = this.hash([
      context.agent.connectedApp
        ? [
            context.agent.name,
            context.agent.connectedApp.orgId,
            context.agent.connectedApp.membershipId,
            context.agent.connectedApp.userId,
            context.agent.connectedApp.keyId,
          ]
        : context.agent.name,
      connection,
      action.name,
      token,
    ]);
    const binding = (value: typeof policy) => [
      value.provider,
      version,
      value.vault,
      value.credentialField,
      value.credentialScope,
      payload,
    ];
    const fingerprint = this.hash(binding(policy));
    const reserve = action.reserveMicros(args);
    if (!Number.isSafeInteger(reserve) || reserve < 0)
      throw new Error("Invalid API usage reservation");
    let resource = this.resources.get(connection);
    if (!resource) this.resources.set(connection, (resource = {}));
    let row: ApiExecutionRecord | undefined;
    let dispatched = false;
    const stopped = (code: string, message: string) =>
      new PublicError(
        code,
        message,
        408,
        row
          ? {
              execution: executionMetadata({
                ...row,
                state: dispatched ? "unknown" : "failed",
                accountedMicros: dispatched ? reserve : 0,
                costBasis: dispatched ? "reservation" : "no_request",
                errorCode: "execution_stopped",
                finishedAt: new Date().toISOString(),
              }),
            }
          : undefined,
      );
    const stopRecord = () =>
      row
        ? this.ledger.finish(key, {
            state: dispatched ? "unknown" : "failed",
            accountedMicros: dispatched ? reserve : 0,
            costBasis: dispatched ? "reservation" : "no_request",
            errorCode: "execution_stopped",
          })
        : undefined;
    let operation: Operation<{
      ok: boolean;
      execution: ReturnType<typeof executionMetadata>;
      data: unknown;
    }>;
    try {
      operation = this.runner.start(
        {
          key,
          fingerprint,
          resource,
          access: "exclusive",
          deadline: Date.now() + timeoutMs,
          timeoutError: () =>
            stopped(
              "execution_timeout",
              "API execution timed out; its provider outcome may be unknown",
            ),
          cancelError: () => stopped("execution_cancelled", "API execution was cancelled"),
          onStop: stopRecord,
        },
        async (current) => {
          try {
            // Admission may wait behind another call. Recheck grants and limits
            // after that wait, and refuse a changed credential binding.
            const admitted = await this.connections.authorizeApi(
              connection,
              action.name,
              context.agent,
            );
            await assertAgentCurrent(context.agent);
            context.assertAuthorized?.();
            if (fingerprint !== this.hash(binding(admitted)))
              throw new PublicError(
                "idempotency_conflict",
                "The API account binding changed while this call waited",
                409,
              );
            current.check();
            row = await this.ledger.reserve(
              {
                key,
                fingerprint,
                owner: context.agent.name,
                connection,
                tool: action.name,
                capabilityVersion: version,
                accountBinding: {
                  provider: admitted.provider,
                  credential: admitted.vault,
                  field: admitted.credentialField,
                  scope: admitted.credentialScope!,
                },
                ...(context.agent.connectedApp
                  ? {
                      connectedApp: {
                        orgId: context.agent.connectedApp.orgId,
                        membershipId: context.agent.connectedApp.membershipId,
                        userId: context.agent.connectedApp.userId,
                        keyId: context.agent.connectedApp.keyId,
                        oauthClientId: context.agent.connectedApp.oauthClientId,
                      },
                    }
                  : {}),
              },
              reserve,
              admitted,
            );
            current.check();
            const reply = await this.credentials.use(
              policy.vault,
              context.agent,
              async (fields) => {
                await assertAgentCurrent(context.agent);
                const apiKey = fields[policy.credentialField];
                if (!apiKey || /[\r\n\0]/.test(apiKey))
                  throw new PublicError(
                    "provider_auth_required",
                    "The configured API key field is unavailable",
                    401,
                  );
                current.markActed();
                dispatched = true;
                return current.wait(() => action.run(args, apiKey, current.signal));
              },
              policy.credentialScope ?? undefined,
            );
            current.check();
            row = await this.ledger.finish(key, {
              state: reply.state,
              accountedMicros: reply.estimatedCostMicros ?? reserve,
              costBasis:
                reply.estimatedCostMicros === undefined ? "reservation" : "provider_estimate",
              ...(reply.providerRequestId ? { providerRequestId: reply.providerRequestId } : {}),
              ...(reply.state === "failed" ? { errorCode: "content_unavailable" } : {}),
            });
            return {
              ok: reply.state !== "failed",
              execution: executionMetadata(row),
              data: reply.data,
            };
          } catch (error) {
            if (row)
              row = await this.ledger.finish(key, {
                state:
                  dispatched && !(error instanceof PublicError && refusedCodes.has(error.code))
                    ? "unknown"
                    : "failed",
                accountedMicros: dispatched ? reserve : 0,
                costBasis: dispatched ? "reservation" : "no_request",
                errorCode: error instanceof PublicError ? error.code : "execution_error",
              });
            if (error instanceof PublicError && row)
              throw new PublicError(error.code, error.message, error.statusCode, {
                execution: executionMetadata(row),
              });
            throw error;
          }
        },
      );
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 409)
        throw new PublicError(
          "idempotency_conflict",
          "Retry key was used with different arguments or account binding",
          409,
        );
      if ((error as { statusCode?: number }).statusCode === 429)
        throw new PublicError(
          "execution_capacity",
          "API execution capacity is full; retry later",
          429,
        );
      throw error;
    }
    this.active.add(operation);
    void operation.done.then(() => this.active.delete(operation));
    const abort = () =>
      operation.cancel(stopped("execution_cancelled", "API execution was cancelled"));
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    try {
      return await operation.promise;
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }
  async history(input: unknown, context: ToolContext) {
    const args = apiHistoryInput.parse(input);
    const connection = await this.connections.get(args.connection, context.agent);
    if (connection.type !== "api")
      throw new PublicError("invalid_connection", "Select an API connection", 400);
    const usage = await this.ledger.history(
      args.connection,
      context.agent.name,
      !!context.agent.admin,
      args,
    );
    return {
      ...usage,
      limits: connection.limits,
      remainingCalls: Math.max(0, connection.limits.dailyCalls - usage.calls),
      remainingEstimatedUSD: Math.max(0, connection.limits.dailyBudgetUSD - usage.accountedUSD),
    };
  }
  async close() {
    this.closing = true;
    for (const operation of this.active)
      operation.cancel(
        new PublicError("execution_cancelled", "API execution is shutting down", 408),
      );
    await Promise.allSettled([...this.active].map((operation) => operation.done));
    await this.ledger.flush();
  }
}
