/**
 * S3StorageProvider.ts — issue #248
 *
 * Default storage backend for production.  Uses the AWS SDK v3 S3 client,
 * which works with any S3-compatible store (AWS S3, MinIO, Cloudflare R2, etc.)
 *
 * Required env vars:
 *   S3_BUCKET      — bucket name
 *   S3_REGION      — AWS region or custom region string (e.g. "auto" for R2)
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *
 * Optional env vars:
 *   S3_ENDPOINT    — custom endpoint URL for non-AWS S3-compatible stores
 *
 * Dependencies (add to server/package.json):
 *   "@aws-sdk/client-s3": "^3.600.0"
 *   "@aws-sdk/lib-storage": "^3.600.0"
 *
 * File validation is performed via `validateFile()` before any bytes are sent
 * to S3, so rejected files never reach the bucket.
 */

import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";
import {
  validateFile,
  type StorageProvider,
  type UploadOptions,
  type UploadResult,
} from "./StorageProvider";
import logger from "../utils/logger";

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const bucket = process.env["S3_BUCKET"];
    const region = process.env["S3_REGION"];

    if (!bucket) throw new Error("[S3StorageProvider] S3_BUCKET is not set");
    if (!region) throw new Error("[S3StorageProvider] S3_REGION is not set");

    this.bucket = bucket;

    const endpoint = process.env["S3_ENDPOINT"];

    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  async upload(key: string, stream: Readable, opts: UploadOptions): Promise<UploadResult> {
    // Validate before touching S3 — throws FileValidationException on failure,
    // so nothing is uploaded on rejection.
    const validatedStream = await validateFile(stream, opts.contentType, opts.size);

    logger.debug({ bucket: this.bucket, key }, "[S3Storage] Uploading object");

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: validatedStream,
        ContentType: opts.contentType,
        Metadata: opts.metadata ?? {},
        // Objects are private by default — presigned URLs for admin access
        // should be generated server-side and never exposed to clients.
        ACL: "private",
        ServerSideEncryption: "AES256",
      },
    });

    await upload.done();

    logger.info({ bucket: this.bucket, key }, "[S3Storage] Upload complete");

    return { key };
  }

  async delete(key: string): Promise<void> {
    logger.debug({ bucket: this.bucket, key }, "[S3Storage] Deleting object");

    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );

    logger.info({ bucket: this.bucket, key }, "[S3Storage] Deleted object");
  }
}
