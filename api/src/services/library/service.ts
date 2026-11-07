import { z } from "zod";
import { sharedStoreConnection } from "../shared-store.js";
import { PublicError } from "../../utils/public-error.js";
import { libraryDatabase } from "./database.js";
import { ContentLibrary } from "./library.js";
import { WasabiObjects } from "./objects.js";
import { assertOrganizationMember, currentOrganization } from "../organization.js";
import {
  maxFileBytes,
  type LibraryActor,
  type LibraryCommand,
  type LibraryService,
} from "./contracts.js";

class RemoteLibrary implements LibraryService {
  async call(actor: LibraryActor, command: LibraryCommand) {
    assertOrganizationMember(actor);
    const connection = sharedStoreConnection();
    if (!connection)
      throw new PublicError("library_unavailable", "Your content library is being set up", 503);
    const response = await fetch(new URL("/internal/library", connection.url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
      headers: {
        authorization: `Bearer ${connection.key}`,
        "content-type": "application/json",
        "x-toolstack-org-id": currentOrganization().id,
      },
      body: JSON.stringify({ principal: actor.principal, command }),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      if (size > maxFileBytes * 1.5 + 1_000_000)
        throw new Error("Library response exceeds its byte limit");
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok)
      throw new PublicError(
        "library_request_failed",
        value?.message ??
          (typeof value?.error === "string" ? value.error : "Content request failed"),
        response.status,
      );
    return value;
  }
  async close() {}
}
export function configuredLibrary(): LibraryService | undefined {
  if (process.env.STEEL_ROLE === "worker") {
    if (
      process.env.TOOLSTACK_DATABASE_URL ||
      process.env.TOOLSTACK_WASABI_SECRET_KEY ||
      process.env.TOOLSTACK_CONTENT_KEY
    )
      throw new Error("Private workers must not receive central content storage credentials");
    return sharedStoreConnection() ? new RemoteLibrary() : undefined;
  }
  const database = process.env.TOOLSTACK_DATABASE_URL;
  const names = [
    "TOOLSTACK_WASABI_BUCKET",
    "TOOLSTACK_WASABI_REGION",
    "TOOLSTACK_WASABI_ACCESS_KEY",
    "TOOLSTACK_WASABI_SECRET_KEY",
    "TOOLSTACK_CONTENT_KEY",
  ] as const;
  if (!database && names.every((name) => !process.env[name])) return;
  if (!database || names.some((name) => !process.env[name]))
    throw new Error("Configure Toolstack Postgres, Wasabi and the content encryption key together");
  const objects = new WasabiObjects(
    process.env.TOOLSTACK_WASABI_BUCKET!,
    process.env.TOOLSTACK_WASABI_REGION!,
    process.env.TOOLSTACK_WASABI_ACCESS_KEY!,
    process.env.TOOLSTACK_WASABI_SECRET_KEY!,
    process.env.TOOLSTACK_CONTENT_KEY!,
  );
  return new ContentLibrary(libraryDatabase(database), objects);
}
export function requireLibrary(service: LibraryService | undefined): LibraryService {
  if (!service)
    throw new PublicError(
      "library_unavailable",
      "Your content library is being set up. Try again shortly.",
      503,
    );
  return service;
}
export async function callLibrary(
  service: LibraryService | undefined,
  actor: LibraryActor,
  command: LibraryCommand,
) {
  try {
    return await requireLibrary(service).call(actor, command);
  } catch (error) {
    if (error instanceof PublicError || error instanceof z.ZodError) throw error;
    // Provider/database diagnostics may contain private content. Keep them out
    // of client errors and standard request logs.
    throw new PublicError(
      "library_unavailable",
      "Content storage is unavailable. Retry with the same request ID.",
      503,
    );
  }
}
