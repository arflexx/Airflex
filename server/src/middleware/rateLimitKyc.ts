import { Request, Response, NextFunction } from "express";

import { pool } from "../db/pool";
import { AuthenticatedRequest } from "./authenticate";

/**
 * Per-user rate limit for KYC submissions.
 *
 * POST /api/kyc/submit had no rate limiting at all, so a user (or a script
 * running as one) could resubmit KYC documents — each triggering a file
 * write and an admin-review row — without limit. This mirrors the
 * database-backed, sliding-window design already used for OTP requests
 * (see middleware/rateLimitOtp.ts): counting rows in a window rather than a
 * fixed counter avoids the "5 at 10:59, 5 more at 11:00" bypass, and being
 * DB-backed (not in-memory) means the limit holds across restarts and
 * multiple server instances.
 *
 * Keyed on the authenticated user's ID, with the request IP as a fallback
 * when this middleware is reused before authentication.
 */

/** KYC submissions allowed per user per window. */
function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const KYC_MAX_SUBMISSIONS = positiveInteger(process.env["KYC_MAX_SUBMISSIONS"], 3);

/** Window length in minutes. */
export const KYC_WINDOW_MINUTES = positiveInteger(process.env["KYC_WINDOW_MINUTES"], 60);

export interface KycRateLimitState {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window rolls over, when blocked. */
  retryAfterSeconds: number;
}

/**
 * Record a submission attempt and report whether it is allowed.
 *
 * The insert happens before the count so an attempt is charged even when it
 * is about to be rejected — otherwise a caller past the limit could keep
 * retrying for free and the window would never fill.
 */
export async function checkKycRateLimit(
  userId: string | null,
  ipAddress: string | null = null
): Promise<KycRateLimitState> {
  if (!userId && !ipAddress) {
    throw new Error("A user ID or IP address is required for KYC rate limiting.");
  }
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO kyc_submission_attempts (user_id, ip_address, requested_at)
       VALUES ($1::uuid, $2::inet, NOW())`,
      [userId, userId ? null : ipAddress]
    );

    const { rows } = await client.query<{ attempts: string; oldest: string | null }>(
      `SELECT COUNT(*)::text AS attempts,
              MIN(requested_at)::text AS oldest
       FROM kyc_submission_attempts
       WHERE (($1::uuid IS NOT NULL AND user_id = $1::uuid)
          OR ($1::uuid IS NULL AND ip_address = $2::inet))
         AND requested_at > NOW() - ($3 || ' minutes')::interval`,
      [userId, ipAddress, String(KYC_WINDOW_MINUTES)]
    );

    await client.query("COMMIT");

    const attempts = Number(rows[0]?.attempts ?? 0);
    const oldest = rows[0]?.oldest ? new Date(rows[0].oldest) : null;

    const retryAfterSeconds =
      oldest === null
        ? KYC_WINDOW_MINUTES * 60
        : Math.max(
            1,
            Math.ceil(
              (oldest.getTime() + KYC_WINDOW_MINUTES * 60_000 - Date.now()) / 1000
            )
          );

    return {
      allowed: attempts <= KYC_MAX_SUBMISSIONS,
      remaining: Math.max(0, KYC_MAX_SUBMISSIONS - attempts),
      retryAfterSeconds,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Express middleware enforcing the KYC submission limit.
 *
 * Must run after `authenticate` (needs `req.user.sub`). Fails open on a
 * database error — the same trade-off as rateLimitOtp: losing the limit for
 * the duration of a DB blip is cheaper than locking every user out of
 * submitting KYC, and the error is logged so the gap is visible.
 */
export async function rateLimitKyc(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = (req as AuthenticatedRequest).user?.sub;
  const ipAddress = req.ip || req.socket.remoteAddress || null;

  if (!userId && !ipAddress) {
    next();
    return;
  }

  try {
    const state = await checkKycRateLimit(userId ?? null, ipAddress);

    res.setHeader("X-RateLimit-Limit", String(KYC_MAX_SUBMISSIONS));
    res.setHeader("X-RateLimit-Remaining", String(state.remaining));

    if (!state.allowed) {
      res.setHeader("Retry-After", String(state.retryAfterSeconds));
      res.status(429).json({
        error: `Too many KYC submissions. Try again in ${Math.ceil(
          state.retryAfterSeconds / 60
        )} minute(s).`,
      });
      return;
    }

    next();
  } catch (err) {
    console.error("[rateLimitKyc] Rate limit check failed:", (err as Error).message);
    next();
  }
}
