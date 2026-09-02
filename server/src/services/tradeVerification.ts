/**
 * tradeVerification.ts — Oracle/Verification service for AirFlex.
 *
 * Responsibility
 * --------------
 * Once a seller calls POST /api/v1/trades/:id/confirm-delivery, this service:
 *
 *  1. Validates the trade is in the correct state (Locked).
 *  2. Attempts to call `release_payment` on the Soroban escrow contract
 *     using the server's admin signing key (STELLAR_SERVER_SECRET).
 *  3. On success → updates the DB row to Completed and notifies both
 *     parties via SSE.
 *  4. On failure → retries up to MAX_RETRIES times with exponential back-off.
 *  5. After exhausting retries → escalates the trade to Disputed in the DB,
 *     emits an SSE admin alert, and logs a structured error for ops.
 *
 * The STELLAR_SERVER_SECRET is read from the environment at call time and
 * is NEVER stored in a variable that survives the function call scope, and
 * NEVER included in any log statement.
 *
 * Design notes
 * ------------
 * - Each verification attempt runs in its own async execution context.
 *   The HTTP response to the caller is sent immediately (202 Accepted) and
 *   the verification runs in the background so the seller's request doesn't
 *   time out waiting for Soroban RPC polling.
 * - Retries use truncated exponential back-off with jitter to avoid
 *   thundering-herd if multiple trades are retried simultaneously.
 * - The service is stateless — retry state lives in the recursive call stack,
 *   not in module-level mutable state. This makes it safe to run in a
 *   single-process setup and easy to reason about.
 */

import pool from "../db";
import { releasePayment } from "./stellar";
import { SseEmitter } from "./sseEmitter";
import { WalletService } from "./wallet";
import { creditReferralReward } from "./referrals";
import { NotificationService } from "./notifications";
import type { TradeOffer } from "../types/trade";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

/**
 * Base delay in ms for the first retry. Each subsequent retry doubles this
 * value plus a random jitter of ±20 % to spread load.
 */
const BASE_RETRY_DELAY_MS = 2_000;

