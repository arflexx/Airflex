import { z } from "zod";
import { MAX_TRADE_STROOPS } from "@airflex/shared/units";

// ---------------------------------------------------------------------------
// Asset-type allowlist
// ---------------------------------------------------------------------------

/**
 * Canonical uppercase values accepted for assetType.
 * Keep this list in sync with ASSET_TYPE_VALUES in
 * frontend/app/lib/assetTypes.ts so validation is consistent on both sides.
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

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/v1/trades (create listing)
 *
 * Matches the server-side Zod rules AND the frontend sell form validation so
 * both layers share a single source of truth (this file is the canonical one).
 */
export const createTradeSchema = z.object({
  assetType: z.enum(ASSET_TYPE_VALUES, {
    required_error: "assetType is required",
    message:
      "assetType must be one of: " + ASSET_TYPE_VALUES.join(", "),
  }),

  /**
   * Listing amount **in stroops** — the contract's unit, converted by the
   * caller with `toStroops()` from packages/shared (issue #292).
   *
   * Requiring a positive integer removes the ambiguous conversion that used to
   * happen inside services/stellar.ts (`amount * 1_000_000`) and rejects
   * fractional inputs that could drift by a few stroops before reaching the
   * contract. The ceiling mirrors the sell form's ₦1,000,000 listing cap.
   *
   * The route persists the naira equivalent (`fromStroops`) so the
   * naira-denominated platform ledger stays consistent; only this wire format
   * and the escrow call are in stroops.
   */
  amount: z
    .number({ required_error: "amount is required", invalid_type_error: "amount must be a number" })
    .int("amount must be a whole number of stroops")
    .positive("amount must be greater than 0")
    .max(
      Number(MAX_TRADE_STROOPS),
      "amount must not exceed 1,000,000,000,000 stroops (₦1,000,000)"
    ),

  expiresInHours: z
    .number({ required_error: "expiresInHours is required", invalid_type_error: "expiresInHours must be a number" })
    .int("expiresInHours must be a whole number")
    .min(1, "minimum expiry is 1 hour")
    .max(168, "maximum expiry is 7 days (168 hours)"),
});

export type CreateTradeInput = z.infer<typeof createTradeSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/v1/trades/:id/buy
 *
 * The buyer signs the escrow deposit in their own browser and sends only the
 * signed envelope. The secret key is never accepted here — see Issue #342.
 * Use POST /api/v1/trades/:id/buy/prepare to obtain the unsigned XDR first.
 */
export const buyTradeSchema = z.object({
  signedXdr: z
    .string({ required_error: "signedXdr is required" })
    .min(1, "signedXdr must not be empty")
    // Envelopes are base64; a Soroban invoke envelope is comfortably larger
    // than a raw secret key, so this also rejects a key pasted in by mistake.
    .regex(/^[A-Za-z0-9+/=]+$/, "signedXdr must be base64-encoded XDR")
    .min(100, "signedXdr does not look like a transaction envelope"),
});

export type BuyTradeInput = z.infer<typeof buyTradeSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for GET /api/v1/trades query parameters (pagination + optional filter)
 *
 * This schema is applied to req.query, not req.body.
 * Strings are coerced to integers via transform().
 */
export const paginationSchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 1))
    .pipe(z.number().int().min(1, "page must be at least 1")),

  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 20))
    .pipe(
      z
        .number()
        .int()
        .min(1, "limit must be at least 1")
        .max(100, "limit must be 100 or fewer")
    ),

  /**
   * Optional filter — when supplied, only listings of this asset type are returned.
   * Must be one of the canonical allowlist values so the same validation applies
   * to both create and filter paths.
   */
  assetType: z
    .enum(ASSET_TYPE_VALUES, {
      message: "assetType must be one of: " + ASSET_TYPE_VALUES.join(", "),
    })
    .optional(),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/v1/trades/:id/dispute
 *
 * Previously this validation (required, non-empty, <= 500 chars) lived
 * inline in the route handler instead of as a Zod schema like every other
 * validated endpoint, which meant it wasn't discoverable from src/schemas/
 * and couldn't be reused for OpenAPI documentation the way the other request
 * bodies are.
 */
export const disputeSchema = z.object({
  reason: z
    .string({ required_error: "Dispute reason is required" })
    .trim()
    .min(1, "Dispute reason is required")
    .max(500, "Dispute reason cannot exceed 500 characters"),
});

export type DisputeInput = z.infer<typeof disputeSchema>;
