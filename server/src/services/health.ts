/**
 * Health probe for GET /health (issue #633).
 *
 * Liveness + readiness in one call for Railway and the Docker HEALTHCHECK:
 * 200 when every configured dependency answers, 503 when any of them fails.
 * Redis is optional outside production (no REDIS_URL), in which case it is
 * reported as "disabled" and does not fail the probe.
 */

export type ComponentStatus = "ok" | "error" | "disabled";

export interface HealthDeps {
  /** Runs `SELECT 1` against the pool. */
  pingDb: () => Promise<unknown>;
  /** Sends Redis PING; must resolve to "PONG". */
  pingRedis: () => Promise<string | null>;
  redisConfigured: boolean;
  version: string;
  /** Per-check budget so a hung dependency cannot hang the probe. */
  timeoutMs?: number;
}

export interface HealthReport {
  httpStatus: 200 | 503;
  body: {
    status: "ok" | "error";
    db: ComponentStatus;
    redis: ComponentStatus;
    uptime: number;
    version: string;
    timestamp: string;
  };
}

async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("health check timed out")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const timeoutMs = deps.timeoutMs ?? 2000;

  const [db, redis] = await Promise.all([
    probe(deps.pingDb, timeoutMs).then(
      (): ComponentStatus => "ok",
      (): ComponentStatus => "error"
    ),
    deps.redisConfigured
      ? probe(deps.pingRedis, timeoutMs).then(
          (pong): ComponentStatus => (pong === "PONG" ? "ok" : "error"),
          (): ComponentStatus => "error"
        )
      : Promise.resolve<ComponentStatus>("disabled"),
  ]);

  const healthy = db !== "error" && redis !== "error";
  return {
    httpStatus: healthy ? 200 : 503,
    body: {
      status: healthy ? "ok" : "error",
      db,
      redis,
      uptime: Math.floor(process.uptime()),
      version: deps.version,
      timestamp: new Date().toISOString(),
    },
  };
}
