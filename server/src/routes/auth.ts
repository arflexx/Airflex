import { Router } from "express";

import { rateLimitOtp } from "../middleware/rateLimitOtp";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import {
  isRecoveryLockedOut,
  recordFailedRecoveryAttempt,
  RECOVERY_WINDOW_MINUTES,
} from "../middleware/rateLimitRecovery";
import { v4 as uuidv4 } from "uuid";
import { randomInt } from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db";
import { generateAndFundWallet } from "../services/stellar";
import { validate } from "../middleware/validate";
import {
  requestOtpSchema,
  verifyOtpSchema,
  recoverSchema,
  changePhoneSchema,
  type RequestOtpInput,
  type VerifyOtpInput,
  type RecoverInput,
  type ChangePhoneInput,
} from "../schemas";
import { createReferralCode } from "../services/referrals";
import {
  generateRecoveryCodesForUser,
  userHasRecoveryCodes,
  countRemainingRecoveryCodes,
  redeemRecoveryCode,
} from "../services/recoveryCodes";
import { provisionVirtualAccountForUser } from "../services/virtualAccount";

const router = Router();

function newReferralCode(): string {
  return createReferralCode(() => randomInt(0, 32) / 32);
}

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
// POST /api/v1/auth/request-otp
// ---------------------------------------------------------------------------

