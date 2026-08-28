import { Router } from "express";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { getWalletBalance } from "../services/stellar";
import { NotificationService } from "../services/notifications";

// ---------------------------------------------------------------------------
// OpenTelemetry tracer (no-op fallback when packages not installed)
// ---------------------------------------------------------------------------

import type { Tracer, Span } from "@opentelemetry/api";

function getTracer(): Tracer {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trace } = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    return trace.getTracer("airflex-paystack", "1.0.0");
  } catch {
    return {
      startActiveSpan: <F extends (span: Span) => unknown>(_n: string, fn: F) =>
        fn({
          setAttribute: () => {},
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        } as unknown as Span) as ReturnType<F>,
    } as unknown as Tracer;
  }
}

const router = Router();

// ---------------------------------------------------------------------------
// Paystack helper functions
// ---------------------------------------------------------------------------

interface Bank {
  code: string;
  name: string;
}

async function fetchPaystackBanks(): Promise<Bank[]> {
  const paystackSecretKey = process.env["PAYSTACK_SECRET_KEY"];
  if (!paystackSecretKey) {
    throw new Error("PAYSTACK_SECRET_KEY not configured");
  }

  const tracer = getTracer();
  return tracer.startActiveSpan("paystack.list_banks", async (span: Span) => {
    span.setAttribute("paystack.endpoint", "GET /bank");
    span.setAttribute("paystack.country", "nigeria");
    try {
      const response = await fetch(
        "https://api.paystack.co/bank?country=nigeria&currency=NGN",
        {
          headers: { Authorization: `Bearer ${paystackSecretKey}` },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch banks from Paystack");
      }

      const data = (await response.json()) as { data: Bank[] };
      span.setAttribute("paystack.bank_count", data.data.length);
      return data.data;
    } catch (err) {
      span.recordException(err as Error);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SpanStatusCode } = require("@opentelemetry/api");
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

async function resolvePaystackAccount(
  accountNumber: string,
  bankCode: string
): Promise<string> {
  const paystackSecretKey = process.env["PAYSTACK_SECRET_KEY"];
  if (!paystackSecretKey) {
    throw new Error("PAYSTACK_SECRET_KEY not configured");
  }

  const tracer = getTracer();
  return tracer.startActiveSpan(
    "paystack.resolve_account",
    async (span: Span) => {
      span.setAttribute("paystack.endpoint", "GET /bank/resolve");
      span.setAttribute("paystack.bank_code", bankCode);
      // Do NOT record the account_number — it is PII
      try {
        const response = await fetch(
          `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
          {
            headers: { Authorization: `Bearer ${paystackSecretKey}` },
          }
        );

        if (!response.ok) {
          throw new Error("Failed to resolve account from Paystack");
        }

        const data = (await response.json()) as {
          data: { account_name: string } | null;
        };
        if (!data.data || !data.data.account_name) {
          throw new Error("Unable to resolve account name");
        }

        return data.data.account_name;
      } catch (err) {
        span.recordException(err as Error);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SpanStatusCode } = require("@opentelemetry/api");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/wallet  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns the authenticated user's Stellar public key and current XLM balance.
 * The secret key is never included in the response.
 */
router.get(
  "/",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const { rows } = await pool.query<{ stellar_public_key: string }>(
      `SELECT stellar_public_key FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (!rows.length || !rows[0]?.stellar_public_key) {
      res.status(404).json({
        error: "Wallet not found. It may still be provisioning — try again shortly.",
      });
      return;
    }

    const publicKey = rows[0].stellar_public_key;

    let balance: string;
    try {
      balance = await getWalletBalance(publicKey);
    } catch (err) {
      console.error("[wallet] Failed to fetch balance for", publicKey, "–", (err as Error).message);
      res.status(502).json({ error: "Unable to fetch balance from Horizon. Try again." });
      return;
    }

    res.status(200).json({
      publicKey,
      balance,          // XLM balance as a decimal string, e.g. "10000.0000000"
      asset: "XLM",
      network: process.env["STELLAR_NETWORK"] ?? "testnet",
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/wallet/banks  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns a list of Nigerian banks from Paystack for the bank selection dropdown.
 */
router.get(
  "/banks",
  authenticate,
  async (req, res) => {
    try {
      const banks = await fetchPaystackBanks();
      res.status(200).json({ banks });
    } catch (err) {
      console.error("[wallet] Failed to fetch banks:", (err as Error).message);
      res.status(502).json({ error: "Unable to fetch bank list. Try again." });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/wallet/resolve-account  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Resolves a Nigerian bank account number to the account name using Paystack.
 * Query params: account_number, bank_code
 */
router.get(
  "/resolve-account",
  authenticate,
  async (req, res) => {
    const { account_number, bank_code } = req.query;

    if (!account_number || !bank_code) {
      res.status(400).json({ error: "account_number and bank_code are required" });
      return;
    }

    if (typeof account_number !== "string" || typeof bank_code !== "string") {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }

    try {
      const accountName = await resolvePaystackAccount(account_number, bank_code);
      res.status(200).json({ account_name: accountName });
    } catch (err) {
      console.error("[wallet] Failed to resolve account:", (err as Error).message);
      res.status(502).json({ error: "Unable to resolve account. Check the account number and bank." });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/wallet/withdraw  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Submits a withdrawal request to a Nigerian bank account.
 * Body: { amount, bank_code, account_number, account_name }
 */
router.post(
  "/withdraw",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;
    const { amount, bank_code, account_number, account_name } = req.body;

    // Validate input
    if (!amount || !bank_code || !account_number || !account_name) {
      res.status(400).json({ error: "All fields are required: amount, bank_code, account_number, account_name" });
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      res.status(400).json({ error: "Invalid amount" });
      return;
    }

    // Get user's wallet and current balance
    const { rows } = await pool.query<{ stellar_public_key: string }>(
      `SELECT stellar_public_key FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (!rows.length || !rows[0]?.stellar_public_key) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    const publicKey = rows[0].stellar_public_key;

    let currentBalance: string;
    try {
      currentBalance = await getWalletBalance(publicKey);
    } catch (err) {
      console.error("[wallet] Failed to fetch balance for withdrawal:", (err as Error).message);
      res.status(502).json({ error: "Unable to fetch current balance. Try again." });
      return;
    }

    const currentBalanceNum = parseFloat(currentBalance);
    if (amountNum > currentBalanceNum) {
      res.status(400).json({ error: "Insufficient balance" });
      return;
    }

    // TODO: Implement actual withdrawal logic via Paystack transfer
    // For now, we'll just log the request and return success
    console.log("[wallet] Withdrawal request:", {
      userId,
      amount: amountNum,
      bank_code,
      account_number,
      account_name,
    });

    // In production, you would:
    // 1. Create a withdrawal record in the database
    // 2. Initiate a Paystack transfer
    // 3. Update the wallet balance after successful transfer
    // 4. Handle transfer failures and retries

    // Notify the user that their withdrawal was processed (best-effort)
    void NotificationService.send(userId, "WITHDRAWAL_PROCESSED", {
      amount: amountNum,
    });

    res.status(200).json({ success: true });
  }
);

export default router;
