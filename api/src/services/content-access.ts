// Content belongs to a person. Visibility grants access to the package only;
// account grants and each operation's existing policy remain independent.
import { z } from "zod";
import { storeName } from "./shared-store.js";
import type { ToolContext } from "./toolkits/registry.js";
import { currentOrganization, organizationId, membershipId } from "./organization.js";

export const contentAccess = z
  .object({
    orgId: organizationId.default(() => currentOrganization().id),
    id: storeName,
    owner: storeName,
    visibility: z.enum(["private", "assigned", "global"]).default("private"),
    assignedTo: z.array(storeName).max(100).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.visibility === "assigned" ? !value.assignedTo.length : value.assignedTo.length > 0)
      context.addIssue({ code: "custom", message: "Assignments require assigned visibility" });
  });
export type ContentAccess = z.infer<typeof contentAccess>;

export function canUseContent(access: ContentAccess | undefined, context: ToolContext): boolean {
  const orgId = currentOrganization().id;
  if (
    context.agent.connectedApp &&
    (context.agent.connectedApp.orgId !== orgId ||
      context.agent.connectedApp.membershipId !==
        membershipId(orgId, context.agent.connectedApp.userId))
  )
    return false;
  if (!access) return true;
  if (access.orgId !== orgId) return false;
  // A standalone instance belongs to its owner. Hosted workers use their fixed
  // user binding; a verified gateway claim identifies the person, not the app key.
  const user = context.agent.connectedApp?.userId ?? process.env.STEEL_USER_ID ?? "owner";
  return (
    user === access.owner ||
    access.visibility === "global" ||
    (access.visibility === "assigned" && access.assignedTo.includes(user))
  );
}

export function contentSummary(access: ContentAccess | undefined) {
  if (!access) return undefined;
  const { id, owner, visibility, orgId } = access;
  return { id, owner, visibility, orgId };
}
