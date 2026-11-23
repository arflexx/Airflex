/**
 * LocalStorageProvider.ts — issue #248
 *
 * Development-only storage backend.  Writes files to the local filesystem
 * under `uploads/kyc/` — the same directory used before this abstraction was
 * introduced — so local dev workflows are unchanged.
 *
 * Activated by setting:  STORAGE_PROVIDER=local
 *
 * NEVER use this in production or any replicated deployment.  Stored files
 * are not replicated across instances and are lost on container restart.
 *
 * File validation is performed via `validateFile()` before any bytes are
 * written to disk, so rejected files never touch the filesystem.
 */

import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import type { Readable } from "stream";
import {
  validateFile,
  type StorageProvider,
  type UploadOptions,
  type UploadResult,
} from "./StorageProvider";
import logger from "../utils/logger";

export class LocalStorageProvider implements StorageProvider {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), "uploads", "kyc");
  }

  async upload(key: string, stream: Readable, opts: UploadOptions): Promise<UploadResult> {
    // Validate before touching the filesystem — throws FileValidationException
    // on failure, so nothing is written on rejection.
    const validatedStream = await validateFile(stream, opts.contentType, opts.size);

    // The `key` may include sub-directories, e.g. "kyc/2024/07/uuid.jpg"
    const filePath = join(this.baseDir, key);
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStream(filePath);
      validatedStream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      validatedStream.on("error", reject);
    });

    logger.debug({ filePath, key }, "[LocalStorage] File written");

    return { key };
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.baseDir, key);
    try {
      unlinkSync(filePath);
      logger.debug({ filePath, key }, "[LocalStorage] File deleted");
    } catch (err) {
      // ENOENT — already gone; not an error for a delete operation
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}