export function calculatePlatformFee(amount: number): number {
  const configured = Number.parseFloat(process.env["PLATFORM_FEE_PERCENT"] ?? "1.5");
  const percentage = Number.isFinite(configured) ? configured : 1.5;
  return Math.round((amount * percentage / 100 + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Triggers the delivery verification flow for a trade.
 *
 * This function returns immediately after basic validation. The actual
 * contract call and retry logic run asynchronously in the background.
 *
 * @param tradeId   The AirFlex DB trade UUID.
 * @param sellerId  The user ID of the seller (used to authorise the call).
 * @throws          If the trade is not found, not Locked, or the caller is
 *                  not the seller — these errors propagate synchronously so
 *                  the HTTP layer can respond with the correct status code.
 */
export async function triggerVerification(
  tradeId: string,
  sellerId: string
): Promise<void> {
  // ------------------------------------------------------------------
  // 1. Load and validate the trade synchronously before returning 202
  // ------------------------------------------------------------------
  const { rows } = await pool.query<TradeOffer>(
    `SELECT * FROM trade_offers WHERE id = $1 LIMIT 1`,
    [tradeId]
  );

  if (!rows.length) {
    throw new VerificationError("Trade not found", 404);
  }

  const trade = rows[0]!;

  if (trade.seller_id !== sellerId) {
    throw new VerificationError("Only the seller can confirm delivery", 403);
  }

  if (trade.status !== "Locked") {
    throw new VerificationError(
      `Trade cannot be confirmed in its current state (${trade.status}). ` +
        `Only Locked trades can be confirmed.`,
      400
    );
  }

  if (!trade.contract_listing_id) {
    throw new VerificationError(
      "Trade has no associated on-chain listing ID",
      400
    );
  }

  // ------------------------------------------------------------------
  // 2. Kick off async verification — do NOT await; returns to caller
  // ------------------------------------------------------------------
  void runVerificationWithRetry(trade, 1);
}

// ---------------------------------------------------------------------------
// Internal — retry loop
// ---------------------------------------------------------------------------

/**
 * Attempts to call `release_payment` on the contract, retrying up to
 * MAX_RETRIES times on failure. On final failure escalates to Disputed.
 */
async function runVerificationWithRetry(
  trade: TradeOffer,
  attempt: number
): Promise<void> {
  const tradeId          = trade.id;
  const contractListingId = trade.contract_listing_id!;

  log("info", tradeId, `Verification attempt ${attempt}/${MAX_RETRIES}`);

  try {
    // ------------------------------------------------------------------
    // Call release_payment on the Soroban contract
    // ------------------------------------------------------------------
    const txHash = await releasePayment(contractListingId);

    // ------------------------------------------------------------------
    // Success — update DB to Completed
    // ------------------------------------------------------------------
    const client = await pool.connect();
    let updated: TradeOffer[] = [];
    try {
      await client.query("BEGIN");
      const { rows: locked } = await client.query<TradeOffer>(
        `SELECT * FROM trade_offers WHERE id = $1 AND status = 'Locked' FOR UPDATE`,
        [tradeId]
      );
      if (!locked.length) {
        await client.query("ROLLBACK");
        log("warn", tradeId, "Settlement skipped — status already changed");
        return;
      }

      const settledTrade = locked[0]!;
      const tradeAmount = Number(settledTrade.amount);
      const feeAmount = calculatePlatformFee(tradeAmount);
      const sellerNetAmount = Math.round((tradeAmount - feeAmount + Number.EPSILON) * 100) / 100;
      const treasuryUserId = process.env["PLATFORM_TREASURY_USER_ID"];
      if (!treasuryUserId) throw new Error("PLATFORM_TREASURY_USER_ID is not set");
      if (!settledTrade.buyer_id) throw new Error("Trade has no buyer to debit");

      const wallet = new WalletService(client);
      await wallet.debit(settledTrade.buyer_id, tradeAmount, tradeId);
      await wallet.credit({ userId: settledTrade.seller_id, amount: sellerNetAmount, type: "trade_settlement", tradeId });
      await wallet.credit({ userId: treasuryUserId, amount: feeAmount, type: "platform_fee", tradeId });

      const result = await client.query<TradeOffer>(
        `UPDATE trade_offers
            SET status = 'Completed', fee_amount = $2, seller_net_amount = $3, updated_at = NOW()
          WHERE id = $1 AND status = 'Locked'
          RETURNING *`,
        [tradeId, feeAmount, sellerNetAmount]
      );
      updated = result.rows;
      await creditReferralReward(client, settledTrade.buyer_id, tradeId);
      await creditReferralReward(client, settledTrade.seller_id, tradeId);
      await client.query("COMMIT");
    } catch (settlementError) {
      await client.query("ROLLBACK");
      throw settlementError;
    } finally {
      client.release();
    }

    if (!updated.length) return;

    log("info", tradeId, `Release successful. tx=${txHash}`);

    // ------------------------------------------------------------------
    // Notify parties via SSE
    // ------------------------------------------------------------------
    const participants = buildParticipantList(trade);

    SseEmitter.emit(participants, {
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

  } catch (err) {
    const errorName = err instanceof Error ? err.constructor.name : "UnknownError";
    const message = err instanceof Error ? err.message : String(err);
    log("error", tradeId, `Attempt ${attempt} failed [${errorName}]: ${message}`);

    if (attempt < MAX_RETRIES) {
      // Exponential back-off with ±20 % jitter
      const delay = backoffDelay(attempt);
      log("info", tradeId, `Retrying in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      return runVerificationWithRetry(trade, attempt + 1);
    }

    // ------------------------------------------------------------------
    // All retries exhausted — escalate to Disputed
    // ------------------------------------------------------------------
    await escalateToDisputed(trade, message);
  }
}

/**
 * Marks the trade as Disputed in the DB and fires an SSE admin alert.
 * This is the "dead-letter" path — ops must manually intervene.
 */
async function escalateToDisputed(
  trade: TradeOffer,
  reason: string
): Promise<void> {
  const tradeId = trade.id;

  log(
    "error",
    tradeId,
    `Escalating to Disputed after ${MAX_RETRIES} failed attempts. Reason: ${reason}`
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
    // If the DB update itself fails, log but don't throw — we still want
    // to fire the admin alert.
    const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
    log("error", tradeId, `Failed to update status to Disputed: ${msg}`);
  }

  // Notify trade parties that the trade is now disputed
  const participants = buildParticipantList(trade);
  SseEmitter.emit(participants, {
    type:    "trade_disputed",
    tradeId,
    status:  "Disputed",
    message: "Payment release failed after multiple attempts. An admin will review your trade.",
  });

  // Admin alert — broadcast to all connected admin clients.
  // In a production system this would also fire a Slack/PagerDuty webhook.
  SseEmitter.emitAll({
    type:    "admin_alert",
    tradeId,
    sellerId: trade.seller_id,
    buyerId:  trade.buyer_id,
    reason,
    message: `Trade ${tradeId} escalated to Disputed after ${MAX_RETRIES} failed release attempts.`,
  });

  // Out-of-band SMS to both parties and all admins (best-effort)
  void NotificationService.sendToMany(participants, "DISPUTE_FILED", {
    tradeId,
  });
  void NotificationService.sendToAdmins("DISPUTE_FILED", { tradeId });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a deduplicated list of user IDs involved in a trade. */
function buildParticipantList(trade: TradeOffer): string[] {
  const ids = [trade.seller_id];
  if (trade.buyer_id) ids.push(trade.buyer_id);
  return [...new Set(ids)];
}

/**
 * Truncated exponential back-off with ±20 % random jitter.
 * attempt=1 → ~2 s, attempt=2 → ~4 s, attempt=3 → ~8 s (capped at 30 s).
 */
function backoffDelay(attempt: number): number {
  const base   = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  const capped = Math.min(base, 30_000);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1); // ±20 %
  return Math.round(capped + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Structured logger — deliberately excludes any secret values.
 * Replace with your observability sink (Pino, Winston, Datadog, etc.).
 */
function log(
  level: "info" | "warn" | "error",
  tradeId: string,
  message: string
): void {
  const line = `[tradeVerification] [${level.toUpperCase()}] trade=${tradeId} ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/**
 * Carries an HTTP status code so the route handler can respond correctly
 * for synchronous validation failures (not found, forbidden, bad state).
 */
export class VerificationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "VerificationError";
  }
}
