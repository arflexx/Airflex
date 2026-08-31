import { pool } from "../db/pool";

/**
 * Brute-force protection for POST /api/v1/auth/recover (issue #108).
 *
 * 5 failed recovery attempts from the same IP within 1 hour triggers a
 * temporary lockout (HTTP 429). Only *failed* attempts are counted, so a user
 * who legitimately recovers their account is never penalised, and a user who
 * mistypes once or twice keeps their remaining budget.
 *
 * Like the OTP limiter, this is database-backed rather than in-memory so the
 * count survives restarts and holds across multiple instances.
 */

/** Failed attempts allowed per IP per window. */
export const RECOVERY_MAX_FAILED_ATTEMPTS = 5;

/** Window length in minutes. */
export const RECOVERY_WINDOW_MINUTES = 60;

/** True if the IP has exhausted its failed-attempt budget for the window. */
export async function isRecoveryLockedOut(ip: string): Promise<boolean> {
  const { rows } = await pool.query<{ attempts: string }>(
    `SELECT COUNT(*)::text AS attempts
     FROM recovery_attempts
     WHERE ip = $1
       AND attempted_at > NOW() - ($2 || ' minutes')::interval`,
    [ip, String(RECOVERY_WINDOW_MINUTES)]
  );

  return Number(rows[0]?.attempts ?? 0) >= RECOVERY_MAX_FAILED_ATTEMPTS;
}

/** Record a failed redemption so it counts towards the lockout. */
export async function recordFailedRecoveryAttempt(ip: string): Promise<void> {
  await pool.query(
    `INSERT INTO recovery_attempts (ip) VALUES ($1)`,
    [ip]
  );
}
