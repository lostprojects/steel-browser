// Durable jobs accept registered operations and references only. Do not accept
// shell commands, module paths, provider secrets or caller-supplied identities.
import { z } from "zod";
import type { LibraryActor } from "../library/contracts.js";

export const submitJob = z
  .object({
    requestId: z.string().uuid(),
    type: z.literal("library_export"),
    packageId: z.string().uuid(),
    version: z.number().int().positive(),
  })
  .strict();
export const jobsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  })
  .strict();
export type JobAuthorization = { keyHash: string };
export type JobSubmission = z.infer<typeof submitJob>;
export type JobState = "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled";
export interface Jobs {
  list(actor: LibraryActor, query?: unknown): Promise<any>;
  get(actor: LibraryActor, id: string): Promise<any>;
  submit(actor: LibraryActor, input: unknown, authorization: JobAuthorization): Promise<any>;
  cancel(actor: LibraryActor, id: string): Promise<any>;
  download(
    actor: LibraryActor,
    id: string,
  ): Promise<{ name: string; bytes: Buffer; sha256: string }>;
}
