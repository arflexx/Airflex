import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import pool from "../db";
import { generateAndFundWallet } from "../services/stellar";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import {
  requestOtpSchema,
  verifyOtpSchema,
  type RequestOtpInput,
  type VerifyOtpInput,
} from "../schemas";

const router: Router = Router();

/** Send OTP via Termii SMS API */
async function sendOtp(phone: string, otp: string): Promise<void> {
  const apiKey = process.env["TERMII_API_KEY"];
  if (!apiKey) {
    throw new Error("TERMII_API_KEY environment variable is not set");
  }

  const body = {
    api_key: apiKey,
    message_type: "NUMERIC",
    to: phone,
    from: "AirFlex",
    channel: "generic",
    pin_attempts: 3,
    pin_time_to_live: 10, // minutes
    pin_length: 6,
    pin_placeholder: "< 1234 >",
    message_text: "Your AirFlex verification code is < 1234 >. It expires in 10 minutes.",
    pin_type: "NUMERIC",
  };

  const res = await fetch("https://api.ng.termii.com/api/sms/otp/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Termii API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { pinId?: string; status?: string };

  if (!data.pinId) {
    throw new Error("Termii did not return a pinId");
  }

  // Store the Termii pinId in the DB so we can verify it later
  await pool.query(
    `UPDATE users SET otp_pin_id = $1, otp_expires_at = NOW() + INTERVAL '10 minutes'
     WHERE phone = $2`,
    [data.pinId, phone]
  );
}

/** Verify OTP pin against Termii */
async function verifyOtpWithTermii(
  pinId: string,
  pin: string
): Promise<boolean> {
  const apiKey = process.env["TERMII_API_KEY"];
  if (!apiKey) {
    throw new Error("TERMII_API_KEY environment variable is not set");
  }

  const res = await fetch("https://api.ng.termii.com/api/sms/otp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, pin_id: pinId, pin }),
  });

  if (!res.ok) return false;

  const data = (await res.json()) as { verified?: boolean; msisdn?: string };
  return data.verified === true;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
// Schemas are defined in src/schemas/auth.schemas.ts and imported above.
// The validate() middleware handles 422 responses automatically.

// ---------------------------------------------------------------------------
// POST /api/auth/request-otp
// ---------------------------------------------------------------------------

router.post(
  "/request-otp",
  validate(requestOtpSchema),
  asyncHandler(async (req, res) => {
    const { phone } = req.body as RequestOtpInput;

    // Upsert user row — create if first time, leave existing data untouched
    await pool.query(
      `INSERT INTO users (id, phone)
       VALUES ($1, $2)
       ON CONFLICT (phone) DO NOTHING`,
      [uuidv4(), phone]
    );

    try {
      await sendOtp(phone, "");
    } catch (err) {
      console.error("[auth] Failed to send OTP:", (err as Error).message);
      res.status(502).json({ error: "Failed to send OTP. Please try again." });
      return;
    }

    res.status(200).json({ message: "OTP sent successfully" });
  })
);

// ---------------------------------------------------------------------------
// POST /api/auth/verify-otp
// ---------------------------------------------------------------------------

router.post(
  "/verify-otp",
  validate(verifyOtpSchema),
  asyncHandler(async (req, res) => {
    const { phone, otp } = req.body as VerifyOtpInput;

    // Look up the user and their pending OTP pin
    const { rows } = await pool.query<{
      id: string;
      otp_pin_id: string | null;
      otp_expires_at: string | null;
      stellar_public_key: string | null;
    }>(
      `SELECT u.id, u.otp_pin_id, u.otp_expires_at, w.stellar_public_key
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.phone = $1
       LIMIT 1`,
      [phone]
    );

    const user = rows[0];

    if (!user) {
      // Return generic error — don't leak whether the phone exists
      res.status(400).json({ error: "Invalid phone number or OTP" });
      return;
    }

    if (!user.otp_pin_id || !user.otp_expires_at) {
      res.status(400).json({ error: "No pending OTP for this number. Request a new one." });
      return;
    }

    // Guard: OTP expired
    if (new Date(user.otp_expires_at) < new Date()) {
      res.status(400).json({ error: "OTP has expired. Request a new one." });
      return;
    }

    // Verify against Termii
    let verified: boolean;
    try {
      verified = await verifyOtpWithTermii(user.otp_pin_id, otp);
    } catch (err) {
      console.error("[auth] Termii verify error:", (err as Error).message);
      res.status(502).json({ error: "Verification service unavailable. Try again." });
      return;
    }

    if (!verified) {
      res.status(400).json({ error: "Invalid or expired OTP" });
      return;
    }

    // Clear the used OTP fields
    await pool.query(
      `UPDATE users SET otp_pin_id = NULL, otp_expires_at = NULL WHERE id = $1`,
      [user.id]
    );

    // Provision a Stellar wallet if the user doesn't have one yet
    let stellarPublicKey = user.stellar_public_key ?? "";

    if (!stellarPublicKey) {
      try {
        const { publicKey, encryptedSecretKey } = await generateAndFundWallet();

        // Persist wallet — upsert in case of concurrent requests
        await pool.query(
          `INSERT INTO wallets (id, user_id, stellar_public_key, stellar_secret_key)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO UPDATE
             SET stellar_public_key  = EXCLUDED.stellar_public_key,
                 stellar_secret_key  = EXCLUDED.stellar_secret_key`,
          [uuidv4(), user.id, publicKey, encryptedSecretKey]
        );

        // Mirror the public key on the users row for quick JWT embedding
        await pool.query(
          `UPDATE users SET stellar_public_key = $1 WHERE id = $2`,
          [publicKey, user.id]
        );

        stellarPublicKey = publicKey;
      } catch (err) {
        // Wallet creation is non-fatal for auth — log and continue.
        // The user can retry; wallet provisioning is idempotent.
        console.error(
          "[auth] Wallet provisioning failed for user",
          user.id,
          "–",
          (err as Error).message
        );
      }
    }

    // Issue JWT — same payload shape the authenticate middleware expects
    const secret = process.env["JWT_SECRET"]!;
    const token = jwt.sign(
      { sub: user.id, stellarPublicKey },
      secret,
      { expiresIn: "7d" }
    );

    res.status(200).json({
      token,
      user: { id: user.id, phone, stellarPublicKey },
    });
  })
);

export default router;
