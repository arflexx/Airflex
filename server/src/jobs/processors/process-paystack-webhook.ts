import { pool } from "../../db/pool";
import logger from "../../utils/logger";
import { NotificationService } from "../../services/notifications";
import { SseEmitter } from "../../services/sseEmitter";
import type { Job } from "../queue";
import {
  applyChargeSuccess,
  applyDVAAssigned,
  type PaystackWebhookEvent,
} from "../../services/paystackWebhookHandlers";

export interface ProcessPaystackWebhookData {
  webhookEventId: string;
}

async function markWebhookStatus(
  id: string,
  status: "processed" | "failed"
): Promise<void> {
  await pool.query(
    `UPDATE webhook_events
     SET status = $2, processed_at = NOW()
     WHERE id = $1`,
    [id, status]
  );
}

export async function processPaystackWebhookProcessor(
  job: Job<ProcessPaystackWebhookData>
): Promise<void> {
  const { webhookEventId } = job.data;

  const { rows } = await pool.query<{
    id: string;
    status: string;
    payload: PaystackWebhookEvent;
  }>(
    `SELECT id, status, payload FROM webhook_events WHERE id = $1 LIMIT 1`,
    [webhookEventId]
  );

  if (rows.length === 0) {
    throw new Error(`Webhook event ${webhookEventId} not found`);
  }

  const row = rows[0]!;
  if (row.status === "processed") {
    return;
  }

  const event = row.payload;

  try {
    if (event.event === "charge.success") {
      await applyChargeSuccess(event);
    } else if (event.event === "dedicatedaccount.assign.success") {
      await applyDVAAssigned(event);
    }

    await markWebhookStatus(webhookEventId, "processed");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      { webhookEventId, attempt: job.attempts, reason },
      "[process-paystack-webhook] Processing failed"
    );

    if (job.attempts >= job.maxAttempts) {
      await markWebhookStatus(webhookEventId, "failed");
      void NotificationService.sendToAdmins("WEBHOOK_FAILED", {
        eventId: webhookEventId,
        eventType: event.event,
      });
      SseEmitter.emitAll({
        type: "admin_alert",
        message: `Paystack webhook ${webhookEventId} failed after ${job.maxAttempts} attempts`,
      });
    }

    throw err;
  }
}
