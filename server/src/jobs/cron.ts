/**
 * cron.ts — minimal in-process scheduler for periodic maintenance tasks.
 *
 * The job queue (queue.ts) handles event-driven work; this module covers
 * recurring housekeeping such as audit log retention and expired data-export
 * cleanup. Each task runs once shortly after startup (so a server that
 * restarts more often than the interval still gets its maintenance done) and
 * then every `intervalMs`. Timers are unref'd so they never keep the process
 * alive on shutdown.
 *
 * Tasks must be idempotent and safe to run concurrently on several replicas
 * (e.g. guarded by a Postgres advisory lock).
 */

import logger from "../utils/logger";

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Delay before the first run, so startup isn't competing with maintenance. */
const INITIAL_DELAY_MS = 60_000;

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  /**
   * Delay before the first run. Defaults to INITIAL_DELAY_MS (60s); cache
   * pre-warm tasks pass 0 so the cache is populated as soon as the server
   * starts instead of after the first interval (issue #676).
   */
  initialDelayMs?: number;
}

const timers: NodeJS.Timeout[] = [];

async function runSafely(task: ScheduledTask): Promise<void> {
  const startedAt = Date.now();
  try {
    await task.run();
    logger.info({ task: task.name, durationMs: Date.now() - startedAt }, "[cron] Task completed");
  } catch (err) {
    logger.error({ task: task.name, err: (err as Error).message }, "[cron] Task failed");
  }
}

/** Registers a recurring task. */
export function schedule(task: ScheduledTask): void {
  const initial = setTimeout(() => {
    void runSafely(task);
    const interval = setInterval(() => void runSafely(task), task.intervalMs);
    interval.unref();
    timers.push(interval);
  }, task.initialDelayMs ?? INITIAL_DELAY_MS);
  initial.unref();
  timers.push(initial);

  logger.info({ task: task.name, intervalMs: task.intervalMs }, "[cron] Task scheduled");
}

/** Cancels every scheduled task (used by tests and graceful shutdown). */
export function stopAllScheduledTasks(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
}
