/**
 * admin.ts — Admin-only API routes.
 *
 * All routes require a valid Bearer JWT (`authenticate`) and an admin role
 * (`authorize("admin")`). The admin role is checked against the `role` column
 * on the users row.
 *
 * Endpoints:
 *   GET  /api/v1/admin/queues            — background job queue health
 *   GET  /api/v1/admin/trades            — all trades (optional status filter + pagination)
 *   POST /api/v1/admin/trades/:id/resolve— settle a disputed trade (RELEASE | REFUND)
 *   GET  /api/v1/admin/users             — paginated users with balance + trade count
 *   GET  /api/v1/admin/users/:phone      — single user profile + wallet + trade history
 */

import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { authorize } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { QueueService } from "../jobs";
import { SseEmitter } from "../services/sseEmitter";
import pool from "../db";
import { resolveDispute } from "../services/stellar";
import {
  resolveDisputeSchema,
  paginationSchema,
  type ResolveDisputeInput,
} from "../schemas";
import type { TradeOffer } from "../types/trade";
import { FraudDetectionService } from "../services/fraudDetection";

const router = Router();

const ALLOWED_TRADE_STATUSES = [
  "Active",
  "Locked",
  "Completed",
  "Cancelled",
  "Disputed",
] as const;

// ---------------------------------------------------------------------------
// GET /api/v1/admin/queues  (admin only)
// ---------------------------------------------------------------------------

/**
 * Returns queue depths and recent failure counts for all background job queues.
 */
