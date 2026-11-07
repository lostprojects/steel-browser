// Queue authorization uses digests of existing client keys. The executor gets
// one job-control credential and cannot use it on browser or vault endpoints.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { currentOrganization } from "../organization.js";

export const credentialDigest = (key: string) => createHash("sha256").update(key).digest("hex");
function same(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function activeJobCredential(row: any) {
  const digest = row.auth_binding?.keyHash;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return false;
  const named = JSON.parse(process.env.STEEL_AGENT_KEYS ?? "[]") as { key: string }[];
  return [process.env.STEEL_API_KEY, ...named.map((entry) => entry.key)].some(
    (key) => key && same(credentialDigest(key), digest),
  );
}
export function jobWorkerAuthorized(req: IncomingMessage) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method !== "POST" || !/^\/internal\/jobs\/(ready|[a-f0-9-]{36}\/authorize)$/.test(path))
    return false;
  const key = process.env.TOOLSTACK_JOBS_WORKER_KEY;
  const supplied = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  return (
    !!key &&
    key.length >= 32 &&
    !!supplied &&
    supplied.length <= 256 &&
    same(supplied, key) &&
    req.headers["x-toolstack-org-id"] === currentOrganization().id
  );
}
