/**
 * storage/index.ts — issue #248
 *
 * Resolves and exports a singleton StorageProvider instance chosen at
 * server startup based on the STORAGE_PROVIDER environment variable.
 *
 *   STORAGE_PROVIDER=s3    (default) → S3StorageProvider
 *   STORAGE_PROVIDER=local           → LocalStorageProvider (dev only)
 *
 * All application code imports `storageProvider` from here — never
 * instantiates a concrete provider directly.  This makes it trivial to add
 * future backends (GCS, Azure Blob, etc.) without touching callers.
 */

import type { StorageProvider } from "./StorageProvider";

let _provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (_provider) return _provider;

  const backend = (process.env["STORAGE_PROVIDER"] ?? "s3").toLowerCase();

  if (backend === "local") {
    // Lazy import — keeps @aws-sdk out of the local dev require tree
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalStorageProvider } = require("./LocalStorageProvider") as typeof import("./LocalStorageProvider");
    _provider = new LocalStorageProvider();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { S3StorageProvider } = require("./S3StorageProvider") as typeof import("./S3StorageProvider");
    _provider = new S3StorageProvider();
  }

  return _provider;
}

// Convenience re-exports
export type { StorageProvider, UploadOptions, UploadResult } from "./StorageProvider";
export {
  validateFile,
  FileValidationException,
  MAX_FILE_BYTES,
  ALLOWED_MIME,
} from "./StorageProvider";
export type { FileValidationError } from "./StorageProvider";
