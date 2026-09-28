/**
 * refund-cancelled-trade processor
 *
 * Background job: releases a buyer's escrowed funds back to them on-chain
 * after their trade was cancelled in the database while still Locked.
 *
 * Why this exists: DELETE /api/v1/profile (account deletion) cancels a
 * user's Active/Locked trades in Postgres immediately, but a Locked trade
 * has real funds sitting in the escrow contract. Previously nothing ever
 * told the chain about the cancellation, so a buyer's money could stay
 * locked in escrow indefinitely after their trade was marked Cancelled in
 * the database. This processor closes that gap by calling the same
 * admin-signed `resolve_dispute` path the admin dispute-resolution endpoint
 * uses, with a REFUND resolution, so the buyer is made whole on-chain.
 *
 * The QueueService retries this job up to 3 times with exponential back-off
 * before moving it to the dead-letter queue (visible via
 * GET /api/v1/admin/webhooks-style tooling — see QueueService.getStats()),
 * so a stuck refund surfaces for manual admin follow-up rather than being
 * silently lost.
 *
 * Job data shape: RefundCancelledTradeData
 */

import type { Job } from "../queue";
import logger from "../../utils/logger";
import { resolveDispute } from "../../services/stellar";

export interface RefundCancelledTradeData {
  /** AirFlex trade_offers.id */
  tradeId: string;
  /** The on-chain trade/listing ID (trade_offers.contract_listing_id) */
  contractTradeId: string;
  /** The buyer being refunded — for logging only; the contract call itself
   *  doesn't need it since resolve_dispute's REFUND resolution routes funds
   *  to the buyer address recorded on-chain. */
  buyerId: string;
}

/**
 * Processor — called by QueueService when a refund-cancelled-trade job is
 * dequeued. Calls the escrow contract's dispute-resolution path with a
 * REFUND resolution so the buyer's escrowed funds are returned on-chain.
 */
export async function refundCancelledTradeProcessor(
  job: Job<RefundCancelledTradeData>
): Promise<void> {
  const { tradeId, contractTradeId, buyerId } = job.data;

  logger.info(
    { jobId: job.id, tradeId, buyerId, attempt: job.attempts },
    "[refund-cancelled-trade] Starting"
  );

  const txHash = await resolveDispute({
    contractTradeId,
    resolution: "REFUND",
  });

  logger.info(
    { jobId: job.id, tradeId, buyerId, txHash },
    "[refund-cancelled-trade] Completed"
  );
}
