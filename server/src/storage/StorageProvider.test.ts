/**
 * StorageProvider.test.ts
 *
 * Unit tests for `validateFile()`.
 *
 * Cases covered:
 *   1. Valid JPEG — passes validation, full content returned on output stream.
 *   2. Valid PNG  — same.
 *   3. Valid PDF  — same.
 *   4. Disallowed MIME type (image/gif) — throws MIME_NOT_ALLOWED.
 *   5. Oversized file detected via sizeHint — throws FILE_TOO_LARGE before
 *      reading any bytes (Content-Length fast-path).
 *   6. Oversized file detected while streaming — throws FILE_TOO_LARGE on
 *      the returned stream after the limit is crossed.
 *   7. Spoofed Content-Type — JPEG bytes sent with mimeType "image/png" →
 *      throws MAGIC_MISMATCH.
 *   8. PDF bytes sent with mimeType "image/jpeg" → throws MAGIC_MISMATCH.
 */

import { Readable, PassThrough } from "stream";
import {
  validateFile,
  FileValidationException,
  MAX_FILE_BYTES,
  ALLOWED_MIME,
} from "./StorageProvider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Magic byte prefixes for each supported type. */
const MAGIC = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  png:  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pdf:  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), // %PDF-1.4
};

/** Builds a Readable from one or more Buffers. */
function makeStream(...parts: Buffer[]): Readable {
  return Readable.from(
    (async function* () {
      for (const p of parts) yield p;
    })(),
  );
}

/**
 * Drains a Readable into a Buffer.
 * Rejects if the stream emits an error (including FileValidationException).
 */
function drain(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Payload smaller than the limit. */
function smallPayload(magic: Buffer, extraBytes = 1024): Buffer {
  return Buffer.concat([magic, Buffer.alloc(extraBytes)]);
}

// ---------------------------------------------------------------------------
// 1 – 3. Valid files
// ---------------------------------------------------------------------------

describe("validateFile — valid files", () => {
  it("accepts a valid JPEG and returns its full content", async () => {
    const payload = smallPayload(MAGIC.jpeg);
    const stream = makeStream(payload);
    const out = await validateFile(stream, "image/jpeg");
    const result = await drain(out);
    expect(result).toEqual(payload);
  });

  it("accepts a valid PNG and returns its full content", async () => {
    const payload = smallPayload(MAGIC.png);
    const stream = makeStream(payload);
    const out = await validateFile(stream, "image/png");
    const result = await drain(out);
    expect(result).toEqual(payload);
  });

  it("accepts a valid PDF and returns its full content", async () => {
    const payload = smallPayload(MAGIC.pdf);
    const stream = makeStream(payload);
    const out = await validateFile(stream, "application/pdf");
    const result = await drain(out);
    expect(result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// 4. Disallowed MIME type
// ---------------------------------------------------------------------------

describe("validateFile — wrong MIME type", () => {
  it("throws MIME_NOT_ALLOWED for image/gif (not in allowlist)", async () => {
    // GIF header: GIF89a
    const gifMagic = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const stream = makeStream(gifMagic, Buffer.alloc(64));

    await expect(validateFile(stream, "image/gif")).rejects.toMatchObject({
      name: "FileValidationException",
      code: "MIME_NOT_ALLOWED",
    });
  });

  it("throws MIME_NOT_ALLOWED for text/plain", async () => {
    const stream = makeStream(Buffer.from("hello world"));
    await expect(validateFile(stream, "text/plain")).rejects.toMatchObject({
      code: "MIME_NOT_ALLOWED",
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Oversized file — Content-Length fast-path
// ---------------------------------------------------------------------------

describe("validateFile — oversized file (sizeHint)", () => {
  it("throws FILE_TOO_LARGE when sizeHint exceeds MAX_FILE_BYTES", async () => {
    const stream = makeStream(MAGIC.jpeg); // content doesn't matter
    await expect(
      validateFile(stream, "image/jpeg", MAX_FILE_BYTES + 1),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("accepts a file whose sizeHint equals MAX_FILE_BYTES exactly", async () => {
    // We only check the sizeHint guard; we don't stream MAX_FILE_BYTES of data.
    const payload = smallPayload(MAGIC.jpeg);
    const stream = makeStream(payload);
    // Passing sizeHint === MAX_FILE_BYTES should not trigger the fast-path.
    const out = await validateFile(stream, "image/jpeg", MAX_FILE_BYTES);
    const result = await drain(out);
    expect(result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// 6. Oversized file — detected while streaming
// ---------------------------------------------------------------------------

describe("validateFile — oversized file (stream)", () => {
  it("destroys the output stream with FILE_TOO_LARGE when data exceeds the limit", async () => {
    // Build a stream that sends valid magic bytes followed by enough data to
    // exceed MAX_FILE_BYTES.
    const filler = Buffer.alloc(MAX_FILE_BYTES); // exactly at limit → needs +1 to trigger
    const extraByte = Buffer.alloc(1, 0xab);
    const stream = makeStream(MAGIC.jpeg, filler, extraByte);

    const out = await validateFile(stream, "image/jpeg");

    await expect(drain(out)).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });
});

// ---------------------------------------------------------------------------
// 7 – 8. Spoofed Content-Type
// ---------------------------------------------------------------------------

describe("validateFile — spoofed Content-Type", () => {
  it("throws MAGIC_MISMATCH when JPEG bytes are declared as image/png", async () => {
    // JPEG magic but we claim PNG
    const stream = makeStream(MAGIC.jpeg, Buffer.alloc(64));
    await expect(validateFile(stream, "image/png")).rejects.toMatchObject({
      code: "MAGIC_MISMATCH",
    });
  });

  it("throws MAGIC_MISMATCH when PDF bytes are declared as image/jpeg", async () => {
    const stream = makeStream(MAGIC.pdf, Buffer.alloc(64));
    await expect(validateFile(stream, "image/jpeg")).rejects.toMatchObject({
      code: "MAGIC_MISMATCH",
    });
  });

  it("throws MAGIC_MISMATCH when PNG bytes are declared as application/pdf", async () => {
    const stream = makeStream(MAGIC.png, Buffer.alloc(64));
    await expect(validateFile(stream, "application/pdf")).rejects.toMatchObject({
      code: "MAGIC_MISMATCH",
    });
  });
});

// ---------------------------------------------------------------------------
// 9. ALLOWED_MIME and MAX_FILE_BYTES exports are correct
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("ALLOWED_MIME contains exactly the three accepted types", () => {
    expect([...ALLOWED_MIME].sort()).toEqual(
      ["application/pdf", "image/jpeg", "image/png"].sort(),
    );
  });

  it("MAX_FILE_BYTES is 10 MB", () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});
