import { Request, Response, NextFunction } from "express";

import { pool } from "../db/pool";

/**
 * Per-phone rate limit for OTP requests (Issue #7).
 *
 * # Why this is database-backed rather than in-memory
 *
 * An in-memory counter resets on every deploy and is per-process, so it does
 * not hold across a restart or behind more than one instance. Both are exactly
 * the conditions under which someone is abusing the endpoint — and each OTP
 * request costs real money at Termii, so a limiter that silently stops
 * counting is worse than none: it reads as protection while providing none.
 *
 * The limit is keyed on **phone number, not IP**. The cost and the abuse both
 * attach to the number: one attacker rotating IPs to SMS-bomb a single victim
 * is the case that matters, and an IP limit does nothing about it. It also
 * avoids punishing everyone behind a shared NAT, which is common on the mobile
 * networks this platform targets.
 */

/** Requests allowed per phone number per window. */
export const OTP_MAX_REQUESTS = 5;

/** Window length in minutes. */
export const OTP_WINDOW_MINUTES = 60;

export interface OtpRateLimitState {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window rolls over, when blocked. */
  retryAfterSeconds: number;
}

/**
 * Record an attempt and report whether it is allowed.
 *
 * Counts rows inside the window rather than keeping a running total, so the
 * window slides continuously instead of resetting on the hour. A fixed window
 * lets someone send 5 at 10:59 and 5 more at 11:00 — ten messages in a minute
 * while never breaching a limit of five.
 *
 * The insert happens before the count so a request is charged even when it is
 * about to be rejected; otherwise a caller past the limit could keep retrying
 * for free and the window would never fill.
 */
export async function checkOtpRateLimit(phone: string): Promise<OtpRateLimitState> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO otp_requests (phone, requested_at) VALUES ($1, NOW())`,
      [phone]
    );

    const { rows } = await client.query<{ attempts: string; oldest: string | null }>(
      `SELECT COUNT(*)::text AS attempts,
              MIN(requested_at)::text AS oldest
       FROM otp_requests
       WHERE phone = $1
         AND requested_at > NOW() - ($2 || ' minutes')::interval`,
      [phone, String(OTP_WINDOW_MINUTES)]
    );

    await client.query("COMMIT");

    const attempts = Number(rows[0]?.attempts ?? 0);
    const oldest = rows[0]?.oldest ? new Date(rows[0].oldest) : null;

    // Capacity frees up when the oldest attempt in the window ages out, not
    // at a fixed boundary.
    const retryAfterSeconds =
      oldest === null
        ? OTP_WINDOW_MINUTES * 60
        : Math.max(
            1,
            Math.ceil(
              (oldest.getTime() + OTP_WINDOW_MINUTES * 60_000 - Date.now()) / 1000
            )
          );

    return {
      allowed: attempts <= OTP_MAX_REQUESTS,
      remaining: Math.max(0, OTP_MAX_REQUESTS - attempts),
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
 * Express middleware enforcing the OTP request limit.
 *
 * **Fails open on a database error.** That is a deliberate trade: the limiter
 * protects against cost and nuisance, while failing closed would mean a
 * database blip locks every user out of signing in. Losing the limit for the
 * duration of an outage is the cheaper failure, and the error is logged so the
 * gap is visible rather than silent.
 */
export async function rateLimitOtp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const phone = (req.body as { phone?: string } | undefined)?.phone;

  // No phone means the request will fail validation anyway; let the validator
  // produce the better error rather than reporting a rate limit.
  if (!phone) {
    next();
    return;
  }

  try {
    const state = await checkOtpRateLimit(phone);

    res.setHeader("X-RateLimit-Limit", String(OTP_MAX_REQUESTS));
    res.setHeader("X-RateLimit-Remaining", String(state.remaining));

    if (!state.allowed) {
      res.setHeader("Retry-After", String(state.retryAfterSeconds));
      res.status(429).json({
        error: `Too many OTP requests. Try again in ${Math.ceil(
          state.retryAfterSeconds / 60
        )} minute(s).`,
      });
      return;
    }

    next();
  } catch (err) {
    console.error("[rateLimitOtp] Rate limit check failed:", (err as Error).message);
    next();
  }
}
