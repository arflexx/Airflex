import type { PoolClient } from "pg";

export type WalletTransactionType = "trade_settlement" | "platform_fee" | "referral_reward";

export interface WalletTransactionInput {
  userId: string;
  amount: number;
  type: WalletTransactionType;
  tradeId: string;
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

  async credit(input: WalletTransactionInput): Promise<void> {
    await this.client.query(
      `INSERT INTO transactions (user_id, trade_id, amount, direction, type)
       VALUES ($1, $2, $3, 'credit', $4)`,
      [input.userId, input.tradeId, input.amount, input.type]
    );
  }
}
