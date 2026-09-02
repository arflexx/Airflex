import { Router, Request, Response } from "express";
import crypto from "crypto";

import { pool } from "../db/pool";
import { maskAccountNumber } from "../services/virtualAccount";
import { WalletService } from "../services/wallet";

/**
 * Webhook endpoints.
 *
 * Paystack deposit processing (Issue #9).
 *
 * A payment webhook is an endpoint that credits money on the strength of an
 * unauthenticated HTTP request. Three things therefore have to be true before
 * any balance moves, and each has its own failure mode:
 *
 *   1. **The request is really from Paystack.** Verified by HMAC-SHA512 over
 *      the *raw* body with the secret key. Without it the endpoint is a
 *      free-money API.
 *   2. **The event has not already been applied.** Paystack retries on any
 *      non-2xx, and will re-deliver events that did succeed. Without
 *      deduplication a network blip becomes a double credit.
 *   3. **The response is fast.** Paystack times out around 10 seconds and
 *      treats a slow response as a failure, which triggers a retry — so slow
 *      processing manufactures the duplicates point 2 has to absorb.
 */
const router = Router();

/** Paystack amounts are in the smallest currency unit (kobo for NGN). */
const KOBO_PER_NAIRA = 100;

interface PaystackEvent {
  event: string;
  data: {
    reference: string;
    amount: number;
    currency?: string;
    status?: string;
    customer?: { phone?: string; email?: string };
    metadata?: { user_id?: string; phone?: string };
    // dedicatedaccount.assign.success fields
    account_number?: string;
    bank?: { name?: string; slug?: string; id?: number };
    dedicated_account?: {
      account_number?: string;
      account_name?: string;
      bank?: { name?: string; slug?: string; id?: number };
    };
  };
}

/**
 * Constant-time comparison of the signature header.
 *
 * `===` on strings short-circuits at the first differing byte, which leaks
 * how much of a guess was correct and makes the signature forgeable given
 * enough attempts. `timingSafeEqual` requires equal lengths, so the length
 * check comes first and is itself not secret.
 */
function signatureMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Credit a verified deposit, exactly once.
 *
 * The whole operation runs in one transaction so the audit row, the dedupe
 * marker and the balance change commit together. A partial apply here is the
 * worst outcome available: a recorded event with no credit looks processed and
 * will never be retried.
 */
