import { z } from "zod";

/**
 * Query schema for GET /api/v1/admin/analytics/trades/timeseries (issue #110).
 *
 * `from` / `to` accept ISO-8601 dates — either date-only (`2026-08-01`) or
 * full datetimes (`2026-08-01T00:00:00Z`). Both are optional; when omitted the
 * endpoint defaults to the last 30 days.
 */
export const analyticsDateRangeSchema = z
  .object({
    from: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
        "from must be an ISO-8601 date (e.g. 2026-08-01 or 2026-08-01T00:00:00Z)"
      )
      .optional(),
    to: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
        "to must be an ISO-8601 date (e.g. 2026-08-01 or 2026-08-01T00:00:00Z)"
      )
      .optional(),
  })
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      Date.parse(value.from) <= Date.parse(value.to),
    { message: "from must not be after to", path: ["from"] }
  );

export type AnalyticsDateRangeInput = z.infer<typeof analyticsDateRangeSchema>;

/** Default window for the timeseries endpoint when no dates are supplied. */
export const ANALYTICS_DEFAULT_WINDOW_DAYS = 30;
