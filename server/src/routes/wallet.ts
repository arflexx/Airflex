import { Router } from "express";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { decryptSecret, getWalletBalance } from "../services/stellar";
import {
  executeIdempotentWithdrawal,
  executeIdempotentDeposit,
  parseIdempotencyKey,
  type WithdrawalOutcome,
} from "../services/wallet";
import { QueueService } from "../jobs";
import { NotificationService } from "../services/notifications";
import logger from "../utils/logger";

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
        const params = new URLSearchParams({
          account_number: accountNumber,
          bank_code: bankCode,
        });
        const response = await fetch(
          `https://api.paystack.co/bank/resolve?${params.toString()}`,
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

    const { rows } = await pool.query<{
      stellar_public_key: string;
      virtual_account_number: string | null;
      virtual_bank_name: string | null;
    }>(
      `SELECT w.stellar_public_key,
              u.virtual_account_number,
              u.virtual_bank_name
       FROM wallets w
       JOIN users u ON u.id = w.user_id
       WHERE w.user_id = $1
       LIMIT 1`,
      [userId]
    );

    if (!rows.length || !rows[0]?.stellar_public_key) {
      res.status(404).json({
        error: "Wallet not found. It may still be provisioning — try again shortly.",
      });
      return;
    }

    const { stellar_public_key: publicKey, virtual_account_number, virtual_bank_name } = rows[0];

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
      // Virtual bank account for NGN deposits — null while still provisioning
      virtualAccount: virtual_account_number
        ? {
            accountNumber: virtual_account_number,
            bankName: virtual_bank_name,
          }
        : null,
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
// POST /api/v1/wallet/withdraw  (authenticated) — issue #246
// ---------------------------------------------------------------------------

/**
 * Accepts a withdrawal request, validates the fiat balance, persists the
 * record, deducts the balance atomically, and enqueues a background job that
 * calls the Paystack Transfer API.
 *
 * Returns 202 Accepted immediately — the Paystack API call and final status
 * transitions happen asynchronously via the `process-withdrawal` processor
 * and the `transfer.success` / `transfer.failed` webhook events.
 *
 * Body: { amount: number, bank_code: string, account_number: string, account_name: string }
 *
 * Headers: `Idempotency-Key` (required, issue #479). The first request with a
 * key performs the withdrawal; a retry with the same key and body gets the
 * same response back (with `Idempotent-Replayed: true`) and debits nothing.
 * Reusing a key with a different body is rejected with 422.
 *
 * Response 202:
 *   { withdrawalId: string, reference: string, status: "pending" }
 */
router.post(
  "/withdraw",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const keyCheck = parseIdempotencyKey(req.header("idempotency-key"));
    if (!keyCheck.ok) {
      res.status(400).json({ error: keyCheck.error });
      return;
    }

    const { amount, bank_code, account_number, account_name } = req.body as {
      amount: unknown;
      bank_code: unknown;
      account_number: unknown;
      account_name: unknown;
    };

    // ---- input validation ------------------------------------------------
    if (!amount || !bank_code || !account_number || !account_name) {
      res.status(400).json({
        error: "All fields are required: amount, bank_code, account_number, account_name",
      });
      return;
    }

    const amountNum = parseFloat(String(amount));
    if (isNaN(amountNum) || amountNum <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }

    if (typeof bank_code !== "string" || bank_code.trim() === "") {
      res.status(400).json({ error: "Invalid bank_code" });
      return;
    }

    if (
      typeof account_number !== "string" ||
      !/^\d{10}$/.test(account_number.trim())
    ) {
      res.status(400).json({ error: "account_number must be a 10-digit string" });
      return;
    }

    if (typeof account_name !== "string" || account_name.trim() === "") {
      res.status(400).json({ error: "Invalid account_name" });
      return;
    }

    let outcome: WithdrawalOutcome;
    try {
      outcome = await executeIdempotentWithdrawal(userId, keyCheck.key, {
        amount: amountNum,
        bankCode: bank_code.trim(),
        accountNumber: account_number.trim(),
        accountName: account_name.trim(),
      });
    } catch (err) {
      logger.error({ err, userId }, "[wallet] Withdraw error");
      res.status(500).json({ error: "Withdrawal request failed. Please try again." });
      return;
    }

    if (outcome.replayed) {
      logger.info({ userId }, "[wallet] Replayed withdrawal response for a retried Idempotency-Key");
      res.setHeader("Idempotent-Replayed", "true");
    }

    // ---- enqueue background job (only for a withdrawal created just now) --
    if (outcome.withdrawalId) {
      try {
        await QueueService.enqueue("process-withdrawal", {
          withdrawalId: outcome.withdrawalId,
        });
      } catch (err) {
        logger.error(
          { err, userId, withdrawalId: outcome.withdrawalId },
          "[wallet] Failed to queue withdrawal"
        );
        res.status(500).json({ error: "Withdrawal request failed. Please try again." });
        return;
      }

      logger.info(
        {
          withdrawalId: outcome.withdrawalId,
          userId,
          amount: amountNum,
          reference: outcome.body["reference"],
        },
        "[wallet] Withdrawal queued"
      );
    }

    res.status(outcome.status).json(outcome.body);
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/wallet/deposit  (authenticated) — issue #621
// ---------------------------------------------------------------------------

/**
 * Initiates a fiat deposit idempotently.
 *
 * Headers: `X-Idempotency-Key` (required). Missing header returns HTTP 400.
 * A repeat request within the 24-hour TTL returns the original cached response (HTTP 200).
 */
router.post(
  "/deposit",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const rawKey = req.header("x-idempotency-key");
    if (!rawKey || !rawKey.trim()) {
      res.status(400).json({ error: "X-Idempotency-Key header is required" });
      return;
    }

    const { amount } = req.body as { amount?: unknown };
    const amountNum = parseFloat(String(amount));
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }

    try {
      const outcome = await executeIdempotentDeposit(userId, rawKey.trim(), {
        amount: amountNum,
      });

      if (outcome.replayed) {
        res.setHeader("Idempotent-Replayed", "true");
      }

      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      logger.error({ err, userId }, "[wallet] Deposit error");
      res.status(500).json({ error: "Deposit request failed. Please try again." });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/wallet/unlock  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Per-user throttle for key release.
 *
 * Deliberately in-memory, unlike `rateLimitOtp`'s database-backed counter.
 * There is no cost or victim-harassment angle here — the caller can only ever
 * unlock their own key, which they are already entitled to — so the limit
 * exists to blunt a scripted loop, not to be an authorization boundary. A
 * counter that resets on deploy is adequate for that and does not need a
 * migration. Authorization is `authenticate`, and that is not per-process.
 */
const UNLOCK_MAX_PER_WINDOW = 10;
const UNLOCK_WINDOW_MS = 60_000;
const unlockAttempts = new Map<string, number[]>();

function unlockAllowed(userId: string): boolean {
  const now = Date.now();
  const recent = (unlockAttempts.get(userId) ?? []).filter(
    (at) => now - at < UNLOCK_WINDOW_MS
  );
  recent.push(now);
  unlockAttempts.set(userId, recent);
  return recent.length <= UNLOCK_MAX_PER_WINDOW;
}

/**
 * Releases the caller's own Stellar secret key so their browser can sign
 * transactions locally (Issue #342).
 *
 * # Why this endpoint exists
 *
 * The buy flow used to collect the buyer's secret key in a plaintext input and
 * POST it with the trade request, putting it in the DOM, in form autocomplete,
 * and in server request logs. Signing in the browser removes all of that — but
 * the wallet is custodial today (`generateAndFundWallet` encrypts the secret
 * into the `wallets` table), so the browser has no key to sign with unless the
 * server hands the owner theirs.
 *
 * # The trade-off, stated plainly
 *
 * This moves a custodial key into client memory. That is a real change in
 * exposure and it is not free. It is still the better side of the trade: the
 * key stops travelling inside trade requests, stops being typed into a form,
 * and stops being logged — and it is the step the code's own TODOs call for
 * on the way to non-custodial wallets, where this endpoint disappears entirely
 * because the server never had the key.
 *
 * The response is never cached, and the client holds the key in memory only
 * (see `frontend/app/lib/stellarSession.ts`) — never localStorage, never a
 * form field, never a URL.
 */
router.post(
  "/unlock",
  authenticate,
  async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    if (!unlockAllowed(userId)) {
      res.setHeader("Retry-After", String(Math.ceil(UNLOCK_WINDOW_MS / 1000)));
      res.status(429).json({ error: "Too many unlock requests. Try again shortly." });
      return;
    }

    const { rows } = await pool.query<{
      stellar_public_key: string;
      stellar_secret_key: string;
    }>(
      `SELECT stellar_public_key, stellar_secret_key FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    const wallet = rows[0];
    if (!wallet?.stellar_secret_key) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    let secretKey: string;
    try {
      secretKey = decryptSecret(wallet.stellar_secret_key);
    } catch (err) {
      console.error("[wallet] Failed to decrypt secret key:", (err as Error).message);
      res.status(500).json({ error: "Unable to unlock wallet" });
      return;
    }

    // Leave a trail: key release is worth being able to reconstruct later.
    console.info(`[wallet] Released signing key to owner user_id=${userId}`);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      data: {
        publicKey: wallet.stellar_public_key,
        secretKey,
      },
    });
  }
);

export default router;
