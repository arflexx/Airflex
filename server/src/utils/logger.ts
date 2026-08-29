type LogContext = Record<string, unknown>;

type LogMethod = {
  (message: string): void;
  (context: LogContext, message: string): void;
};

const levelColors: Record<string, string> = {
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

function write(level: string, context: LogContext, message: string): void {
  const timestamp = new Date().toISOString();

  if (process.env["NODE_ENV"] === "production") {
    process.stdout.write(
      `${JSON.stringify({
        ...formatContext(context),
        level: level.toLowerCase(),
        message,
        timestamp,
      })}\n`,
    );
    return;
  }

  const time = timestamp.slice(11, 19);
  const label = level.toUpperCase();
  const color = levelColors[label] ?? "";
  const reset = color ? "\u001b[0m" : "";
  process.stdout.write(`${color}[${label}] ${time} — ${message}${reset}\n`);
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
  debug: createLogMethod("debug"),
};

export default logger;
