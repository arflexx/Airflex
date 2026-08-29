/**
 * notificationTemplates.ts — SMS/email message templates for the
 * NotificationService.
 *
 * Templates live here as plain string constants so route handlers and services
 * never inline message text. The NotificationService renders these constants
 * with the event payload (see `renderTemplate` in notifications.ts).
 *
 * Placeholders are expressed as `{name}` tokens and are substituted from the
 * payload passed to `NotificationService.send(...)`.
 */

export const NOTIFICATION_TEMPLATES = {
  /**
   * Sent to the seller when a buyer locks a trade (deposits funds into escrow).
   */
  TRADE_LOCKED:
    "AirFlex: Your trade {tradeId} has been locked. " +
    "The buyer's funds are secured in escrow. Deliver the airtime/data now.",

  /**
   * Sent to both parties when escrow is released after delivery confirmation.
   */
  TRADE_COMPLETED:
    "AirFlex: Payment released! Trade {tradeId} is now complete. " +
    "Funds have been transferred to the seller's wallet.",

  /**
   * Sent to both parties and all admins when a trade is escalated to a dispute.
   */
  DISPUTE_FILED:
    "AirFlex: Trade {tradeId} has been escalated to a dispute. " +
    "Our team will review it and reach out within 24 hours.",

  /**
   * Sent to the user when a withdrawal request is processed.
   */
  WITHDRAWAL_PROCESSED:
    "AirFlex: Your withdrawal of {amount} has been processed and will arrive " +
    "in your bank account shortly.",
} as const;

export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATES;
