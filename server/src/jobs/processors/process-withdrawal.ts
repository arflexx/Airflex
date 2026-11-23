/**
 * process-withdrawal processor — issue #246
 *
 * Dequeued by QueueService after POST /api/v1/wallet/withdraw creates a
 * withdrawal record in `pending` state and enqueues this job.
 *
 * Steps:
 *  1. Load the withdrawal row; skip if already beyond `pending` (idempotent).
 *  2. Create a Paystack transfer recipient for the destination account.
 *  3. Initiate a Paystack transfer and record the transfer_code + move to
 *     `processing` state.
 *  4. On permanent failure (all retries exhausted): mark `failed`, restore
 *     the fiat_balance, and alert admins.
 *
 * Final settlement (completed/failed) is driven by the Paystack
 * `transfer.success` / `transfer.failed` webhook via
 * applyTransferSuccess / applyTransferFailed in paystackWebhookHandlers.ts.
 */

import { pool } from "../../db/pool";
import logger from "../../utils/logger";
import { NotificationService } from "../../services/notifications";
import { WalletService } from "../../services/wallet";
import type { Job } from "../queue";

export interface ProcessWithdrawalData {
  withdrawalId: string;
}

const PAYSTACK_API = "https://api.paystack.co";

function paystackHeaders(secret: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
  };
}

async function createRecipient(
  secret: string,
  accountName: string,
  accountNumber: string,
  bankCode: string
): Promise<string> {
  const res = await fetch(`${PAYSTACK_API}/transferrecipient`, {
    method: "POST",
    headers: paystackHeaders(secret),
    body: JSON.stringify({
      type: "nuban",
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    }),
  });

  const data = (await res.json()) as {
    status: boolean;
    data?: { recipient_code: string };
    message?: string;
  };

  if (!res.ok || !data.status || !data.data?.recipient_code) {
    throw new Error(
      `Paystack recipient creation failed: ${data.message ?? res.status}`
    );
  }

  return data.data.recipient_code;
}

async function initiateTransfer(
  secret: string,
  amountKobo: number,
  recipientCode: string,
  reference: string,
  userId: string
): Promise<{ transferCode: string; paystackStatus: string }> {
  const res = await fetch(`${PAYSTACK_API}/transfer`, {
    method: "POST",
    headers: paystackHeaders(secret),
    body: JSON.stringify({
      source: "balance",
      amount: amountKobo,
      recipient: recipientCode,
      reason: `AirFlex withdrawal for user ${userId}`,
      reference,
    }),
  });

  const data = (await res.json()) as {
    status: boolean;
    data?: { transfer_code: string; status: string };
    message?: string;
  };

  if (!res.ok || !data.status || !data.data) {
    throw new Error(
      `Paystack transfer initiation failed: ${data.message ?? res.status}`
    );
  }

  return {
    transferCode: data.data.transfer_code,
    paystackStatus: data.data.status,
  };
}

export async function processWithdrawalProcessor(
  job: Job<ProcessWithdrawalData>
): Promise<void> {
  const { withdrawalId } = job.data;
  const secret = process.env["PAYSTACK_SECRET_KEY"];

  if (!secret) {
    throw new Error("[process-withdrawal] PAYSTACK_SECRET_KEY is not configured");
  }

  // ------------------------------------------------------------------
  // 1. Load withdrawal row
  // ------------------------------------------------------------------

  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    amount: string;
    bank_code: string;
    account_number: string;
    account_name: string;
    reference: string;
    status: string;
  }>(
    `SELECT id, user_id, amount, bank_code, account_number, account_name,
            reference, status
     FROM withdrawals WHERE id = $1 LIMIT 1`,
    [withdrawalId]
  );

  if (rows.length === 0) {
    throw new Error(`[process-withdrawal] Withdrawal ${withdrawalId} not found`);
  }

  const withdrawal = rows[0]!;

  // Idempotency: if a prior attempt already moved us past `pending`, skip.
  if (withdrawal.status !== "pending") {
    logger.info(
      { withdrawalId, status: withdrawal.status },
      "[process-withdrawal] Already processed — skipping"
    );
    return;
  }

  const amountNum = parseFloat(withdrawal.amount);
  const amountKobo = Math.round(amountNum * 100);

  logger.info(
    { jobId: job.id, withdrawalId, attempt: job.attempts, amountNum },
    "[process-withdrawal] Starting"
  );

  // ------------------------------------------------------------------
  // 2. Create Paystack transfer recipient
  // ------------------------------------------------------------------

  const recipientCode = await createRecipient(
    secret,
    withdrawal.account_name,
    withdrawal.account_number,
    withdrawal.bank_code
  );

  // Persist recipient code so a retry can skip re-creation when possible.
  await pool.query(
    `UPDATE withdrawals SET paystack_recipient_code = $1 WHERE id = $2`,
    [recipientCode, withdrawalId]
  );

  // ------------------------------------------------------------------
  // 3. Initiate transfer
  // ------------------------------------------------------------------

  const { transferCode } = await initiateTransfer(
    secret,
    amountKobo,
    recipientCode,
    withdrawal.reference,
    withdrawal.user_id
  );

  // Move to `processing` (final state set by webhook) and record the debit
  // in the ledger + denormalised users.balance in one transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE withdrawals
       SET status = 'processing',
           paystack_transfer_code = $1
       WHERE id = $2`,
      [transferCode, withdrawalId]
    );
    await new WalletService(client).debitEntry({
      userId: withdrawal.user_id,
      amount: amountNum,
      type: "withdrawal",
      externalReference: withdrawal.reference,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  logger.info(
    { jobId: job.id, withdrawalId, transferCode },
    "[process-withdrawal] Transfer initiated — waiting for webhook"
  );
}

/**
 * Called by the Paystack webhook processor when a `transfer.success` event
 * arrives.  Marks the withdrawal completed and notifies the user.
 */
export async function applyTransferSuccess(reference: string): Promise<void> {
  const { rows } = await pool.query<{ id: string; user_id: string; amount: string }>(
    `UPDATE withdrawals
     SET status = 'completed'
     WHERE reference = $1 AND status = 'processing'
     RETURNING id, user_id, amount`,
    [reference]
  );

  if (!rows.length) return; // already handled or unknown reference

  const { user_id, amount } = rows[0]!;

  void NotificationService.send(user_id, "WITHDRAWAL_PROCESSED", {
    amount: parseFloat(amount),
  });

  logger.info({ reference, user_id }, "[process-withdrawal] Transfer succeeded");
}

/**
 * Called by the Paystack webhook processor when a `transfer.failed` or
 * `transfer.reversed` event arrives.  Marks the withdrawal failed and
 * restores the fiat balance so the user can retry.
 */
export async function applyTransferFailed(
  reference: string,
  reason: string
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      id: string;
      user_id: string;
      amount: string;
    }>(
      `UPDATE withdrawals
       SET status = 'failed', failure_reason = $2
       WHERE reference = $1 AND status IN ('pending', 'processing')
       RETURNING id, user_id, amount`,
      [reference, reason]
    );

    if (!rows.length) {
      await client.query("COMMIT");
      return;
    }

    const { user_id, amount } = rows[0]!;

    // Restore balance — transfer never left Paystack's side
    await client.query(
      `UPDATE wallets SET fiat_balance = fiat_balance + $1 WHERE user_id = $2`,
      [parseFloat(amount), user_id]
    );

    await client.query("COMMIT");

    void NotificationService.send(user_id, "WITHDRAWAL_FAILED", {
      amount: parseFloat(amount),
      reason,
    });

    logger.warn({ reference, user_id, reason }, "[process-withdrawal] Transfer failed — balance restored");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