async function applyChargeSuccess(event: PaystackEvent): Promise<"credited" | "duplicate" | "unmatched"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // The unique index on reference is what actually enforces idempotency.
    // Checking first and inserting second would leave a race between two
    // concurrent deliveries of the same event; ON CONFLICT makes the database
    // arbitrate instead.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_events (provider, event_type, reference, payload, status)
       VALUES ('paystack', $1, $2, $3, 'processing')
       ON CONFLICT (provider, reference) DO NOTHING
       RETURNING id`,
      [event.event, event.data.reference, JSON.stringify(event)]
    );

    if (inserted.rowCount === 0) {
      // Already recorded, so this is a re-delivery. Committing rather than
      // rolling back keeps the (unchanged) row and returns 200, which stops
      // Paystack retrying something already handled.
      await client.query("COMMIT");
      return "duplicate";
    }

    // Resolve the user. Paystack carries our identifier in metadata when we
    // set it at charge time; phone is the fallback for charges initiated
    // outside our flow.
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
      // Do not fail: an unmatched payment is a real event that must stay in
      // the record for reconciliation. Failing would make Paystack retry
      // forever against a user who does not exist.
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
      [rows[0].id, amountNaira, event.data.reference]
    );

    await client.query(
      `UPDATE wallets SET fiat_balance = fiat_balance + $1 WHERE user_id = $2`,
      [amountNaira, rows[0].id]
    );

    await client.query(
      `UPDATE payment_events
       SET status = 'processed', user_id = $2, processed_at = NOW()
       WHERE provider = 'paystack' AND reference = $1`,
      [event.data.reference, rows[0].id]
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

/**
 * Handle dedicatedaccount.assign.success — Paystack fires this when a transfer
 * arrives on a user's dedicated virtual account. We credit the user's fiat
 * balance exactly as we do for charge.success, using the same idempotency guard.
 *
 * Paystack sends the amount in kobo (smallest NGN unit).
 */
async function applyDVAAssigned(
  event: PaystackEvent
): Promise<"credited" | "duplicate" | "unmatched"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Idempotency: use the event reference as a unique key
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

    // Resolve the account number from the event payload.
    // Paystack can nest it under data.dedicated_account or data directly.
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
      console.warn(
        `[webhooks] DVA event ${reference} has no account_number — held for reconciliation`
      );
      return "unmatched";
    }

    // Look up which user owns this virtual account number
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
        `[webhooks] DVA account ${maskAccountNumber(accountNumber)} matched no user — held for reconciliation`
      );
      return "unmatched";
    }

    const userId = rows[0]!.id;
    const amountNaira = event.data.amount / KOBO_PER_NAIRA;

    // Credit the transaction ledger and update fiat balance via WalletService
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

/**
 * `POST /api/v1/webhooks/paystack`
 *
 * Responds before doing the work. Paystack's contract is that a 200 means
 * "received", not "processed" — and holding the response open while crediting
 * risks a timeout, which Paystack reads as failure and retries. Acknowledging
 * first and processing after is what keeps a slow database from generating
 * duplicate deliveries.
 *
 * The signature check is the exception: it runs *before* the acknowledgement,
 * because an unverified request must never reach the processing path at all.
 */
router.post("/paystack", (req: Request, res: Response) => {
  const secret = process.env["PAYSTACK_SECRET_KEY"];
  if (!secret) {
    console.error("[webhooks] PAYSTACK_SECRET_KEY is not configured");
    res.status(500).json({ error: "Webhook not configured" });
    return;
  }

  const signature = req.header("x-paystack-signature");
  if (!signature) {
    res.status(400).json({ error: "Missing x-paystack-signature header" });
    return;
  }

  // Must be the exact bytes Paystack signed. `express.json()` re-serialisation
  // reorders keys and changes whitespace, which produces a different digest
  // for a genuine request — so the raw body is captured by the body parser's
  // verify hook and used here.
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw) {
    console.error("[webhooks] rawBody unavailable — check the express.json verify hook");
    res.status(500).json({ error: "Webhook not configured" });
    return;
  }

  const expected = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  if (!signatureMatches(expected, signature)) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const event = req.body as PaystackEvent;

  // Acknowledge now; process after. See the note on the handler.
  res.status(200).json({ received: true });

  if (event.event === "charge.success") {
    void applyChargeSuccess(event)
      .then((outcome) => {
        if (outcome === "unmatched") {
          console.warn(
            `[webhooks] Paystack charge ${event.data.reference} matched no user; held for reconciliation`
          );
        }
      })
      .catch((err: Error) => {
        console.error(
          `[webhooks] Failed to process Paystack charge ${event.data.reference}:`,
          err.message
        );
        void pool
          .query(
            `UPDATE payment_events
             SET status = 'failed', error = $2, processed_at = NOW()
             WHERE provider = 'paystack' AND reference = $1`,
            [event.data.reference, err.message]
          )
          .catch(() => undefined);
      });
    return;
  }

  if (event.event === "dedicatedaccount.assign.success") {
    void applyDVAAssigned(event)
      .then((outcome) => {
        if (outcome === "unmatched") {
          console.warn(
            `[webhooks] DVA transfer ${event.data.reference} matched no user; held for reconciliation`
          );
        }
      })
      .catch((err: Error) => {
        console.error(
          `[webhooks] Failed to process DVA transfer ${event.data.reference}:`,
          err.message
        );
        void pool
          .query(
            `UPDATE payment_events
             SET status = 'failed', error = $2, processed_at = NOW()
             WHERE provider = 'paystack' AND reference = $1`,
            [event.data.reference, err.message]
          )
          .catch(() => undefined);
      });
    return;
  }

  // All other events are logged and ignored
  void pool
    .query(
      `INSERT INTO payment_events (provider, event_type, reference, payload, status, processed_at)
       VALUES ('paystack', $1, $2, $3, 'ignored', NOW())
       ON CONFLICT (provider, reference) DO NOTHING`,
      [event.event, event.data?.reference ?? null, JSON.stringify(event)]
    )
    .catch((err: Error) =>
      console.error("[webhooks] Failed to log non-charge event:", err.message)
    );
});

/** Stellar webhook — still to be implemented. */
router.post("/stellar", (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

export { signatureMatches, applyChargeSuccess, applyDVAAssigned };
export default router;
