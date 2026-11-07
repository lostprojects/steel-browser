// MCP shares the command engine's schema and result semantics. Keep browser
// ownership, credentials and mode restrictions in the existing service paths.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  publishedRequestSchema,
  readOptions,
  scoped,
  snapshotOptions,
  target,
} from "../../services/commands/commands.js";
import { callerTag } from "../../services/caller-outcomes.js";
import { scrub, scrubObject } from "../../services/vault.js";
import { DEFAULT_TEXT_LIMIT } from "../../utils/text.js";
import { connectionId } from "../../services/connection-store.js";

const session = z.string().uuid();
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const siteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/);
const url = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }, "Use an HTTP URL without credentials");
const residential = z.union([
  z.boolean(),
  z.object({ country: z.string().regex(/^[A-Z]{2}$/) }).strict(),
]);
const continuation = publishedRequestSchema.pick({ after: true, eventsAfter: true }).shape;
const idempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe("Reuse for a transport retry of this operation; use a fresh key for new work.");

export const schemas = {
  browser_sessions: z.object({}).strict(),
  browser_open: z
    .object({
      connection: connectionId.optional(),
      site: siteName.optional(),
      url: url.optional(),
      identity: name.optional(),
      mode: z.enum(["agent", "quiet"]).optional(),
      residential: residential.optional(),
      proxyProfile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional(),
      proxyLeaseId: z.string().uuid().optional(),
      caller: callerTag.default("mcp"),
      idempotencyKey,
      observe: publishedRequestSchema.shape.observe.default({ mode: "snapshot", compact: true }),
    })
    .strict()
    .refine(
      (value) => value.connection || value.site || value.url,
      "Supply a connection, site or URL",
    ),
  browser_snapshot: z
    .object({
      session,
      tab: scoped.tab,
      snapshotId: z
        .string()
        .regex(/^s-\d+$/)
        .optional(),
      ...snapshotOptions,
      compact: z.boolean().default(true),
      ...continuation,
    })
    .strict(),
  browser_act: publishedRequestSchema.extend({
    session,
    idempotencyKey,
  }),
  browser_read: z
    .object({
      session,
      format: z.enum(["markdown", "text", "html"]).default("markdown"),
      target: target.optional(),
      ...scoped,
      ...readOptions,
      limit: readOptions.limit.default(DEFAULT_TEXT_LIMIT),
      ...continuation,
    })
    .strict(),
  browser_screenshot: z
    .object({
      session,
      target: target.optional(),
      ...scoped,
      fullPage: z.boolean().optional(),
      format: z.enum(["png", "jpeg", "webp"]).default("png"),
      quality: z.number().int().min(0).max(100).optional(),
    })
    .strict(),
  browser_download: z
    .object({
      session,
      url: url.optional(),
      ref: z.string().min(1).max(200).optional(),
      transfer: z.string().uuid().optional(),
      cancel: z.boolean().optional(),
      idempotencyKey,
    })
    .strict()
    .refine(
      (value) => [value.url, value.ref, value.transfer].filter(Boolean).length === 1,
      "Supply one URL, element ref or transfer ID",
    )
    .refine((value) => !value.cancel || !!value.transfer, "cancel requires a transfer ID"),
  browser_login: z
    .object({
      session,
      identity: name.optional(),
      site: name.optional(),
      current: z.boolean().default(false),
    })
    .strict(),
  browser_handoff: z
    .object({
      session,
      reason: z.string().trim().min(1).max(1000),
      approval: z.string().uuid().optional(),
    })
    .strict(),
  browser_network: z
    .object({
      session,
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  browser_close: z.object({ session }).strict(),
  fetch: z
    .object({
      url,
      site: siteName.optional(),
      residential: residential.optional(),
      caller: callerTag.default("mcp-fetch"),
      requestId: z.string().uuid().optional(),
      timeoutMs: z.number().int().min(1000).max(300_000).optional(),
      ...readOptions,
      limit: readOptions.limit.default(DEFAULT_TEXT_LIMIT),
    })
    .strict(),
};

export type ToolName = keyof typeof schemas;

export const descriptions: Record<ToolName, string> = {
  browser_sessions:
    "List live sessions visible to your key so you can resume or release your work.",
  browser_open:
    "Open by connection, site or URL with an initial compact snapshot. Use connections_list to discover permitted saved accounts, then pass their browser connection ID. Reuse idempotencyKey on retry to avoid creating another browser. A queued/running execution continues; use browser_act status or cancel. Keep the returned session even on a navigation/observation error and close it in finally. Set observe.mode to none to skip the snapshot.",
  browser_snapshot:
    "Read a page outline with stable element refs. Supports tab, interactive, compact and depth. Text defaults to 20,000 code points; continue with snapshotId and nextOffset as offset. Use browser_act.observe for snapshot diffs after actions.",
  browser_act:
    "Run the command engine: navigation, input, find/get/is, drag/upload, tabs, eval, screenshots/PDF and status/cancel/dialog. Batch up to 50; stop on first failure. Pass after=next for retry protection, observe={mode:diff,compact:true} for changes, eventsAfter=c-0 then events.cursor for events. Running/queued executions continue; send status or cancel alone. Preserve partial results and check effect before retrying. Use vault login for credentials.",
  browser_read:
    "Read markdown, visible text or masked HTML, optionally within a target or frame. Returns at most 20,000 characters by default; resume at nextOffset with the same format/target. total is the full character count. limit can be at most 100,000.",
  browser_screenshot:
    "Capture PNG, JPEG or WebP; supports tab, element target and fullPage in agent mode. Quiet mode captures the visible display. Protected identities refuse images.",
  browser_download:
    "Download a URL or click a ref. Reuse idempotencyKey on retry. A pending click returns an execution for browser_act status/cancel. A receiving URL returns a transfer ID; pass transfer to poll. Ready deliveries include SHA-256, size, expiry and a binary URL. Open webUri in a signed-in browser for an ordinary download, with no local install. A ready handoff expires thirty minutes after publication and survives remote browser closure. Optional automation can use browser_save or the Toolstack CLI for verified local publication and a receipt. Wait for ready before closing the session.",
  browser_login:
    "Run the scoped vault flow on the session identity. A verification-code request belongs only to that waiting login and its verified origin. Stop on credentials_rejected.",
  browser_handoff:
    "Return a noVNC link only after an admin records the owner's explicit agreement for this session and reason. Without approval, returns owner_agreement_required.",
  browser_network:
    "Read recent request metadata in agent mode. Request bodies, headers and URL queries are omitted.",
  browser_close: "Release the browser and report its proxy lease and observed bytes.",
  fetch:
    "Read one page as markdown using the routing ladder, then release its browser. Returns up to 20,000 code points by default (limit up to 100,000). Continue with the returned requestId and nextOffset as offset, keeping other arguments unchanged. The source response is reused for ten minutes while retained.",
};

export function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: scrub(JSON.stringify(scrubObject(value))) }],
    ...(isError ? { isError: true } : {}),
  };
}

// Running work and answered dialogs are successful protocol responses. Failed
// commands retain their envelope, including effects, refs and recovery tokens.
export function commandFailed(value: any, cancelling = false): boolean {
  if (cancelling && value.execution?.state === "cancelled" && !value.error && !value.observe?.error)
    return false;
  return !!(
    value.error ||
    value.observe?.error ||
    value.results?.some((item: any) => !item.ok) ||
    (value.execution && !["queued", "running", "completed"].includes(value.execution.state))
  );
}
