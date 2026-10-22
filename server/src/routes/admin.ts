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
 *   GET  /api/v1/admin/fraud-flags       — accounts flagged by fraud rules (status filter + pagination)
 *   PATCH /api/v1/admin/fraud-flags/:id  — close a flag as reviewed or dismissed
 *   GET  /api/v1/admin/audit-logs        — immutable admin action trail (super_admin only)
 *
 * Every state-changing route records an entry in `audit_logs` (actor, action,
 * target, before/after state, request context) via services/auditLog.ts.
 */

import { Router } from "express";
import { createHash } from "crypto";
import { authenticate } from "../middleware/authenticate";
import { authorize } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { normalizePhone, maskPhone } from "../utils/phone";
import { QueueService } from "../jobs";
import { SseEmitter } from "../services/sseEmitter";
import pool from "../db";
import { resolveDispute } from "../services/stellar";
import {
  resolveDisputeSchema,
  reviewFraudFlagSchema,
  paginationSchema,
  auditLogQuerySchema,
  type ResolveDisputeInput,
  type ReviewFraudFlagInput,
} from "../schemas";
import type { TradeOffer } from "../types/trade";
import { FraudDetectionService, type FraudFlagStatus } from "../services/fraudDetection";
import type { AuthenticatedRequest } from "../middleware/authenticate";
import {
  auditActor,
  auditContext,
  listAuditLogs,
  recordAuditLog,
  recordAuditLogAfterCommit,
} from "../services/auditLog";

const router = Router();

const ALLOWED_TRADE_STATUSES = [
  "Active",
  "Locked",
  "Completed",
  "Cancelled",
  "Disputed",
] as const;

/**
 * Columns admins are allowed to sort GET /admin/trades by (issue: sorting
 * previously only supported created_at DESC). Whitelisted rather than taking
 * the column name straight from the query string, since that string is
 * interpolated into the ORDER BY clause and cannot be parameterised.
 */
const ALLOWED_SORT_FIELDS = [
  "created_at",
  "updated_at",
  "amount",
  "status",
  "expires_at",
] as const;
type SortField = (typeof ALLOWED_SORT_FIELDS)[number];

