// Library content is owned data. Uploaded code is never imported into the API
// process; registered execution runtimes remain a separate application boundary.
import { z } from "zod";
import { storeName } from "../shared-store.js";
import type { Agent } from "../proxy-manager.js";
import type { ConnectedPrincipal } from "../gateway-principal.js";
import { organizationMember, type MembershipIdentity } from "../organization.js";

export const packageId = z.string().uuid();
export const requestId = z.string().uuid();
export const maxFileBytes = 16 * 1024 * 1024;
export const packageBody = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).default(""),
    kind: z.enum(["skill", "toolkit", "workflow"]).default("skill"),
    instructions: z.string().max(200_000).default(""),
    runtime: z
      .object({ id: storeName, version: z.string().min(1).max(80) })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export const createPackage = packageBody.extend({ requestId });
export const updatePackage = packageBody.extend({
  requestId,
  expectedVersion: z.number().int().positive(),
  files: z.array(packageId).max(100),
});
export const sharePackage = z
  .object({
    requestId,
    expectedVersion: z.number().int().positive(),
    visibility: z.enum(["private", "assigned", "global"]),
    assignedTo: z.array(storeName).max(100).default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.visibility === "assigned" ? value.assignedTo.length > 0 : value.assignedTo.length === 0,
    "Select people for assigned content; clear assignments for private or global content",
  );
export const archivePackage = z
  .object({
    requestId,
    expectedVersion: z.number().int().positive(),
    archived: z.boolean(),
  })
  .strict();
export const uploadFile = z
  .object({
    requestId,
    expectedVersion: z.number().int().positive(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((value) => !/[\/\\\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value)),
    role: z.enum(["script", "reference", "asset"]).default("reference"),
    mediaType: z
      .string()
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i)
      .max(120)
      .default("application/octet-stream"),
  })
  .strict();
export const listPackages = z
  .object({
    query: z.string().trim().max(200).default(""),
    scope: z.enum(["available", "mine", "archived"]).default("available"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export function libraryUser(agent: Agent): string {
  return storeName.parse(agent.connectedApp?.userId ?? process.env.STEEL_USER_ID ?? "owner");
}
export function libraryActor(agent: Agent): LibraryActor {
  return { ...organizationMember(libraryUser(agent)), principal: agent.connectedApp };
}
export type LibraryActor = MembershipIdentity & { principal?: ConnectedPrincipal };
export type LibraryCommand = {
  action:
    | "list"
    | "get"
    | "history"
    | "create"
    | "update"
    | "share"
    | "archive"
    | "upload"
    | "file"
    | "file_info";
  id?: string;
  input?: unknown;
  version?: number;
};
export interface LibraryService {
  readonly ready?: Promise<void>;
  call(actor: LibraryActor, command: LibraryCommand): Promise<any>;
  close(): Promise<void>;
}
