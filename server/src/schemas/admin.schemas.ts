import { z } from "zod";

/**
 * Schema for POST /api/v1/admin/trades/:id/resolve request body.
 *
 * `resolution` selects the outcome of a disputed trade:
 *   - "RELEASE" → release escrowed funds to the seller.
 *   - "REFUND"  → return escrowed funds to the buyer.
 */
export const resolveDisputeSchema = z.object({
  resolution: z.enum(["RELEASE", "REFUND"]),
});

export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
