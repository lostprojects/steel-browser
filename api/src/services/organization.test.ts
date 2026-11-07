import { afterEach, expect, test, vi } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  currentOrganization,
  membershipId,
  organizationMember,
  assertOrganizationMember,
} from "./organization.js";
import { signPrincipal, verifyPrincipal } from "./gateway-principal.js";
import { requireWorkerBoundary } from "./worker-boundary.js";
import { GatewayStore } from "../gateway/store.js";
import { contentAccess, canUseContent } from "./content-access.js";
import { createGateway } from "../gateway/server.js";
import { readSharedStore } from "./shared-store.js";
import type { AddressInfo } from "node:net";

afterEach(() => vi.unstubAllEnvs());

test("production requires an explicit organization and memberships remain stable within it", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TOOLSTACK_ORG_ID", "");
  expect(() => currentOrganization()).toThrow("TOOLSTACK_ORG_ID");
  vi.stubEnv("TOOLSTACK_ORG_ID", randomUUID());
  const first = organizationMember("owner");
  expect(organizationMember("owner")).toEqual(first);
  expect(organizationMember("alice").membershipId).not.toBe(first.membershipId);
  expect(membershipId(randomUUID(), "owner")).not.toBe(first.membershipId);
  expect(() => assertOrganizationMember({ ...first, orgId: randomUUID() })).toThrow("unavailable");
});

test("correctly signed foreign or unbound claims are refused by a worker", () => {
  const now = Date.now(),
    key = "fixture-worker-key";
  const input = { userId: "owner", keyId: "fixture", admin: true, expires: now + 60000 };
  const signed = signPrincipal(input, key, now);
  expect(verifyPrincipal(signed, key, "owner", now)?.membershipId).toBe(
    organizationMember("owner").membershipId,
  );
  expect(
    verifyPrincipal(signPrincipal({ ...input, orgId: randomUUID() }, key, now), key, "owner", now),
  ).toBeUndefined();
  expect(
    verifyPrincipal(
      signPrincipal({ ...input, membershipId: randomUUID() }, key, now),
      key,
      "owner",
      now,
    ),
  ).toBeUndefined();
  const body = Buffer.from(JSON.stringify(input)).toString("base64url");
  expect(
    verifyPrincipal(
      body + "." + createHmac("sha256", key).update(body).digest("hex"),
      key,
      "owner",
      now,
    ),
  ).toBeUndefined();
});

test("organization-wide content remains hidden from a foreign tenant and forged membership", () => {
  const access = contentAccess.parse({ id: "method", owner: "owner", visibility: "global" });
  const context = {
    requestId: "fixture",
    signal: new AbortController().signal,
    agent: {
      name: "admin",
      admin: true,
      dailyBudgetBytes: 1,
      connectedApp: {
        ...organizationMember("alice"),
        keyId: "fixture",
        admin: true,
        expires: Date.now() + 60000,
      },
    },
  };
  expect(canUseContent(access, context)).toBe(true);
  context.agent.connectedApp.orgId = randomUUID();
  expect(canUseContent(access, context)).toBe(false);
  context.agent.connectedApp = {
    ...context.agent.connectedApp,
    ...organizationMember("alice"),
    membershipId: randomUUID(),
  };
  expect(canUseContent(access, context)).toBe(false);
});

