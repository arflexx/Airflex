/**
 * notifications.ts — Out-of-band notification service.
 *
 * Sends best-effort SMS notifications for key trade lifecycle events (trade
 * locked, completed, disputed, and withdrawals).
 *
 * Design notes
 * ------------
 * - `send(userId, event, payload)` resolves the user's registered phone number
 *   from PostgreSQL, renders the template that matches the event type, and
 *   **enqueues** a `send-notification` job (issue #678). The Termii API is only
 *   ever called from the queue worker (jobs/processors/send-notification.ts),
 *   which retries transient failures — so no HTTP request waits on SMS
 *   delivery and a Termii outage never slows a trade route down.
 * - Every job payload is validated against `sendNotificationJobSchema` (Zod)
 *   before it is enqueued; an invalid payload is logged and dropped.
 * - Notifications are **best-effort**: any failure (DB lookup failure, missing
 *   template variable, invalid payload, enqueue failure) is logged with
 *   `logger.warn` and swallowed. A notification failure must never fail the
 *   parent operation.
 * - The `opt_out_notifications` flag on the user record is respected — opted-out
 *   users receive no SMS.
 * - Templates live in `notificationTemplates.ts` as string constants.
 */

import pool from "../db";
import logger from "../utils/logger";
import { QueueService } from "../jobs/queue";
import {
  sendNotificationJobSchema,
  type SendNotificationData,
} from "../jobs/processors/send-notification";
import {
  NOTIFICATION_TEMPLATES,
  renderTemplate,
  renderTradeDisputeOpened,
  type NotificationTemplateKey,
} from "./notificationTemplates";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationEvent = NotificationTemplateKey;

export interface NotificationPayload {
  [key: string]: string | number;
}

interface NotificationTarget {
  id: string;
  phone: string;
  opt_out_notifications: boolean;
}

/** Input for NotificationService.notifyTradeDisputeOpened (issue #490). */
export interface TradeDisputeOpenedInput {
  tradeId: string;
  /** User who opened the dispute. */
  initiatorId: string;
  /** The other party to the trade, if any. */
  counterpartyId: string | null;
  reason: string;
  /** Recipient locale (e.g. "en-NG"); unsupported locales fall back to English. */
  locale?: string | null;
}