const ALLOWED_SORT_ORDERS = ["asc", "desc"] as const;

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
 * Returns all trades with optional `?status=Disputed` filtering, pagination,
 * and sorting.
 *
 * Sorting: `?sortBy=<field>&sortOrder=<asc|desc>`. `sortBy` defaults to
 * `created_at` and `sortOrder` defaults to `desc` (the previous, hard-coded
 * behaviour), but any field in ALLOWED_SORT_FIELDS may now be requested.
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

    const rawSortBy =
      typeof req.query.sortBy === "string" ? req.query.sortBy : "created_at";
    if (!(ALLOWED_SORT_FIELDS as readonly string[]).includes(rawSortBy)) {
      res.status(400).json({
        error: `sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(", ")}`,
      });
      return;
    }
    const sortBy = rawSortBy as SortField;

    const rawSortOrder =
      typeof req.query.sortOrder === "string"
        ? req.query.sortOrder.toLowerCase()
        : "desc";
    if (!(ALLOWED_SORT_ORDERS as readonly string[]).includes(rawSortOrder)) {
      res.status(400).json({
        error: `sortOrder must be one of: ${ALLOWED_SORT_ORDERS.join(", ")}`,
      });
      return;
    }
    const sortOrder = rawSortOrder.toUpperCase() as "ASC" | "DESC";

    const where = filterByStatus ? "WHERE status = $1" : "";
    const dataParams: (string | number)[] = filterByStatus
      ? [rawStatus!, limit, offset]
      : [limit, offset];
    const countParams: (string | number)[] = filterByStatus ? [rawStatus!] : [];
    const limitIdx = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    // sortBy/sortOrder come from a closed whitelist above, never from the raw
    // query string, so interpolating them into ORDER BY is safe here.
    const { rows: trades } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers
       ${where}
       ORDER BY ${sortBy} ${sortOrder}, created_at DESC
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

      // Same transaction as the status change: the audit row and the
      // resolution commit or roll back together.
      await recordAuditLog(
        {
          ...auditActor(req),
          action: "trade.dispute_resolved",
          targetType: "trade",
          targetId: id!,
          before: { status: trade.status },
          after: { status: newStatus, resolution, txHash },
          metadata: auditContext(req),
        },
        client
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
 *
 * Performance (issue #256): the original query computed balance and trade
 * count via correlated subqueries, executing one sub-select per user row —
 * O(n) against `transactions` and `trade_offers` for a result set of n users.
 * At 1 000 users that is 2 000 sub-selects; at 10 000 users it causes timeouts.
 *
 * The fix aggregates both metrics in a single pass each using grouped
 * subqueries joined with LEFT JOIN.  The planner can hash- or merge-join the
 * pre-aggregated subqueries against `users` in one scan, reducing total I/O
 * from O(n) correlated lookups to O(1) sequential scans regardless of page size.
 * `transactions(user_id)` is indexed by migration 010 (added alongside this
 * change) so the aggregation scan uses the index rather than a full table scan.
 *
 * Issue #480: the grouped subqueries above still aggregated *every* row in
 * `transactions` and `trade_offers` on each request, so latency grew with
 * total platform activity even though only one page of users is returned.
 * The page is now selected first (`page_users` CTE) and both aggregates are
 * restricted to that page with a batched `IN (SELECT id FROM page_users)`,
 * which lets Postgres use the user_id / seller_id / buyer_id indexes from
 * migration 010. The handler still issues exactly two queries per request
 * (page + total count) regardless of page size, and the response shape and
 * ordering are unchanged.
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
      `WITH page_users AS (
         SELECT id, phone, created_at
         FROM users
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2
       )
       SELECT
         pu.id,
         pu.phone,
         pu.created_at AS "registrationDate",
         COALESCE(tx_agg.net_balance, 0)::float8          AS balance,
         COALESCE(tr_agg.trade_count, 0)::int             AS "tradeCount"
       FROM page_users pu
       LEFT JOIN (
         SELECT
           user_id,
           SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS net_balance
         FROM transactions
         WHERE user_id IN (SELECT id FROM page_users)
         GROUP BY user_id
       ) tx_agg ON tx_agg.user_id = pu.id
       LEFT JOIN (
         SELECT participant_id, COUNT(*) AS trade_count
         FROM (
           SELECT seller_id AS participant_id FROM trade_offers
           WHERE seller_id IN (SELECT id FROM page_users)
           UNION ALL
           SELECT buyer_id  AS participant_id FROM trade_offers
           WHERE buyer_id  IN (SELECT id FROM page_users)
         ) participation
         GROUP BY participant_id
       ) tr_agg ON tr_agg.participant_id = pu.id
       ORDER BY pu.created_at DESC`,
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
    const normalizedPhone = normalizePhone(phone);

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
      [normalizedPhone]
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

    const phoneHash = createHash("sha256")
      .update(user.phone)
      .digest("hex")
      .slice(0, 8);

    res.status(200).json({
      data: {
        id: user.id,
        maskedPhone: maskPhone(user.phone),
        phoneHash,
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

// ---------------------------------------------------------------------------
// Fraud flag review queue (issue #491)
// ---------------------------------------------------------------------------

const FRAUD_FLAG_STATUSES: readonly FraudFlagStatus[] = ["open", "reviewed", "dismissed"];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/admin/fraud-flags?status=open&page=1&limit=20
 *
 * Accounts flagged by fraud rules (e.g. REPEATED_FAILED_TRADES), newest
 * first. `status` is optional; omit it to list every flag.
 */
router.get(
  "/fraud-flags",
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

    const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
    if (rawStatus !== undefined && !FRAUD_FLAG_STATUSES.includes(rawStatus as FraudFlagStatus)) {
      res.status(400).json({
        error: `Invalid status. Allowed: ${FRAUD_FLAG_STATUSES.join(", ")}`,
      });
      return;
    }

    const { page, limit } = parsed.data;
    const { flags, total } = await FraudDetectionService.listFraudFlags({
      status: rawStatus as FraudFlagStatus | undefined,
      limit,
      offset: (page - 1) * limit,
    });

    res.status(200).json({
      data: flags,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }
);

/**
 * PATCH /api/v1/admin/fraud-flags/:id   body: { status: "reviewed" | "dismissed", note? }
 *
 * Closes an open flag and records the reviewing admin, timestamp and note.
 * 404 if the flag doesn't exist, 409 if it was already closed.
 */
router.patch(
  "/fraud-flags/:id",
  authenticate,
  authorize("admin"),
  validate(reviewFraudFlagSchema),
  async (req, res) => {
    const { id } = req.params;
    if (!id || !UUID_PATTERN.test(id)) {
      res.status(400).json({ error: "Invalid fraud flag id" });
      return;
    }

    const { status, note } = req.body as ReviewFraudFlagInput;
    const reviewerId = (req as unknown as AuthenticatedRequest).user.sub;

    const flag = await FraudDetectionService.reviewFraudFlag(id, reviewerId, status, note || null);
    if (flag) {
      // reviewFraudFlag only updates rows that were 'open', so that is the
      // prior state by construction.
      await recordAuditLogAfterCommit({
        ...auditActor(req),
        action: "fraud_flag.reviewed",
        targetType: "fraud_flag",
        targetId: id,
        before: { status: "open" },
        after: {
          status: flag.status,
          reviewed_by: flag.reviewed_by,
          reviewed_at: flag.reviewed_at,
          review_note: flag.review_note,
        },
        metadata: auditContext(req),
      });
      res.status(200).json({ data: flag });
      return;
    }

    const { rows } = await pool.query<{ status: FraudFlagStatus }>(
      `SELECT status FROM fraud_flags WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!rows.length) {
      res.status(404).json({ error: "Fraud flag not found" });
      return;
    }
    res.status(409).json({ error: `Fraud flag is already ${rows[0]!.status}` });
  }
);

// ---------------------------------------------------------------------------
// Webhook dead-letter inspection (#118)
// ---------------------------------------------------------------------------

router.get(
  "/webhooks",
  authenticate,
  authorize("admin"),
  async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, provider, event_type, payload, status, processed_at, created_at
       FROM webhook_events
       WHERE status = 'failed'
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.status(200).json({ events: rows });
  }
);

router.post(
  "/webhooks/:id/replay",
  authenticate,
  authorize("admin"),
  async (req, res) => {
    const id = req.params["id"];

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_events WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      res.status(404).json({ error: "Webhook event not found" });
      return;
    }

    if (rows[0]!.status !== "failed") {
      res.status(409).json({ error: "Only failed webhook events can be replayed" });
      return;
    }

    await pool.query(
      `UPDATE webhook_events SET status = 'pending', processed_at = NULL WHERE id = $1`,
      [id]
    );

    await recordAuditLogAfterCommit({
      ...auditActor(req),
      action: "webhook.replayed",
      targetType: "webhook_event",
      targetId: id!,
      before: { status: "failed" },
      after: { status: "pending" },
      metadata: auditContext(req),
    });

    await QueueService.enqueue("process-paystack-webhook", { webhookEventId: id });

    res.status(202).json({ message: "Webhook re-enqueued for processing" });
  }
);

// ---------------------------------------------------------------------------
// Audit logs (issue #539) — super_admin only, read-only
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/audit-logs
 *   ?actorId=&action=&targetType=&targetId=&from=&to=&page=1&limit=20
 *
 * Immutable trail of state-changing admin actions, newest first. Restricted
 * to super_admin: regular admins are the subjects of this log and must not
 * be able to read (or infer) what is recorded about them.
 */
router.get(
  "/audit-logs",
  authenticate,
  authorize("super_admin"),
  async (req, res) => {
    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit, actorId, action, targetType, targetId, from, to } = parsed.data;
    const { entries, total } = await listAuditLogs({
      actorId,
      action,
      targetType,
      targetId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit,
      offset: (page - 1) * limit,
    });

    res.status(200).json({
      data: entries,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }
);

/**
 * Audit entries are append-only. Answer any attempt to create, edit or delete
 * one through the API with 405 instead of a generic 404, so the intent is
 * explicit (the database trigger in migration 013 enforces the same rule).
 */
router.all(["/audit-logs", "/audit-logs/:id"], (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  res.setHeader("Allow", "GET");
  res.status(405).json({ error: "Audit logs are immutable" });
});

export default router;
