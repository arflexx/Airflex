import { Router, Request, Response } from "express";
import crypto from "crypto";

import { pool } from "../db/pool";
import { QueueService } from "../jobs";
import type { PaystackWebhookEvent } from "../services/paystackWebhookHandlers";

/**
 * Webhook endpoints — Paystack deposit processing (issues #9, #118).
 */
const router = Router();

function signatureMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function persistAndEnqueue(event: PaystackWebhookEvent): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webhook_events (provider, event_type, payload, status)
     VALUES ('paystack', $1, $2, 'pending')
     RETURNING id`,
    [event.event, JSON.stringify(event)]
  );

  const webhookEventId = rows[0]?.id;
  if (!webhookEventId) {
    throw new Error("Failed to persist webhook event");
  }

  await QueueService.enqueue("process-paystack-webhook", { webhookEventId });
}

/**
 * `POST /api/v1/webhooks/paystack`
 *
 * Validates the signature, persists the raw payload, enqueues async processing,
 * and returns 200 immediately.
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

  const event = req.body as PaystackWebhookEvent;

  void persistAndEnqueue(event).catch((err: Error) => {
    console.error("[webhooks] Failed to persist/enqueue Paystack event:", err.message);
  });

  res.status(200).json({ received: true });
});

router.post("/stellar", (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

export { signatureMatches };
export default router;
