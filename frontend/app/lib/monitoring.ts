export interface ErrorContext {
  [key: string]: unknown;
}

interface MonitorLike {
  captureException?: (error: unknown, context?: ErrorContext) => void;
}

type GlobalWithMonitor = typeof globalThis & {
  __AIRFLEX_MONITOR__?: MonitorLike;
  Sentry?: MonitorLike;
};

function getMonitor(): MonitorLike | undefined {
  if (typeof window !== "undefined") {
    const browserMonitor = (window as unknown as GlobalWithMonitor).__AIRFLEX_MONITOR__;
    if (browserMonitor) return browserMonitor;
  }
  return (globalThis as GlobalWithMonitor).Sentry ?? (globalThis as GlobalWithMonitor).__AIRFLEX_MONITOR__;
}

export function reportError(error: unknown, context?: ErrorContext): void {
  try {
    console.error("[airflex] Unhandled error", error, context ?? {});
  } catch {
    // Logging must never throw.
  }

  try {
    const monitor = getMonitor();
    if (typeof monitor?.captureException === "function") {
      monitor.captureException(error, context);
    }
  } catch {
    // Forwarding to an optional monitoring service must never throw.
  }
}
