/**
 * fraudDetection.ts — AML & Fraud Detection Service: Transaction Velocity Checks
 */

import pool from "../db";
import { cache } from "./cache";
import logger from "../utils/logger";

export interface VelocityRule {
  limit: number;
  windowSeconds: number;
  name: string;
}

export class VelocityError extends Error {
  status = 429;
  retryAfterSeconds: number;
  error = "Rate limit exceeded";

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "VelocityError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface FlaggedAccount {
  user_id: string;
  violation_count: number;
  last_violation_at: string;
  violations: Array<{ action: string; timestamp: string; details?: unknown }>;
}

export interface FraudSignals { velocityExceeded?: boolean; deviceKnownFraud?: boolean; relatedAccounts?: number; }
/** Deterministic, side-effect-free decision used by request handlers and tests. */
export function evaluateFraudSignals(signals: FraudSignals): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (signals.velocityExceeded) reasons.push("velocity");
  if (signals.deviceKnownFraud) reasons.push("device");
  if ((signals.relatedAccounts ?? 0) > 1) reasons.push("cross_account");
  return { blocked: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Repeated failed trades (issue #491)
// ---------------------------------------------------------------------------

/** Reason code persisted on fraud_flags rows raised by the failed-trade rule. */
export const REPEATED_FAILED_TRADES = "REPEATED_FAILED_TRADES";

/** Why a single trade attempt counted as failed. */
export type FailedTradeReason =
  /** The user's confirm-delivery request was rejected (not seller, wrong state, ...). */
  | "CONFIRMATION_REJECTED"
  /** Escrow release was rejected by the contract with a permanent error. */
  | "VERIFICATION_FAILED";

export interface FailedTradeRule {
  threshold: number;
  windowSeconds: number;
}

export interface FailedTradeOutcome {
  /** Failures inside the current window, including this one. */
  failureCount: number;
  /** True only when this failure created a new open flag. */
  flagged: boolean;
}

export type FraudFlagStatus = "open" | "reviewed" | "dismissed";

export interface FraudFlag {
  id: string;
  user_id: string;
  reason_code: string;
  details: Record<string, unknown>;
  status: FraudFlagStatus;
  flagged_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

interface FailedTradeEntry {
  at: number;
  tradeId: string;
  reason: FailedTradeReason;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function failedTradesKey(userId: string): string {
  return `failed-trades:${userId}`;
}

/**
 * Tail of the pending velocity checks for each counter key. The cache API is
 * GET/SET only (no atomic INCR), so concurrent checks for the same user and
 * action are serialised in-process — otherwise N simultaneous requests at
 * `limit - 1` would all read the same count and all be allowed.
 */
const velocityLocks = new Map<string, Promise<void>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = velocityLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  velocityLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // Only the last waiter clears the entry, so the map doesn't grow unbounded.
    if (velocityLocks.get(key) === tail) velocityLocks.delete(key);
  }
}

export class FraudDetectionService {
  /**
   * Resolve velocity rule limits and windows based on action and env vars.
   */
  private static getRule(action: string): VelocityRule {
    const norm = action.toLowerCase();

    if (norm.includes("trade")) {
      const limit = positiveIntFromEnv("MAX_TRADES_PER_HOUR", 10);
      return { limit, windowSeconds: 3600, name: "MAX_TRADES_PER_HOUR" };
    }

    if (norm.includes("deposit")) {
      const limit = positiveIntFromEnv("MAX_DEPOSITS_PER_DAY", 5);
      return { limit, windowSeconds: 86400, name: "MAX_DEPOSITS_PER_DAY" };
    }

    if (norm.includes("withdraw")) {
      const limit = positiveIntFromEnv("MAX_WITHDRAWALS_PER_DAY", 3);
      return { limit, windowSeconds: 86400, name: "MAX_WITHDRAWALS_PER_DAY" };
    }

    // Default fall-back rule
    return { limit: 10, windowSeconds: 3600, name: "DEFAULT_VELOCITY_RULE" };
  }

  /**
   * Enforces velocity checks on transactions and trade creation.
   * Throws VelocityError (429) if rule is violated.
   */
  static async checkVelocity(userId: string, action: string): Promise<{ allowed: boolean }> {
    const key = `velocity:${action.toLowerCase()}:${userId}`;
    return withKeyLock(key, () => this.checkVelocityUnlocked(key, userId, action));
  }

  private static async checkVelocityUnlocked(
    key: string,
    userId: string,
    action: string
  ): Promise<{ allowed: boolean }> {
    const rule = this.getRule(action);

    const raw = await cache.get(key);
    const now = Date.now();
    let count = 0;
    let resetAt = now + rule.windowSeconds * 1000;

    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }

      if (parsed !== null && typeof parsed === "object") {
        const entry = parsed as { count?: unknown; resetAt?: unknown };
        // A window whose resetAt has passed (the cache TTL is rounded up, so an
        // entry can outlive its window briefly) starts a fresh count.
        if (typeof entry.resetAt === "number" && entry.resetAt > now) {
          count = typeof entry.count === "number" && entry.count > 0 ? entry.count : 0;
          resetAt = entry.resetAt;
        }
      } else {
        // Legacy plain-integer counter (e.g. "3"); keeps the fresh window.
        count = parseInt(String(parsed), 10) || 0;
      }
    }

    const newCount = count + 1;
    const remainingMs = Math.max(1000, resetAt - Date.now());
    const retryAfterSeconds = Math.ceil(remainingMs / 1000);

    if (newCount > rule.limit) {
      logger.warn(
        { userId, action, rule: rule.name, limit: rule.limit, currentCount: newCount },
        `[FraudDetection] Rate limit exceeded for user ${userId} on action ${action}`
      );

      // Log violation into PostgreSQL suspicious_activity table
      try {
        await pool.query(
          `INSERT INTO suspicious_activity (user_id, action, timestamp, details)
           VALUES ($1, $2, NOW(), $3)`,
          [
            userId,
            action,
            JSON.stringify({
              rule: rule.name,
              limit: rule.limit,
              attemptedCount: newCount,
              retryAfterSeconds,
            }),
          ]
        );
      } catch (dbErr) {
        logger.error({ dbErr }, "[FraudDetection] Failed to log suspicious activity to DB");
      }

      throw new VelocityError("Rate limit exceeded", retryAfterSeconds);
    }

    // Update counter in Redis / memory cache
    await cache.set(
      key,
      JSON.stringify({ count: newCount, resetAt }),
      Math.ceil(remainingMs / 1000)
    );

    return { allowed: true };
  }

  /**
   * Retrieves users with more than 3 velocity violations in the past 24 hours.
   */
  static async getFlaggedAccounts(): Promise<FlaggedAccount[]> {
    const { rows } = await pool.query<FlaggedAccount>(
      `SELECT 
         user_id, 
         COUNT(*)::int AS violation_count, 
         MAX(timestamp) AS last_violation_at,
         json_agg(json_build_object('action', action, 'timestamp', timestamp, 'details', details)) AS violations
       FROM suspicious_activity
       WHERE timestamp >= NOW() - INTERVAL '24 hours'
       GROUP BY user_id
       HAVING COUNT(*) > 3
       ORDER BY violation_count DESC`
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // Repeated failed trades (issue #491)
  // -------------------------------------------------------------------------

  /**
   * Threshold and rolling window for the failed-trade rule. Defaults to
   * 5 failures within 1 hour; override with FAILED_TRADE_THRESHOLD and
   * FAILED_TRADE_WINDOW_SECONDS.
   */
  static getFailedTradeRule(): FailedTradeRule {
    return {
      threshold: positiveIntFromEnv("FAILED_TRADE_THRESHOLD", 5),
      windowSeconds: positiveIntFromEnv("FAILED_TRADE_WINDOW_SECONDS", 3600),
    };
  }

  /**
   * Records one failed trade attempt for a user and flags the account for
   * admin review once `threshold` failures fall inside the rolling window.
   *
   * Failures older than the window are dropped on every call, so the count
   * only ever reflects the last `windowSeconds`. A success in between clears
   * the history entirely (see `resetFailedTrades`) — the rule targets
   * *consecutive* failures.
   */
  static async recordFailedTrade(
    userId: string,
    tradeId: string,
    reason: FailedTradeReason
  ): Promise<FailedTradeOutcome> {
    const rule = this.getFailedTradeRule();
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;
    const key = failedTradesKey(userId);

    let history: FailedTradeEntry[] = [];
    const raw = await cache.get(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) history = parsed as FailedTradeEntry[];
      } catch {
        // Corrupt entry — start a fresh window.
      }
    }

    const recent = history.filter((entry) => entry.at > windowStart);
    recent.push({ at: now, tradeId, reason });
    await cache.set(key, JSON.stringify(recent), rule.windowSeconds);

    if (recent.length < rule.threshold) {
      return { failureCount: recent.length, flagged: false };
    }

    const flagged = await this.flagAccount(userId, REPEATED_FAILED_TRADES, {
      threshold: rule.threshold,
      windowSeconds: rule.windowSeconds,
      failureCount: recent.length,
      failures: recent.map((entry) => ({
        tradeId: entry.tradeId,
        reason: entry.reason,
        at: new Date(entry.at).toISOString(),
      })),
    });

    return { failureCount: recent.length, flagged };
  }

  /** Clears a user's failed-trade history after a successful trade. */
  static async resetFailedTrades(userId: string): Promise<void> {
    // The cache has no delete; an empty list with a 1s TTL is equivalent.
    await cache.set(failedTradesKey(userId), "[]", 1);
  }

  /**
   * Persists an open fraud flag. Returns false (and writes nothing) when the
   * user already has an open flag for the same reason awaiting review.
   */
  static async flagAccount(
    userId: string,
    reasonCode: string,
    details: Record<string, unknown>
  ): Promise<boolean> {
    const { rowCount } = await pool.query(
      `INSERT INTO fraud_flags (user_id, reason_code, details)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, reason_code) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [userId, reasonCode, JSON.stringify(details)]
    );

    const created = (rowCount ?? 0) > 0;
    if (created) {
      logger.warn(
        { userId, reasonCode, details },
        `[FraudDetection] Account ${userId} flagged for review (${reasonCode})`
      );
    }
    return created;
  }

  /** Lists fraud flags for the admin review queue, newest first. */
  static async listFraudFlags(options: {
    status?: FraudFlagStatus;
    limit: number;
    offset: number;
  }): Promise<{ flags: FraudFlag[]; total: number }> {
    const where = options.status ? "WHERE status = $1" : "";
    const filterParams = options.status ? [options.status] : [];

    const [{ rows: flags }, { rows: countRows }] = await Promise.all([
      pool.query<FraudFlag>(
        `SELECT id, user_id, reason_code, details, status, flagged_at,
                reviewed_by, reviewed_at, review_note
           FROM fraud_flags
           ${where}
          ORDER BY flagged_at DESC
          LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
        [...filterParams, options.limit, options.offset]
      ),
      pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM fraud_flags ${where}`,
        filterParams
      ),
    ]);

    return { flags, total: countRows[0]?.total ?? 0 };
  }

  /**
   * Closes an open flag as reviewed or dismissed, recording who did it, when,
   * and an optional note. Returns null if the flag doesn't exist or was
   * already closed.
   */
  static async reviewFraudFlag(
    flagId: string,
    reviewerId: string,
    status: Exclude<FraudFlagStatus, "open">,
    note: string | null
  ): Promise<FraudFlag | null> {
    const { rows } = await pool.query<FraudFlag>(
      `UPDATE fraud_flags
          SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_note = $4
        WHERE id = $1 AND status = 'open'
        RETURNING id, user_id, reason_code, details, status, flagged_at,
                  reviewed_by, reviewed_at, review_note`,
      [flagId, status, reviewerId, note]
    );
    return rows[0] ?? null;
  }
}
