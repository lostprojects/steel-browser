import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { GatewayStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolstack-gateway-grants-"));
  roots.push(root);
  const store = new GatewayStore(
    path.join(root, "gateway.enc"),
    "67".repeat(32),
    "owner-admin-key".repeat(3),
  );
  await store.ready;
  const registration = (id: string) => ({
    id,
    name: id,
    backendUrl: `https://${id}.example.test`,
    backendKey: `${id}-backend-`.repeat(5),
    sharedKey: `${id}-shared-`.repeat(5),
  });
  const owner = registration("owner"),
    teammate = registration("teammate");
  await store.register(owner);
  const invitation = await store.register(teammate);
  const claimed = await store.claim(invitation.invitation!);
  return { root, store, owner, teammate, principal: store.authenticate(claimed.key)! };
}
test("new shared credentials default to owner and grants filter metadata and secret supply", async () => {
  const { store, owner, teammate, principal } = await fixture();
  await store.putShared("vault", "campaign", { apiKey: "shared-provider-secret" });
  expect(store.sharedForWorker(owner.sharedKey)?.credentials.campaign).toEqual({
    apiKey: "shared-provider-secret",
  });
  expect(store.sharedForWorker(teammate.sharedKey)?.credentials).toEqual({});
  expect(store.sharedMetadata(principal).credentials).toEqual([]);
  await store.putSharedGrants("campaign", { allowedUsers: ["owner", "teammate"] });
  expect(store.sharedForWorker(teammate.sharedKey)?.credentials.campaign).toBeDefined();
  expect(store.sharedMetadata(principal).credentials).toEqual([
    { name: "campaign", fields: ["apiKey"] },
  ]);
  await store.putSharedGrants("campaign", { allowedUsers: ["owner"] });
  expect(store.sharedForWorker(teammate.sharedKey)?.credentials).toEqual({});
  expect(store.sharedForWorker("unknown-key")).toBeUndefined();
});
test("grants persist through restart, reject unknown users, and disabled workers receive no secrets", async () => {
  const { root, store, teammate } = await fixture();
  await store.putShared("vault", "campaign", { apiKey: "shared-provider-secret" });
  await expect(
    store.putSharedGrants("campaign", { allowedUsers: ["missing-user"] }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await store.putSharedGrants("campaign", { allowedUsers: ["teammate"] });
  const restarted = new GatewayStore(store.file, "67".repeat(32), "owner-admin-key".repeat(3));
  await restarted.ready;
  expect(restarted.sharedForWorker(teammate.sharedKey)?.credentials.campaign).toBeDefined();
  await restarted.disable("teammate", true);
  expect(restarted.sharedForWorker(teammate.sharedKey)).toBeUndefined();
  expect(
    (await readFile(path.join(root, "gateway.enc"))).includes(
      Buffer.from("shared-provider-secret"),
    ),
  ).toBe(false);
});
test("only a person's assigned worker can validate that person's connected key", async () => {
  const { store, owner, teammate, principal } = await fixture();
  expect(store.principalActiveForWorker(teammate.sharedKey, principal)).toBe(true);
  expect(store.principalActiveForWorker(owner.sharedKey, principal)).toBe(false);
  const recovery = await store.createKey(principal, "Recovery");
  await store.revoke(principal, principal.keyId);
  expect(store.principalActiveForWorker(teammate.sharedKey, principal)).toBe(false);
  expect(store.authenticate(recovery.key)).toBeDefined();
});
