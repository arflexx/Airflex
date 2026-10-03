/**
 * Canonical asset-type constants shared across the frontend.
 *
 * Values are the canonical uppercase strings stored in the database and
 * validated by the backend schema (e.g. "MTN_AIRTIME").  Any place that
 * needs to display, filter, or submit an assetType should import from here
 * so the whole UI stays in sync with the allowlist.
 */

export const ASSET_TYPE_VALUES = [
  "MTN_AIRTIME",
  "MTN_DATA",
  "GLO_AIRTIME",
  "GLO_DATA",
  "AIRTEL_AIRTIME",
  "AIRTEL_DATA",
  "9MOBILE_AIRTIME",
  "9MOBILE_DATA",
  "SPECTRANET_DATA",
] as const;

export type AssetTypeValue = (typeof ASSET_TYPE_VALUES)[number];

/** Human-readable label for each canonical value. */
export const ASSET_TYPE_LABELS: Record<AssetTypeValue, string> = {
  MTN_AIRTIME:      "MTN — Airtime",
  MTN_DATA:         "MTN — Data",
  GLO_AIRTIME:      "Glo — Airtime",
  GLO_DATA:         "Glo — Data",
  AIRTEL_AIRTIME:   "Airtel — Airtime",
  AIRTEL_DATA:      "Airtel — Data",
  "9MOBILE_AIRTIME":"9mobile — Airtime",
  "9MOBILE_DATA":   "9mobile — Data",
  SPECTRANET_DATA:  "Spectranet — Data",
};

/** { value, label } pairs ready for <select> / filter buttons. */
export const ASSET_OPTIONS = ASSET_TYPE_VALUES.map((value) => ({
  value,
  label: ASSET_TYPE_LABELS[value],
}));

/**
 * Format a raw canonical value for display (e.g. "MTN_AIRTIME" → "Mtn Airtime").
 * Falls back to splitting on underscores for any unrecognised value.
 */
export function formatAssetType(raw: string): string {
  const known = ASSET_TYPE_LABELS[raw as AssetTypeValue];
  if (known) return known;
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
