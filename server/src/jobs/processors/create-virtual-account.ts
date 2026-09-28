/**
 * create-virtual-account processor
 *
 * Background job: creates a Paystack dedicated virtual account for a user.
 * Triggered when inline provisioning at registration fails.
 *
 * The QueueService retries this job up to 3 times with exponential back-off
 * before moving it to the dead-letter queue. Paystack timeouts are detected
 * explicitly and re-thrown so the queue's back-off retry policy applies
 * instead of the job silently hanging.
 *
 * Job data shape: CreateVirtualAccountData
 */

import type { Job } from "../queue";
import logger from "../../utils/logger";
import {
  ensurePaystackCustomer,
  createDedicatedVirtualAccount,
  maskAccountNumber,
  PaystackTimeoutError,
} from "../../services/virtualAccount";

export interface CreateVirtualAccountData {
  /** AirFlex user UUID */
  userId: string;
  /** User's display name (phone fallback if KYC not complete) */
  displayName: string;
  /** Paystack customer code — re-used if already created in a prior attempt */
  paystackCustomerCode?: string;
}

/**
 * Processor — called by QueueService when a create-virtual-account job is dequeued.
 *
 * Steps:
 *  1. Ensure a Paystack customer exists (idempotent — skips if already stored).
 *  2. Create a dedicated virtual account for that customer.
 *  3. Persist the account number and bank name to the users table.
 *
 * If Paystack times out (PaystackTimeoutError) the error is logged with the
 * operation + timeout and re-thrown, which makes QueueService schedule the
 * next attempt with exponential back-off rather than blocking the worker.
 */
export async function createVirtualAccountProcessor(
  job: Job<CreateVirtualAccountData>
): Promise<void> {
  const { userId, displayName } = job.data;

  logger.info(
    { jobId: job.id, userId, attempt: job.attempts },
    "[create-virtual-account] Starting"
  );

  try {
    const customerCode = await ensurePaystackCustomer(userId, displayName);

    const { accountNumber, bankName } = await createDedicatedVirtualAccount(
      userId,
      customerCode
    );

    logger.info(
      {
        jobId: job.id,
        userId,
        account_number: maskAccountNumber(accountNumber),
        bank: bankName,
      },
      "[create-virtual-account] Completed"
    );
  } catch (err) {
    if (err instanceof PaystackTimeoutError) {
      // Re-throw so QueueService's retry policy schedules the next attempt
      // with exponential back-off — the worker is never hung by Paystack.
      logger.warn(
        {
          jobId: job.id,
          userId,
          attempt: job.attempts,
          operation: err.operation,
          timeoutMs: err.timeoutMs,
        },
        "[create-virtual-account] Paystack request timed out — scheduling retry with back-off"
      );
    }
    throw err;
  }
}
