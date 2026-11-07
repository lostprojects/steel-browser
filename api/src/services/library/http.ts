import { z } from "zod";
import { PublicError } from "../../utils/public-error.js";
import { packageId, type LibraryCommand } from "./contracts.js";

export function libraryCommand(
  method: string,
  url: URL,
  body?: unknown,
): { command: LibraryCommand; binary?: boolean } {
  const path = url.pathname.replace(/^\/v1\/library\/?/, ""),
    parts = path.split("/").filter(Boolean);
  if (!parts.length) {
    if (method === "GET")
      return { command: { action: "list", input: Object.fromEntries(url.searchParams) } };
    if (method === "POST") return { command: { action: "create", input: body } };
  }
  const id = packageId.parse(parts[0]);
  if (parts.length === 1) {
    if (method === "GET")
      return {
        command: {
          action: "get",
          id,
          version: url.searchParams.has("version")
            ? z.coerce.number().int().positive().parse(url.searchParams.get("version"))
            : undefined,
        },
      };
    if (method === "PUT") return { command: { action: "update", id, input: body } };
  }
  if (parts.length === 2) {
    if (method === "GET" && parts[1] === "history") return { command: { action: "history", id } };
    if (method === "POST" && ["share", "archive", "files"].includes(parts[1]))
      return {
        command: {
          action: parts[1] === "files" ? "upload" : (parts[1] as "share" | "archive"),
          id,
          input: body,
        },
      };
  }
  if (parts.length === 3 && parts[1] === "files" && ["GET", "HEAD"].includes(method))
    return {
      command: {
        action: method === "HEAD" ? "file_info" : "file",
        id,
        input: { file: packageId.parse(parts[2]) },
      },
      binary: true,
    };
  throw new PublicError("invalid_request", "Unsupported content library operation", 405);
}
