/**
 * send-notification processor
 *
 * Dispatches SMS notifications via the Termii API. Used for any asynchronous
 * notification that doesn't need to block the HTTP request — e.g. trade status
 * updates, escrow confirmations, admin alerts.
 *
 * Since issue #678 every NotificationService call enqueues a job here instead
 * of calling Termii inline, so trade state-change routes never wait on SMS
 * delivery.
 *
 * Retry semantics
 * ---------------
 * The QueueService retries a job (up to 3 attempts, exponential back-off)
 * whenever the processor throws. The processor therefore throws only for
 * *transient* failures — network errors, timeouts, HTTP 408/429 and 5xx — and
 * logs-and-drops *permanent* ones (invalid payload, other 4xx responses) so a
 * request Termii will never accept isn't retried pointlessly.
 *
 * Job data shape: SendNotificationData (validated by sendNotificationJobSchema)
 */

import { z } from "zod";
import type { Job } from "../queue";
import logger from "../../utils/logger";

export const TERMII_SMS_URL = "https://api.ng.termii.com/api/sms/send";

/** Per-attempt timeout for the Termii request (TERMII_TIMEOUT_MS, default 10s). */
const DEFAULT_TERMII_TIMEOUT_MS = 10_000;

export const NOTIFICATION_TYPES = [
  "trade_locked",
  "trade_completed",
  "trade_cancelled",
  "trade_disputed",
  "deletion_scheduled",
  "wallet_funded",
  "custom",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Zod schema for send-notification job payloads (issue #678). Applied before
 * a job is enqueued (NotificationService) and again when it is processed, so a
 * malformed job is rejected early and never reaches Termii.
 */
export const sendNotificationJobSchema = z
  .object({
    /** Destination phone number — E.164 (+234...) or local digits (080...). */
    phone: z
      .string()
      .trim()
      .regex(/^\+?\d{7,15}$/, "phone must be 7-15 digits, optionally prefixed with +"),
    /** Notification type — used to select the message template */
    type: z.enum(NOTIFICATION_TYPES),
    /** Template variables merged into the message text */
    vars: z.record(z.string()).optional(),
    /** Override: send this exact message instead of a template */
    message: z.string().trim().min(1).max(1600).optional(),
    /** Recipient user id — for logging/traceability only. */
    userId: z.string().min(1).optional(),
    /** Originating NotificationService event — for logging only. */
    event: z.string().min(1).optional(),
  })
  .refine((data) => data.type !== "custom" || data.message !== undefined || data.vars?.["message"], {
    message: "custom notifications require a message",
    path: ["message"],
  });

export type SendNotificationData = z.infer<typeof sendNotificationJobSchema>;

/** Error for a failure that retrying cannot fix. */
export class PermanentNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentNotificationError";
  }
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

const TEMPLATES: Record<NotificationType, (vars: Record<string, string>) => string> = {
  trade_locked: (v) =>
    `AirFlex: Your trade (${v["tradeId"] ?? "N/A"}) has been locked. ` +
    `The buyer's funds are secured in escrow. Deliver the airtime/data now.`,

  trade_completed: (v) =>
    `AirFlex: Payment released! Trade (${v["tradeId"] ?? "N/A"}) is now complete. ` +
    `Funds have been transferred to your wallet.`,

  trade_cancelled: (v) =>
    `AirFlex: Trade (${v["tradeId"] ?? "N/A"}) has been cancelled. ` +
    `Any locked funds will be refunded.`,

  trade_disputed: (v) =>
    `AirFlex: Trade (${v["tradeId"] ?? "N/A"}) has been escalated to a dispute. ` +
    `Our team will review and reach out within 24 hours.`,

  deletion_scheduled: (v) =>
    `AirFlex: Your account deletion has been scheduled for ${v["date"] ?? "30 days from now"}. ` +
    `To cancel, visit the app or contact support.`,

  wallet_funded: (_v) =>
    `AirFlex: Your Stellar wallet has been funded and is ready to use.`,

  custom: (v) => v["message"] ?? "AirFlex notification.",
};

// ---------------------------------------------------------------------------
// Termii client
// ---------------------------------------------------------------------------

/** HTTP statuses worth retrying: timeouts, rate limiting and server errors. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function termiiTimeoutMs(): number {
  const parsed = Number.parseInt(process.env["TERMII_TIMEOUT_MS"] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TERMII_TIMEOUT_MS;
}

/**
 * Sends one SMS via Termii. Throws a plain Error for transient failures and a
 * PermanentNotificationError for responses retrying cannot fix.
 */
export async function sendTermiiSms(phone: string, text: string): Promise<void> {
  const apiKey = process.env["TERMII_API_KEY"];
  if (!apiKey) {
    // Configuration error: retry so jobs survive until the key is deployed.
    throw new Error("TERMII_API_KEY is not set");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), termiiTimeoutMs());
  timer.unref?.();

  let res: Response;
  try {
    res = await fetch(TERMII_SMS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to: phone,
        from: "AirFlex",
        sms: text,
        type: "plain",
        channel: "generic",
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure / timeout — transient.
    throw new Error(`Termii request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const message = `Termii SMS API error ${res.status}: ${body}`;
    if (isTransientStatus(res.status)) throw new Error(message);
    throw new PermanentNotificationError(message);
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Processor — called by QueueService when a send-notification job is dequeued.
 *
 * Validates the payload, renders the message and sends it via Termii. Throws
 * on transient errors so the QueueService retry policy applies; permanent
 * errors are logged and the job completes without retrying.
 */
export async function sendNotificationProcessor(
  job: Job<SendNotificationData>
): Promise<void> {
  const parsed = sendNotificationJobSchema.safeParse(job.data);
  if (!parsed.success) {
    logger.error(
      { jobId: job.id, issues: parsed.error.issues },
      "[send-notification] Invalid job payload — dropping without retry"
    );
    return;
  }

  const { phone, type, vars = {}, message: override, userId, event } = parsed.data;
  const text = override ?? TEMPLATES[type](vars);

  logger.debug(
    { jobId: job.id, userId, event, type, attempt: job.attempts },
    "[send-notification] Dispatching SMS"
  );

  try {
    await sendTermiiSms(phone, text);
  } catch (err) {
    if (err instanceof PermanentNotificationError) {
      logger.error(
        { jobId: job.id, userId, event, type, err: err.message },
        "[send-notification] Permanent Termii failure — not retrying"
      );
      return;
    }
    logger.warn(
      { jobId: job.id, userId, event, type, attempt: job.attempts, err: (err as Error).message },
      "[send-notification] Transient Termii failure — job will be retried"
    );
    throw err;
  }

  logger.info({ jobId: job.id, userId, event, type }, "[send-notification] SMS dispatched");
}
