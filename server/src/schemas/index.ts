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
  createTradeSchema,
  buyTradeSchema,
  paginationSchema,
  type CreateTradeInput,
  type BuyTradeInput,
  type PaginationInput,
} from "./trade.schemas";

export {
  resolveDisputeSchema,
  type ResolveDisputeInput,
} from "./admin.schemas";

export {
  analyticsDateRangeSchema,
  ANALYTICS_DEFAULT_WINDOW_DAYS,
  type AnalyticsDateRangeInput,
} from "./analytics.schemas";
