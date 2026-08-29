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

  if (process.env["NODE_ENV"] === "production" || process.env["NODE_ENV"] === "test") {
    res.status(500).json({ error: "Internal server error" });
  } else {
    res.status(status).json({
      error: err.message,
      stack: err.stack,
    });
  }
}
