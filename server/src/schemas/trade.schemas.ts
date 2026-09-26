import { z } from "zod";

/**
 * Schema for POST /api/v1/trades (create listing)
 *
 * Matches the server-side Zod rules AND the frontend sell form validation so
 * both layers share a single source of truth (this file is the canonical one).
 */
export const createTradeSchema = z.object({
  assetType: z
    .string({ required_error: "assetType is required" })
    .min(1, "assetType is required")
    .max(50, "assetType must be 50 characters or fewer")
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "assetType must contain only letters, numbers, underscores, or hyphens"
    ),

  amount: z
    .number({ required_error: "amount is required", invalid_type_error: "amount must be a number" })
    .positive("amount must be greater than 0"),

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
 * Schema for GET /api/v1/trades query parameters (pagination)
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

  assetType: z.string().optional(),
  carrier: z.string().optional(),
  minAmount: z
    .string()
    .optional()
    .transform((v) => (v ? parseFloat(v) : undefined))
    .pipe(z.number().min(0).optional()),
  maxAmount: z
    .string()
    .optional()
    .transform((v) => (v ? parseFloat(v) : undefined))
    .pipe(z.number().min(0).optional()),
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