interface DisputeParticipant extends NotificationTarget {
  display_handle: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Loads a single user's phone + opt-out flag, or null if not found. */
async function loadTarget(userId: string): Promise<NotificationTarget | null> {
  const { rows } = await pool.query<NotificationTarget>(
    `SELECT id, phone, COALESCE(opt_out_notifications, false) AS opt_out_notifications
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** Loads all admin users (used for dispute alerts). */
async function loadAdmins(): Promise<NotificationTarget[]> {
  const { rows } = await pool.query<NotificationTarget>(
    `SELECT id, phone, COALESCE(opt_out_notifications, false) AS opt_out_notifications
     FROM users
     WHERE role IN ('admin', 'super_admin')`
  );
  return rows;
}

/**
 * Validates and enqueues a `send-notification` job. Returns the job id, or
 * null when the payload failed validation. Throws if the enqueue itself fails
 * (the caller logs and swallows).
 */
export async function enqueueNotification(data: SendNotificationData): Promise<string | null> {
  const parsed = sendNotificationJobSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn(
      { userId: data.userId, event: data.event, issues: parsed.error.issues },
      "[notifications] Invalid notification payload — not enqueued"
    );
    return null;
  }
  return QueueService.enqueue("send-notification", parsed.data);
}

/** Renders a template and queues it for a single target (best-effort). */
async function sendToTarget(
  target: NotificationTarget,
  event: NotificationEvent,
  payload: NotificationPayload
): Promise<void> {
  let text: string;
  try {
    // Throws MissingTemplateVariableError on an incomplete payload — better
    // no SMS than a malformed one.
    text = renderTemplate(NOTIFICATION_TEMPLATES[event], payload);
  } catch (err) {
    logger.warn(
      { userId: target.id, event, err: (err as Error).message },
      "[notifications] Failed to render notification template"
    );
    return;
  }
  await deliverText(target, event, text);
}

/**
 * Queues already-rendered text for a single target, honouring opt-out and
 * swallowing (and logging) any failure. `event` is only used for logging.
 */
async function deliverText(
  target: NotificationTarget,
  event: string,
  text: string
): Promise<void> {
  if (target.opt_out_notifications) {
    logger.info(
      { userId: target.id, event },
      "[notifications] User opted out of notifications — skipping SMS"
    );
    return;
  }

  try {
    const jobId = await enqueueNotification({
      phone: target.phone,
      type: "custom",
      message: text,
      userId: target.id,
      event,
    });
    if (jobId) {
      logger.info(
        { userId: target.id, event, jobId },
        "[notifications] SMS queued"
      );
    }
  } catch (err) {
    logger.warn(
      { userId: target.id, event, err: (err as Error).message },
      "[notifications] Failed to enqueue SMS"
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const NotificationService = {
  /**
   * Queues a notification for a single user. Best-effort: never throws.
   */
  async send(
    userId: string,
    event: NotificationEvent,
    payload: NotificationPayload
  ): Promise<void> {
    let target: NotificationTarget | null;
    try {
      target = await loadTarget(userId);
    } catch (err) {
      logger.warn(
        { userId, event, err: (err as Error).message },
        "[notifications] Failed to load notification target"
      );
      return;
    }

    if (!target) {
      logger.warn(
        { userId, event },
        "[notifications] Notification target not found — skipping"
      );
      return;
    }

    await sendToTarget(target, event, payload);
  },

  /**
   * Queues a notification for multiple users (e.g. both trade parties).
   * Best-effort: never throws.
   */
  async sendToMany(
    userIds: string[],
    event: NotificationEvent,
    payload: NotificationPayload
  ): Promise<void> {
    const deduped = [...new Set(userIds.filter(Boolean))];
    await Promise.all(
      deduped.map((userId) => NotificationService.send(userId, event, payload))
    );
  },

  /**
   * Queues a notification for every admin user. Best-effort: never throws.
   */
  async sendToAdmins(
    event: NotificationEvent,
    payload: NotificationPayload
  ): Promise<void> {
    let admins: NotificationTarget[];
    try {
      admins = await loadAdmins();
    } catch (err) {
      logger.warn(
        { event, err: (err as Error).message },
        "[notifications] Failed to load admin targets"
      );
      return;
    }

    await Promise.all(
      admins.map((admin) => sendToTarget(admin, event, payload))
    );
  },

  /**
   * Queues the `trade_dispute_opened` notification for both participants of
   * a trade (issue #490). Each recipient's message names the *other* party as
   * the counterparty. Best-effort: never throws.
   */
  async notifyTradeDisputeOpened(input: TradeDisputeOpenedInput): Promise<void> {
    const ids = [...new Set([input.initiatorId, input.counterpartyId].filter(Boolean))] as string[];

    let participants: DisputeParticipant[];
    try {
      participants = await loadDisputeParticipants(ids);
    } catch (err) {
      logger.warn(
        { tradeId: input.tradeId, err: (err as Error).message },
        "[notifications] Failed to load dispute participants"
      );
      return;
    }

    const disputeLink = buildDisputeLink(input.tradeId);

    await Promise.all(
      participants.map((recipient) => {
        const other = participants.find((p) => p.id !== recipient.id);
        const text = renderTradeDisputeOpened(
          {
            tradeId: input.tradeId,
            counterparty: other?.display_handle ?? undefined,
            reason: input.reason,
            disputeLink,
          },
          input.locale
        );
        return deliverText(recipient, "trade_dispute_opened", text);
      })
    );
  },
} as const;

/** Loads phone, opt-out flag and display handle for the given users. */
async function loadDisputeParticipants(userIds: string[]): Promise<DisputeParticipant[]> {
  if (userIds.length === 0) return [];
  const { rows } = await pool.query<DisputeParticipant>(
    `SELECT id, phone, COALESCE(opt_out_notifications, false) AS opt_out_notifications,
            display_handle
     FROM users
     WHERE id = ANY($1::uuid[])`,
    [userIds]
  );
  return rows;
}

/**
 * Deep link to the trade page, built from APP_BASE_URL. Returns undefined when
 * it isn't configured so the template's fallback text is used instead.
 */
function buildDisputeLink(tradeId: string): string | undefined {
  const base = process.env["APP_BASE_URL"]?.trim().replace(/\/+$/, "");
  return base ? `${base}/trades/${encodeURIComponent(tradeId)}` : undefined;
}
