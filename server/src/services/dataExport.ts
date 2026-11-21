/**
 * dataExport.ts — GDPR Article 20 data portability exports (issue #539).
 *
 * Flow:
 *   1. GET /users/me/export → requestDataExport(): enforces one export per
 *      user per 24 h, inserts a 'pending' row and enqueues
 *      `generate-data-export`.
 *   2. The job calls buildUserDataExport() inside a REPEATABLE READ snapshot,
 *      encrypts the JSON with ENCRYPTION_KEY and stores it as 'ready'. The
 *      user is notified by SMS (the platform has no email channel).
 *   3. GET /users/me/export/:id returns status and, once ready, a signed
 *      download URL valid for DATA_EXPORT_LINK_TTL_SECONDS.
 *   4. GET /users/me/export/:id/download?expires=&signature= streams the
 *      decrypted JSON as an attachment. The signature alone authorises the
 *      download so it works as a plain browser navigation.
 *
 * Redaction policy: the export contains the user's own personal data. It
 * excludes credentials (Stellar secret key, token version, recovery codes),
 * raw payment details (full bank account numbers, Paystack codes, payment
 * webhook payloads), internal storage keys, and other users' identifiers.
 * Everything excluded is listed in the export's `redactions` section.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { PoolClient } from "pg";
import pool from "../db";
import { WalletService, maskPaymentIdentifier, type WalletExport } from "./wallet";

/** Minimum time between two export requests from the same user. */
export const DATA_EXPORT_COOLDOWN_HOURS = 24;

/** Statuses that count against the 24 h limit (a failed export does not). */
const COUNTED_STATUSES = ["pending", "processing", "ready", "expired"] as const;

export const EXPORT_SCHEMA_VERSION = "1.0";

export type DataExportStatus = "pending" | "processing" | "ready" | "failed" | "expired";

export interface DataExportRequest {
  id: string;
  user_id: string;
  status: DataExportStatus;
  format: "json";
  requested_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  downloaded_at: Date | null;
  failure_reason: string | null;
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long a generated export is kept before cleanup (default 7 days). */
export function exportRetentionHours(): number {
  return positiveIntEnv("DATA_EXPORT_RETENTION_HOURS", 168);
}

/** Lifetime of a signed download URL (default 15 minutes). */
export function downloadLinkTtlSeconds(): number {
  return positiveIntEnv("DATA_EXPORT_LINK_TTL_SECONDS", 900);
}

// ---------------------------------------------------------------------------
// Requesting an export (rate limited)
// ---------------------------------------------------------------------------

export type RequestExportResult =
  | { ok: true; request: DataExportRequest }
  | { ok: false; existing: DataExportRequest; retryAfterSeconds: number };

const REQUEST_COLUMNS = `id, user_id, status, format, requested_at, completed_at,
                         expires_at, downloaded_at, failure_reason`;

/**
 * Creates a new export request unless the user already has one inside the
 * cooldown window. A per-user advisory lock serialises concurrent calls so
 * two simultaneous requests cannot both slip under the limit.
 */
export async function requestDataExport(userId: string): Promise<RequestExportResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`data-export:${userId}`]);

    const { rows: recent } = await client.query<DataExportRequest>(
      `SELECT ${REQUEST_COLUMNS}
       FROM data_export_requests
       WHERE user_id = $1
         AND status = ANY($2::text[])
         AND requested_at > NOW() - make_interval(hours => $3)
       ORDER BY requested_at DESC
       LIMIT 1`,
      [userId, COUNTED_STATUSES, DATA_EXPORT_COOLDOWN_HOURS]
    );

    if (recent.length) {
      await client.query("ROLLBACK");
      const existing = recent[0]!;
      const retryAt = new Date(existing.requested_at).getTime() + DATA_EXPORT_COOLDOWN_HOURS * 3_600_000;
      return {
        ok: false,
        existing,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)),
      };
    }

    const { rows } = await client.query<DataExportRequest>(
      `INSERT INTO data_export_requests (user_id) VALUES ($1) RETURNING ${REQUEST_COLUMNS}`,
      [userId]
    );
    await client.query("COMMIT");
    return { ok: true, request: rows[0]! };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Loads one of the user's export requests, or null if not theirs / unknown. */
