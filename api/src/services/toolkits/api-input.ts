import { z } from "zod";
import { connectionId } from "../connection-store.js";

export const apiConnectionId = connectionId.refine(
  (value) => value.startsWith("api:"),
  "Select an API connection",
);
export const apiActionInput = z
  .object({
    connection: apiConnectionId,
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    timeoutMs: z.number().int().min(1000).max(60_000).default(30_000),
  })
  .strict();
