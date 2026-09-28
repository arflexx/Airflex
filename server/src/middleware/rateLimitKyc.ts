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
 * Keyed on the authenticated user's ID (not phone/IP) since this endpoint is
 * already behind `authenticate` — the caller's identity is exactly what
 * should be rate limited.
 */

/** KYC submissions allowed per user per window. */
export const KYC_MAX_SUBMISSIONS = 3;

/** Window length in minutes. */
export const KYC_WINDOW_MINUTES = 60;

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
export async function checkKycRateLimit(userId: string): Promise<KycRateLimitState> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO kyc_submission_attempts (user_id, requested_at) VALUES ($1, NOW())`,
      [userId]
    );

    const { rows } = await client.query<{ attempts: string; oldest: string | null }>(
      `SELECT COUNT(*)::text AS attempts,
              MIN(requested_at)::text AS oldest
       FROM kyc_submission_attempts
       WHERE user_id = $1
         AND requested_at > NOW() - ($2 || ' minutes')::interval`,
      [userId, String(KYC_WINDOW_MINUTES)]
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

  if (!userId) {
    // authenticate should already have rejected this request; nothing to
    // rate-limit without an identity.
    next();
    return;
  }

  try {
    const state = await checkKycRateLimit(userId);

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
