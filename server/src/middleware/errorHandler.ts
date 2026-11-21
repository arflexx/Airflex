import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";

/**
 * Global Express error-handling middleware.
 *
 * Must be registered LAST — after all routes — so it catches errors forwarded
 * by `next(err)` or thrown inside `asyncHandler`-wrapped handlers.
 *
 * Behaviour:
 *  - Always logs method, path, and full stack via the structured logger.
 *  - In production: returns a generic { error: "Internal server error" } so
 *    stack traces are never leaked to API consumers.
 *  - In development: includes the error message and stack for easier debugging.
 *  - Always includes a machine-readable `code` field alongside `error`
 *    (issue #618), formatted consistently regardless of environment:
 *      - an explicit `err.code` (e.g. from a typed error like
 *        `VerificationError`/`VelocityError`) is passed through as-is;
 *      - otherwise 5xx errors fall back to "INTERNAL_ERROR" and 4xx errors
 *        fall back to "UNKNOWN_ERROR".
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error(
    {
      method: req.method,
      path: req.path,
      stack: err.stack,
    },
    err.message
  );

  const errMeta = err as Error & { status?: number; statusCode?: number; code?: string };
  const status = errMeta.status ?? errMeta.statusCode ?? 500;
  const code = errMeta.code ?? (status >= 500 ? "INTERNAL_ERROR" : "UNKNOWN_ERROR");

  if (process.env["NODE_ENV"] === "production") {
    res.status(status).json({
      error: "Internal server error",
      code: status >= 500 ? "INTERNAL_ERROR" : code,
    });
  } else {
    res.status(status).json({
      error: err.message,
      code,
      stack: err.stack,
    });
  }
}
