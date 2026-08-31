import { Router } from "express";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import Busboy from "busboy";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import logger from "../utils/logger";

const router = Router();

const UPLOAD_DIR = join(process.cwd(), "uploads", "kyc");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME = new Set(["image/jpeg", "image/png"]);

interface KycFields {
  legalName?: string;
  dateOfBirth?: string;
  nin?: string;
}

function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function parseMultipart(
  req: AuthenticatedRequest
): Promise<{ fields: KycFields; filePath: string | null; fileError: string | null }> {
  return new Promise((resolve, reject) => {
    const fields: KycFields = {};
    let filePath: string | null = null;
    let fileError: string | null = null;

    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_BYTES, files: 1 },
    });

    busboy.on("field", (name, value) => {
      if (name === "legalName" || name === "dateOfBirth" || name === "nin") {
        fields[name] = value;
      }
    });

    busboy.on("file", (name, file, info) => {
      if (name !== "document") {
        file.resume();
        return;
      }

      const { mimeType } = info;
      if (!ACCEPTED_MIME.has(mimeType)) {
        fileError = "Only JPEG or PNG images are accepted.";
        file.resume();
        return;
      }

      ensureUploadDir();
      const ext = mimeType === "image/png" ? "png" : "jpg";
      filePath = join(UPLOAD_DIR, `${randomUUID()}.${ext}`);
      const stream = createWriteStream(filePath);

      file.on("limit", () => {
        fileError = "File size must not exceed 5 MB.";
        stream.destroy();
      });

      file.pipe(stream);
    });

    busboy.on("finish", () => resolve({ fields, filePath, fileError }));
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

// POST /api/kyc/submit
router.post("/submit", authenticate, async (req, res) => {
  const { sub: userId } = (req as AuthenticatedRequest).user;

  let parsed: Awaited<ReturnType<typeof parseMultipart>>;
  try {
    parsed = await parseMultipart(req as AuthenticatedRequest);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[kyc] multipart parse failed");
    res.status(400).json({ error: "Invalid multipart form data." });
    return;
  }

  if (parsed.fileError) {
    res.status(422).json({ error: parsed.fileError });
    return;
  }

  const validationError = validateFields(parsed.fields, Boolean(parsed.filePath));
  if (validationError) {
    res.status(422).json({ error: validationError });
    return;
  }

  const { rows: existing } = await pool.query<{ kyc_status: string | null }>(
    `SELECT kyc_status FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (!existing.length) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (existing[0]!.kyc_status === "verified") {
    res.status(400).json({ error: "KYC is already verified." });
    return;
  }

  if (existing[0]!.kyc_status === "pending") {
    res.status(400).json({ error: "KYC submission is already pending review." });
    return;
  }

  await pool.query(
    `UPDATE users
     SET kyc_status = 'pending',
         kyc_legal_name = $1,
         kyc_date_of_birth = $2,
         kyc_nin = $3,
         kyc_document_path = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [
      parsed.fields.legalName!.trim(),
      parsed.fields.dateOfBirth,
      parsed.fields.nin!.trim(),
      parsed.filePath,
      userId,
    ]
  );

  logger.info({ userId }, "[kyc] submission received");

  res.status(200).json({
    message: "KYC submitted successfully. Pending admin review.",
    kycStatus: "pending",
  });
});

export default router;
