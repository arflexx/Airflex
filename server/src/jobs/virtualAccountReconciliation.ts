import pool from "../db";
import logger from "../utils/logger";
import {
  listDedicatedAccountTransactions,
  maskAccountNumber,
  type PaystackDvaTransaction,
} from "../services/virtualAccount";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;
const MIN_INTERVAL_MS = 60_000;
const KOBO_PER_NAIRA = 100n;

export interface VirtualAccountReconciliationResult {
  accountsScanned: number;
  accountsReconciled: number;
  mismatches: number;
  errors: number;
}

export interface LocalDepositReference {
  external_reference: string;
  amount_kobo: string;
}

export interface ReconciliationMismatch {
  reference: string;
  kind: "provider_only" | "local_only" | "amount_mismatch";
  providerAmountKobo?: string;
  localAmountKobo?: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getVirtualAccountReconciliationIntervalMs(): number {
  return Math.max(
    MIN_INTERVAL_MS,
    positiveInteger(process.env["VIRTUAL_ACCOUNT_RECONCILIATION_INTERVAL_MS"], DEFAULT_INTERVAL_MS)
  );
}

function getToleranceKobo(): bigint {
  const raw = process.env["VIRTUAL_ACCOUNT_RECONCILIATION_TOLERANCE_NAIRA"];
  if (!raw?.trim()) return 0n;
  const naira = Number(raw);
  const kobo = naira * Number(KOBO_PER_NAIRA);
  return Number.isFinite(kobo) && Number.isSafeInteger(kobo) && kobo >= 0
    ? BigInt(Math.round(kobo))
    : 0n;
}

/** Compare provider payments with local deposit references without mutating either ledger. */
export function compareDepositReferences(
  providerTransactions: PaystackDvaTransaction[],
  localDeposits: LocalDepositReference[],
  toleranceKobo: bigint
): ReconciliationMismatch[] {
  const providerByReference = new Map(
    providerTransactions.map((transaction) => [transaction.reference, BigInt(transaction.amount)])
  );
  const localByReference = new Map(
    localDeposits.map((deposit) => [deposit.external_reference, BigInt(deposit.amount_kobo)])
  );
  const mismatches: ReconciliationMismatch[] = [];

  for (const [reference, providerAmount] of providerByReference) {
    const localAmount = localByReference.get(reference);
    if (localAmount === undefined) {
      mismatches.push({ reference, kind: "provider_only", providerAmountKobo: String(providerAmount) });
    } else if (providerAmount - localAmount > toleranceKobo || localAmount - providerAmount > toleranceKobo) {
      mismatches.push({
        reference,
        kind: "amount_mismatch",
        providerAmountKobo: String(providerAmount),
        localAmountKobo: String(localAmount),
      });
    }
  }

  for (const [reference, localAmount] of localByReference) {
    if (!providerByReference.has(reference)) {
      mismatches.push({ reference, kind: "local_only", localAmountKobo: String(localAmount) });
    }
  }

  return mismatches;
}

/**
 * Reconciles successful Paystack DVA deposit references against local ledger
 * references. This is read-only: reruns can repeat alerts, but cannot duplicate
 * credits or otherwise change wallet balances.
 */
export async function reconcileVirtualAccountDeposits(): Promise<VirtualAccountReconciliationResult> {
  const startedAt = Date.now();
  const toleranceKobo = getToleranceKobo();
  const result: VirtualAccountReconciliationResult = {
    accountsScanned: 0,
    accountsReconciled: 0,
    mismatches: 0,
    errors: 0,
  };

  logger.info(
    { toleranceKobo: String(toleranceKobo), intervalMs: getVirtualAccountReconciliationIntervalMs() },
    "[virtual-account-reconciliation] Started"
  );

  const { rows: accounts } = await pool.query<{
    user_id: string;
    paystack_customer_code: string;
    virtual_account_number: string;
  }>(
    `SELECT id AS user_id, paystack_customer_code, virtual_account_number
       FROM users
      WHERE paystack_customer_code IS NOT NULL
        AND virtual_account_number IS NOT NULL
      ORDER BY id`
  );
  result.accountsScanned = accounts.length;

  for (const account of accounts) {
    try {
      const providerTransactions = await listDedicatedAccountTransactions(
        account.paystack_customer_code
      );
      if (providerTransactions === null) {
        result.mismatches += 1;
        logger.warn(
          {
            userId: account.user_id,
            accountNumber: maskAccountNumber(account.virtual_account_number),
            kind: "provider_account_inactive",
          },
          "[virtual-account-reconciliation] Provider account is inactive"
        );
        continue;
      }

      const { rows: localDeposits } = await pool.query<LocalDepositReference>(
        `SELECT t.external_reference,
                (t.amount * 100)::bigint::text AS amount_kobo
           FROM transactions t
           JOIN payment_events pe
             ON pe.provider = 'paystack'
            AND pe.reference = t.external_reference
          WHERE t.user_id = $1
            AND t.direction = 'credit'
            AND t.type = 'deposit'
            AND t.external_reference IS NOT NULL
            AND COALESCE(
                  pe.payload #>> '{data,authorization,channel}',
                  pe.payload #>> '{data,channel}'
                ) = 'dedicated_nuban'`,
        [account.user_id]
      );

      const mismatches = compareDepositReferences(
        providerTransactions,
        localDeposits,
        toleranceKobo
      );
      result.accountsReconciled += 1;
      result.mismatches += mismatches.length;

      for (const mismatch of mismatches) {
        logger.warn(
          {
            userId: account.user_id,
            accountNumber: maskAccountNumber(account.virtual_account_number),
            ...mismatch,
          },
          "[virtual-account-reconciliation] Deposit mismatch"
        );
      }
    } catch (err) {
      result.errors += 1;
      logger.error(
        { userId: account.user_id, err: (err as Error).message },
        "[virtual-account-reconciliation] Account check failed"
      );
    }
  }

  logger.info(
    { ...result, durationMs: Date.now() - startedAt },
    "[virtual-account-reconciliation] Finished"
  );
  return result;
}