router.get(
  "/queues",
  authenticate,
  authorize("admin"),
  async (_req, res) => {
    const queues = QueueService.getStats();
    res.status(200).json({ queues });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/trades  (admin only)
// ---------------------------------------------------------------------------

/**
 * Returns all trades with optional `?status=Disputed` filtering and pagination.
 */
router.get(
  "/trades",
  authenticate,
  authorize("admin"),
  async (req, res) => {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const rawStatus =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const filterByStatus = rawStatus !== undefined;

    if (
      filterByStatus &&
      !(ALLOWED_TRADE_STATUSES as readonly string[]).includes(rawStatus)
    ) {
      res.status(400).json({
        error: `status must be one of: ${ALLOWED_TRADE_STATUSES.join(", ")}`,
      });
      return;
    }

    const where = filterByStatus ? "WHERE status = $1" : "";
    const dataParams: (string | number)[] = filterByStatus
      ? [rawStatus!, limit, offset]
      : [limit, offset];
    const countParams: (string | number)[] = filterByStatus ? [rawStatus!] : [];
    const limitIdx = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    const { rows: trades } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      dataParams
    );

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM trade_offers ${where}`,
      countParams
    );

    const total = parseInt(countRows[0]?.count ?? "0", 10);

    res.status(200).json({
      data: trades,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/admin/trades/:id/resolve  (admin only)
// ---------------------------------------------------------------------------

/**
 * Settles a disputed trade by calling `resolve_dispute` on the Soroban escrow
 * contract and updating the trade status in PostgreSQL.
 *
 * Body: { resolution: "RELEASE" | "REFUND" }
 *   - RELEASE → funds released to the seller; DB status becomes Completed.
 *   - REFUND  → funds returned to the buyer;  DB status becomes Cancelled.
 *
 * If the on-chain contract call fails, the database update is rolled back and
 * the endpoint responds with HTTP 502 and a descriptive error.
 */
router.post(
  "/trades/:id/resolve",
  authenticate,
  authorize("admin"),
  validate(resolveDisputeSchema),
  async (req, res) => {
    const { id } = req.params;
    const { resolution } = req.body as ResolveDisputeInput;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: tradeRows } = await client.query<TradeOffer>(
        `SELECT * FROM trade_offers WHERE id = $1 FOR UPDATE`,
        [id]
      );

      if (!tradeRows.length) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Trade not found" });
        return;
      }

      const trade = tradeRows[0]!;

      if (trade.status !== "Disputed") {
        await client.query("ROLLBACK");
        res.status(400).json({
          error:
            `Trade cannot be resolved in its current state (${trade.status}). ` +
            "Only Disputed trades can be resolved.",
        });
        return;
      }

      if (!trade.contract_listing_id) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Trade has no associated on-chain listing ID" });
        return;
      }

      let txHash: string;
      try {
        txHash = await resolveDispute({
          contractTradeId: trade.contract_listing_id,
          resolution,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({
          error: `Failed to resolve dispute on-chain: ${message}`,
        });
        return;
      }

      const newStatus = resolution === "RELEASE" ? "Completed" : "Cancelled";

      const { rows: updated } = await client.query<TradeOffer>(
        `UPDATE trade_offers
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [newStatus, id]
      );

      await client.query("COMMIT");

      const participants = [trade.seller_id];
      if (trade.buyer_id) participants.push(trade.buyer_id);

      SseEmitter.emit([...new Set(participants)], {
        type: "trade_resolved",
        tradeId: id,
        status: newStatus,
        resolution,
        txHash,
        message:
          resolution === "RELEASE"
            ? "The dispute was resolved in favour of the seller."
            : "The dispute was resolved in favour of the buyer.",
      });

      res.status(200).json({ data: updated[0], txHash });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users  (admin only)
// ---------------------------------------------------------------------------

/**
 * Returns a paginated list of users with their ledger balance, trade count,
 * and registration date.
 */
router.get(
  "/users",
  authenticate,
  authorize("admin"),
  async (req, res) => {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const { rows: users } = await pool.query<{
      id: string;
      phone: string;
      registrationDate: string;
      balance: number;
      tradeCount: number;
    }>(
      `SELECT
         u.id,
         u.phone,
         u.created_at AS "registrationDate",
         COALESCE((
           SELECT SUM(CASE WHEN t.direction = 'credit' THEN t.amount ELSE -t.amount END)
           FROM transactions t
           WHERE t.user_id = u.id
         ), 0)::float8 AS balance,
         COALESCE((
           SELECT COUNT(*)
           FROM trade_offers o
           WHERE o.seller_id = u.id OR o.buyer_id = u.id
         ), 0)::int AS "tradeCount"
       FROM users u
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM users`
    );

    const total = parseInt(countRows[0]?.count ?? "0", 10);

    res.status(200).json({
      data: users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users/:phone  (admin only)
// ---------------------------------------------------------------------------

/**
 * Returns a single user's full profile, wallet balance, and trade history by
 * phone number.
 */
router.get(
  "/users/:phone",
  authenticate,
  authorize("admin"),
  async (req, res) => {
    const { phone } = req.params;

    const { rows: userRows } = await pool.query<{
      id: string;
      phone: string;
      role: string;
      created_at: string;
      stellar_public_key: string | null;
      balance: number;
    }>(
      `SELECT
         u.id,
         u.phone,
         u.role,
         u.created_at,
         u.stellar_public_key,
         COALESCE((
           SELECT SUM(CASE WHEN t.direction = 'credit' THEN t.amount ELSE -t.amount END)
           FROM transactions t
           WHERE t.user_id = u.id
         ), 0)::float8 AS balance
       FROM users u
       WHERE u.phone = $1
       LIMIT 1`,
      [phone]
    );

    if (!userRows.length) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const user = userRows[0]!;

    const { rows: tradeHistory } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers
       WHERE seller_id = $1 OR buyer_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );

    res.status(200).json({
      data: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        registrationDate: user.created_at,
        stellarPublicKey: user.stellar_public_key,
        balance: user.balance,
        tradeCount: tradeHistory.length,
        tradeHistory,
      },
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/flagged-accounts  (admin only)
// ---------------------------------------------------------------------------

/**
 * Returns accounts flagged for velocity violations (> 3 violations in past 24h).
 */
router.get(
  "/flagged-accounts",
  authenticate,
  authorize("admin"),
  async (_req, res) => {
    const flagged = await FraudDetectionService.getFlaggedAccounts();
    res.status(200).json({ flaggedAccounts: flagged });
  }
);

export default router;
