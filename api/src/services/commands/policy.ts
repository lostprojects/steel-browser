import { CommandError } from "./errors.js";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

// Apply the same filesystem boundary to commands and raw CDP, including symlinks.
export async function sessionUploadFiles(filesRoot: string, names: string[]): Promise<string[]> {
  const root = await realpath(filesRoot);
  const files: string[] = [];
  for (const name of names) {
    const candidate = resolve(root, name);
    const real = candidate.startsWith(root + sep)
      ? await realpath(candidate).catch(() => null)
      : candidate;
    if (!real || !real.startsWith(root + sep))
      throw new CommandError(
        "forbidden_file",
        "Upload a file into this session's files first.",
        real ? "outside_files" : "missing",
      );
    if (!(await stat(real)).isFile())
      throw new CommandError("forbidden_file", "The upload path is not a file.", "not_file");
    files.push(real);
  }
  return files;
}

// Preserve CDP compatibility while keeping client-selected file paths inside the
// session. Nested legacy messages must pass the same checks as direct messages.
export async function scopeClientFiles(message: any, filesRoot: string, depth = 0): Promise<void> {
  if (!message || typeof message !== "object" || typeof message.method !== "string" || depth > 4)
    throw new Error("Invalid browser command");
  const params = message.params ?? {};
  if (message.method === "Target.sendMessageToTarget") {
    const nested = JSON.parse(params.message);
    await scopeClientFiles(nested, filesRoot, depth + 1);
    params.message = JSON.stringify(nested);
  }
  const files =
    message.method === "DOM.setFileInputFiles"
      ? params.files
      : message.method === "Input.dispatchDragEvent"
      ? params.data?.files
      : undefined;
  if (files !== undefined) {
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string"))
      throw new Error("Invalid browser upload files");
    const safe = await sessionUploadFiles(filesRoot, files);
    if (message.method === "DOM.setFileInputFiles") params.files = safe;
    else params.data.files = safe;
  }
  if (
    ["Browser.setDownloadBehavior", "Page.setDownloadBehavior"].includes(message.method) &&
    ["allow", "allowAndName"].includes(params.behavior)
  )
    params.downloadPath = filesRoot;
}

export function checkUrl(raw: string): string {
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(SCHEME.test(input) ? input : `https://${input}`);
  } catch {
    throw new CommandError("forbidden_url", `"${raw}" is not a valid URL.`, "invalid");
  }
  if (url.href === "about:blank") {
    return url.href;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CommandError(
      "forbidden_url",
      `Navigation to ${url.protocol} URLs is not allowed. Use an http or https URL.`,
      "protocol",
    );
  }
  return url.href;
}
