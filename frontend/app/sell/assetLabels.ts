/**
 * Display helpers for the sell flow, shared by the sell form and the offline
 * queue list. Labels come from the `Sell` message namespace (issue #453), so
 * they follow the active language.
 */

/** Asset types a seller can list, in the order the form offers them. */
export const ASSET_TYPES = [
  "MTN_AIRTIME",
  "MTN_DATA",
  "GLO_AIRTIME",
  "GLO_DATA",
  "AIRTEL_AIRTIME",
  "AIRTEL_DATA",
  "9MOBILE_AIRTIME",
  "9MOBILE_DATA",
] as const;

/** Network brand names — the same in every language. */
const NETWORK_NAMES: Record<string, string> = {
  MTN: "MTN",
  GLO: "Glo",
  AIRTEL: "Airtel",
  "9MOBILE": "9mobile",
};

/** A translator for the `Sell` namespace, as returned by `useTranslations("Sell")`. */
export type SellTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Localised label for an asset type, e.g. `MTN_AIRTIME` → "MTN — Airtime".
 * Unknown asset types are shown as-is.
 */
export function assetLabel(t: SellTranslator, assetType: string): string {
  const match = /^(.+)_(AIRTIME|DATA)$/.exec(assetType);
  const network = match ? NETWORK_NAMES[match[1]!] : undefined;
  if (!match || !network) return assetType;
  return t(match[2] === "AIRTIME" ? "assets.airtime" : "assets.data", { network });
}

/** Localised listing duration, e.g. 6 → "6 hours", 48 → "2 days". */
export function durationLabel(t: SellTranslator, hours: number): string {
  return hours > 24 && hours % 24 === 0
    ? t("durationDays", { count: hours / 24 })
    : t("durationHours", { count: hours });
}

/** Number format for naira amounts: "₦5,000", "₦1,250.50" in English. */
// Typed as a literal (not Intl.NumberFormatOptions) so it is assignable to
// next-intl's narrower NumberFormatOptions accepted by format.number().
export const NAIRA_FORMAT = {
  style: "currency",
  currency: "NGN",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
} as const satisfies Intl.NumberFormatOptions;
