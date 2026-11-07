// Shared configuration contains explicitly published credentials and defaults only.
// Never send profiles, cookies, usage or login observations to the shared service.
import { z } from "zod";
import { currentOrganization } from "./organization.js";

export const storeName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .refine((value) => !["constructor", "prototype", "__proto__"].includes(value));
export const credentialFields = z
  .record(storeName, z.string().min(1).max(8192))
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 24);
export const sharedSite = z
  .object({
    site: storeName,
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }),
    identity: storeName.nullable().default(null),
    mode: z.enum(["agent", "quiet"]).default("agent"),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .default(null),
    loginSite: z
      .enum(["ancestry", "newspapers", "fold3", "mary-ferrell", "hathitrust-google"])
      .nullable()
      .default(null),
    startRung: z.number().int().min(1).max(3).default(1),
  })
  .strict();
export const sharedSnapshot = z
  .object({
    credentials: z.record(storeName, credentialFields),
    sites: z.record(z.string().regex(/^[a-z0-9.-]{1,253}$/), sharedSite),
  })
  .strict();
export type SharedSnapshot = z.infer<typeof sharedSnapshot>;
const empty: SharedSnapshot = { credentials: {}, sites: {} };

export function sharedStoreConnection() {
  const origin = process.env.STEEL_SHARED_URL;
  const key = process.env.STEEL_SHARED_KEY;
  if (!origin && !key) return;
  if (!origin || !key) throw new Error("Shared store configuration is incomplete");
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        process.env.NODE_ENV !== "production"
      ))
  )
    throw new Error("Shared store requires an HTTPS origin");
  return { url, key };
}

// Metadata reads share a bounded 15s cache. Execution resolves fresh grants;
// neither path falls back to stale data after a failed fetch.
let cached: { value: SharedSnapshot; expires: number; binding: string } | undefined;
let pending: { binding: string; promise: Promise<SharedSnapshot> } | undefined;
export async function readSharedStore(fresh = false): Promise<SharedSnapshot> {
  const connection = sharedStoreConnection();
  if (!connection) return empty;
  const { url, key } = connection;
  const binding = `${currentOrganization().id}:${url.origin}:${key}`;
  if (!fresh && cached && cached.binding === binding && cached.expires > Date.now())
    return cached.value;
  const request = async () => {
    const response = await fetch(new URL("/internal/shared", url), {
      headers: { authorization: `Bearer ${key}`, "x-toolstack-org-id": currentOrganization().id },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Shared store unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      if (size > 4_000_000) throw new Error("Shared store response exceeds its limit");
      chunks.push(chunk);
    }
    const value = sharedSnapshot.parse(JSON.parse(Buffer.concat(chunks).toString()));
    cached = { value, expires: Date.now() + 15_000, binding };
    return value;
  };
  // Resolve shared secrets against current grants at dispatch. Metadata can use
  // the short cache; secret supply must not reuse an earlier in-flight read.
  if (fresh) return request();
  if (!pending || pending.binding !== binding) pending = { binding, promise: request() };
  const active = pending;
  try {
    return await active.promise;
  } finally {
    if (pending === active) pending = undefined;
  }
}
