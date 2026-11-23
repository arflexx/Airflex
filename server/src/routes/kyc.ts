/**
 * kyc.ts — issue #248
 *
 * KYC document upload route.  File storage is now handled through the
 * StorageProvider abstraction so the route is decoupled from the local
 * filesystem.  The concrete implementation (S3 vs local) is selected at
 * server startup via the STORAGE_PROVIDER environment variable.
 *
 * `kyc_document_path` now stores the object-store key (e.g.
 * "kyc/2024/07/<uuid>.jpg") rather than an absolute filesystem path.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import Busboy from "busboy";
import { PassThrough } from "stream";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { rateLimitKyc } from "../middleware/rateLimitKyc";
import { getStorageProvider, MAX_FILE_BYTES, ALLOWED_MIME } from "../storage";
import logger from "../utils/logger";

const router = Router();


interface KycFields {
  legalName?: string;
  dateOfBirth?: string;
  nin?: string;
}

interface ParsedMultipart {
  fields: KycFields;
  /** Object-store key if a valid file was uploaded, null otherwise */
  objectKey: string | null;
  fileError: string | null;
}

/**
 * Streams the multipart body through Busboy.  When a valid document file is
 * encountered it is piped directly into the StorageProvider — no temporary
 * disk writes required.
 *
 * The function resolves after the entire body has been consumed.
 */
