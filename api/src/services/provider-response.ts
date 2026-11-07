import { z } from "zod";
import { PublicError } from "../utils/public-error.js";

// Bounded, validated provider data. Callers own status mapping and fixed origins;
// raw response bodies and parser errors must not become public failures.
export async function providerJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  label: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new PublicError("provider_invalid_response", `${label} returned an empty response`, 502);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new PublicError(
          "provider_response_too_large",
          `${label} response exceeded the size limit`,
          502,
        );
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new PublicError("provider_invalid_response", `${label} returned an invalid result`, 502);
  }
}
