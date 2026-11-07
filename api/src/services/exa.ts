// Exa retrieval only. Provider URLs are fixed, credentials stay in headers, and
// raw provider failures must not be copied into logs or public error messages.
import { z } from "zod";
import { apiActionInput } from "./toolkits/api-input.js";
export { apiConnectionId } from "./toolkits/api-input.js";
import { PublicError } from "../utils/public-error.js";
import type { ApiAction, ProviderReply } from "./api-execution.js";
import { providerJson } from "./provider-response.js";

const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "Use an HTTP URL without credentials");
const domain = z
  .string()
  .max(253)
  .regex(/^(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i);
export const exaSearchInput = z
  .object({
    ...apiActionInput.shape,
    query: z.string().trim().min(1).max(2000),
    mode: z.enum(["auto", "lite"]).default("auto"),
    numResults: z.number().int().min(1).max(10).default(5),
    includeDomains: z.array(domain).min(1).max(20).optional(),
    excludeDomains: z.array(domain).min(1).max(20).optional(),
    startPublishedDate: z.string().datetime({ offset: true }).optional(),
    endPublishedDate: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.startPublishedDate ||
      !value.endPublishedDate ||
      Date.parse(value.startPublishedDate) <= Date.parse(value.endPublishedDate),
    "Publication dates must be in order",
  );
export const exaContentsInput = z
  .object({
    ...apiActionInput.shape,
    urls: z
      .array(httpUrl)
      .min(1)
      .max(10)
      .refine((urls) => new Set(urls).size === urls.length, "Supply distinct URLs"),
    maxCharacters: z.number().int().min(100).max(20_000).default(4000),
  })
  .strict();
const resultSchema = z.object({
  id: z.string().max(2048).optional(),
  url: httpUrl,
  title: z.string().max(20_000).nullable().optional(),
  author: z.string().max(2000).nullable().optional(),
  publishedDate: z.string().max(100).nullable().optional(),
  text: z.string().optional(),
});
const responseSchema = z.object({
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  results: z.array(resultSchema).max(100),
  statuses: z
    .array(
      z.object({
        id: z.string().max(2048),
        status: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        error: z
          .object({
            tag: z
              .string()
              .regex(/^[A-Za-z0-9_-]{1,100}$/)
              .optional(),
            httpStatusCode: z.number().int().min(100).max(599).optional(),
          })
          .optional(),
      }),
    )
    .max(100)
    .optional(),
  costDollars: z.object({ total: z.number().finite().min(0).max(100) }).optional(),
});
export interface ExaData {
  acquiredAt: string;
  results: Array<{
    sourceId: string;
    id: string | null;
    url: string;
    title: string | null;
    author: string | null;
    publishedAt: string | null;
    text: string | null;
    textTruncated: boolean;
  }>;
  statuses: Array<{
    id: string;
    status: string;
    errorCode: string | null;
    httpStatusCode: number | null;
  }>;
  truncatedResults: boolean;
}

export class ExaClient {
  constructor(private readonly request: typeof fetch = globalThis.fetch) {}
  private async call(
    endpoint: "search" | "contents",
    payload: Record<string, unknown>,
    apiKey: string,
    signal: AbortSignal,
    limit: number,
    textLimit: number,
  ): Promise<ProviderReply<ExaData>> {
    let response: Response;
    try {
      response = await this.request(`https://api.exa.ai/${endpoint}`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new PublicError("provider_unavailable", "Exa did not return a response", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new PublicError(
          "provider_auth_required",
          "Exa rejected this connection's credentials",
          401,
        );
      if (response.status === 402)
        throw new PublicError("provider_quota", "Exa credits are exhausted", 402);
      if (response.status === 429)
        throw new PublicError(
          "provider_rate_limited",
          "Exa refused the request because of its rate limit; retry later with a new operation key",
          429,
        );
      if (response.status >= 500)
        throw new PublicError("provider_unavailable", "Exa is temporarily unavailable", 503);
      throw new PublicError("provider_rejected", "Exa rejected these request parameters", 400);
    }
    const value = await providerJson(response, responseSchema, "Exa");
    const statuses = (value.statuses ?? []).map((row) => ({
      id: row.id,
      status: row.status,
      errorCode: row.error?.tag ?? null,
      httpStatusCode: row.error?.httpStatusCode ?? null,
    }));
    const results = value.results.slice(0, limit).map((row) => ({
      sourceId: row.id ?? row.url,
      id: row.id ?? null,
      url: row.url,
      title: row.title ?? null,
      author: row.author ?? null,
      publishedAt: row.publishedDate ?? null,
      text: row.text === undefined ? null : row.text.slice(0, textLimit),
      textTruncated: (row.text?.length ?? 0) > textLimit,
    }));
    const failed = statuses.some((row) => row.status !== "success");
    const state =
      endpoint === "contents" && !results.length
        ? "failed"
        : failed || (endpoint === "contents" && results.length < limit)
          ? "partial"
          : "succeeded";
    return {
      state,
      data: {
        acquiredAt: new Date().toISOString(),
        results,
        statuses,
        truncatedResults: value.results.length > limit,
      },
      ...(value.costDollars
        ? { estimatedCostMicros: Math.ceil(value.costDollars.total * 1_000_000) }
        : {}),
      ...(value.requestId ? { providerRequestId: value.requestId } : {}),
    };
  }
  actions(): ApiAction[] {
    return [
      {
        name: "exa_search",
        provider: "exa",
        annotations: { readOnlyHint: true, openWorldHint: true },
        input: exaSearchInput,
        description:
          "Search public web sources through a permitted Exa API connection. Returns retrieval results without synthesized answers. Choose auto or lite, up to ten results. Supply idempotencyKey and reuse it on transport retry. Usage is reserved before provider work; unknown outcomes are not replayed. Search text stays out of durable history.",
        reserveMicros: () => 10_000,
        run: (args, key, signal) => {
          const {
            connection: _connection,
            idempotencyKey: _key,
            timeoutMs: _timeout,
            mode,
            ...payload
          } = exaSearchInput.parse(args);
          return this.call(
            "search",
            { ...payload, type: mode },
            key,
            signal,
            payload.numResults,
            0,
          );
        },
      },
      {
        name: "exa_contents",
        provider: "exa",
        annotations: { readOnlyHint: true, openWorldHint: true },
        input: exaContentsInput,
        description:
          "Retrieve bounded text for up to ten public HTTP URLs using an Exa API connection. Saved browser authentication is not sent. Returns per-URL failures and text-truncation flags. Supply idempotencyKey and reuse it on transport retry. Limits and account permissions apply before provider work.",
        reserveMicros: (args) => exaContentsInput.parse(args).urls.length * 2000,
        run: (args, key, signal) => {
          const input = exaContentsInput.parse(args);
          return this.call(
            "contents",
            {
              urls: input.urls,
              text: { maxCharacters: input.maxCharacters },
              highlights: false,
              summary: false,
            },
            key,
            signal,
            input.urls.length,
            input.maxCharacters,
          );
        },
      },
    ];
  }
}
