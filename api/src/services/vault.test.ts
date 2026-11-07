import { expect, test } from "vitest";
import { scrubObject, totp } from "./vault.js";
// RFC 6238 Appendix B, SHA-1 vectors. The service emits six digits, so the
// expected values are the published eight-digit results modulo 10^6.
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
test.each([
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
])("RFC 6238 SHA-1 at %s seconds", (seconds, published) => {
  expect(totp(seed, Number(seconds) * 1000)).toBe(String(published).slice(-6));
});

// Response redaction must preserve JSON timestamps from Postgres rows.
test("redaction preserves valid and invalid JSON date semantics", () => {
  const at = new Date("2026-11-07T08:00:00.000Z");
  expect(
    scrubObject({ createdAt: at, nested: [at], invalid: new Date(NaN), password: "private" }),
  ).toEqual({
    createdAt: at.toISOString(),
    nested: [at.toISOString()],
    invalid: null,
    password: "[redacted]",
  });
});
