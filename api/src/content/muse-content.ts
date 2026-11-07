// A bounded read adapter for the existing Muse admin API. No SQL, guest records,
// writes or arbitrary destinations are part of this shared capability.
import { z } from "zod";
import { apiActionInput } from "../services/toolkits/api-input.js";
import type { NativeApiToolkit } from "../services/toolkits/native-api.js";
import { providerJson } from "../services/provider-response.js";
import { PublicError } from "../utils/public-error.js";
import { contentAccess } from "../services/content-access.js";

const documentKey = z
  .string()
  .regex(/^(?:page:[a-z0-9][a-z0-9-]{0,99}|site-settings|business|footer)$/);
const documentSummary = z.object({
  key: documentKey,
  version: z.number().int().positive(),
  title: z.string().max(2000).nullable().optional(),
  deleted: z.boolean().optional(),
});
const document = z.object({
  key: documentKey,
  version: z.number().int().positive(),
  value: z.json(),
  deleted: z.boolean().optional(),
});
const listInput = apiActionInput;
const getInput = apiActionInput.extend({ key: documentKey });
const instructions = `Use the selected Muse API connection for every read in this review.
1. Read the requested page with muse_document. Read business and site-settings when the review concerns venue details or navigation. Use muse_documents to resolve unknown page names.
2. Compare the requested wording or question against these current versions. Cite each document key, version and exact field path. A blank field is missing information; it does not authorize an invented opening time, contact address or service.
3. Return a compact review with the current wording, the proposed correction when requested, and the evidence for each suggestion. Identify any conflicting document versions or unresolved facts.
4. Re-read affected documents before handing off a proposed publication. If a version changed, reconcile it explicitly. Deliver the review to the requesting person. Publication requires a separately authorized operation and its version check.
On interruption, keep the same idempotencyKey to recover an existing read. Use a new key for an intentional fresh snapshot. Credential refusal requires reconnecting the intended account; do not switch to another account silently.`;

export function museContentToolkit(
  owner: string,
  request: typeof fetch = globalThis.fetch,
): NativeApiToolkit {
  const read = async <T>(
    key: string | undefined,
    credential: string,
    signal: AbortSignal,
    schema: z.ZodType<T>,
  ) => {
    const source = new URL("/admin/api/document", "https://musehotel.co");
    if (key) source.searchParams.set("key", key);
    let response: Response;
    try {
      response = await request(source, {
        headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
        redirect: "manual",
        signal,
      });
    } catch {
      throw new PublicError(
        "provider_unavailable",
        "The Muse content service did not return a response",
        503,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status))
        throw new PublicError(
          "provider_auth_required",
          "Reconnect the permitted Muse content account",
          401,
        );
      if (response.status === 404)
        throw new PublicError(
          "provider_rejected",
          "The requested Muse document is unavailable",
          404,
        );
      if (response.status === 429)
        throw new PublicError(
          "provider_rate_limited",
          "The Muse content service is busy; retry later",
          429,
        );
      throw new PublicError("provider_unavailable", "The Muse content service is unavailable", 503);
    }
    return {
      value: await providerJson(response, schema, "The Muse", 2_000_000),
      acquiredAt: new Date().toISOString(),
      sourceUrl: source.href,
    };
  };
  return {
    id: "muse",
    content: contentAccess.parse({ id: "muse-content", owner }),
    name: "The Muse content",
    version: "1.0.0",
    description: "Current website pages and venue settings through the established content API",
    authentication:
      "Select a permitted Muse admin API token stored in the Toolstack vault. This toolkit exposes bounded reads only.",
    credentialFields: ["apiKey"],
    verification: { tool: "muse_documents", arguments: {}, estimatedCostUSD: 0 },
    actions: [
      {
        name: "muse_documents",
        provider: "muse",
        description:
          "List current Muse website documents and their versions. A validated empty list is returned as success. Includes a source identifier and acquisition time; no guest data is read.",
        input: listInput,
        reserveMicros: () => 0,
        annotations: { readOnlyHint: true, openWorldHint: true },
        run: async (_args, credential, signal) => {
          const result = await read(
            undefined,
            credential,
            signal,
            z.object({ documents: z.array(documentSummary).max(1000) }),
          );
          return {
            state: "succeeded",
            estimatedCostMicros: 0,
            data: {
              sourceId: "muse:documents",
              sourceUrl: result.sourceUrl,
              acquiredAt: result.acquiredAt,
              documents: result.value.documents
                .filter((row) => !row.deleted)
                .map(({ deleted: _deleted, ...row }) => row),
            },
          };
        },
      },
      {
        name: "muse_document",
        provider: "muse",
        description:
          "Read one current Muse website document by exact key (page:home, page:history, business, site-settings or footer). Returns its version, source identifier and acquisition time. Preserve the operation key on transport retry; start a new run for a fresh snapshot.",
        input: getInput,
        reserveMicros: () => 0,
        annotations: { readOnlyHint: true, openWorldHint: true },
        run: async (args, credential, signal) => {
          const input = getInput.parse(args);
          const result = await read(input.key, credential, signal, document);
          if (result.value.key !== input.key || result.value.deleted)
            throw new PublicError(
              "provider_invalid_response",
              "The Muse did not return the requested current document",
              502,
            );
          return {
            state: "succeeded",
            estimatedCostMicros: 0,
            data: {
              sourceId: `muse:${result.value.key}@${result.value.version}`,
              sourceUrl: result.sourceUrl,
              acquiredAt: result.acquiredAt,
              document: result.value,
            },
          };
        },
      },
    ],
    workflows: [
      {
        id: "muse_content_review",
        name: "Review Muse website content",
        version: "1.0.0",
        description:
          "Check current website wording against versioned venue records and deliver a cited review",
        input: z
          .object({
            connection: apiActionInput.shape.connection,
            page: documentKey,
            question: z.string().trim().min(1).max(2000),
          })
          .strict(),
        instructions,
        dependencies: [
          { tool: "muse_documents", version: "1.0.0" },
          { tool: "muse_document", version: "1.0.0" },
        ],
        references: [
          {
            id: "review_contract",
            title: "Content review and publication rules",
            mediaType: "text/markdown",
            content:
              "The Muse content API returns current document versions. Keep document keys and exact field paths with every proposed correction. Distinguish recorded venue information from suggestions. Recheck versions before publication. A content review does not authorize a live save, an email, or a guest-data query.",
          },
        ],
        outputs: [
          "A content review with document versions and field paths",
          "Proposed wording when requested, with unresolved facts identified",
        ],
        checks: [
          "Every factual correction cites a retrieved document and version",
          "The selected account and permitted read tools were used",
          "No live content was changed",
        ],
        policy: {
          runtime: "worker",
          authority: "read",
          maxDurationMs: 300_000,
          retry:
            "Reuse operation keys after interrupted reads; use a new key for a fresh snapshot.",
          cancellation:
            "Stop further reads. Keep completed source snapshots and their acquisition times in the private result.",
        },
      },
    ],
  };
}
