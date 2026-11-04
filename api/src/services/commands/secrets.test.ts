import { describe, expect, test } from "vitest";
import { hideSecrets, SECRET_MASK, secretMask } from "./secrets.js";

function slowHide(text: string, secrets: string[], minimum: number): string {
  const ends = new Array<number>(text.length).fill(0);
  for (const secret of secrets) {
    for (const variant of [secret, secret.replace(/\s+/g, " ").trim()]) {
      if (variant.length < minimum) {
        continue;
      }
      for (let at = text.indexOf(variant); at >= 0; at = text.indexOf(variant, at + 1)) {
        ends[at] = Math.max(ends[at], at + variant.length);
      }
    }
  }
  let hidden = "";
  let until = 0;
  ends.forEach((end, index) => {
    if (end === 0) {
      return;
    }
    if (index >= until) {
      hidden += text.slice(until, index) + SECRET_MASK;
      until = end;
    } else {
      until = Math.max(until, end);
    }
  });
  return hidden + text.slice(until);
}

describe("hideSecrets", () => {
  test("hides a longer secret that contains a shorter one", () => {
    expect(hideSecrets("old Summer, new Summer2025!", ["Summer", "Summer2025!"])).toBe(
      `old ${SECRET_MASK}, new ${SECRET_MASK}`,
    );
  });

  test("hides overlapping secrets as one and keeps short ones unless asked", () => {
    expect(hideSecrets("xabcdefx", ["abcd", "cdef"])).toBe(`x${SECRET_MASK}x`);
    expect(hideSecrets("pin 123 here", ["123"])).toBe("pin 123 here");
    expect(hideSecrets("pin 123 here", ["123"], 1)).toBe(`pin ${SECRET_MASK} here`);
    expect(hideSecrets("say open sesame", ["open\n  sesame"])).toBe(`say ${SECRET_MASK}`);
  });

  test("matches a plain search for every secret", () => {
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    const word = (length: number) => Array.from({ length }, () => "ab c"[random(4)]).join("");
    for (let round = 0; round < 3_000; round++) {
      const secrets = Array.from({ length: 1 + random(6) }, () => word(1 + random(6)));
      const text = word(random(40));
      const minimum = random(2) === 0 ? 1 : 4;
      expect(hideSecrets(text, secrets, minimum), JSON.stringify({ text, secrets, minimum })).toBe(
        slowHide(text, secrets, minimum),
      );
    }
  });

  test("stays fast with thousands of secrets", () => {
    const secrets = Array.from({ length: 5_000 }, (_, index) => `pw-${index}-${index * 7919}`);
    const started = performance.now();
    const hide = secretMask(secrets);
    for (let index = 0; index < 10_000; index++) {
      const name = `Button ${index}`;
      expect(hide(`${name} ${secrets[index] ?? "plain"}`)).toBe(
        `${name} ${secrets[index] ? SECRET_MASK : "plain"}`,
      );
    }
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test("hides the secrets that fit its budget and skips the rest", () => {
    const secrets = Array.from({ length: 30 }, (_, index) => `${index}:`.padEnd(10_000, "x"));
    const hide = secretMask(secrets);
    expect(hide(`a ${secrets[0]} b`)).toBe(`a ${SECRET_MASK} b`);
    expect(hide(secrets[29])).toBe(secrets[29]);
  });
});

// Service vault checks use generated values; assertions never include those values.
import { Vault, scrub, totp } from "../vault.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
test("vault encrypts, scopes, reopens and fails closed after tampering", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vault-check-"));
  const file = path.join(dir, "vault"),
    key = randomBytes(32).toString("hex"),
    secret = randomBytes(24).toString("hex");
  const admin = { name: "admin", admin: true, dailyBudgetBytes: 1 },
    allowed = { name: "mosaic", dailyBudgetBytes: 1 },
    denied = { name: "other", dailyBudgetBytes: 1 };
  try {
    const v = new Vault(file, key);
    await v.put(
      "example",
      { fields: { username: "fixture-account", password: secret }, allowedAgents: ["mosaic"] },
      admin,
    );
    expect((await readFile(file)).includes(Buffer.from(secret))).toBe(false);
    expect(JSON.stringify(await v.list(allowed)).includes(secret)).toBe(false);
    expect((await v.list(denied)).length).toBe(0);
    await expect(v.use("example", denied, async () => true)).rejects.toThrow("unavailable");
    const reopened = new Vault(file, key);
    expect(await reopened.use("example", allowed, async (f) => f.password === secret)).toBe(true);
    expect(scrub(JSON.stringify({ secret })).includes(secret)).toBe(false);
    const bytes = await readFile(file);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(file, bytes);
    const damaged = new Vault(file, key);
    await damaged.ready;
    expect(damaged.status).toBe("locked");
    await expect(
      damaged.put(
        "replacement",
        { fields: { password: "fixture" }, allowedAgents: ["mosaic"] },
        admin,
      ),
    ).rejects.toThrow("locked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("TOTP follows the RFC 6238 timestamp vector", () => {
  expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59000)).toBe("287082");
});
