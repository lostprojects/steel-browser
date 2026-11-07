import { z } from "zod";

export enum StorageProviderName {
  Cookies = "cookies",
  LocalStorage = "localStorage",
  SessionStorage = "sessionStorage",
  IndexedDB = "indexedDB",
}

// CDP related schemas
export const CDPSameSite = z.enum(["Strict", "Lax", "None"]);
export const CDPCookiePriority = z.enum(["Low", "Medium", "High"]);
export const CDPSourceScheme = z.enum(["Unset", "NonSecure", "Secure"]);

/**
 * CDP Network.Cookie schema
 * @see https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-Cookie
 */
export const CDPCookieSchema = z.object({
  name: z.string().describe("The name of the cookie"),
  value: z.string().describe("The value of the cookie"),
  url: z.string().optional().describe("The URL of the cookie"),
  domain: z.string().optional().describe("The domain of the cookie"),
  path: z.string().optional().describe("The path of the cookie"),
  secure: z.boolean().optional().describe("Whether the cookie is secure"),
  httpOnly: z.boolean().optional().describe("Whether the cookie is HTTP only"),
  sameSite: CDPSameSite.optional().describe("The same site attribute of the cookie"),
  size: z.number().optional().describe("The size of the cookie"),
  expires: z.number().optional().describe("The expiration date of the cookie"),
  partitionKey: z
    .object({
      topLevelSite: z
        .string()
        .describe(
          "The site of the top-level URL the browser was visiting at the start of the request to the endpoint that set the cookie.",
        ),
      hasCrossSiteAncestor: z
        .boolean()
        .describe(
          "Indicates if the cookie has any ancestors that are cross-site to the topLevelSite.",
        ),
    })
    .optional()
    .describe("The partition key of the cookie"),
  session: z.boolean().optional().describe("Whether the cookie is a session cookie"),
  priority: CDPCookiePriority.optional().describe("The priority of the cookie"),
  sameParty: z.boolean().optional().describe("Whether the cookie is a same party cookie"),
  sourceScheme: CDPSourceScheme.optional().describe("The source scheme of the cookie"),
  sourcePort: z.number().optional().describe("The source port of the cookie"),
});

// IndexedDB related schemas
export const IndexedDBBlobFileSchema = z.object({
  blobNumber: z.number(),
  mimeType: z.string(),
  size: z.number(),
  filename: z.string().optional(),
  lastModified: z.date().optional(),
  path: z.string().optional(),
});

export const IndexedDBRecordSchema = z.object({
  key: z.any().optional(),
  value: z.any().optional(),
  blobFiles: z.array(IndexedDBBlobFileSchema).optional(),
});

export const IndexedDBObjectStoreSchema = z.object({
  id: z.number(),
  name: z.string(),
  records: z.array(IndexedDBRecordSchema),
});

export const IndexedDBDatabaseSchema = z.object({
  id: z.number(),
  name: z.string(),
  data: z.array(IndexedDBObjectStoreSchema),
});

export const SessionContextSchema = z.object({
  [StorageProviderName.Cookies]: z
    .array(CDPCookieSchema)
    .optional()
    .describe("Cookies to initialize in the session"),
  [StorageProviderName.LocalStorage]: z
    .record(z.string(), z.record(z.string(), z.string()))
    .optional()
    .describe("Domain-specific localStorage items to initialize in the session"),
  [StorageProviderName.SessionStorage]: z
    .record(z.string(), z.record(z.string(), z.string()))
    .optional()
    .describe("Domain-specific sessionStorage items to initialize in the session"),
  [StorageProviderName.IndexedDB]: z
    .record(z.string(), z.array(IndexedDBDatabaseSchema))
    .optional()
    .describe(
      "Legacy context field; named profiles preserve IndexedDB, but context injection does not restore it",
    ),
});

export type IndexedDBDatabase = z.infer<typeof IndexedDBDatabaseSchema>;
export type LocalStorageData = Record<string, string>;
export type SessionStorageData = Record<string, string>;
export type SessionData = z.infer<typeof SessionContextSchema>;
