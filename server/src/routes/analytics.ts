/**
 * analytics.ts — Admin-only platform analytics endpoints (issue #110).
 *
 * Powers the admin dashboard charts with aggregation queries over the
 * trade_offers table. All responses are cached in Redis for 5 minutes
 * (in-memory fallback when Redis is unavailable) to avoid hammering the
 * database on dashboard loads.
 *
 * Endpoints:
 *   GET /api/v1/admin/analytics/overview           — platform-level metrics
 *   GET /api/v1/admin/analytics/trades/timeseries  — daily trade counts + volume
 *   GET /api/v1/admin/analytics/assets             — per-asset-type breakdown
 *
 * All queries hit the indexes added in migrations/003_analytics.sql
 * (trade_offers(created_at), trade_offers(status, created_at),
 * trade_offers(asset_type)).
 */

import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { authorize } from "../middleware/authorize";
import pool from "../db";
import { cache } from "../services/cache";
import {
  analyticsDateRangeSchema,
  ANALYTICS_DEFAULT_WINDOW_DAYS,
} from "../schemas";

const router = Router();

/** Cache analytics responses for 5 minutes (issue #110). */
const ANALYTICS_CACHE_TTL_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// GET /api/v1/admin/analytics/overview  (admin only)
// ---------------------------------------------------------------------------

/**
 * Platform-level metrics:
 *   totalUsers   — all-time registered users
 *   totalTrades  — all trade offers created
 *   tradeVolume  — sum of amounts on Completed trades
 *   feeRevenue   — sum of platform fees collected on Completed trades
 *   successRate  — completed / total trades as a percentage
 */
router.get(
  "/analytics/overview",
  authenticate,
  authorize("admin"),
  async (_req, res) => {
    const data = await cache.remember(
      "analytics:overview",
      ANALYTICS_CACHE_TTL_SECONDS,
      async () => {
        const { rows } = await pool.query<{
          totalUsers: string;
          totalTrades: string;
          completedTrades: string;
          tradeVolume: string | null;
          feeRevenue: string | null;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM users)                          AS "totalUsers",
             (SELECT COUNT(*) FROM trade_offers)                   AS "totalTrades",
             (SELECT COUNT(*) FROM trade_offers
               WHERE status = 'Completed')                         AS "completedTrades",
             (SELECT SUM(amount) FROM trade_offers
               WHERE status = 'Completed')                         AS "tradeVolume",
             (SELECT SUM(fee_amount) FROM trade_offers
               WHERE status = 'Completed' AND fee_amount IS NOT NULL) AS "feeRevenue"`
        );

        const row = rows[0]!;
        const totalTrades = Number(row.totalTrades);
        const completedTrades = Number(row.completedTrades);

        return {
          totalUsers: Number(row.totalUsers),
          totalTrades,
          tradeVolume: Math.round((Number(row.tradeVolume ?? 0) + Number.EPSILON) * 100) / 100,
          feeRevenue: Math.round((Number(row.feeRevenue ?? 0) + Number.EPSILON) * 100) / 100,
          successRate:
            totalTrades === 0
              ? 0
              : Math.round((completedTrades / totalTrades) * 10000) / 100,
        };
      }
    );

    res.status(200).json({ data });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/analytics/trades/timeseries  (admin only)
// ---------------------------------------------------------------------------

/**
 * Daily trade counts and volume for the range [?from, ?to]. Dates default to
 * the last 30 days. The range is inclusive of full days: `to` is treated as
 * the end of its day, so a trade on 2026-08-01 is included when to=2026-08-01.
 */
router.get(
  "/analytics/trades/timeseries",
  authenticate,
  authorize("admin"),
  async (req, res) => {
    const parsed = analyticsDateRangeSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const now = new Date();
    const from = parsed.data.from ?? defaultFrom(now);
    const to = parsed.data.to ?? defaultTo(now);
    const cacheKey = `analytics:timeseries:${from}:${to}`;

    const data = await cache.remember(cacheKey, ANALYTICS_CACHE_TTL_SECONDS, async () => {
      const { rows } = await pool.query<{
        date: string;
        tradeCount: string;
        volume: string | null;
      }>(
        `SELECT created_at::date                                    AS date,
                COUNT(*)                                            AS "tradeCount",
                COALESCE(SUM(amount), 0)                            AS volume
         FROM trade_offers
         WHERE created_at >= $1::date
           AND created_at <  ($2::date + INTERVAL '1 day')
         GROUP BY created_at::date
         ORDER BY date ASC`,
        [from, to]
      );

      return rows.map((row) => ({
        date: row.date,
        tradeCount: Number(row.tradeCount),
        volume: Math.round((Number(row.volume ?? 0) + Number.EPSILON) * 100) / 100,
      }));
    });

    res.status(200).json({ data });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/analytics/assets  (admin only)
// ---------------------------------------------------------------------------

/**
 * Trade counts and volume grouped by asset_type (e.g. MTN_AIRTIME), ordered
 * by volume so the biggest markets are listed first.
 */
router.get(
  "/analytics/assets",
  authenticate,
  authorize("admin"),
  async (_req, res) => {
    const data = await cache.remember(
      "analytics:assets",
      ANALYTICS_CACHE_TTL_SECONDS,
      async () => {
        const { rows } = await pool.query<{
          assetType: string;
          tradeCount: string;
          volume: string | null;
        }>(
          `SELECT asset_type                                  AS "assetType",
                  COUNT(*)                                    AS "tradeCount",
                  COALESCE(SUM(amount), 0)                    AS volume
           FROM trade_offers
           GROUP BY asset_type
           ORDER BY volume DESC, "assetType" ASC`
        );

        return rows.map((row) => ({
          assetType: row.assetType,
          tradeCount: Number(row.tradeCount),
          volume: Math.round((Number(row.volume ?? 0) + Number.EPSILON) * 100) / 100,
        }));
      }
    );

    res.status(200).json({ data });
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Date-only ISO string N days before today, in server-local time. */
function defaultFrom(now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() - (ANALYTICS_DEFAULT_WINDOW_DAYS - 1));
  return toDateOnly(d);
}

/** Date-only ISO string for today. */
function defaultTo(now: Date): string {
  return toDateOnly(now);
}

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default router;