test("gateway credentials and encrypted stores cannot be rebound to another organization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolstack-organization-gateway-"));
  const file = path.join(root, "gateway.enc"),
    key = "ab".repeat(32),
    admin = "fixture-admin-".repeat(4);
  try {
    const org = currentOrganization(),
      a = new GatewayStore(file, key, admin, org);
    await a.ready;
    await a.putShared("vault", "fixture", { apiKey: "fixture-provider-value" });
    const principal = a.authenticate(admin)!;
    expect(a.active({ ...principal, orgId: randomUUID() })).toBe(false);
    expect(a.active({ ...principal, membershipId: randomUUID() })).toBe(false);
    const b = new GatewayStore(file, key, admin, { id: randomUUID(), name: "Other organization" });
    await expect(b.ready).rejects.toThrow("startup refused");
    const reopened = new GatewayStore(file, key, admin, org);
    await reopened.ready;
    expect(reopened.sharedMetadata(reopened.authenticate(admin)!).credentials).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy worker volumes bind once and refuse a foreign org or member without changing profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolstack-organization-volume-"));
  try {
    vi.stubEnv("PROFILES_ROOT", path.join(root, "profiles"));
    vi.stubEnv("STEEL_ROLE", "worker");
    vi.stubEnv("STEEL_USER_ID", "alice");
    vi.stubEnv("STEEL_SHARED_URL", "https://gateway.example.test");
    vi.stubEnv("STEEL_SHARED_KEY", "fixture-reader-".repeat(4));
    vi.stubEnv("STEEL_API_KEY", "fixture-worker-".repeat(4));
    vi.stubEnv("VAULT_KEY", "ab".repeat(32));
    vi.stubEnv("GATEWAY_STORE_KEY", "");
    vi.stubEnv("GATEWAY_STORE_PATH", "");
    await writeFile(path.join(root, ".steel-user"), "alice");
    await writeFile(path.join(root, "retained-profile"), "unchanged");
    await requireWorkerBoundary();
    const binding = await readFile(path.join(root, ".toolstack-membership"), "utf8");
    await requireWorkerBoundary();
    expect(binding).toBe(organizationMember("alice").membershipId);
    vi.stubEnv("STEEL_USER_ID", "bob");
    await expect(requireWorkerBoundary()).rejects.toThrow("another user");
    expect(await readFile(path.join(root, ".toolstack-membership"), "utf8")).toBe(binding);
    vi.stubEnv("TOOLSTACK_ORG_ID", randomUUID());
    await expect(requireWorkerBoundary()).rejects.toThrow("another organization");
    expect(await readFile(path.join(root, "retained-profile"), "utf8")).toBe("unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader credentials cannot retrieve secrets from a gateway in a different organization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolstack-organization-reader-"));
  const reader = "fixture-reader-".repeat(4),
    admin = "fixture-admin-".repeat(4);
  const store = new GatewayStore(path.join(root, "gateway.enc"), "ab".repeat(32), admin);
  await store.ready;
  await store.register({
    id: "owner",
    name: "Owner",
    backendUrl: "https://worker.example.test",
    backendKey: "fixture-worker-".repeat(4),
    sharedKey: reader,
  });
  await store.putShared("vault", "fixture", { apiKey: "fixture-provider-value" });
  const server = createGateway(store, "http://127.0.0.1", true);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const context = await (
      await fetch(origin + "/v1/organization", {
        headers: { authorization: `Bearer ${admin}` },
      })
    ).json();
    expect(context.organization).toEqual(store.organization);
    expect(context.membership).toEqual({
      orgId: store.organization.id,
      id: organizationMember("owner").membershipId,
      userId: "owner",
      role: "owner",
    });
    vi.stubEnv("STEEL_SHARED_URL", origin);
    vi.stubEnv("STEEL_SHARED_KEY", reader);
    expect((await readSharedStore(true)).credentials.fixture.apiKey).toBe("fixture-provider-value");
    const unavailable = await fetch(origin + "/internal/shared", {
      headers: { authorization: `Bearer ${reader}`, "x-toolstack-org-id": randomUUID() },
    });
    expect(unavailable.status).toBe(403);
    expect(await unavailable.text()).not.toContain("fixture-provider-value");
    expect(
      (await fetch(origin + "/internal/shared", { headers: { authorization: `Bearer ${reader}` } }))
        .status,
    ).toBe(403);
    vi.stubEnv("TOOLSTACK_ORG_ID", randomUUID());
    await expect(readSharedStore(true)).rejects.toThrow("unavailable");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
