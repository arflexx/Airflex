import { createHash, randomUUID } from "crypto";
import type { PoolClient } from "pg";
import pool from "../db";
import { cache } from "./cache";

export type WalletTransactionType =
  | "trade_settlement"
  | "platform_fee"
  | "referral_reward"
  | "deposit";

export interface WalletTransactionInput {
  userId: string;
  amount: number;
  type: WalletTransactionType;
  /** Required for trade-related types; omit for deposits. */
  tradeId?: string | null;
  /** External payment reference (e.g. Paystack reference) for deposit types. */
  externalReference?: string | null;
}

/**
 * Wallet section of a GDPR data export (issue #539).
 *
 * Deliberately omits the Stellar secret key, Paystack recipient/transfer
 * codes and full bank account numbers: these are credentials or raw payment
 * details, not personal data the user needs to port, and leaking them from a
 * downloaded file would let anyone holding it move funds.
 */
export interface WalletExport {
  wallet: {
    stellarPublicKey: string | null;
    fiatBalance: string | null;
  } | null;
  transactions: Array<{
    id: string;
    tradeId: string | null;
    amount: string;
    direction: "credit" | "debit";
    type: string;
    externalReference: string | null;
    createdAt: string;
  }>;
  withdrawals: Array<{
    id: string;
    amount: string;
    bankCode: string;
    accountName: string;
    accountNumber: string;
    reference: string;
    status: string;
    failureReason: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

/** Keeps the last `visible` characters of a payment identifier. */
export function maskPaymentIdentifier(value: string | null, visible = 4): string | null {
  if (value === null) return null;
  if (value.length <= visible) return "*".repeat(value.length);
  return `${"*".repeat(value.length - visible)}${value.slice(-visible)}`;
}

/** Database-backed wallet ledger operations. Callers own the transaction. */
export class WalletService {
  constructor(private readonly client: PoolClient) {}

  /**
   * Collects the user's wallet, ledger and withdrawal history for a data
   * export, with payment details redacted (see WalletExport). Run inside a
   * REPEATABLE READ transaction for a consistent snapshot.
   */
  async exportHistory(userId: string): Promise<WalletExport> {
    const { rows: walletRows } = await this.client.query<{
      stellar_public_key: string | null;
      fiat_balance: string | null;
    }>(
      `SELECT stellar_public_key, fiat_balance::text AS fiat_balance
       FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    const { rows: txRows } = await this.client.query<{
      id: string;
      trade_id: string | null;
      amount: string;
      direction: "credit" | "debit";
      type: string;
      external_reference: string | null;
      created_at: Date;
    }>(
      `SELECT id, trade_id, amount::text AS amount, direction, type, external_reference, created_at
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    const { rows: wdRows } = await this.client.query<{
      id: string;
      amount: string;
      bank_code: string;
      account_name: string;
      account_number: string;
      reference: string;
      status: string;
      failure_reason: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, amount::text AS amount, bank_code, account_name, account_number,
              reference, status, failure_reason, created_at, updated_at
       FROM withdrawals
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId]
    );

    const wallet = walletRows[0];

    return {
      wallet: wallet
        ? { stellarPublicKey: wallet.stellar_public_key, fiatBalance: wallet.fiat_balance }
        : null,
      transactions: txRows.map((t) => ({
        id: t.id,
        tradeId: t.trade_id,
        amount: t.amount,
        direction: t.direction,
        type: t.type,
        externalReference: maskPaymentIdentifier(t.external_reference, 6),
        createdAt: new Date(t.created_at).toISOString(),
      })),
      withdrawals: wdRows.map((w) => ({
        id: w.id,
        amount: w.amount,
        bankCode: w.bank_code,
        accountName: w.account_name,
        accountNumber: maskPaymentIdentifier(w.account_number) ?? "",
        reference: w.reference,
        status: w.status,
        failureReason: w.failure_reason,
        createdAt: new Date(w.created_at).toISOString(),
        updatedAt: new Date(w.updated_at).toISOString(),
      })),
    };
  }

  async debit(userId: string, amount: number, tradeId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO transactions (user_id, trade_id, amount, direction, type)
       VALUES ($1, $2, $3, 'debit', 'trade_settlement')`,
      [userId, tradeId, amount]
    );
  }

  /**
   * Credit a user's wallet.
   *
   * For `deposit` credits the method also increments `wallets.fiat_balance`
   * so the stored balance stays in sync with the ledger. All other credit
   * types (trade_settlement, platform_fee, referral_reward) are ledger-only
   * entries settled by the trade flow.
   */
  async credit(input: WalletTransactionInput): Promise<void> {
    await this.client.query(
      `INSERT INTO transactions
         (user_id, trade_id, amount, direction, type, external_reference)
       VALUES ($1, $2, $3, 'credit', $4, $5)`,
      [
        input.userId,
        input.tradeId ?? null,
        input.amount,
        input.type,
        input.externalReference ?? null,
      ]
    );

    // Deposits must also update the wallet's running fiat balance.
    if (input.type === "deposit") {
      await this.client.query(
        `UPDATE wallets SET fiat_balance = fiat_balance + $1 WHERE user_id = $2`,
        [input.amount, input.userId]
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotent withdrawals (issue #479)
// ---------------------------------------------------------------------------

/**
 * Accepted `Idempotency-Key` values: what a client gets from
 * `crypto.randomUUID()` or a similar generator, with no room for whitespace
 * or other content that has no business being in a key.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export type IdempotencyKeyCheck =
  | { ok: true; key: string }
  | { ok: false; error: string };

/** Validates the raw `Idempotency-Key` header of a withdrawal request. */
export function parseIdempotencyKey(raw: string | undefined): IdempotencyKeyCheck {
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, error: "Idempotency-Key header is required" };
  }
  const key = raw.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      error:
        "Idempotency-Key must be 8–128 characters of letters, digits, '.', '_', ':' or '-'",
    };
  }
  return { ok: true, key };
}

export interface WithdrawalRequest {
  amount: number;
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

export interface WithdrawalOutcome {
  status: number;
  body: Record<string, unknown>;
  /** True when `body` is the stored response to an earlier request. */
  replayed: boolean;
  /** Set when this call created a withdrawal that still has to be queued. */
  withdrawalId?: string;
}

/** Identifies the request a key was first used with. */
export function withdrawalFingerprint(request: WithdrawalRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.amount,
        request.bankCode,
        request.accountNumber,
        request.accountName,
      ])
    )
    .digest("hex");
}

interface StoredKey {
  request_fingerprint: string;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
}

async function findStoredKey(
  db: Pick<PoolClient, "query">,
  userId: string,
  key: string
): Promise<StoredKey | null> {
  const { rows } = await db.query<StoredKey>(
    `SELECT request_fingerprint, response_status, response_body
       FROM withdrawal_idempotency_keys
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key]
  );
  return rows[0] ?? null;
}

function replay(stored: StoredKey, fingerprint: string): WithdrawalOutcome {
  if (stored.request_fingerprint !== fingerprint) {
    return {
      status: 422,
      body: {
        error:
          "This Idempotency-Key was already used for a different withdrawal request. " +
          "Use a new key for a new withdrawal.",
      },
      replayed: false,
    };
  }
  if (stored.response_status === null || stored.response_body === null) {
    // Only visible to a reader inside the creating transaction; kept as a
    // safe answer rather than a crash.
    return {
      status: 409,
      body: { error: "A withdrawal with this Idempotency-Key is still being processed." },
      replayed: false,
    };
  }
  return { status: stored.response_status, body: stored.response_body, replayed: true };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

/**
 * Runs a withdrawal at most once per (user, Idempotency-Key).
 *
 * The first request with a key checks the fiat balance, records a `pending`
 * withdrawal, debits the balance and stores the 202 response under the key —
 * all in one transaction. Any later request with the same key, including one
 * racing the first, gets that stored response back without touching the
 * wallet.
 *
 * Requests that are refused (no wallet, insufficient balance) roll back and
 * leave no key behind: nothing was debited, so a retry is simply evaluated
 * again.
 *
 * Queueing the payout job is left to the caller, and only for an outcome
 * with `withdrawalId` set, so a replay never queues a second payout.
 */
export async function executeIdempotentWithdrawal(
  userId: string,
  idempotencyKey: string,
  request: WithdrawalRequest
): Promise<WithdrawalOutcome> {
  const fingerprint = withdrawalFingerprint(request);

  const existing = await findStoredKey(pool, userId, idempotencyKey);
  if (existing) return replay(existing, fingerprint);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Claim the key before touching the wallet. A concurrent request with
    // the same key waits here until this transaction ends.
    try {
      await client.query(
        `INSERT INTO withdrawal_idempotency_keys
           (user_id, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3)`,
        [userId, idempotencyKey, fingerprint]
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await client.query("ROLLBACK");
      const stored = await findStoredKey(pool, userId, idempotencyKey);
      if (!stored) throw err;
      return replay(stored, fingerprint);
    }

    // ---- check fiat balance (row-lock the wallet row) ---------------------
    const { rows: walletRows } = await client.query<{ fiat_balance: string }>(
      `SELECT fiat_balance FROM wallets WHERE user_id = $1 LIMIT 1 FOR UPDATE`,
      [userId]
    );

    if (!walletRows.length) {
      await client.query("ROLLBACK");
      return { status: 404, body: { error: "Wallet not found" }, replayed: false };
    }

    const fiatBalance = parseFloat(walletRows[0]!.fiat_balance);
    if (request.amount > fiatBalance) {
      await client.query("ROLLBACK");
      return { status: 400, body: { error: "Insufficient fiat balance" }, replayed: false };
    }

    // ---- create withdrawal record in `pending` state ----------------------
    const reference = `airflex-wd-${randomUUID()}`;
    const { rows: wdRows } = await client.query<{ id: string }>(
      `INSERT INTO withdrawals
         (user_id, amount, bank_code, account_number, account_name, reference, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [
        userId,
        request.amount,
        request.bankCode,
        request.accountNumber,
        request.accountName,
        reference,
      ]
    );
    const withdrawalId = wdRows[0]!.id;

    // ---- deduct fiat balance atomically -----------------------------------
    await client.query(
      `UPDATE wallets
       SET fiat_balance = fiat_balance - $1
       WHERE user_id = $2`,
      [request.amount, userId]
    );

    const body = {
      withdrawalId,
      reference,
      status: "pending",
      message: "Withdrawal request accepted. Funds will arrive within 1–2 business days.",
    };

    // ---- store the outcome under the key ----------------------------------
    await client.query(
      `UPDATE withdrawal_idempotency_keys
          SET withdrawal_id = $3, response_status = $4, response_body = $5
        WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey, withdrawalId, 202, JSON.stringify(body)]
    );

    await client.query("COMMIT");

    return { status: 202, body, replayed: false, withdrawalId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Idempotent deposits (issues #615, #620)
// ---------------------------------------------------------------------------

export interface DepositRequest {
  amount: number;
}

export interface DepositOutcome {
  status: number;
  body: Record<string, unknown>;
  replayed: boolean;
}

/**
 * Runs a fiat deposit initiation idempotently per (userId, idempotencyKey).
 * Caches the response in Redis with a 24-hour TTL (86,400 seconds).
 */
export async function executeIdempotentDeposit(
  userId: string,
  idempotencyKey: string,
  request: DepositRequest
): Promise<DepositOutcome> {
  const cacheKey = `idempotency:deposit:${userId}:${idempotencyKey}`;
  const cached = await cache.get(cacheKey);

  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Record<string, unknown>;
      return { status: 200, body: parsed, replayed: true };
    } catch {
      // If parsing fails, fall through and re-issue
    }
  }

  const reference = `airflex-dep-${randomUUID()}`;
  const body = {
    success: true,
    reference,
    amount: request.amount,
    status: "pending",
    message: "Deposit initiated. Complete payment using the provided reference or dedicated virtual account.",
  };

  // 24-hour TTL
  await cache.set(cacheKey, JSON.stringify(body), 24 * 60 * 60);

  return { status: 200, body, replayed: false };
}