router.post(
  "/request-otp",
  // Validation first so a malformed phone is rejected before it is charged
  // against that number's quota (Issue #7).
  validate(requestOtpSchema),
  rateLimitOtp,
  async (req, res) => {
    const { phone, referralCode } = req.body as RequestOtpInput;

    // Upsert user row — create if first time, leave existing data untouched
    await pool.query(
      `INSERT INTO users (id, phone, referral_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO NOTHING`,
      [uuidv4(), phone, newReferralCode()]
    );

    if (referralCode) {
      await pool.query(
        `INSERT INTO referrals (referrer_id, referred_id)
         SELECT referrer.id, referred.id FROM users referrer, users referred
          WHERE referrer.referral_code = $1 AND referred.phone = $2
            AND referrer.id <> referred.id ON CONFLICT (referred_id) DO NOTHING`,
        [referralCode, phone]
      );
    }

    try {
      await sendOtp(phone, "");
    } catch (err) {
      console.error("[auth] Failed to send OTP:", (err as Error).message);
      res.status(502).json({ error: "Failed to send OTP. Please try again." });
      return;
    }

    res.status(200).json({ message: "OTP sent successfully" });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/verify-otp
// ---------------------------------------------------------------------------

router.post(
  "/verify-otp",
  validate(verifyOtpSchema),
  async (req, res) => {
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
      res.status(401).json({ error: "Invalid phone number or OTP" });
      return;
    }

    if (!user.otp_pin_id || !user.otp_expires_at) {
      res.status(401).json({ error: "No pending OTP for this number. Request a new one." });
      return;
    }

    // Guard: OTP expired
    if (new Date(user.otp_expires_at) < new Date()) {
      res.status(401).json({ error: "OTP has expired. Request a new one." });
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
      res.status(401).json({ error: "Invalid or expired OTP" });
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

    // Issue 8 single-use recovery codes on first signup (issue #108). They are
    // returned in plaintext exactly once and never stored or shown again.
    let recoveryCodes: string[] = [];
    try {
      if (!(await userHasRecoveryCodes(user.id))) {
        recoveryCodes = await generateRecoveryCodesForUser(user.id);
      }
    } catch (err) {
      // Non-fatal for auth — log and continue. The user can still sign in;
      // recovery codes can be re-issued through account support if needed.
      console.error(
        "[auth] Failed to issue recovery codes for user",
        user.id,
        "–",
        (err as Error).message
      );
    }

    // Provision a Paystack dedicated virtual account (non-fatal).
    // Uses the phone number as display name until KYC provides a legal name.
    // If inline creation fails the service enqueues a background retry job.
    void provisionVirtualAccountForUser(user.id, phone).catch((err) => {
      console.error(
        "[auth] Virtual account provisioning error for user",
        user.id,
        "–",
        (err as Error).message
      );
    });

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
      // Only present on the very first signup — never on later logins.
      ...(recoveryCodes.length > 0 ? { recoveryCodes } : {}),
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/recover
// ---------------------------------------------------------------------------
//
// 2FA recovery (issue #108): a user who lost their phone number redeems one of
// their backup codes. A valid code is consumed (single-use) and exchanged for
// a short-lived, one-time JWT scoped to `recovery`, which is then presented to
// POST /api/v1/auth/recover/change-phone to register a new number.
//
// Brute-force protection: 5 failed attempts from the same IP within 1 hour
// locks the IP out with HTTP 429.

router.post(
  "/recover",
  validate(recoverSchema),
  async (req, res) => {
    const { recoveryCode } = req.body as RecoverInput;
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

    // Fail closed on the lockout check — a DB blip blocks recovery attempts
    // for the duration rather than silently disabling the lockout.
    let lockedOut: boolean;
    try {
      lockedOut = await isRecoveryLockedOut(ip);
    } catch (err) {
      console.error("[auth] Recovery lockout check failed:", (err as Error).message);
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    if (lockedOut) {
      res.status(429).json({
        error: `Too many failed recovery attempts. Try again in ${RECOVERY_WINDOW_MINUTES} minute(s).`,
      });
      return;
    }

    let result: Awaited<ReturnType<typeof redeemRecoveryCode>>;
    try {
      result = await redeemRecoveryCode(recoveryCode);
    } catch (err) {
      console.error("[auth] Recovery redemption failed:", (err as Error).message);
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    if (!result.ok) {
      // Only failed attempts count towards the lockout.
      try {
        await recordFailedRecoveryAttempt(ip);
      } catch (err) {
        console.error("[auth] Failed to record recovery attempt:", (err as Error).message);
      }
      // Generic message — do not reveal whether the code exists or was used.
      res.status(401).json({ error: "Invalid or already-used recovery code" });
      return;
    }

    // One-time token: short TTL, scoped to recovery so it can never be used
    // as a normal session token.
    const secret = process.env["JWT_SECRET"]!;
    const recoveryToken = jwt.sign(
      { sub: result.userId, scope: "recovery", purpose: "change-phone" },
      secret,
      { expiresIn: "15m" }
    );

    res.status(200).json({
      token: recoveryToken,
      message: "Recovery code accepted. Use this token to register a new phone number.",
      expiresIn: "15m",
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/recover/change-phone
// ---------------------------------------------------------------------------

router.post(
  "/recover/change-phone",
  validate(changePhoneSchema),
  async (req, res) => {
    const { token, newPhone } = req.body as ChangePhoneInput;
    const secret = process.env["JWT_SECRET"]!;

    let payload: { sub?: string; scope?: string };
    try {
      payload = jwt.verify(token, secret) as { sub?: string; scope?: string };
    } catch {
      res.status(401).json({ error: "Recovery token is invalid or expired" });
      return;
    }

    if (payload.scope !== "recovery" || !payload.sub) {
      res.status(401).json({ error: "Recovery token is invalid or expired" });
      return;
    }

    const userId = payload.sub;

    // The new phone must not belong to another account.
    const { rows: phoneRows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [newPhone]
    );

    if (phoneRows.length > 0 && phoneRows[0]!.id !== userId) {
      res.status(409).json({ error: "That phone number is already registered" });
      return;
    }

    // Re-verify the user still exists (they may have been deleted meanwhile).
    const { rows: userRows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );

    if (!userRows.length) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    await pool.query(
      `UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2`,
      [newPhone, userId]
    );

    // Issue a normal session JWT so the user is signed in immediately.
    const { rows: keyRows } = await pool.query<{ stellar_public_key: string | null }>(
      `SELECT stellar_public_key FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    const stellarPublicKey = keyRows[0]?.stellar_public_key ?? "";

    const sessionToken = jwt.sign(
      { sub: userId, stellarPublicKey },
      secret,
      { expiresIn: "7d" }
    );

    res.status(200).json({
      token: sessionToken,
      user: { id: userId, phone: newPhone, stellarPublicKey },
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/auth/recovery-codes/status
// ---------------------------------------------------------------------------

/**
 * Authenticated status check: how many backup codes remain unused. Never
 * reveals the codes themselves.
 */
router.get(
  "/recovery-codes/status",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const remaining = await countRemainingRecoveryCodes(userId);

    res.status(200).json({ data: { remaining } });
  }
);

export default router;
