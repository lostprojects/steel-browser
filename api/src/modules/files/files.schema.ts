import { z } from "zod";

const FileUploadRequest = z.object({
  file: z.any().optional().describe("The file to upload (binary) or URL string to download from"),
  path: z.string().optional().describe("Path to the file in the storage system"),
});

const FileDetails = z.object({
  name: z.string().optional().describe("Original browser download name."),
  path: z.string().describe("Path to the file in the storage system"),
  size: z.number().describe("Size of the file in bytes"),
  lastModified: z.string().datetime().describe("Timestamp when the file was last updated"),
});

const MultipleFiles = z.object({
  data: z.array(FileDetails).describe("Array of files for the current page"),
});

const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use an HTTP URL without credentials");

export const TransferRequest = z
  .object({
    file: z.string().min(1).max(255).optional(),
    url: httpUrl.optional(),
    name: z.string().min(1).max(255).optional(),
    referer: httpUrl.optional(),
  })
  .strict()
  .refine((value) => !!value.file !== !!value.url, "Supply one file or URL");

export const TransferAck = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

const DeliveryDetails = z.object({
  id: z.string().uuid(),
  session: z.string().uuid(),
  state: z.enum(["receiving", "ready", "acknowledged", "failed", "cancelled", "expired"]),
  name: z.string(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  route: z.string().optional(),
  expiresAt: z.string().datetime(),
  error: z.string().optional(),
  statusUri: z.string().url(),
  handoff: z.boolean(),
  webUri: z.string().url().optional(),
  uri: z.string().url().optional(),
  acknowledgeUri: z.string().url().optional(),
  requiresAuthentication: z.literal(true),
});

export const filesSchemas = {
  FileUploadRequest,
  FileDetails,
  MultipleFiles,
  TransferRequest,
  TransferAck,
  DeliveryDetails,
};

export default filesSchemas;
