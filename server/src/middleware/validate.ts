import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

/**
 * Structured validation error item returned to callers.
 * `field` is the dot-notation path to the invalid field (e.g. "amount"),
 * `message` is the human-readable reason (e.g. "amount must be greater than 0").
 */
export interface ValidationErrorItem {
  field: string;
  message: string;
}

/**
 * validate — Express middleware factory for request body validation.
 *
 * Usage:
 *   router.post("/", validate(myZodSchema), asyncHandler(async (req, res) => { … }))
 *
 * On success:
 *   - `req.body` is replaced with the *parsed* (coerced + stripped) value
 *     returned by Zod, so downstream handlers always receive clean data.
 *   - `next()` is called with no argument.
 *
 * On failure:
 *   - Returns HTTP 422 Unprocessable Entity with the shape:
 *     { errors: [{ field: string, message: string }] }
 *   - Each ZodIssue is mapped to one error item. Nested field paths are joined
 *     with "." (e.g. "address.city").
 *
 * HTTP 422 is chosen over 400 because the request was syntactically valid JSON
 * but semantically invalid — the standard distinction in REST APIs.
 */
export function validate<T>(
  schema: ZodSchema<T>,
  statusCodeOrOptions: number | { statusCode?: number } = 422
) {
  const statusCode =
    typeof statusCodeOrOptions === "number"
      ? statusCodeOrOptions
      : (statusCodeOrOptions?.statusCode ?? 422);

  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (result.success) {
      // Replace req.body with the parsed (coerced + stripped) value so
      // downstream handlers receive validated, type-safe data.
      req.body = result.data;
      next();
      return;
    }

    const errors = formatErrors(result.error);
    res.status(statusCode).json({
      error: "Validation failed",
      errors,
    });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps a ZodError to a flat array of { field, message } objects.
 * Nested paths (e.g. ZodIssue.path = ["address", "city"]) are joined as
 * "address.city". Top-level issues with no path use "_body" as the field name.
 * Unrecognized keys from .strict() schemas are listed individually by key name.
 */
export function formatErrors(error: ZodError): ValidationErrorItem[] {
  const items: ValidationErrorItem[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys" && Array.isArray((issue as any).keys)) {
      for (const key of (issue as any).keys) {
        items.push({
          field: String(key),
          message: `Unrecognized key in body: '${key}'`,
        });
      }
    } else {
      items.push({
        field: issue.path.length > 0 ? issue.path.join(".") : "_body",
        message: issue.message,
      });
    }
  }

  return items;
}
