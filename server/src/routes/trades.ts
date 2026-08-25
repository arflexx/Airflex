import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { createListing, depositToEscrow } from "../services/stellar";
import {
  triggerVerification,
  VerificationError,
} from "../services/tradeVerification";
import type { TradeOffer } from "../types/trade";
import {
  createTradeSchema,
  buyTradeSchema,
  paginationSchema,
  type CreateTradeInput,
  type BuyTradeInput,
} from "../schemas";
import { asyncHandler } from "../utils/asyncHandler";

const router: Router = Router();

// ---------------------------------------------------------------------------
// GET /api/trades
// ---------------------------------------------------------------------------

router.get(
  "/",
  asyncHandler(async (req, res) => {
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

    const { rows: trades } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers
       WHERE status = 'Active' AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM trade_offers
       WHERE status = 'Active' AND expires_at > NOW()`
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
  })
);

// ---------------------------------------------------------------------------
// POST /api/trades  (authenticated)
// ---------------------------------------------------------------------------

router.post(
  "/",
  authenticate,
  validate(createTradeSchema),
  asyncHandler(async (req, res) => {
    const { assetType, amount, expiresInHours } = req.body as CreateTradeInput;
    const { sub: sellerId, stellarPublicKey } = (req as AuthenticatedRequest).user;

    // Fetch seller's encrypted secret key from their wallet record
    const { rows: walletRows } = await pool.query<{
      stellar_secret_key: string;
    }>(
      `SELECT stellar_secret_key FROM wallets WHERE user_id = $1 LIMIT 1`,
      [sellerId]
    );

    if (!walletRows.length || !walletRows[0]?.stellar_secret_key) {
      res.status(400).json({ error: "Seller wallet not found" });
      return;
    }

    const expiresAt = new Date(
      Date.now() + expiresInHours * 60 * 60 * 1000
    );

    // Call Soroban create_listing — may throw if contract call fails
    const contractListingId = await createListing({
      sellerPublicKey: stellarPublicKey,
      sellerSecretKey: walletRows[0].stellar_secret_key,
      assetType,
      amount,
      expiresAt,
    });

    const tradeId = uuidv4();

    const { rows } = await pool.query<TradeOffer>(
      `INSERT INTO trade_offers
         (id, seller_id, asset_type, amount, status, contract_listing_id, expires_at)
       VALUES ($1, $2, $3, $4, 'Active', $5, $6)
       RETURNING *`,
      [tradeId, sellerId, assetType, amount, contractListingId, expiresAt]
    );

    res.status(201).json({ data: rows[0] });
  })
);

// ---------------------------------------------------------------------------
// GET /api/trades/:id
// ---------------------------------------------------------------------------

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers WHERE id = $1`,
      [id]
    );

    if (!rows.length) {
      res.status(404).json({ error: "Trade offer not found" });
      return;
    }

    res.status(200).json({ data: rows[0] });
  })
);

// ---------------------------------------------------------------------------
// POST /api/trades/:id/buy  (authenticated)
// ---------------------------------------------------------------------------

router.post(
  "/:id/buy",
  authenticate,
  validate(buyTradeSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { sub: buyerId, stellarPublicKey } = (req as AuthenticatedRequest).user;
    const { buyerSecretKey } = req.body as BuyTradeInput;

    // Load the trade offer
    const { rows: tradeRows } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers WHERE id = $1`,
      [id]
    );

    if (!tradeRows.length) {
      res.status(404).json({ error: "Trade offer not found" });
      return;
    }

    const trade = tradeRows[0]!;

    if (trade.status !== "Active") {
      res.status(400).json({
        error: `Trade is not available for purchase (status: ${trade.status})`,
      });
      return;
    }

    if (!trade.contract_listing_id) {
      res.status(400).json({ error: "Trade has no associated contract listing" });
      return;
    }

    if (trade.seller_id === buyerId) {
      res.status(400).json({ error: "Seller cannot buy their own trade" });
      return;
    }

    // Call Soroban deposit_to_escrow
    const txHash = await depositToEscrow({
      buyerPublicKey: stellarPublicKey,
      buyerSecretKey: buyerSecretKey,
      listingId: trade.contract_listing_id,
      amount: trade.amount,
    });

    // Lock the trade in the database
    const { rows: updated } = await pool.query<TradeOffer>(
      `UPDATE trade_offers
       SET status = 'Locked', buyer_id = $1, escrow_tx_hash = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [buyerId, txHash, id]
    );

    res.status(200).json({ data: updated[0] });
  })
);

// ---------------------------------------------------------------------------
// POST /api/trades/:id/confirm-delivery  (authenticated — seller only)
// ---------------------------------------------------------------------------

/**
 * Seller calls this endpoint to signal that they have delivered the
 * airtime / data and the escrow payment should be released.
 *
 * The endpoint responds with 202 Accepted immediately. Verification and the
 * Soroban `release_payment` call run asynchronously in the background so the
 * seller's request never times out waiting for on-chain confirmation.
 *
 * Flow:
 *  1. Authenticate + validate trade ownership synchronously.
 *  2. Return 202 to the seller.
 *  3. tradeVerification.triggerVerification() runs in the background:
 *       - Calls release_payment on the escrow contract (up to 3 attempts).
 *       - On success: updates DB to Completed, notifies parties via SSE.
 *       - On failure: escalates to Disputed, fires SSE admin alert.
 */
router.post(
  "/:id/confirm-delivery",
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { sub: sellerId } = (req as AuthenticatedRequest).user;

    try {
      // triggerVerification validates synchronously then fires async work
      await triggerVerification(id, sellerId);
    } catch (err) {
      if (err instanceof VerificationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err; // Re-throw unexpected errors to global handler
    }

    res.status(202).json({
      message:
        "Delivery confirmation received. Payment release is being processed — " +
        "you will be notified via the event stream when complete.",
      tradeId: id,
    });
  })
);

export default router;
