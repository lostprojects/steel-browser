import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createGateway } from "./server.js";
import { GatewayStore } from "./store.js";
import {
  principalHeader,
  verifyPrincipal,
  type ConnectedPrincipal,
} from "../services/gateway-principal.js";
import { assertAgentCurrent } from "../services/agent-access.js";

test("gateway replaces caller identity, fixes the worker, and refuses revoked queued authorization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "toolstack-gateway-http-"));
  const servers: http.Server[] = [];
  let lastClaim: ConnectedPrincipal | undefined;
  async function listen(server: http.Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  try {
    const store = new GatewayStore(
      path.join(root, "gateway.enc"),
      "45".repeat(32),
      "gateway-fixture-admin-".repeat(3),
    );
    await store.ready;
    async function worker(id: string) {
      const key = `${id}-fixture-worker-key-`.repeat(3),
        sharedKey = `${id}-fixture-reader-key-`.repeat(3);
      const origin = await listen(
        http.createServer((req, res) => {
          expect(req.headers["steel-api-key"]).toBe(key);
          const claim = verifyPrincipal(req.headers[principalHeader], key, id);
          expect(claim?.userId).toBe(id);
          lastClaim = claim;
          res.writeHead(req.url?.includes("foreign-session") ? 404 : 200, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ worker: id, keyId: claim?.keyId }));
        }),
      );
      const registration = await store.register({
        id,
        name: id,
        backendUrl: origin,
        backendKey: key,
        sharedKey,
      });
      const claimed = await store.claim(registration.invitation!);
      return { ...claimed, sharedKey };
    }
    const alice = await worker("alice"),
      bob = await worker("bob");
    const origin = await listen(createGateway(store, "http://127.0.0.1", true));
    const response = await fetch(origin + "/v1/sessions?user=bob", {
      headers: {
        authorization: `Bearer ${alice.key}`,
        [principalHeader]: "caller-supplied-identity",
      },
    });
    expect(await response.json()).toEqual({ worker: "alice", keyId: alice.keyId });
    expect(
      (
        await fetch(origin + "/v1/sessions/foreign-session", {
          headers: { authorization: `Bearer ${alice.key}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(origin + "/v1/sessions", { headers: { authorization: `Bearer ${bob.key}` } }))
        .status,
    ).toBe(200);
    // Restore Alice's verified claim before exercising the worker's live recheck.
    await fetch(origin + "/v1/sessions", { headers: { authorization: `Bearer ${alice.key}` } });
    vi.stubEnv("STEEL_SHARED_URL", origin);
    vi.stubEnv("STEEL_SHARED_KEY", alice.sharedKey);
    const agent = { name: "admin", admin: true, dailyBudgetBytes: 1000, connectedApp: lastClaim! };
    await expect(assertAgentCurrent(agent)).resolves.toBeUndefined();
    const principal = store.authenticate(alice.key)!;
    await store.createKey(principal, "Recovery");
    await store.revoke(principal, alice.keyId);
    await expect(assertAgentCurrent(agent)).rejects.toMatchObject({ code: "connection_revoked" });
    expect(
      (await fetch(origin + "/v1/sessions", { headers: { authorization: `Bearer ${alice.key}` } }))
        .status,
    ).toBe(401);
  } finally {
    vi.unstubAllEnvs();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
