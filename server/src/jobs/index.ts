/**
 * jobs/index.ts — Registers all job processors with the QueueService singleton.
 *
 * Import this module once during server startup (in src/index.ts).
 * After this module is loaded the QueueService is ready to process jobs.
 */

import { QueueService } from "./queue";
import { fundStellarAccountProcessor }    from "./processors/fund-stellar-account";
import { createVirtualAccountProcessor }  from "./processors/create-virtual-account";
import { sendNotificationProcessor }      from "./processors/send-notification";
import { verifyTradeDeliveryProcessor }   from "./processors/verify-trade-delivery";
import { processPaystackWebhookProcessor } from "./processors/process-paystack-webhook";
import { refundCancelledTradeProcessor }  from "./processors/refund-cancelled-trade";

/** Initialise the queue service and register all processors. */
export function initJobQueue(): void {
  // Connect to Redis (falls back to in-process queue if REDIS_URL is absent)
  QueueService.init();

  // Register typed processors
  QueueService.register("fund-stellar-account",   fundStellarAccountProcessor);
  QueueService.register("create-virtual-account",  createVirtualAccountProcessor);
  QueueService.register("send-notification",       sendNotificationProcessor);
  QueueService.register("verify-trade-delivery",   verifyTradeDeliveryProcessor);
  QueueService.register("process-paystack-webhook", processPaystackWebhookProcessor);
  QueueService.register("refund-cancelled-trade",   refundCancelledTradeProcessor);
}

// Re-export queue primitives so route/service files only import from here
export { QueueService } from "./queue";
export type { QueueName, Job } from "./queue";
export type { FundStellarAccountData }   from "./processors/fund-stellar-account";
export type { CreateVirtualAccountData } from "./processors/create-virtual-account";
export type { SendNotificationData }     from "./processors/send-notification";
export type { VerifyTradeDeliveryData }  from "./processors/verify-trade-delivery";
export type { RefundCancelledTradeData } from "./processors/refund-cancelled-trade";
