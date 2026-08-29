/**
 * verify-trade-delivery processor
 *
 * Async delivery verification with Soroban oracle. This is the job-queue
 * equivalent of the existing tradeVerification.ts service — running inside
 * QueueService gives us persistent retries, dead-letter tracking, and admin
 * visibility via GET /api/v1/admin/queues.
 *
 * Job data shape: VerifyTradeDeliveryData
 *
 * Flow:
 *  1. Load the trade from DB and validate it is still Locked.
 *  2. Call release_payment on the Soroban escrow contract.
 *  3. On success: update DB to Completed, notify parties via SSE.
 *  4. On failure: throw so QueueService retries up to MAX_ATTEMPTS.
 *     After all retries exhausted QueueService moves job to dead-letter
 *     and we escalate the trade to Disputed via a separate escalation step.
 */

import type { Job } from "../queue";
import pool from "../../db";
import { releasePayment } from "../../services/stellar";
import { SseEmitter } from "../../services/sseEmitter";
import { NotificationService } from "../../services/notifications";
import type { TradeOffer } from "../../types/trade";
import logger from "../../utils/logger";

export interface VerifyTradeDeliveryData {
  /** AirFlex DB trade UUID */
  tradeId: string;
  /** Seller's user ID — used for SSE targeting */
  sellerId: string;
}

/**
 * Processor — called by QueueService when a verify-trade-delivery job is dequeued.
 *
 * Throws on failure so QueueService applies retry + back-off policy.
 * After all retries are exhausted the job moves to dead-letter and
 * escalateToDisputed() is called to mark the trade as Disputed.
 */
export async function verifyTradeDeliveryProcessor(
  job: Job<VerifyTradeDeliveryData>
): Promise<void> {
  const { tradeId, sellerId } = job.data;
  const isFinalAttempt = job.attempts >= job.maxAttempts;

  logger.info(
    { jobId: job.id, tradeId, attempt: job.attempts },
    "[verify-trade-delivery] Starting verification"
  );

  // ------------------------------------------------------------------
  // 1. Load trade
  // ------------------------------------------------------------------

  const { rows } = await pool.query<TradeOffer>(
    `SELECT * FROM trade_offers WHERE id = $1 LIMIT 1`,
    [tradeId]
  );

  if (!rows.length) {
    // Trade deleted — no point retrying
    logger.warn({ jobId: job.id, tradeId }, "[verify-trade-delivery] Trade not found — discarding job");
    return;
  }

  const trade = rows[0]!;

  if (trade.status !== "Locked") {
    // Already completed or cancelled by another process — idempotent exit
    logger.info(
      { jobId: job.id, tradeId, status: trade.status },
      "[verify-trade-delivery] Trade no longer Locked — skipping"
    );
    return;
  }

  if (!trade.contract_listing_id) {
    throw new Error(`Trade ${tradeId} has no contract_listing_id`);
  }

  // ------------------------------------------------------------------
  // 2. Call release_payment on Soroban contract
  // ------------------------------------------------------------------

  let txHash: string;
  try {
    txHash = await releasePayment(trade.contract_listing_id);
  } catch (err) {
    const reason = (err as Error).message;

    // If this is the last attempt, escalate to Disputed before throwing
    if (isFinalAttempt) {
      await escalateToDisputed(trade, reason);
    }

    // Always re-throw so QueueService records the failure
    throw err;
  }

  // ------------------------------------------------------------------
  // 3. Update DB to Completed
  // ------------------------------------------------------------------

  const { rows: updated } = await pool.query<TradeOffer>(
    `UPDATE trade_offers
        SET status     = 'Completed',
            updated_at = NOW()
      WHERE id = $1
        AND status = 'Locked'
      RETURNING *`,
    [tradeId]
  );

  if (!updated.length) {
    logger.warn(
      { jobId: job.id, tradeId },
      "[verify-trade-delivery] DB update skipped — status already changed"
    );
    return;
  }

  logger.info({ jobId: job.id, tradeId, txHash }, "[verify-trade-delivery] Trade completed");

  // ------------------------------------------------------------------
  // 4. Notify parties via SSE
  // ------------------------------------------------------------------

  const participants = [trade.seller_id];
  if (trade.buyer_id) participants.push(trade.buyer_id);

  SseEmitter.emit([...new Set(participants)], {
    type:    "trade_completed",
    tradeId,
    status:  "Completed",
    txHash,
    message: "Payment has been released to the seller.",
  });

  // Out-of-band SMS to both parties (best-effort)
  void NotificationService.sendToMany(participants, "TRADE_COMPLETED", {
    tradeId,
  });
}

// ---------------------------------------------------------------------------
// Escalation helper
// ---------------------------------------------------------------------------

async function escalateToDisputed(trade: TradeOffer, reason: string): Promise<void> {
  const { id: tradeId } = trade;

  logger.error(
    { tradeId, reason },
    "[verify-trade-delivery] All retries exhausted — escalating to Disputed"
  );

  try {
    await pool.query(
      `UPDATE trade_offers
          SET status     = 'Disputed',
              updated_at = NOW()
        WHERE id = $1
          AND status = 'Locked'`,
      [tradeId]
    );
  } catch (dbErr) {
    logger.error(
      { tradeId, err: (dbErr as Error).message },
      "[verify-trade-delivery] Failed to update trade to Disputed"
    );
  }

  const participants = [trade.seller_id];
  if (trade.buyer_id) participants.push(trade.buyer_id);

  SseEmitter.emit([...new Set(participants)], {
    type:    "trade_disputed",
    tradeId,
    status:  "Disputed",
    message: "Payment release failed after multiple attempts. An admin will review your trade.",
  });

  SseEmitter.emitAll({
    type:     "admin_alert",
    tradeId,
    sellerId: trade.seller_id,
    buyerId:  trade.buyer_id,
    reason,
    message:  `Trade ${tradeId} escalated to Disputed after all retry attempts failed.`,
  });

  // Out-of-band SMS to both parties and all admins (best-effort)
  void NotificationService.sendToMany(participants, "DISPUTE_FILED", {
    tradeId,
  });
  void NotificationService.sendToAdmins("DISPUTE_FILED", { tradeId });
}
