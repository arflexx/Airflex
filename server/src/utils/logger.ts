import { isSpanContextValid, trace } from "@opentelemetry/api";
import { getRequestId } from "./requestContext";

type LogContext = Record<string, unknown>;

type LogMethod = {
  (message: string): void;
  (context: LogContext, message: string): void;
};

const levelColors: Record<string, string> = {
  FATAL: "\u001b[35m",
  INFO: "\u001b[36m",
  WARN: "\u001b[33m",
  ERROR: "\u001b[31m",
  DEBUG: "\u001b[90m",
};

function formatContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    ]),
  );
}

/**
 * Trace/span ids of the active OpenTelemetry span (issue #482), so a log line
 * can be joined to its trace. Empty when tracing is disabled or no span is
 * active — `@opentelemetry/api` falls back to a no-op without the SDK.
 */
function traceContext(): { traceId?: string; spanId?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

function write(level: string, context: LogContext, message: string): void {
  const timestamp = new Date().toISOString();
  // Correlation ID of the current request (issue #481); an explicit
  // `requestId` in the context wins.
  const requestId = (context["requestId"] as string | undefined) ?? getRequestId();

  if (process.env["NODE_ENV"] === "production") {
    process.stdout.write(
      `${JSON.stringify({
        ...formatContext(context),
        level: level.toLowerCase(),
        message,
        ...(requestId ? { requestId } : {}),
        ...traceContext(),
        timestamp,
      })}\n`,
    );
    return;
  }

  const time = timestamp.slice(11, 19);
  const label = level.toUpperCase();
  const color = levelColors[label] ?? "";
  const reset = color ? "\u001b[0m" : "";
  const rid = requestId ? ` [${requestId}]` : "";
  process.stdout.write(`${color}[${label}] ${time}${rid} — ${message}${reset}\n`);
}

function createLogMethod(level: string): LogMethod {
  return ((contextOrMessage: LogContext | string, message?: string) => {
    if (typeof contextOrMessage === "string") {
      write(level, {}, contextOrMessage);
      return;
    }

    write(level, contextOrMessage, message ?? "");
  }) as LogMethod;
}

/**
 * Minimal structured logger using only Node.js built-ins.
 * Production output is one JSON object per line; development output is
 * colourised and human-readable.
 */
export const logger = {
  info: createLogMethod("info"),
  warn: createLogMethod("warn"),
  error: createLogMethod("error"),
  fatal: createLogMethod("fatal"),
  debug: createLogMethod("debug"),
};

export default logger;