export async function getDataExportRequest(
  userId: string,
  exportId: string
): Promise<DataExportRequest | null> {
  const { rows } = await pool.query<DataExportRequest>(
    `SELECT ${REQUEST_COLUMNS} FROM data_export_requests WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [exportId, userId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Signed download URLs
// ---------------------------------------------------------------------------

/**
 * Signing key derived from ENCRYPTION_KEY with a fixed context string, so a
 * download signature can never be confused with (or replayed as) a JWT.
 */
function signingKey(): Buffer {
  const secret = process.env["ENCRYPTION_KEY"];
  if (!secret) throw new Error("ENCRYPTION_KEY is required to sign data export URLs");
  return createHmac("sha256", secret).update("airflex:data-export-url:v1").digest();
}

function computeSignature(exportId: string, userId: string, expires: number): string {
  return createHmac("sha256", signingKey())
    .update(`${exportId}.${userId}.${expires}`)
    .digest("base64url");
}

/** Signs a download for `exportId`, valid until `expires` (epoch seconds). */
export function signDownload(
  exportId: string,
  userId: string,
  expires: number
): { expires: number; signature: string } {
  return { expires, signature: computeSignature(exportId, userId, expires) };
}

/** Constant-time check of a download signature and its expiry. */
export function verifyDownloadSignature(
  exportId: string,
  userId: string,
  expires: number,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!Number.isInteger(expires) || expires < nowSeconds) return false;
  const expected = Buffer.from(computeSignature(exportId, userId, expires));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// Building the export
// ---------------------------------------------------------------------------

export interface UserDataExport {
  schemaVersion: string;
  exportId: string;
  generatedAt: string;
  account: Record<string, unknown> | null;
  kyc: Record<string, unknown> | null;
  trades: Array<Record<string, unknown>>;
  ratings: { given: Array<Record<string, unknown>>; received: Array<Record<string, unknown>> };
  wallet: WalletExport;
  referrals: {
    referralCode: string | null;
    referredBy: { joinedAt: string; rewardedAt: string | null } | null;
    referred: Array<{ joinedAt: string; rewardedAt: string | null }>;
  };
  redactions: Array<{ field: string; treatment: "omitted" | "masked"; reason: string }>;
}

export const EXPORT_REDACTIONS: UserDataExport["redactions"] = [
  { field: "wallets.stellar_secret_key", treatment: "omitted", reason: "Credential — grants control of the wallet" },
  { field: "users.token_version, recovery codes, OTPs", treatment: "omitted", reason: "Authentication secrets" },
  { field: "users.kyc_nin", treatment: "masked", reason: "National identity number — last 3 digits kept" },
  { field: "users.kyc_document_path", treatment: "omitted", reason: "Internal storage key; document presence is reported instead" },
  { field: "users.virtual_account_number", treatment: "masked", reason: "Raw payment detail — last 4 digits kept" },
  { field: "users.paystack_customer_code", treatment: "omitted", reason: "Payment processor identifier" },
  { field: "withdrawals.account_number", treatment: "masked", reason: "Raw payment detail — last 4 digits kept" },
  { field: "withdrawals.paystack_recipient_code, paystack_transfer_code", treatment: "omitted", reason: "Payment processor identifiers" },
  { field: "transactions.external_reference", treatment: "masked", reason: "Payment reference — last 6 characters kept" },
  { field: "payment_events.payload", treatment: "omitted", reason: "Raw payment processor payloads" },
  { field: "trade counterparties, raters and referred users", treatment: "omitted", reason: "Personal data of other users" },
];

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Assembles the full export for `userId`. Run inside a REPEATABLE READ
 * transaction on `client` so every section reflects the same snapshot.
 */
export async function buildUserDataExport(
  client: PoolClient,
  userId: string,
  exportId: string
): Promise<UserDataExport> {
  const { rows: userRows } = await client.query<{
    id: string;
    phone: string;
    display_handle: string | null;
    role: string;
    created_at: Date;
    stellar_public_key: string | null;
    referral_code: string | null;
    opt_out_notifications: boolean | null;
    pending_deletion: boolean | null;
    scheduled_deletion_at: Date | null;
    virtual_bank_name: string | null;
    virtual_account_number: string | null;
    kyc_status: string | null;
    kyc_legal_name: string | null;
    kyc_date_of_birth: Date | null;
    kyc_nin: string | null;
    kyc_document_path: string | null;
  }>(
    `SELECT id, phone, display_handle, role, created_at, stellar_public_key, referral_code,
            opt_out_notifications, pending_deletion, scheduled_deletion_at,
            virtual_bank_name, virtual_account_number,
            kyc_status, kyc_legal_name, kyc_date_of_birth, kyc_nin, kyc_document_path
     FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const user = userRows[0];

  const { rows: kycAttempts } = await client.query<{ requested_at: Date }>(
    `SELECT requested_at FROM kyc_submission_attempts WHERE user_id = $1 ORDER BY requested_at ASC`,
    [userId]
  );

  const { rows: trades } = await client.query<{
    id: string;
    seller_id: string;
    asset_type: string;
    amount: string;
    fee_amount: string | null;
    seller_net_amount: string | null;
    status: string;
    escrow_tx_hash: string | null;
    expires_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, seller_id, asset_type, amount::text AS amount, fee_amount::text AS fee_amount,
            seller_net_amount::text AS seller_net_amount, status, escrow_tx_hash,
            expires_at, created_at, updated_at
     FROM trade_offers
     WHERE seller_id = $1 OR buyer_id = $1
     ORDER BY created_at ASC`,
    [userId]
  );

  const { rows: ratingsGiven } = await client.query<{
    trade_id: string; stars: number; comment: string | null; created_at: Date;
  }>(
    `SELECT trade_id, stars, comment, created_at FROM ratings WHERE reviewer_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  const { rows: ratingsReceived } = await client.query<{
    trade_id: string; stars: number; comment: string | null; created_at: Date;
  }>(
    `SELECT trade_id, stars, comment, created_at FROM ratings WHERE reviewee_id = $1 ORDER BY created_at ASC`,
    [userId]
  );

  const { rows: referredBy } = await client.query<{ created_at: Date; rewarded_at: Date | null }>(
    `SELECT created_at, rewarded_at FROM referrals WHERE referred_id = $1 LIMIT 1`,
    [userId]
  );
  const { rows: referred } = await client.query<{ created_at: Date; rewarded_at: Date | null }>(
    `SELECT created_at, rewarded_at FROM referrals WHERE referrer_id = $1 ORDER BY created_at ASC`,
    [userId]
  );

  const wallet = await new WalletService(client).exportHistory(userId);

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportId,
    generatedAt: new Date().toISOString(),
    account: user
      ? {
          id: user.id,
          phone: user.phone,
          displayHandle: user.display_handle,
          role: user.role,
          createdAt: iso(user.created_at),
          stellarPublicKey: user.stellar_public_key,
          notificationsOptedOut: Boolean(user.opt_out_notifications),
          pendingDeletion: Boolean(user.pending_deletion),
          scheduledDeletionAt: iso(user.scheduled_deletion_at),
          virtualAccount: user.virtual_account_number
            ? {
                bankName: user.virtual_bank_name,
                accountNumber: maskPaymentIdentifier(user.virtual_account_number),
              }
            : null,
        }
      : null,
    kyc: user
      ? {
          status: user.kyc_status,
          legalName: user.kyc_legal_name,
          dateOfBirth: user.kyc_date_of_birth ? iso(user.kyc_date_of_birth)!.slice(0, 10) : null,
          nin: maskPaymentIdentifier(user.kyc_nin, 3),
          documentOnFile: Boolean(user.kyc_document_path),
          submissionAttempts: kycAttempts.map((a) => iso(a.requested_at)),
        }
      : null,
    trades: trades.map((t) => ({
      id: t.id,
      role: t.seller_id === userId ? "seller" : "buyer",
      assetType: t.asset_type,
      amount: t.amount,
      feeAmount: t.fee_amount,
      sellerNetAmount: t.seller_net_amount,
      status: t.status,
      escrowTxHash: t.escrow_tx_hash,
      expiresAt: iso(t.expires_at),
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
    })),
    ratings: {
      given: ratingsGiven.map((r) => ({
        tradeId: r.trade_id, stars: r.stars, comment: r.comment, createdAt: iso(r.created_at),
      })),
      received: ratingsReceived.map((r) => ({
        tradeId: r.trade_id, stars: r.stars, comment: r.comment, createdAt: iso(r.created_at),
      })),
    },
    wallet,
    referrals: {
      referralCode: user?.referral_code ?? null,
      referredBy: referredBy[0]
        ? { joinedAt: iso(referredBy[0].created_at)!, rewardedAt: iso(referredBy[0].rewarded_at) }
        : null,
      referred: referred.map((r) => ({ joinedAt: iso(r.created_at)!, rewardedAt: iso(r.rewarded_at) })),
    },
    redactions: EXPORT_REDACTIONS,
  };
}

/** SHA-256 of the serialised export, stored so downloads can be integrity-checked. */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}
