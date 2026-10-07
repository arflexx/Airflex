import { pool } from "../db/pool";
import { maskAccountNumber } from "./virtualAccount";
import { WalletService } from "./wallet";

/** Paystack amounts are in the smallest currency unit (kobo for NGN). */
const KOBO_PER_NAIRA = 100;

export interface PaystackWebhookEvent {
  event: string;
  data: {
    reference: string;
    amount: number;
    currency?: string;
    status?: string;
    customer?: { phone?: string; email?: string };
    metadata?: { user_id?: string; phone?: string };
    account_number?: string;
    bank?: { name?: string; slug?: string; id?: number };
    dedicated_account?: {
      account_number?: string;
      account_name?: string;
      bank?: { name?: string; slug?: string; id?: number };
    };
  };
}

export async function applyChargeSuccess(
  event: PaystackWebhookEvent
): Promise<"credited" | "duplicate" | "unmatched"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_events (provider, event_type, reference, payload, status)
       VALUES ('paystack', $1, $2, $3, 'processing')
       ON CONFLICT (provider, reference) DO NOTHING
       RETURNING id`,
      [event.event, event.data.reference, JSON.stringify(event)]
    );

    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      return "duplicate";
    }

    const phone = event.data.metadata?.phone ?? event.data.customer?.phone ?? null;
    const userId = event.data.metadata?.user_id ?? null;

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM users
       WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
          OR ($2::text IS NOT NULL AND phone = $2::text)
       LIMIT 1`,
      [userId, phone]
    );

    if (rows.length === 0) {
      await client.query(
        `UPDATE payment_events
         SET status = 'unmatched', processed_at = NOW()
         WHERE provider = 'paystack' AND reference = $1`,
        [event.data.reference]
      );
      await client.query("COMMIT");
      return "unmatched";
    }

    const amountNaira = event.data.amount / KOBO_PER_NAIRA;

    await client.query(
      `INSERT INTO transactions (user_id, amount, direction, type, external_reference)
       VALUES ($1, $2, 'credit', 'deposit', $3)`,
      [rows[0]!.id, amountNaira, event.data.reference]
    );

    await client.query(
      `UPDATE wallets SET fiat_balance = fiat_balance + $1 WHERE user_id = $2`,
      [amountNaira, rows[0]!.id]
    );

    await client.query(
      `UPDATE payment_events
       SET status = 'processed', user_id = $2, processed_at = NOW()
       WHERE provider = 'paystack' AND reference = $1`,
      [event.data.reference, rows[0]!.id]
    );

    await client.query("COMMIT");
    return "credited";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function applyDVAAssigned(
  event: PaystackWebhookEvent
): Promise<"credited" | "duplicate" | "unmatched"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const reference = event.data.reference;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_events (provider, event_type, reference, payload, status)
       VALUES ('paystack', $1, $2, $3, 'processing')
       ON CONFLICT (provider, reference) DO NOTHING
       RETURNING id`,
      [event.event, reference, JSON.stringify(event)]
    );

    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      return "duplicate";
    }

    const accountNumber =
      event.data.dedicated_account?.account_number ??
      event.data.account_number ??
      null;

    if (!accountNumber) {
      await client.query(
        `UPDATE payment_events
         SET status = 'unmatched', processed_at = NOW()
         WHERE provider = 'paystack' AND reference = $1`,
        [reference]
      );
      await client.query("COMMIT");
      return "unmatched";
    }

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE virtual_account_number = $1 LIMIT 1`,
      [accountNumber]
    );

    if (rows.length === 0) {
      await client.query(
        `UPDATE payment_events
         SET status = 'unmatched', processed_at = NOW()
         WHERE provider = 'paystack' AND reference = $1`,
        [reference]
      );
      await client.query("COMMIT");
      console.warn(
        `[webhooks] DVA account ${maskAccountNumber(accountNumber)} matched no user`
      );
      return "unmatched";
    }

    const userId = rows[0]!.id;
    const amountNaira = event.data.amount / KOBO_PER_NAIRA;

    await new WalletService(client).credit({
      userId,
      amount: amountNaira,
      type: "deposit",
      externalReference: reference,
    });

    await client.query(
      `UPDATE payment_events
       SET status = 'processed', user_id = $2, processed_at = NOW()
       WHERE provider = 'paystack' AND reference = $1`,
      [reference, userId]
    );

    await client.query("COMMIT");
    return "credited";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
