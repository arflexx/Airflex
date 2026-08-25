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

  // Honour explicit HTTP statuses carried by framework errors
  // (e.g. express.json() body-parser failures arrive with status 400).
  const carrier = err as Error & { status?: number; statusCode?: number };
  const status =
    typeof carrier.status === "number"
      ? carrier.status
      : typeof carrier.statusCode === "number"
        ? carrier.statusCode
        : 500;

  if (status < 400 || status > 499) {
    // Server-side failure — never leak internals in production.
    if (process.env["NODE_ENV"] === "production") {
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.status(500).json({
        error: err.message,
        stack: err.stack,
      });
    }
    return;
  }

  res.status(status).json({ error: err.message });
}
