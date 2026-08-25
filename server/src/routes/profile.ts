import { Router } from "express";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import type { TradeOffer, TradeStatus } from "../types/trade";
import { asyncHandler } from "../utils/asyncHandler";

const router: Router = Router();

/** Mask a phone number — show country code + last 4 digits only: +234 *** *** 7890 */
function maskPhone(phone: string): string {
  if (phone.length < 6) return "***";
  const visible = phone.slice(-4);
  const prefix  = phone.startsWith("+") ? phone.slice(0, 4) : phone.slice(0, 3);
  return `${prefix} *** *** ${visible}`;
}

// ---------------------------------------------------------------------------
// GET /api/profile  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns the authenticated user's profile metadata.
 *
 * Response shape:
 * {
 *   data: {
 *     id: string
 *     maskedPhone: string       // e.g. "+234 *** *** 5678"
 *     createdAt: string         // ISO timestamp — registration date
 *     totalTradesCompleted: number
 *     stellarPublicKey: string
 *   }
 * }
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    // Fetch user row
    const { rows: userRows } = await pool.query<{
      id: string;
      phone: string;
      created_at: string;
      stellar_public_key: string | null;
    }>(
      `SELECT id, phone, created_at, stellar_public_key
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

    // Count completed trades where the user was either seller or buyer
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM trade_offers
       WHERE status = 'Completed'
         AND (seller_id = $1 OR buyer_id = $1)`,
      [userId]
    );

    const totalTradesCompleted = parseInt(countRows[0]?.count ?? "0", 10);

    res.status(200).json({
      data: {
        id: user.id,
        maskedPhone:          maskPhone(user.phone),
        createdAt:            user.created_at,
        totalTradesCompleted,
        stellarPublicKey:     user.stellar_public_key ?? "",
      },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/profile/trades  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns the paginated trade history for the authenticated user.
 * Includes trades where the user was the seller OR the buyer.
 *
 * Query params:
 *   page    — 1-based page number (default: 1)
 *   limit   — items per page (default: 10, max: 50)
 *   status  — filter by trade status: All | Completed | Cancelled | Disputed
 *             ("All" or omitted returns every status)
 *
 * Response shape:
 * {
 *   data: TradeOffer[],
 *   pagination: { page, limit, total, totalPages }
 * }
 */

const ALLOWED_STATUSES: TradeStatus[] = ["Active", "Locked", "Completed", "Cancelled"];

router.get(
  "/trades",
  authenticate,
  asyncHandler(async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    // Parse + validate query params manually (keep deps minimal)
    const rawPage   = parseInt(String(req.query["page"]  ?? "1"),  10);
    const rawLimit  = parseInt(String(req.query["limit"] ?? "10"), 10);
    const rawStatus = String(req.query["status"] ?? "All");

    const page  = isNaN(rawPage)  || rawPage  < 1  ? 1  : rawPage;
    const limit = isNaN(rawLimit) || rawLimit < 1  ? 10
                : rawLimit > 50                    ? 50
                :                                    rawLimit;
    const offset = (page - 1) * limit;

    // Status filter — "All" means no filter
    const filterByStatus =
      rawStatus !== "All" &&
      (ALLOWED_STATUSES as string[]).includes(rawStatus);

    // Build separate param arrays for data vs count queries to keep them clean
    const baseParams: (string | number)[] = [userId, userId];
    const baseWhere = `(seller_id = $1 OR buyer_id = $2)`;

    let dataParams: (string | number)[];
    let countParams: (string | number)[];
    let fullWhere: string;

    if (filterByStatus) {
      // $3 = status, $4 = limit, $5 = offset
      dataParams  = [...baseParams, rawStatus, limit, offset];
      countParams = [...baseParams, rawStatus];
      fullWhere   = `${baseWhere} AND status = $3`;
    } else {
      // $3 = limit, $4 = offset
      dataParams  = [...baseParams, limit, offset];
      countParams = [...baseParams];
      fullWhere   = baseWhere;
    }

    const limitIdx  = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    const { rows: trades } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers
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
  })
);

export default router;
