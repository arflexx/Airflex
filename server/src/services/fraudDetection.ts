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

export class FraudDetectionService {
  /**
   * Resolve velocity rule limits and windows based on action and env vars.
   */
  private static getRule(action: string): VelocityRule {
    const norm = action.toLowerCase();

    if (norm.includes("trade")) {
      const limit = parseInt(process.env["MAX_TRADES_PER_HOUR"] || "10", 10);
      return { limit, windowSeconds: 3600, name: "MAX_TRADES_PER_HOUR" };
    }

    if (norm.includes("deposit")) {
      const limit = parseInt(process.env["MAX_DEPOSITS_PER_DAY"] || "5", 10);
      return { limit, windowSeconds: 86400, name: "MAX_DEPOSITS_PER_DAY" };
    }

    if (norm.includes("withdraw")) {
      const limit = parseInt(process.env["MAX_WITHDRAWALS_PER_DAY"] || "3", 10);
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
    const rule = this.getRule(action);
    const key = `velocity:${action.toLowerCase()}:${userId}`;

    const raw = await cache.get(key);
    let count = 0;
    let resetAt = Date.now() + rule.windowSeconds * 1000;

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { count: number; resetAt: number };
        count = parsed.count;
        resetAt = parsed.resetAt;
      } catch {
        count = parseInt(raw, 10) || 0;
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
}
