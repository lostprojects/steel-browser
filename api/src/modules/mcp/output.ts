// Render immutable delivery metadata and engine results for MCP. Binary data
// stays out of text; failed publication preserves the effects of prior actions.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserSession } from "../../services/browser-session.js";
import { identityVault } from "../../services/login.js";
import { scrub, scrubObject } from "../../services/vault.js";
import { textResult, commandFailed } from "./tools.js";

type OutputSession = Pick<BrowserSession, "id" | "options" | "transfers">;

// Tool schemas describe fields rather than hold credentials. Scrub known secret
// strings without replacing schema objects named password or authorization.
export function scrubToolMetadata<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map(scrubToolMetadata) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [scrub(key), scrubToolMetadata(item)]),
    ) as T;
  return value;
}

// MCP writes directly to the response, bypassing Fastify's serialization hooks.
// Scrub extension results here without rewriting encoded image/audio/file bytes.
export function scrubToolResult(result: CallToolResult): CallToolResult {
  const { content, ...metadata } = result;
  return {
    ...scrubObject(metadata),
    content: content.map((block) => {
      if (block.type === "image" || block.type === "audio") {
        const { data, ...fields } = block;
        return { ...scrubObject(fields), data };
      }
      if (block.type === "resource" && "blob" in block.resource) {
        const { resource, ...fields } = block;
        const { blob, ...resourceFields } = resource;
        return {
          ...scrubObject(fields),
          resource: { ...scrubObject(resourceFields), blob },
        };
      }
      return scrubObject(block);
    }),
  };
}

export function deliveryResult(value: any, cancelling = false): CallToolResult {
  const result = textResult(
    value,
    ["failed", "expired"].includes(value.state) || (value.state === "cancelled" && !cancelling),
  );
  if (value.state === "ready")
    result.content.push({
      type: "resource_link",
      uri: value.webUri ?? value.uri,
      name: value.name,
    });
  return result;
}

export async function commandResult(
  browser: OutputSession,
  result: any,
  cancelling = false,
): Promise<CallToolResult> {
  const attachments: CallToolResult["content"] = [];
  const results: Record<string, unknown>[] = [];
  let outputError: { code: string; message: string } | undefined;
  for (const [index, item] of (result.results ?? []).entries()) {
    const binary =
      item.ok &&
      typeof item.data === "string" &&
      ["png", "jpeg", "webp", "pdf"].includes(item.format);
    const download = item.ok && item.waited === "download" && typeof item.file === "string";
    if (!binary && !download) {
      results.push(item);
      continue;
    }
    const { data, ...metadata } = item;
    try {
      if (binary && identityVault(browser.options.identity))
        throw new Error("Protected identity image capture unavailable");
      if (binary && item.format !== "pdf") {
        const contentIndex = attachments.length + 1;
        attachments.push({ type: "image", data, mimeType: `image/${item.format}` });
        results.push({ ...metadata, contentIndex });
        continue;
      }
      let delivery = binary
        ? await browser.transfers.fromBytes(
            `print-${result.execution.id}-${index}`,
            "print.pdf",
            Buffer.from(data, "base64"),
          )
        : await browser.transfers.fromFile(item.file, item.name);
      if (delivery.state === "ready") {
        delivery = browser.transfers.share(delivery.id);
        attachments.push({
          type: "resource_link",
          uri: delivery.webUri ?? delivery.uri,
          name: delivery.name,
        });
      }
      if (["failed", "cancelled", "expired"].includes(delivery.state))
        throw new Error(delivery.error ?? "Delivery unavailable");
      results.push({ ...metadata, delivery, transfer: delivery.id });
    } catch (error) {
      const failure = { code: "output_failed", message: (error as Error).message };
      outputError ??= failure;
      results.push({ ...metadata, outputError: failure });
    }
  }
  const response = textResult(
    { ...result, ...(result.results ? { results } : {}), ...(outputError ? { outputError } : {}) },
    commandFailed(result, cancelling) || !!outputError,
  );
  response.content.push(...attachments);
  return response;
}
