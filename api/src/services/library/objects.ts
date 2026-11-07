// Wasabi credentials and the content encryption key belong only to the central
// library service. Worker runtimes and uploaded scripts must not receive them.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { maxFileBytes } from "./contracts.js";

export interface LibraryObjects {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  close(): void;
}
export class WasabiObjects implements LibraryObjects {
  private readonly client: S3Client;
  private readonly key: Buffer;
  constructor(
    private readonly bucket: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
    key: string,
  ) {
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      !/^[a-z]{2}-[a-z]+-\d+$/.test(region) ||
      !accessKeyId ||
      !secretAccessKey ||
      !/^[a-fA-F0-9]{64}$/.test(key)
    )
      throw new Error("Incomplete Toolstack Wasabi/encryption configuration");
    this.key = Buffer.from(key, "hex");
    this.client = new S3Client({
      region,
      endpoint:
        region === "us-east-1" ? "https://s3.wasabisys.com" : `https://s3.${region}.wasabisys.com`,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { connectionTimeout: 15_000, requestTimeout: 60_000 },
    });
  }
  async put(key: string, data: Buffer) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const payload = Buffer.concat([Buffer.from("TC01"), iv, cipher.getAuthTag(), ciphertext]);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: payload,
        ContentType: "application/octet-stream",
        ContentLength: payload.length,
        ContentMD5: createHash("md5").update(payload).digest("base64"),
      }),
      { abortSignal: AbortSignal.timeout(60_000) },
    );
  }
  async get(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(60_000),
    });
    if (!result.Body) throw new Error("Stored object is unavailable");
    const stream = result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > maxFileBytes + 64) throw new Error("Stored object exceeds its byte budget");
        chunks.push(chunk);
      }
    } finally {
      stream.destroy?.();
    }
    const payload = Buffer.concat(chunks);
    if (payload.subarray(0, 4).toString() !== "TC01" || payload.length < 32)
      throw new Error("Stored object format is invalid");
    const cipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(4, 16));
    cipher.setAAD(Buffer.from(key));
    cipher.setAuthTag(payload.subarray(16, 32));
    return Buffer.concat([cipher.update(payload.subarray(32)), cipher.final()]);
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(60_000),
    });
  }
  close() {
    this.client.destroy();
  }
}
