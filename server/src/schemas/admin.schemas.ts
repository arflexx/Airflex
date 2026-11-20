import { z } from "zod";
import { paginationSchema } from "./trade.schemas";

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

/**
 * Schema for PATCH /api/v1/admin/fraud-flags/:id request body (issue #491).
 *
 * `status` closes an open flag:
 *   - "reviewed"  → investigated; action taken (or none needed) outside this API.
 *   - "dismissed" → false positive.
 */
export const reviewFraudFlagSchema = z.object({
  status: z.enum(["reviewed", "dismissed"]),
  note: z.string().trim().max(1000).optional(),
});

export type ReviewFraudFlagInput = z.infer<typeof reviewFraudFlagSchema>;

/**
 * Schema for PATCH /api/v1/admin/users/:id/kyc request body (issue #74).
 *
 * `status` sets the user's `kyc_status` directly:
 *   - "unverified" → no submission yet, or a prior submission was rejected.
 *   - "pending"    → a document has been submitted and awaits review.
 *   - "verified"   → KYC approved; the user may sell without restriction.
 */
export const updateKycStatusSchema = z.object({
  status: z.enum(["unverified", "pending", "verified"]),
  note: z.string().trim().max(1000).optional(),
});

export type UpdateKycStatusInput = z.infer<typeof updateKycStatusSchema>;

// ---------------------------------------------------------------------------
// Audit logs (issue #539)
// ---------------------------------------------------------------------------

/** Every audited admin action. Extend when auditing a new admin route. */
export const AUDIT_ACTIONS = [
  "trade.dispute_resolved",
  "fraud_flag.reviewed",
  "webhook.replayed",
  "user.banned",
  "user.unbanned",
  "kyc.approved",
  "kyc.rejected",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Resource kinds an audit entry can point at. */
export const AUDIT_TARGET_TYPES = ["trade", "fraud_flag", "webhook_event", "user", "kyc"] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * Query string for GET /api/v1/admin/audit-logs (super_admin only).
 *
 * All filters are optional and combine with AND. `from`/`to` are ISO-8601
 * timestamps bounding `occurred_at` (inclusive).
 */
export const auditLogQuerySchema = paginationSchema
  .extend({
    actorId: z.string().uuid().optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
    targetId: z.string().trim().min(1).max(128).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
    message: "from must be before or equal to to",
    path: ["from"],
  });

export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;
