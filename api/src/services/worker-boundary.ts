// A worker belongs to one user for the lifetime of its volume. Do not repurpose
// a volume or supply gateway credentials to a worker, including an empty worker.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { storeName, sharedStoreConnection } from "./shared-store.js";
import { currentOrganization, membershipId } from "./organization.js";

export async function requireWorkerBoundary() {
  const organization = currentOrganization();
  const root = path.dirname(process.env.PROFILES_ROOT ?? "/data/profiles");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const organizationMarker = path.join(root, ".toolstack-organization");
  try {
    await writeFile(organizationMarker, organization.id, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await readFile(organizationMarker, "utf8")) !== organization.id)
    throw new Error("This volume belongs to another organization; startup refused");
  if (process.env.STEEL_ROLE !== "worker") return;
  const userId = storeName.parse(process.env.STEEL_USER_ID);
  sharedStoreConnection();
  if (process.env.GATEWAY_STORE_KEY || process.env.GATEWAY_STORE_PATH)
    throw new Error("A browser worker must not receive gateway storage or keys");
  if (
    !/^[a-fA-F0-9]{64}$/.test(process.env.VAULT_KEY ?? "") ||
    (process.env.STEEL_API_KEY?.length ?? 0) < 32 ||
    (process.env.STEEL_SHARED_KEY?.length ?? 0) < 32 ||
    process.env.STEEL_API_KEY === process.env.STEEL_SHARED_KEY ||
    !process.env.STEEL_SHARED_URL
  )
    throw new Error("Worker requires independent API, vault and shared-store keys");
  const marker = path.join(root, ".steel-user");
  try {
    await writeFile(marker, userId, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await readFile(marker, "utf8")) !== userId)
    throw new Error("This volume belongs to another user; startup refused");
  const workspaceMarker = path.join(root, ".toolstack-membership");
  const membership = membershipId(organization.id, userId);
  try {
    await writeFile(workspaceMarker, membership, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await readFile(workspaceMarker, "utf8")) !== membership)
    throw new Error("This volume belongs to another membership; startup refused");
}
