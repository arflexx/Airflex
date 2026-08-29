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

import { Router, Request, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { QueueService } from "../jobs";
import { authorize } from "../middleware/authorize";
import { z } from "zod";
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
  async (_req, res) => {
    const queues = QueueService.getStats();
    res.status(200).json({ queues });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users/:phone  (admin only)
// ---------------------------------------------------------------------------

router.get("/users", authenticate, authorize("admin"), (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

router.get("/trades", authenticate, authorize("admin"), (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

router.patch("/users/:id", authenticate, authorize("admin"), (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

const kycSchema = z.object({
  status: z.enum(["unverified", "pending", "verified"]),
});

router.patch("/users/:id/kyc", authenticate, authorize("admin"), async (req, res) => {
  const parsed = kycSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid KYC status", details: parsed.error.flatten() });
    return;
  }

  const { rows } = await pool.query(
    `UPDATE users SET kyc_status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, kyc_status`,
    [parsed.data.status, req.params.id]
  );

  if (!rows.length) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(200).json({ data: rows[0] });
});

export default router;
