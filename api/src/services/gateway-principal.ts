// The gateway replaces caller identity headers with a short-lived signed claim.
// The worker must verify its own user binding before using this identity.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { storeName } from "./shared-store.js";
import { currentOrganization, membershipId, organizationId } from "./organization.js";

export const principalHeader = "x-toolstack-principal";
export const connectedPrincipal = z
  .object({
    orgId: organizationId,
    membershipId: z.string().uuid(),
    userId: storeName,
    keyId: z.string().min(1).max(128),
    admin: z.boolean(),
    expires: z.number().finite(),
    grantId: z.string().uuid().optional(),
    tokenHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    oauthClientId: z.string().min(1).max(2048).optional(),
    resource: z.string().url().optional(),
  })
  .strict();
export type ConnectedPrincipal = z.infer<typeof connectedPrincipal>;
export function signPrincipal(
  principal: Omit<ConnectedPrincipal, "orgId" | "membershipId"> &
    Partial<Pick<ConnectedPrincipal, "orgId" | "membershipId">>,
  key: string,
  now = Date.now(),
) {
  const orgId = principal.orgId ?? currentOrganization().id;
  const payload = Buffer.from(
    JSON.stringify({
      ...principal,
      orgId,
      membershipId: principal.membershipId ?? membershipId(orgId, principal.userId),
      expires: Math.min(principal.expires, now + 300_000),
    }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("hex")}`;
}
export function verifyPrincipal(value: unknown, key: string, userId: string, now = Date.now()) {
  if (typeof value !== "string" || value.length > 8192) return;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return;
  const expected = createHmac("sha256", key).update(parts[0]).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts[1], "hex"))) return;
  try {
    const claim = connectedPrincipal.parse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString()),
    );
    if (
      claim.userId !== userId ||
      claim.orgId !== currentOrganization().id ||
      claim.membershipId !== membershipId(claim.orgId, userId) ||
      claim.expires <= now ||
      claim.expires > now + 300_000
    )
      return;
    return claim;
  } catch {
    return;
  }
}
