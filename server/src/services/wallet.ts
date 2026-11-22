import type { PoolClient } from "pg";

export type WalletTransactionType =
  | "trade_settlement"
  | "platform_fee"
  | "referral_reward"
  | "deposit"
  | "withdrawal";

export type WalletDirection = "credit" | "debit";

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
 * Database-backed wallet ledger operations. Callers own the transaction.
 *
 * Every ledger entry also moves the denormalised `users.balance` column
 * (migration 013) on the same client, so the ledger row and the running
 * balance commit or roll back together. The balance update is a relative
 * `balance = balance ± $1`, which takes a row lock on the user — concurrent
 * credits and debits for the same user serialise on that lock instead of
 * racing on a read-modify-write, so no update is ever lost.
 */
export class WalletService {
  constructor(private readonly client: PoolClient) {}

  async debit(userId: string, amount: number, tradeId: string): Promise<void> {
    await this.record("debit", {
      userId,
      amount,
      tradeId,
      type: "trade_settlement",
    });
  }

  /**
   * Record a debit of any type (e.g. a withdrawal). Returns false when the
   * ledger insert was skipped by a conflict, in which case the balance is
   * left untouched.
   */
  async debitEntry(input: WalletTransactionInput): Promise<boolean> {
    return this.record("debit", input);
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
    const applied = await this.record("credit", input);

    // Deposits must also update the wallet's running fiat balance — but not
    // for a duplicate whose ledger insert was skipped, or it double-credits.
    if (applied && input.type === "deposit") {
      await this.client.query(
        `UPDATE wallets SET fiat_balance = fiat_balance + $1 WHERE user_id = $2`,
        [input.amount, input.userId]
      );
    }
  }

  /**
   * Reads the denormalised ledger balance (credits minus debits) for a user.
   * O(1) — no aggregation over `transactions`.
   */
  async getBalance(userId: string): Promise<number> {
    const { rows } = await this.client.query<{ balance: string }>(
      `SELECT balance FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    return rows.length ? Number(rows[0]!.balance) : 0;
  }

  private async record(
    direction: WalletDirection,
    input: WalletTransactionInput
  ): Promise<boolean> {
    const inserted = await this.client.query(
      `INSERT INTO transactions (user_id, trade_id, amount, direction, type, external_reference)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        input.userId,
        input.tradeId ?? null,
        input.amount,
        direction,
        input.type,
        input.externalReference ?? null,
      ]
    );

    if (inserted.rowCount === 0) return false;

    const delta = direction === "credit" ? input.amount : -input.amount;
    await this.client.query(
      `UPDATE users SET balance = balance + $1 WHERE id = $2`,
      [delta, input.userId]
    );
    return true;
  }
}
