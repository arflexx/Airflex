/**
 * create-virtual-account processor
 *
 * Creates a Paystack dedicated virtual account for a user so they can receive
 * NGN payments directly. Triggered after a successful OTP verify / onboarding.
 *
 * Job data shape: CreateVirtualAccountData
 *
 * Paystack API reference:
 *   POST https://api.paystack.co/dedicated_account
 *   https://paystack.com/docs/payments/dedicated-virtual-accounts/
 */

import type { Job } from "../queue";
import pool from "../../db";
import logger from "../../utils/logger";
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

export interface CreateVirtualAccountData {
  /** AirFlex user UUID */
  userId: string;
  /** User's full name for the virtual account label */
  displayName: string;
  /** Paystack customer code — created during onboarding or lazily here */
  paystackCustomerCode?: string;
}

/**
 * Processor — called by QueueService when a create-virtual-account job is dequeued.
 *
 * Steps:
 *  1. Create a Paystack customer if we don't already have a customer code.
 *  2. Request a dedicated virtual account for that customer.
 *  3. Persist the account number and bank name to the users / virtual_accounts table.
 */
export async function createVirtualAccountProcessor(
  job: Job<CreateVirtualAccountData>
): Promise<void> {
  const { userId, displayName, paystackCustomerCode } = job.data;

  const paystackKey = process.env["PAYSTACK_SECRET_KEY"];
  if (!paystackKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not set");
  }

  logger.info({ jobId: job.id, userId }, "[create-virtual-account] Starting");

  // -------------------------------------------------------------------
  // Step 1: Ensure a Paystack customer exists
  // -------------------------------------------------------------------

  let customerCode = paystackCustomerCode;

  if (!customerCode) {
    // Fetch the user's phone so we can create a Paystack customer
    const { rows: userRows } = await pool.query<{ phone: string }>(
      `SELECT phone FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );

    if (!userRows.length) {
      throw new Error(`User ${userId} not found`);
    }

    const phone = userRows[0]!.phone;

    const tracer = getTracer();
    customerCode = await tracer.startActiveSpan(
      "paystack.create_customer",
      async (span: Span) => {
        span.setAttribute("paystack.endpoint", "POST /customer");
        span.setAttribute("trade.user_id", userId);
        try {
          const customerRes = await fetch("https://api.paystack.co/customer", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${paystackKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email: `${userId}@airflex.local`,
              first_name: displayName.split(" ")[0] ?? displayName,
              last_name: displayName.split(" ").slice(1).join(" ") || "User",
              phone,
            }),
          });

          if (!customerRes.ok) {
            const txt = await customerRes.text();
            throw new Error(
              `Paystack create customer failed: ${customerRes.status} ${txt}`
            );
          }

          const customerData = (await customerRes.json()) as {
            data: { customer_code: string };
          };

          const code = customerData.data.customer_code;
          span.setAttribute("paystack.customer_code", code);
          return code;
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

    logger.info(
      { jobId: job.id, userId, customerCode },
      "[create-virtual-account] Customer created"
    );
  }

  // -------------------------------------------------------------------
  // Step 2: Create a dedicated virtual account
  // -------------------------------------------------------------------

  const tracer = getTracer();
  const dvaData = await tracer.startActiveSpan(
    "paystack.create_dedicated_account",
    async (span: Span) => {
      span.setAttribute("paystack.endpoint", "POST /dedicated_account");
      span.setAttribute("trade.user_id", userId);
      span.setAttribute("paystack.customer_code", customerCode ?? "");
      try {
        const dvaRes = await fetch("https://api.paystack.co/dedicated_account", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            customer: customerCode,
            preferred_bank: "wema-bank",
          }),
        });

        if (!dvaRes.ok) {
          const txt = await dvaRes.text();
          throw new Error(`Paystack create DVA failed: ${dvaRes.status} ${txt}`);
        }

        const data = (await dvaRes.json()) as {
          data: {
            account_number: string;
            account_name: string;
            bank: { name: string; id: number };
          };
        };

        span.setAttribute("paystack.bank_name", data.data.bank.name);
        return data;
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

  const { account_number, account_name, bank } = dvaData.data;

  // -------------------------------------------------------------------
  // Step 3: Persist virtual account details
  // -------------------------------------------------------------------

  // Store on the users row (add columns if not present) or a virtual_accounts table.
  // We use a try/catch so a missing column doesn't break the job — the data is
  // also logged at INFO level for ops to manually add if needed.
  try {
    await pool.query(
      `UPDATE users
       SET virtual_account_number = $1,
           virtual_account_bank   = $2,
           paystack_customer_code = $3,
           updated_at             = NOW()
       WHERE id = $4`,
      [account_number, bank.name, customerCode, userId]
    );
  } catch (dbErr) {
    logger.warn(
      {
        jobId:          job.id,
        userId,
        account_number,
        bank:           bank.name,
        err:            (dbErr as Error).message,
      },
      "[create-virtual-account] DB update failed — virtual account created but not persisted"
    );
    // Re-throw so the job retries and we don't silently lose the account
    throw dbErr;
  }

  logger.info(
    { jobId: job.id, userId, account_number, bank: bank.name },
    "[create-virtual-account] Virtual account created and persisted"
  );
}
