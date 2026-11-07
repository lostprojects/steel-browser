import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { agentFor } from "./api-key.js";
import { OperationRunner, type Operation } from "../services/operations.js";
const requests = new OperationRunner(() => Date.now(), 128);
export function retryKey(headers: { [key: string]: unknown }): string | undefined {
  const token = headers["idempotency-key"];
  if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(token)))
    throw Object.assign(new Error("Invalid idempotency key"), { statusCode: 400 });
  return token as string | undefined;
}
export function retryOperation<T>(
  owner: string,
  action: string,
  token: string | undefined,
  input: unknown,
  run: (operation?: Operation<any>) => Promise<T>,
): Promise<T> {
  if (token !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(token))
    throw Object.assign(new Error("Invalid idempotency key"), { statusCode: 400 });
  return requests.run<T>(
    {
      key: token === undefined ? undefined : JSON.stringify([owner, action, token]),
      fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      retryBeforeAction: true,
    },
    run,
  );
}
export async function idempotent<T>(
  req: FastifyRequest,
  run: (operation?: Operation<any>) => Promise<T>,
): Promise<T> {
  const token = retryKey(req.headers);
  return retryOperation(
    agentFor(req.raw)?.name ?? "",
    `${req.method}:${req.routeOptions.url}`,
    token,
    { params: req.params, body: req.body },
    run,
  );
}
