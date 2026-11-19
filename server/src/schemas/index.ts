/**
 * Central barrel export for all Zod request schemas.
 *
 * Import from here in route files:
 *   import { createTradeSchema, buyTradeSchema } from "../schemas";
 */

export {
  requestOtpSchema,
  verifyOtpSchema,
  recoverSchema,
  changePhoneSchema,
  type RequestOtpInput,
  type VerifyOtpInput,
  type RecoverInput,
  type ChangePhoneInput,
} from "./auth.schemas";

export {
  ASSET_TYPE_VALUES,
  type AssetTypeValue,
  createTradeSchema,
  buyTradeSchema,
  paginationSchema,
  disputeSchema,
  type CreateTradeInput,
  type BuyTradeInput,
  type PaginationInput,
  type DisputeInput,
} from "./trade.schemas";

export {
  resolveDisputeSchema,
  reviewFraudFlagSchema,
  auditLogQuerySchema,
  updateKycStatusSchema,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  type ResolveDisputeInput,
  type ReviewFraudFlagInput,
  type AuditLogQueryInput,
  type UpdateKycStatusInput,
  type AuditAction,
  type AuditTargetType,
} from "./admin.schemas";

export {
  analyticsDateRangeSchema,
  ANALYTICS_DEFAULT_WINDOW_DAYS,
  type AnalyticsDateRangeInput,
} from "./analytics.schemas";

export {
  createRatingSchema,
  userRatingsPaginationSchema,
  type CreateRatingInput,
} from "./ratings.schemas";

export {
  profileUpdateSchema,
  updateProfileSchema,
  type ProfileUpdateInput,
} from "./profile.schemas";
