import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

/**
 * requestId middleware generates a UUID v4 per request and sets it on:
 * - res.locals.requestId (for use in route handlers and logging)
 * - X-Request-Id response header (for client-side correlation)
 */
export function requestId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = uuidv4();

  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  next();
}
