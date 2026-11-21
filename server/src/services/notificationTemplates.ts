/**
 * notificationTemplates.ts — SMS/email message templates for the
 * NotificationService.
 *
 * Templates live here as plain string constants so route handlers and services
 * never inline message text. The NotificationService renders these constants
 * with the event payload via `renderTemplate` / `renderNotification`.
 *
 * Placeholders are expressed as `{name}` tokens and are substituted from the
 * payload passed to `NotificationService.send(...)`. Rendering is strict: a
 * placeholder without a matching payload value throws a
 * `MissingTemplateVariableError` instead of leaking a raw `{name}` token into
 * a message a user will read.
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

  /**
   * Sent to the user when a withdrawal request fails.
   */
  WITHDRAWAL_FAILED:
    "AirFlex: Your withdrawal of {amount} has failed. {reason}. " +
    "Your wallet balance has been restored.",

  /** Sent to admins when a Paystack webhook permanently fails processing (#118). */
  WEBHOOK_FAILED:
    "AirFlex admin: Paystack webhook {eventId} ({eventType}) failed after retries. " +
    "Inspect /api/admin/webhooks and replay if needed.",

  /**
   * Sent when a requested GDPR data export has been generated (issue #539).
   * Deliberately carries no download link: SMS is not a secure channel and
   * phone numbers get recycled, so the user downloads from inside the app.
   */
  DATA_EXPORT_READY:
    "AirFlex: Your personal data export is ready. Download it from your " +
    "profile in the app within {days} days.",

  KYC_DOCUMENT_EXPIRING:
    "AirFlex: Your KYC document expires on {expiryDate}. Please renew it in the app to keep your account active.",
  KYC_ADMIN_SUMMARY:
    "AirFlex admin: {count} KYC document(s) are expired or expiring soon. Review the affected accounts.",
} as const;

export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATES;

// ---------------------------------------------------------------------------
// Localized templates (issue #490)
// ---------------------------------------------------------------------------

/**
 * Locales with translated templates. Add a locale by extending this union and
 * filling in `messages` and `defaults` for every entry in
 * LOCALIZED_NOTIFICATION_TEMPLATES — the compiler flags any that are missing.
 */
export type NotificationLocale = "en";

export const DEFAULT_NOTIFICATION_LOCALE: NotificationLocale = "en";

/** Placeholder values for `trade_dispute_opened`. */
export interface TradeDisputeOpenedContext {
  tradeId: string;
  /** Display label of the *other* party, from the recipient's point of view. */
  counterparty: string;
  reason: string;
  disputeLink: string;
}

interface LocalizedTemplate<C> {
  /** Message text per locale, with `{name}` placeholders. */
  messages: Record<NotificationLocale, string>;
  /**
   * Per-locale fallback for every placeholder, used when a value is missing
   * or blank so a raw `{name}` token can never reach a user.
   */
  defaults: Record<NotificationLocale, { [K in keyof C]: string }>;
}

export const LOCALIZED_NOTIFICATION_TEMPLATES = {
  /** Sent to both participants when either one opens a dispute on a trade. */
  trade_dispute_opened: {
    messages: {
      en:
        "AirFlex: A dispute has been opened on trade {tradeId} with {counterparty}. " +
        "Reason: {reason}. Funds stay in escrow while our team reviews it within " +
        "24 hours. View the dispute: {disputeLink}",
    },
    defaults: {
      en: {
        tradeId: "your trade",
        counterparty: "your trading partner",
        reason: "not specified",
        disputeLink: "open the AirFlex app",
      },
    },
  } satisfies LocalizedTemplate<TradeDisputeOpenedContext>,
} as const;

export type LocalizedTemplateKey = keyof typeof LOCALIZED_NOTIFICATION_TEMPLATES;

/** Longest a single substituted value may be; keeps SMS within a few segments. */
const MAX_VALUE_LENGTH = 160;

/**
 * Makes a payload value safe to drop into a plain-text message: collapses
 * whitespace and control characters (no injected line breaks) and truncates
 * overly long values.
 */
function sanitizeValue(value: string): string {
  const collapsed = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return collapsed.length > MAX_VALUE_LENGTH
    ? `${collapsed.slice(0, MAX_VALUE_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

/**
 * Substitutes `{name}` placeholders in a single pass. Missing or blank values
 * use `defaults[name]`; a placeholder with neither renders as an empty string,
 * so the output never contains a raw token. Because substitution is one pass,
 * a value that itself contains `{...}` is inserted literally, not expanded.
 */
export function renderWithFallbacks(
  template: string,
  values: Partial<Record<string, string | number | null | undefined>>,
  defaults: Partial<Record<string, string>> = {}
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_token, name: string) => {
    const raw = values[name];
    const value = raw === undefined || raw === null ? "" : sanitizeValue(String(raw));
    return value !== "" ? value : (defaults[name] ?? "");
  });
}

/** Resolves a requested locale to one we have, falling back to the default. */
export function resolveNotificationLocale(locale?: string | null): NotificationLocale {
  const base = (locale ?? "").toLowerCase().split(/[-_]/)[0];
  const supported = Object.keys(
    LOCALIZED_NOTIFICATION_TEMPLATES.trade_dispute_opened.messages
  ) as NotificationLocale[];
  return supported.find((l) => l === base) ?? DEFAULT_NOTIFICATION_LOCALE;
}

/** Renders `trade_dispute_opened` for one recipient, with safe fallbacks. */
export function renderTradeDisputeOpened(
  context: Partial<TradeDisputeOpenedContext>,
  locale?: string | null
): string {
  const template = LOCALIZED_NOTIFICATION_TEMPLATES.trade_dispute_opened;
  const resolved = resolveNotificationLocale(locale);
  return renderWithFallbacks(template.messages[resolved], { ...context }, template.defaults[resolved]);
}

// ---------------------------------------------------------------------------
// Strict rendering (restored — NotificationService depends on renderTemplate)
// ---------------------------------------------------------------------------

export type TemplatePayload = Record<string, string | number>;

/** Thrown when a template references a placeholder the payload doesn't supply. */
export class MissingTemplateVariableError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing template variable(s): ${missing.join(", ")}`);
    this.name = "MissingTemplateVariableError";
  }
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes a value for safe interpolation into HTML text or attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** Returns the unique placeholder names referenced by a template, in order. */
export function extractPlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    names.add(match[1]!);
  }
  return [...names];
}

/** Names with no usable value: undefined, null, or an empty/whitespace-only string. */
function findMissing(names: string[], payload: TemplatePayload): string[] {
  return names.filter((name) => {
    const value = payload[name] as string | number | null | undefined;
    return value === undefined || value === null || String(value).trim() === "";
  });
}

/**
 * Substitutes `{name}` placeholders in a template with payload values.
 *
 * Throws `MissingTemplateVariableError` listing every placeholder that has no
 * value (undefined, null, or an empty/whitespace-only string). Extra payload
 * keys are ignored. Pass `escape` to transform each value before substitution
 * (e.g. `escapeHtml` for HTML bodies).
 */
export function renderTemplate(
  template: string,
  payload: TemplatePayload,
  escape: (value: string) => string = (value) => value
): string {
  const missing = findMissing(extractPlaceholders(template), payload);
  if (missing.length > 0) {
    throw new MissingTemplateVariableError(missing);
  }

  return template.replace(PLACEHOLDER, (_token, name: string) =>
    escape(String(payload[name]))
  );
}
