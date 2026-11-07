// One organization per deployment and data store. Display names grant no access.
// Legacy owner/client keys belong to this fixed organization; request fields
// cannot select a tenant. Production requires an explicit operator binding.
import { createHash } from "node:crypto";
import { z } from "zod";
import { PublicError } from "../utils/public-error.js";

export const organizationId = z.string().uuid();
export const organizationSchema = z
  .object({
    id: organizationId,
    name: z.string().trim().min(1).max(100),
  })
  .strict();
export type Organization = z.infer<typeof organizationSchema>;
const developmentOrganization = "00000000-0000-4000-8000-000000000001";

export function currentOrganization(): Organization {
  const id = process.env.TOOLSTACK_ORG_ID;
  if (!id && process.env.NODE_ENV === "production")
    throw new Error("Configure TOOLSTACK_ORG_ID before starting the organization service");
  return organizationSchema.parse({
    id: id ?? developmentOrganization,
    name: process.env.TOOLSTACK_ORG_NAME ?? "My organization",
  });
}

// Stable membership IDs backfill existing immutable user aliases. An alias
// cannot be reassigned to a different person; a new person needs a new user ID.
export function membershipId(orgId: string, userId: string): string {
  organizationId.parse(orgId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(userId)) throw new Error("Invalid member identity");
  const bytes = createHash("sha1")
    .update(Buffer.from(orgId.replaceAll("-", ""), "hex"))
    .update(`toolstack-membership-v1\0${userId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type MembershipIdentity = { orgId: string; membershipId: string; userId: string };
export function organizationMember(
  userId: string,
  organization = currentOrganization(),
): MembershipIdentity {
  return { orgId: organization.id, membershipId: membershipId(organization.id, userId), userId };
}
export function assertOrganizationMember(
  identity: MembershipIdentity,
  organization = currentOrganization(),
) {
  if (
    identity.orgId !== organization.id ||
    identity.membershipId !== membershipId(organization.id, identity.userId)
  )
    throw new PublicError("organization_unavailable", "This workspace is unavailable", 403);
}
export function organizationContext(userId: string) {
  const organization = currentOrganization();
  return {
    organization,
    membership: {
      ...organizationMember(userId, organization),
      role: userId === "owner" ? "owner" : "member",
    },
  };
}
