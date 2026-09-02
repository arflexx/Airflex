/**
 * services/virtualAccount.ts
 *
 * Paystack Dedicated Virtual Accounts (DVA) integration.
 *
 * This module is the single place that owns:
 *  - Creating a Paystack customer for a new user
 *  - Requesting a dedicated virtual account for that customer
 *  - Persisting the virtual account number and bank name to the users table
 *  - Enqueuing a background retry job when creation fails at registration time
 *
 * Security note: virtual account numbers are PII. Callers must use
 * `maskAccountNumber()` before writing account numbers to any log line.
 */

import pool from "../db";
import logger from "../utils/logger";
import { QueueService } from "../jobs";
import type { CreateVirtualAccountData } from "../jobs";

// ---------------------------------------------------------------------------
// Masking helper — log-safe representation (last 4 digits only)
// ---------------------------------------------------------------------------

/**
 * Returns a masked version of a virtual account number for safe logging.
 * "0123456789" → "******6789"
 */
export function maskAccountNumber(accountNumber: string): string {
  if (accountNumber.length <= 4) return "****";
  return "*".repeat(accountNumber.length - 4) + accountNumber.slice(-4);
}

// ---------------------------------------------------------------------------
// Paystack API types
// ---------------------------------------------------------------------------

interface PaystackCustomerResponse {
  status: boolean;
  data: {
    customer_code: string;
    email: string;
  };
}

interface PaystackDVAResponse {
  status: boolean;
  data: {
    account_number: string;
    account_name: string;
    bank: {
      name: string;
      id: number;
      slug: string;
    };
    customer: {
      customer_code: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Core service functions
// ---------------------------------------------------------------------------

/**
 * Creates a Paystack customer for the given user if one does not already exist.
 * Returns the customer_code.
 */
export async function ensurePaystackCustomer(
  userId: string,
  displayName: string
): Promise<string> {
  const paystackKey = process.env["PAYSTACK_SECRET_KEY"];
  if (!paystackKey) throw new Error("PAYSTACK_SECRET_KEY is not set");

  // Return existing code if already stored
  const { rows } = await pool.query<{ paystack_customer_code: string | null }>(
    `SELECT paystack_customer_code FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (rows[0]?.paystack_customer_code) {
    return rows[0].paystack_customer_code;
  }

  // Fetch phone for customer creation
  const { rows: userRows } = await pool.query<{ phone: string }>(
    `SELECT phone FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (!userRows.length) throw new Error(`User ${userId} not found`);

  const phone = userRows[0]!.phone;
  const nameParts = displayName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? displayName;
  const lastName = nameParts.slice(1).join(" ") || "User";

  const res = await fetch("https://api.paystack.co/customer", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paystackKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: `${userId}@airflex.local`,
      first_name: firstName,
      last_name: lastName,
      phone,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paystack create customer failed [${res.status}]: ${text}`);
  }

  const data = (await res.json()) as PaystackCustomerResponse;
  const customerCode = data.data.customer_code;

  // Persist customer code immediately so retries skip this step
  await pool.query(
    `UPDATE users SET paystack_customer_code = $1, updated_at = NOW() WHERE id = $2`,
    [customerCode, userId]
  );

  logger.info(
    { userId, customerCode },
    "[virtualAccount] Paystack customer created"
  );

  return customerCode;
}

/**
 * Calls Paystack's POST /dedicated_account and persists the result.
 * Throws on API or DB failure so the job queue can retry.
 */
export async function createDedicatedVirtualAccount(
  userId: string,
  customerCode: string
): Promise<{ accountNumber: string; bankName: string }> {
  const paystackKey = process.env["PAYSTACK_SECRET_KEY"];
  if (!paystackKey) throw new Error("PAYSTACK_SECRET_KEY is not set");

  const preferredBank =
    process.env["PAYSTACK_PREFERRED_BANK"] ?? "wema-bank";

  const res = await fetch("https://api.paystack.co/dedicated_account", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paystackKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer: customerCode,
      preferred_bank: preferredBank,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Paystack create dedicated account failed [${res.status}]: ${text}`
    );
  }

  const data = (await res.json()) as PaystackDVAResponse;
  const accountNumber = data.data.account_number;
  const bankName = data.data.bank.name;

  // Persist to users table
  await pool.query(
    `UPDATE users
     SET virtual_account_number = $1,
         virtual_bank_name      = $2,
         updated_at             = NOW()
     WHERE id = $3`,
    [accountNumber, bankName, userId]
  );

  logger.info(
    {
      userId,
      account_number: maskAccountNumber(accountNumber),
      bank: bankName,
    },
    "[virtualAccount] Dedicated virtual account created and persisted"
  );

  return { accountNumber, bankName };
}

// ---------------------------------------------------------------------------
// Registration helper — non-fatal with background retry
// ---------------------------------------------------------------------------

/**
 * Called immediately after a user is created / verified.
 *
 * Attempts to provision a virtual account inline. If it fails, the user is
 * still considered successfully registered and a background job is enqueued
 * to retry up to MAX_ATTEMPTS (3) times with exponential back-off.
 *
 * The `displayName` falls back to the user's phone number when no name is
 * available yet (KYC not complete).
 */
export async function provisionVirtualAccountForUser(
  userId: string,
  displayName: string
): Promise<void> {
  // Skip if the user already has a virtual account
  const { rows } = await pool.query<{ virtual_account_number: string | null }>(
    `SELECT virtual_account_number FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (rows[0]?.virtual_account_number) {
    logger.debug(
      { userId },
      "[virtualAccount] User already has a virtual account — skipping"
    );
    return;
  }

  try {
    const customerCode = await ensurePaystackCustomer(userId, displayName);
    await createDedicatedVirtualAccount(userId, customerCode);
  } catch (err) {
    // Non-fatal: log the error and enqueue a background retry
    logger.warn(
      {
        userId,
        err: (err as Error).message,
      },
      "[virtualAccount] Inline creation failed — enqueuing background retry job"
    );

    const jobData: CreateVirtualAccountData = {
      userId,
      displayName,
    };

    await QueueService.enqueue("create-virtual-account", jobData).catch(
      (queueErr: Error) => {
        // If even enqueuing fails, log it — we must not throw from here
        logger.error(
          { userId, err: queueErr.message },
          "[virtualAccount] Failed to enqueue retry job"
        );
      }
    );
  }
}
