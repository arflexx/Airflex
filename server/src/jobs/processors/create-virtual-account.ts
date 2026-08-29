/**
 * create-virtual-account processor
 *
 * Background job: creates a Paystack dedicated virtual account for a user.
 * Triggered when inline provisioning at registration fails.
 *
 * The QueueService retries this job up to 3 times with exponential back-off
 * before moving it to the dead-letter queue.
 *
 * Job data shape: CreateVirtualAccountData
 */

import type { Job } from "../queue";
import logger from "../../utils/logger";
import {
  ensurePaystackCustomer,
  createDedicatedVirtualAccount,
  maskAccountNumber,
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
 */
export async function createVirtualAccountProcessor(
  job: Job<CreateVirtualAccountData>
): Promise<void> {
  const { userId, displayName } = job.data;

  logger.info(
    { jobId: job.id, userId, attempt: job.attempts },
    "[create-virtual-account] Starting"
  );

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
}
