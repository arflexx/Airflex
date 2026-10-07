import { Router } from "express";
import { createHash } from "crypto";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { QueueService } from "../jobs";
import type { TradeOffer, TradeStatus } from "../types/trade";
import logger from "../utils/logger";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask a phone number — show country code + last 4 digits only: +234 *** *** 7890 */
function maskPhone(phone: string): string {
  if (phone.length < 6) return "***";
  const visible = phone.slice(-4);
  const prefix  = phone.startsWith("+") ? phone.slice(0, 4) : phone.slice(0, 3);
  return `${prefix} *** *** ${visible}`;
}

/**
 * One-way SHA-256 hash of a phone number.
 * Used to replace PII on deletion while preserving a non-reversible fingerprint
 * for deduplication (prevents the same phone re-registering under old audit rows).
 */
function hashPhone(phone: string): string {
  return "deleted:" + createHash("sha256").update(phone).digest("hex");
}

/**
 * Sends a deletion confirmation SMS via Termii.
 * Non-fatal — if SMS delivery fails we log and continue; the deletion still proceeds.
 */
async function sendDeletionConfirmationSms(
  phone: string,
  scheduledAt: Date
): Promise<void> {
  const apiKey = process.env["TERMII_API_KEY"];
  if (!apiKey) {
    logger.warn("[profile] TERMII_API_KEY not set — skipping deletion confirmation SMS");
    return;
  }

  const formattedDate = scheduledAt.toISOString().split("T")[0]; // YYYY-MM-DD

  const body = {
    api_key:      apiKey,
    to:           phone,
    from:         "AirFlex",
    sms:          `Your AirFlex account deletion has been scheduled. Your personal data will be permanently anonymised on ${formattedDate}. If this was not you, reply CANCEL or contact support immediately.`,
    type:         "plain",
    channel:      "generic",
  };

  try {
    const res = await fetch("https://api.ng.termii.com/api/sms/send", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn(
        { status: res.status, body: text },
        "[profile] Deletion confirmation SMS failed"
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "[profile] Deletion confirmation SMS threw an error"
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/profile  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns the authenticated user's profile metadata.
 *
 * Response shape:
 * {
 *   data: {
 *     id: string
 *     maskedPhone: string       // e.g. "+234 *** *** 5678"
 *     createdAt: string         // ISO timestamp
 *     totalTradesCompleted: number
 *     stellarPublicKey: string
 *   }
 * }
 */
router.get(
  "/",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const { rows: userRows } = await pool.query<{
      id: string;
      phone: string;
      created_at: string;
      stellar_public_key: string | null;
      kyc_status: string | null;
      referral_code: string | null;
    }>(
      `SELECT id, phone, created_at, stellar_public_key, kyc_status, referral_code
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (!userRows.length) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const user = userRows[0]!;

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM trade_offers
       WHERE status = 'Completed'
         AND (seller_id = $1 OR buyer_id = $1)`,
      [userId]
    );

    const totalTradesCompleted = parseInt(countRows[0]?.count ?? "0", 10);

    res.status(200).json({
      data: {
        id:                   user.id,
        maskedPhone:          maskPhone(user.phone),
        createdAt:            user.created_at,
        totalTradesCompleted,
        stellarPublicKey:     user.stellar_public_key ?? "",
        kycStatus:            user.kyc_status ?? "unverified",
        referralCode:         user.referral_code ?? "",
      },
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/profile/trades  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns the paginated trade history for the authenticated user.
 *
 * Query params:
 *   page    — 1-based page number (default: 1)
 *   limit   — items per page (default: 10, max: 50)
 *   status  — filter by trade status: All | Active | Locked | Completed | Cancelled | Disputed
 */
const ALLOWED_STATUSES: TradeStatus[] = ["Active", "Locked", "Completed", "Cancelled", "Disputed"];

router.get(
  "/trades",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const rawPage   = parseInt(String(req.query["page"]  ?? "1"),  10);
    const rawLimit  = parseInt(String(req.query["limit"] ?? "10"), 10);
    const rawStatus = String(req.query["status"] ?? "All");

    const page  = isNaN(rawPage)  || rawPage  < 1 ? 1  : rawPage;
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 10
                : rawLimit > 50                   ? 50
                :                                   rawLimit;
    const offset = (page - 1) * limit;

    const filterByStatus =
      rawStatus !== "All" &&
      (ALLOWED_STATUSES as string[]).includes(rawStatus);

    const baseParams: (string | number)[] = [userId, userId];
    const baseWhere = `(seller_id = $1 OR buyer_id = $2)`;

    let dataParams:  (string | number)[];
    let countParams: (string | number)[];
    let fullWhere:   string;

    if (filterByStatus) {
      dataParams  = [...baseParams, rawStatus, limit, offset];
      countParams = [...baseParams, rawStatus];
      fullWhere   = `${baseWhere} AND status = $3`;
    } else {
      dataParams  = [...baseParams, limit, offset];
      countParams = [...baseParams];
      fullWhere   = baseWhere;
    }

    const limitIdx  = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    // Explicitly listed (rather than `SELECT *`) so contract_listing_id and
    // escrow_tx_hash are guaranteed present in the response — the frontend
    // trade-history view links out to a Stellar explorer using exactly these
    // two columns, and an explicit column list makes that contract visible
    // here instead of depending on trade_offers' column set matching
    // whatever `TradeOffer` happens to declare.
    const { rows: trades } = await pool.query<TradeOffer>(
      `SELECT id,
              seller_id,
              buyer_id,
              asset_type,
              amount,
              fee_amount,
              seller_net_amount,
              status,
              contract_listing_id,
              escrow_tx_hash,
              expires_at,
              created_at,
              updated_at
       FROM trade_offers
       WHERE ${fullWhere}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      dataParams
    );

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM trade_offers WHERE ${fullWhere}`,
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
// GET /api/v1/profile/deletion-status  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns whether the account has a pending deletion request and when the
 * hard anonymisation is scheduled.
 *
 * Response shape:
 * {
 *   pendingDeletion: boolean
 *   scheduledDeletionAt: string | null   // ISO timestamp or null
 * }
 */
router.get(
  "/deletion-status",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const { rows } = await pool.query<{
      pending_deletion:      boolean;
      scheduled_deletion_at: string | null;
    }>(
      `SELECT pending_deletion, scheduled_deletion_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const user = rows[0]!;

    res.status(200).json({
      pendingDeletion:     user.pending_deletion ?? false,
      scheduledDeletionAt: user.scheduled_deletion_at ?? null,
    });
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/v1/profile  (authenticated)
// ---------------------------------------------------------------------------

/**
 * GDPR / NDPR — Right to Erasure
 *
 * Initiates a 30-day soft-delete grace period:
 *  1. Marks the account pending_deletion = true, scheduled_deletion_at = NOW() + 30 days.
 *  2. Cancels all Active/Locked trades owned by the user.
 *     - Active trades: set to Cancelled.
 *     - Locked trades: set to Cancelled (escrow refund handled out-of-band by admin/oracle).
 *  3. Replaces transaction rows' user references with the sentinel "[deleted]" for audit.
 *  4. Sends a confirmation SMS via Termii with the scheduled date.
 *
 * Hard anonymisation (phone hash, null keys) does NOT happen here — it should
 * be run by a scheduled job after the 30-day window passes.
 *
 * The user can cancel within the grace window via POST /api/v1/profile/cancel-deletion.
 */
router.delete(
  "/",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    // Load the user row to check current deletion state and get phone for SMS
    const { rows: userRows } = await pool.query<{
      id: string;
      phone: string;
      pending_deletion: boolean;
    }>(
      `SELECT id, phone, pending_deletion
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (!userRows.length) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const user = userRows[0]!;

    if (user.pending_deletion) {
      res.status(400).json({
        error:
          "Account deletion is already pending. " +
          "Call POST /api/v1/profile/cancel-deletion to cancel it within the grace window.",
      });
      return;
    }

    // Scheduled hard-anonymisation date — 30 days from now
    const scheduledDeletionAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Populated inside the transaction below with any trades that were
    // Locked (and therefore have real funds in escrow) at the moment they
    // were cancelled — read outside the try block, after COMMIT, to enqueue
    // on-chain refunds.
    let tradesNeedingRefund: Array<{
      id: string;
      buyer_id: string | null;
      contract_listing_id: string | null;
    }> = [];

    // Run all DB mutations in a single transaction for atomicity
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Mark account as pending deletion
      await client.query(
        `UPDATE users
         SET pending_deletion      = true,
             scheduled_deletion_at = $1,
             updated_at            = NOW()
         WHERE id = $2`,
        [scheduledDeletionAt, userId]
      );

      // 2. Cancel all Active and Locked trades where user is the seller or buyer.
      //
      //    A Locked trade has real funds sitting in the escrow contract, so
      //    before flipping it to Cancelled we capture its pre-update state
      //    (status, buyer_id, contract_listing_id) — RETURNING on the UPDATE
      //    itself only ever reflects the *new* row, so it can't tell us which
      //    rows used to be Locked. `FOR UPDATE` holds the rows so nothing else
      //    changes their status between this read and the write just below.
      const { rows: tradesToCancel } = await client.query<{
        id: string;
        status: string;
        buyer_id: string | null;
        contract_listing_id: string | null;
      }>(
        `SELECT id, status, buyer_id, contract_listing_id
         FROM trade_offers
         WHERE (seller_id = $1 OR buyer_id = $1)
           AND status IN ('Active', 'Locked')
         FOR UPDATE`,
        [userId]
      );

      const { rows: cancelledTrades } = await client.query<{ id: string }>(
        `UPDATE trade_offers
         SET status     = 'Cancelled',
             updated_at = NOW()
         WHERE (seller_id = $1 OR buyer_id = $1)
           AND status IN ('Active', 'Locked')
         RETURNING id`,
        [userId]
      );

      if (cancelledTrades.length > 0) {
        logger.info(
          { userId, cancelledCount: cancelledTrades.length },
          "[profile] Cancelled pending trades for deletion request"
        );
      }

      // Trades that were Locked (not just Active) have buyer funds already
      // deposited into the escrow contract. Cancelling them in the database
      // alone doesn't move anything on-chain — previously nothing did, so a
      // buyer's money could stay locked in escrow indefinitely after their
      // trade was marked Cancelled. Queue an on-chain refund for each one;
      // the job itself (jobs/processors/refund-cancelled-trade.ts) is
      // enqueued after COMMIT below, once the cancellation is durable.
      tradesNeedingRefund = tradesToCancel.filter(
        (t) => t.status === "Locked" && t.buyer_id && t.contract_listing_id
      );

      // 3. Replace user references in the transactions table with the sentinel
      //    "[deleted]" so audit rows are preserved without PII linkage.
      //    We use DO NOTHING on the column not existing — the transactions table
      //    may use user_id as a FK; we update a separate denormalised column
      //    `display_user_id` if it exists, otherwise skip gracefully.
      //
      //    NOTE: Adapt this query to match your actual transactions table schema.
      //    The pattern below covers a common shape:
      //      transactions(id, user_id, trade_id, type, amount, created_at, display_user_id)
      //    If your schema differs, update the column name accordingly.
      try {
        await client.query(
          `UPDATE transactions
           SET display_user_id = '[deleted]'
           WHERE user_id = $1`,
          [userId]
        );
      } catch (txErr) {
        // Transactions table may not exist yet or schema may differ — log and continue
        logger.warn(
          { err: (txErr as Error).message },
          "[profile] Could not update transactions table — skipping sentinel replacement"
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // 4. Enqueue on-chain refunds for any Locked trades cancelled above
    //    (fire after DB commit — the cancellation must be durable first).
    for (const trade of tradesNeedingRefund) {
      QueueService.enqueue("refund-cancelled-trade", {
        tradeId: trade.id,
        contractTradeId: trade.contract_listing_id!,
        buyerId: trade.buyer_id!,
      }).catch((err) => {
        logger.error(
          { err: (err as Error).message, tradeId: trade.id },
          "[profile] Failed to enqueue on-chain refund for cancelled trade"
        );
      });
    }

    // 5. Send confirmation SMS (non-fatal — fire after DB commit)
    void sendDeletionConfirmationSms(user.phone, scheduledDeletionAt);

    logger.info(
      { userId, scheduledDeletionAt },
      "[profile] Account deletion request accepted"
    );

    res.status(200).json({
      message:
        "Account deletion requested. Your personal data will be permanently " +
        "anonymised in 30 days. You will receive a confirmation SMS. " +
        "You can cancel this request within the grace period.",
      scheduledDeletionAt: scheduledDeletionAt.toISOString(),
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/profile/cancel-deletion  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Cancels a pending 30-day deletion request within the grace window.
 * Clears the pending_deletion flag and nulls the scheduled date.
 */
router.post(
  "/cancel-deletion",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const { rows } = await pool.query<{
      id: string;
      pending_deletion: boolean;
      scheduled_deletion_at: string | null;
    }>(
      `SELECT id, pending_deletion, scheduled_deletion_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const user = rows[0]!;

    if (!user.pending_deletion) {
      res.status(400).json({
        error: "No pending deletion request found for this account.",
      });
      return;
    }

    // Guard: ensure we're still within the grace window
    if (user.scheduled_deletion_at) {
      const scheduledAt = new Date(user.scheduled_deletion_at);
      if (scheduledAt <= new Date()) {
        res.status(400).json({
          error:
            "The deletion grace period has already passed. " +
            "Your account has been queued for hard anonymisation. Contact support.",
        });
        return;
      }
    }

    await pool.query(
      `UPDATE users
       SET pending_deletion      = false,
           scheduled_deletion_at = NULL,
           updated_at            = NOW()
       WHERE id = $1`,
      [userId]
    );

    logger.info({ userId }, "[profile] Account deletion cancelled by user");

    res.status(200).json({
      message: "Account deletion cancelled. Your account is fully restored.",
    });
  }
);

export default router;
