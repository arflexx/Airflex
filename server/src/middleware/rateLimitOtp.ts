import { Request, Response, NextFunction } from "express";

import { pool } from "../db/pool";

/**
 * Per-identifier and per-IP rate limit for OTP requests.
 *
 * # Why this is database-backed rather than in-memory
 *
 * An in-memory counter resets on every deploy and is per-process, so it does
 * not hold across a restart or behind more than one instance. Both are exactly
 * the conditions under which someone is abusing the endpoint — and each OTP
 * request costs real money at Termii, so a limiter that silently stops
 * counting is worse than none: it reads as protection while providing none.
 *
 * Identifier and IP budgets are checked independently. This prevents both
 * rotating IPs to target one phone and rotating phone numbers from one IP.
 */

/** Requests allowed per identifier and IP per window. */
export const OTP_MAX_REQUESTS = 5;

/** Window length in minutes. */
export const OTP_WINDOW_MINUTES = 60;

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getOtpRateLimitConfig() {
  return {
    maxRequests: positiveEnvInt("OTP_RATE_LIMIT_MAX_REQUESTS", OTP_MAX_REQUESTS),
    windowMinutes: positiveEnvInt("OTP_RATE_LIMIT_WINDOW_MINUTES", OTP_WINDOW_MINUTES),
  };
}

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
export async function checkOtpRateLimit(
  identifier: string,
  ip: string
): Promise<OtpRateLimitState> {
  const { maxRequests, windowMinutes } = getOtpRateLimitConfig();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize requests sharing either dimension so concurrent sends cannot
    // all pass by observing the same pre-insert count.
    const lockKeys = [`otp:identifier:${identifier}`, `otp:ip:${ip}`].sort();
    for (const key of lockKeys) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    }

    await client.query(
      `INSERT INTO otp_requests (phone, ip, requested_at) VALUES ($1, $2, NOW())`,
      [identifier, ip]
    );

    const { rows } = await client.query<{
      identifier_attempts: string;
      identifier_oldest: string | null;
      ip_attempts: string;
      ip_oldest: string | null;
    }>(
      `SELECT COUNT(*) FILTER (WHERE phone = $1)::text AS identifier_attempts,
              MIN(requested_at) FILTER (WHERE phone = $1)::text AS identifier_oldest,
              COUNT(*) FILTER (WHERE ip = $2)::text AS ip_attempts,
              MIN(requested_at) FILTER (WHERE ip = $2)::text AS ip_oldest
       FROM otp_requests
       WHERE requested_at > NOW() - ($3 || ' minutes')::interval
         AND (phone = $1 OR ip = $2)`,
      [identifier, ip, String(windowMinutes)]
    );

    await client.query("COMMIT");

    const identifierAttempts = Number(rows[0]?.identifier_attempts ?? 0);
    const ipAttempts = Number(rows[0]?.ip_attempts ?? 0);
    const identifierOldest = rows[0]?.identifier_oldest
      ? new Date(rows[0].identifier_oldest)
      : null;
    const ipOldest = rows[0]?.ip_oldest ? new Date(rows[0].ip_oldest) : null;

    const retryAfterFor = (oldest: Date | null): number =>
      oldest === null
        ? windowMinutes * 60
        : Math.max(
            1,
            Math.ceil((oldest.getTime() + windowMinutes * 60_000 - Date.now()) / 1000)
          );
    const blockedRetryAfters = [
      ...(identifierAttempts > maxRequests ? [retryAfterFor(identifierOldest)] : []),
      ...(ipAttempts > maxRequests ? [retryAfterFor(ipOldest)] : []),
    ];
    const retryAfterSeconds = blockedRetryAfters.length
      ? Math.max(...blockedRetryAfters)
      : windowMinutes * 60;

    return {
      allowed: identifierAttempts <= maxRequests && ipAttempts <= maxRequests,
      remaining: Math.max(0, Math.min(maxRequests - identifierAttempts, maxRequests - ipAttempts)),
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
export async function enforceOtpRateLimit(
  identifier: string,
  ip: string,
  res: Response
): Promise<boolean> {
  const { maxRequests } = getOtpRateLimitConfig();

  try {
    const state = await checkOtpRateLimit(identifier, ip);

    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(state.remaining));

    if (!state.allowed) {
      res.setHeader("Retry-After", String(state.retryAfterSeconds));
      res.status(429).json({
        error: `Too many OTP requests. Try again in ${Math.ceil(
          state.retryAfterSeconds / 60
        )} minute(s).`,
      });
      return false;
    }

    return true;
  } catch (err) {
    console.error("[rateLimitOtp] Rate limit check failed:", (err as Error).message);
    return true;
  }
}

export async function rateLimitOtp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const body = req.body as { phone?: unknown; email?: unknown } | undefined;
  const rawIdentifier = body?.phone ?? body?.email;
  const identifier = typeof rawIdentifier === "string" ? rawIdentifier.trim() : "";

  // Validation should produce the useful error when no identifier is present.
  if (!identifier) {
    next();
    return;
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (await enforceOtpRateLimit(identifier, ip, res)) {
    next();
  }
}
