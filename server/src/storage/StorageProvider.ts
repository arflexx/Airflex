/**
 * StorageProvider.ts — issue #248
 *
 * Defines the interface every storage backend must satisfy.  The KYC upload
 * route calls only this interface; the concrete implementation is chosen at
 * server startup via the STORAGE_PROVIDER environment variable.
 *
 * Implementations:
 *   S3StorageProvider    — default, uses an S3-compatible object store
 *   LocalStorageProvider — development fallback, writes to the local filesystem
 *
 * File validation
 * ───────────────
 * `validateFile()` is the single source of truth for all upload safety checks.
 * Both providers call it at the top of `upload()` — before any bytes are
 * written to disk or sent to S3 — so a rejected file never touches storage.
 *
 * Rules enforced:
 *   • MIME type must be in ALLOWED_MIME (checked via magic bytes, not the
 *     Content-Type header supplied by the client).
 *   • File must not exceed MAX_FILE_BYTES (10 MB).
 *
 * Magic-byte signatures (all offsets are 0-indexed):
 *   JPEG  — FF D8 FF
 *   PNG   — 89 50 4E 47 0D 0A 1A 0A
 *   PDF   — 25 50 44 46 2D  (%PDF-)
 */

import { PassThrough } from "stream";
import type { Readable } from "stream";

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

/** Maximum accepted upload size in bytes (10 MB). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** MIME types accepted for KYC document uploads. */
export const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "application/pdf",
]);

// Magic-byte signatures: each entry maps a MIME type to the byte sequence
// that must appear at offset 0 of a valid file.
const MAGIC: Array<{ mime: string; bytes: readonly number[] }> = [
  { mime: "image/jpeg",      bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png",       bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
];

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------

/** Reasons a file can be rejected. */
export type FileValidationError =
  | "FILE_TOO_LARGE"
  | "MIME_NOT_ALLOWED"
  | "MAGIC_MISMATCH";

export class FileValidationException extends Error {
  constructor(
    public readonly code: FileValidationError,
    message: string,
  ) {
    super(message);
    this.name = "FileValidationException";
  }
}

/**
 * Buffers the leading bytes of `stream`, validates size and magic bytes, then
 * returns a new Readable that replays those bytes followed by the rest of the
 * original stream.  Throws `FileValidationException` before any bytes are
 * forwarded to storage on failure — nothing is written in that case.
 *
 * @param stream       Incoming file stream.
 * @param declaredMime MIME type declared by the client (Content-Type / Busboy).
 *                     Used to pick the expected magic signature; the actual
 *                     file header is always verified independently.
 * @param sizeHint     Optional known file size in bytes (from Content-Length).
 *                     When provided, an oversized file is rejected immediately
 *                     without reading any bytes.
 */
export async function validateFile(
  stream: Readable,
  declaredMime: string,
  sizeHint?: number,
): Promise<Readable> {
  // Fast-path: reject based on declared MIME before reading anything.
  if (!ALLOWED_MIME.has(declaredMime)) {
    stream.resume(); // drain so the HTTP connection is not left in a broken state
    throw new FileValidationException(
      "MIME_NOT_ALLOWED",
      `File type "${declaredMime}" is not accepted. Allowed types: ${[...ALLOWED_MIME].join(", ")}.`,
    );
  }

  // Fast-path: reject based on Content-Length before reading.
  if (sizeHint !== undefined && sizeHint > MAX_FILE_BYTES) {
    stream.resume();
    throw new FileValidationException(
      "FILE_TOO_LARGE",
      `File exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit.`,
    );
  }

  // Buffer just enough bytes for the longest magic signature.
  const magicLen = Math.max(...MAGIC.map((m) => m.bytes.length));
  const header = await readExactly(stream, magicLen);

  // Verify magic bytes against the declared MIME type.
  const signature = MAGIC.find((m) => m.mime === declaredMime);
  if (!signature) {
    // Unreachable given the ALLOWED_MIME check above, but guard defensively.
    stream.resume();
    throw new FileValidationException(
      "MIME_NOT_ALLOWED",
      `No magic signature defined for "${declaredMime}".`,
    );
  }

  const matches = signature.bytes.every((b, i) => header[i] === b);
  if (!matches) {
    // Header bytes don't match the declared type — likely a spoofed Content-Type.
    stream.resume();
    throw new FileValidationException(
      "MAGIC_MISMATCH",
      `File header does not match declared type "${declaredMime}". Possible Content-Type spoofing.`,
    );
  }

  // Reassemble: prepend the already-read header bytes back onto the stream.
  const reassembled = new PassThrough();

  reassembled.write(header);

  let bytesRead = header.length;
  let limitExceeded = false;

  stream.on("data", (chunk: Buffer) => {
    bytesRead += (chunk as Buffer).length;
    if (!limitExceeded && bytesRead > MAX_FILE_BYTES) {
      limitExceeded = true;
      reassembled.destroy(
        new FileValidationException(
          "FILE_TOO_LARGE",
          `File exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit.`,
        ),
      );
      stream.destroy();
      return;
    }
    reassembled.write(chunk);
  });

  stream.on("end", () => reassembled.end());
  stream.on("error", (err) => reassembled.destroy(err));

  // `readExactly` left the stream paused after buffering the header.
  // Resume it now so the remaining bytes flow through to `reassembled`.
  stream.resume();

  return reassembled;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads up to `n` bytes from `stream`.  Returns fewer bytes only when the
 * stream ends before `n` bytes are available (small files).
 */
function readExactly(stream: Readable, n: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) {
        stream.pause();
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
        resolve(Buffer.concat(chunks));
      }
    };

    const onEnd = () => resolve(Buffer.concat(chunks));
    const onError = (err: Error) => reject(err);

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

export interface UploadOptions {
  /** MIME type of the file, e.g. "image/jpeg" */
  contentType: string;
  /** Optional known file size in bytes (from Content-Length). */
  size?: number;
  /** Arbitrary key-value metadata stored alongside the object */
  metadata?: Record<string, string>;
}

export interface UploadResult {
  /**
   * The object store key (not a filesystem path).
   * Stored in `users.kyc_document_path`.
   * Example: "kyc/2024/07/abcd-1234.jpg"
   */
  key: string;
}

export interface StorageProvider {
  /**
   * Validates then uploads a readable stream, returning the object store key.
   * Throws `FileValidationException` if validation fails — no bytes are
   * written to storage in that case.
   *
   * @param key    Destination key inside the bucket / directory.
   * @param stream Readable stream of file contents.
   * @param opts   Content-type, optional size hint, and optional metadata.
   */
  upload(key: string, stream: Readable, opts: UploadOptions): Promise<UploadResult>;

  /**
   * Deletes an object by key.  Used when a KYC submission is superseded.
   * Implementations should not throw if the key does not exist.
   */
  delete(key: string): Promise<void>;
}
