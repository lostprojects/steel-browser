import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { agentFor } from "./api-key.js";
const requests = new Map<
  string,
  { fingerprint: string; promise: Promise<unknown>; expires: number }
>();
export async function idempotent<T>(req: FastifyRequest, run: () => Promise<T>): Promise<T> {
  const token = req.headers["idempotency-key"];
  if (!token) return run();
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(token))
    throw Object.assign(new Error("Invalid idempotency key"), { statusCode: 400 });
  for (const [key, entry] of requests) if (entry.expires < Date.now()) requests.delete(key);
  const key = `${agentFor(req.raw)?.name}:${req.method}:${req.routeOptions.url}:${token}`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ params: req.params, body: req.body }))
    .digest("hex");
  const previous = requests.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw Object.assign(new Error("Idempotency key reused with different arguments"), {
        statusCode: 409,
      });
    return previous.promise as Promise<T>;
  }
  if (requests.size >= 128)
    throw Object.assign(new Error("Too many recent idempotent operations"), { statusCode: 429 });
  const promise = run();
  const entry = { fingerprint, promise, expires: Number.POSITIVE_INFINITY };
  requests.set(key, entry);
  try {
    const result = await promise;
    entry.expires = Date.now() + 600_000;
    return result;
  } catch (error) {
    requests.delete(key);
    throw error;
  }
}
