import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { trace } from "@opentelemetry/api";
import { runWithRequestContext } from "../utils/requestContext";

/**
 * An inbound X-Request-Id is reused (so a trace can span a gateway or another
 * service) only if it is short and limited to safe characters; anything else
 * is replaced, so it can't be used to inject content into logs.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * requestId middleware assigns a correlation ID to every request and sets it on:
 * - res.locals.requestId (for use in route handlers)
 * - the X-Request-ID response header (for client-side correlation; support
 *   can search logs and traces by the exact value a user reports)
 * - the active OpenTelemetry span as `request.id` (issue #675)
 * - the async request context, so every log line written while handling the
 *   request carries the same `requestId` (see utils/logger.ts, issue #481)
 */
export function requestId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const incoming = req.header("x-request-id");
  const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : uuidv4();

  res.locals.requestId = id;
  res.setHeader("X-Request-ID", id);
  // Imported from @opentelemetry/api directly (not telemetry.ts) so this
  // middleware never triggers SDK initialisation; a no-op without the SDK.
  trace.getActiveSpan()?.setAttribute("request.id", id);

  runWithRequestContext({ requestId: id }, () => next());
}
