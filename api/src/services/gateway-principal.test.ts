import { expect, test } from "vitest";
import { signPrincipal, verifyPrincipal } from "./gateway-principal.js";

test("worker identity claims reject tampering, foreign users, wrong keys and expiry", () => {
  const now = 1_800_000_000_000;
  const principal = { userId: "teammate", keyId: "agent-1", admin: false, expires: Infinity };
  const signed = signPrincipal(principal, "worker-one", now);
  expect(verifyPrincipal(signed, "worker-one", "teammate", now)).toMatchObject({
    userId: "teammate",
    keyId: "agent-1",
    expires: now + 300_000,
  });
  expect(verifyPrincipal(signed, "worker-two", "teammate", now)).toBeUndefined();
  expect(verifyPrincipal(signed, "worker-one", "other-person", now)).toBeUndefined();
  expect(verifyPrincipal(signed, "worker-one", "teammate", now + 300_000)).toBeUndefined();
  const tampered =
    Buffer.from(JSON.stringify({ ...principal, userId: "owner" })).toString("base64url") +
    "." +
    signed.split(".")[1];
  expect(verifyPrincipal(tampered, "worker-one", "owner", now)).toBeUndefined();
  for (const invalid of [null, [], "bad", "a.b", "a." + "a".repeat(63), "a".repeat(9000)])
    expect(verifyPrincipal(invalid, "worker-one", "teammate", now)).toBeUndefined();
});
