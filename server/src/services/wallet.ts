import type { PoolClient } from "pg";

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

/** Database-backed wallet ledger operations. Callers own the transaction. */
export class WalletService {
  constructor(private readonly client: PoolClient) {}

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