function parseAndUploadMultipart(req: AuthenticatedRequest): Promise<ParsedMultipart> {
  return new Promise((resolve, reject) => {
    const fields: KycFields = {};
    let objectKey: string | null = null;
    let fileError: string | null = null;

    // Track the in-flight upload promise so we can await it in `finish`.
    let uploadPromise: Promise<void> | null = null;

    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_BYTES, files: 1 },
    });

    busboy.on("field", (name, value) => {
      if (name === "legalName" || name === "dateOfBirth" || name === "nin") {
        fields[name as keyof KycFields] = value;
      }
    });

    busboy.on("file", (name, file, info) => {
      if (name !== "document") {
        file.resume();
        return;
      }

      const { mimeType } = info;
      if (!ALLOWED_MIME.has(mimeType)) {
        fileError = "Only JPEG, PNG, or PDF files are accepted.";
        file.resume();
        return;
      }

      const ext = mimeType === "image/png" ? "png" : mimeType === "application/pdf" ? "pdf" : "jpg";
      // Use a date-partitioned key for logical separation in the bucket.
      const date = new Date();
      const ymd = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
      const key = `kyc/${ymd}/${randomUUID()}.${ext}`;

      // Pipe through a PassThrough so we can listen for the `limit` event
      // without breaking the upload stream.
      const pass = new PassThrough();
      let limitHit = false;

      file.on("limit", () => {
        limitHit = true;
        fileError = `File size must not exceed ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
        pass.destroy(new Error("file_too_large"));
      });

      file.pipe(pass);

      const storage = getStorageProvider();
      uploadPromise = storage
        .upload(key, pass, { contentType: mimeType })
        .then(() => {
          if (!limitHit) {
            objectKey = key;
          } else {
            // Best-effort cleanup — object may be partially written
            void storage.delete(key).catch(() => undefined);
          }
        });
    });

    busboy.on("finish", () => {
      // Wait for any in-flight upload to settle before resolving.
      Promise.resolve(uploadPromise)
        .then(() => resolve({ fields, objectKey, fileError }))
        .catch(reject);
    });

    busboy.on("error", reject);

    req.pipe(busboy);
  });
}

function validateFields(fields: KycFields, hasFile: boolean): string | null {
  const name = fields.legalName?.trim() ?? "";
  if (!name || name.split(/\s+/).filter(Boolean).length < 2) {
    return "Full legal name must contain at least two words.";
  }

  if (!fields.dateOfBirth) {
    return "Date of birth is required.";
  }

  const dob = new Date(fields.dateOfBirth);
  if (Number.isNaN(dob.getTime()) || dob >= new Date()) {
    return "Enter a valid date of birth.";
  }

  const nin = fields.nin?.trim() ?? "";
  if (!/^\d{11}$/.test(nin)) {
    return "NIN must be exactly 11 digits.";
  }

  if (!hasFile) {
    return "Document photo is required.";
  }

  return null;
}

// ---------------------------------------------------------------------------
// POST /api/v1/kyc/submit
// ---------------------------------------------------------------------------

router.post("/submit", authenticate, rateLimitKyc, async (req, res) => {
  const { sub: userId } = (req as AuthenticatedRequest).user;

  let parsed: ParsedMultipart;
  try {
    parsed = await parseAndUploadMultipart(req as AuthenticatedRequest);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[kyc] multipart parse/upload failed");
    res.status(400).json({ error: "Invalid multipart form data or upload error." });
    return;
  }

  if (parsed.fileError) {
    // If the upload started before the error was detected, delete the partial
    // object from the store.
    if (parsed.objectKey) {
      void getStorageProvider()
        .delete(parsed.objectKey)
        .catch((e: Error) =>
          logger.warn({ key: parsed.objectKey, err: e.message }, "[kyc] partial object cleanup failed")
        );
    }
    res.status(422).json({ error: parsed.fileError });
    return;
  }

  const validationError = validateFields(parsed.fields, Boolean(parsed.objectKey));
  if (validationError) {
    // No file was uploaded to the store if validation fails here, but guard
    // defensively in case a file was uploaded before field validation ran.
    if (parsed.objectKey) {
      void getStorageProvider()
        .delete(parsed.objectKey)
        .catch((e: Error) =>
          logger.warn({ key: parsed.objectKey, err: e.message }, "[kyc] cleanup failed after field validation error")
        );
    }
    res.status(422).json({ error: validationError });
    return;
  }

  const { rows: existing } = await pool.query<{
    kyc_status: string | null;
    kyc_document_path: string | null;
  }>(
    `SELECT kyc_status, kyc_document_path FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (!existing.length) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (existing[0]!.kyc_status === "verified") {
    // Discard the freshly uploaded file — it will never be used.
    if (parsed.objectKey) {
      void getStorageProvider()
        .delete(parsed.objectKey)
        .catch(() => undefined);
    }
    res.status(400).json({ error: "KYC is already verified." });
    return;
  }

  if (existing[0]!.kyc_status === "pending") {
    if (parsed.objectKey) {
      void getStorageProvider()
        .delete(parsed.objectKey)
        .catch(() => undefined);
    }
    res.status(400).json({ error: "KYC submission is already pending review." });
    return;
  }

  // If the user has a previous rejected submission with a stored document,
  // remove the old object from the store before writing the new key.
  const previousKey = existing[0]!.kyc_document_path;
  if (previousKey && previousKey !== parsed.objectKey) {
    void getStorageProvider()
      .delete(previousKey)
      .catch((e: Error) =>
        logger.warn({ key: previousKey, err: e.message }, "[kyc] old document cleanup failed")
      );
  }

  // `kyc_document_path` now stores the object-store key, not a filesystem path.
  await pool.query(
    `UPDATE users
     SET kyc_status        = 'pending',
         kyc_legal_name    = $1,
         kyc_date_of_birth = $2,
         kyc_nin           = $3,
         kyc_document_path = $4,
         updated_at        = NOW()
     WHERE id = $5`,
    [
      parsed.fields.legalName!.trim(),
      parsed.fields.dateOfBirth,
      parsed.fields.nin!.trim(),
      parsed.objectKey,   // object-store key, e.g. "kyc/2024/07/<uuid>.jpg"
      userId,
    ]
  );

  logger.info({ userId, key: parsed.objectKey }, "[kyc] submission received");

  res.status(200).json({
    message: "KYC submitted successfully. Pending admin review.",
    kycStatus: "pending",
  });
});

export default router;
