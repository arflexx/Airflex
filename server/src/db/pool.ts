import { Pool, type PoolClient } from "pg";
import logger from "../utils/logger";

// Shared PostgreSQL connection pool configuration (issue #680)

/** Defaults used when the corresponding environment variable is unset/invalid. */
export const DB_POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
} as const;

/**
 * Parses a positive integer from the first of `names` that is set, falling
 * back to `fallback` when none is set or the value is not a valid positive
 * integer. Keeps a bad value (e.g. "abc" or "-5") from silently producing
 * NaN/negative pool settings that `pg` would otherwise accept.
 */
function envInt(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
  return fallback;
}

export interface DbPoolConfig {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/**
 * Resolves pool sizing from the environment so it can be tuned per deployment
 * (e.g. a small Railway instance vs. a larger box) without a code change:
 * - DB_POOL_MAX:            max concurrent connections    (default: 10)
 * - DB_IDLE_TIMEOUT_MS:     idle connection timeout in ms (default: 30000)
 * - DB_CONNECT_TIMEOUT_MS:  connection acquire timeout ms (default: 5000)
 *
 * The earlier names DB_POOL_IDLE_TIMEOUT_MS / DB_POOL_CONN_TIMEOUT_MS are
 * still honoured as fallbacks so existing deployments keep their settings.
 * See server/.env.example for production recommendations.
 */
export function resolvePoolConfig(): DbPoolConfig {
  return {
    max: envInt(["DB_POOL_MAX"], DB_POOL_DEFAULTS.max),
    idleTimeoutMillis: envInt(
      ["DB_IDLE_TIMEOUT_MS", "DB_POOL_IDLE_TIMEOUT_MS"],
      DB_POOL_DEFAULTS.idleTimeoutMillis
    ),
    connectionTimeoutMillis: envInt(
      ["DB_CONNECT_TIMEOUT_MS", "DB_POOL_CONN_TIMEOUT_MS"],
      DB_POOL_DEFAULTS.connectionTimeoutMillis
    ),
  };
}

const poolConfig = resolvePoolConfig();

/** Shared PostgreSQL connection pool. */
export const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  ...poolConfig,
});

// Handle unexpected client errors without crashing the process
pool.on("error", (err) => {
  logger.error({ err: err.message }, "[db] Unexpected idle client error");
});

// ---------------------------------------------------------------------------
// Pool metrics & exhaustion warnings
// ---------------------------------------------------------------------------

export interface PoolStats {
  /** Configured maximum pool size (DB_POOL_MAX). */
  max: number;
  /** Connections currently open (checked out + idle). */
  total: number;
  /** Connections currently checked out by a query/transaction. */
  active: number;
  /** Open connections waiting to be reused. */
  idle: number;
  /** Callers queued waiting for a connection to free up. */
  waiting: number;
}

/** Snapshot of pool utilisation, exposed on GET /health. */
export function getPoolStats(): PoolStats {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  return {
    max: poolConfig.max,
    total,
    active: Math.max(0, total - idle),
    idle,
    waiting: pool.waitingCount,
  };
}

/** Error code attached to acquire timeouts so callers/logs can identify them. */
export const DB_POOL_EXHAUSTED = "DB_POOL_EXHAUSTED";

/** Minimum gap between "saturated" warnings, so a busy pool doesn't flood logs. */
const SATURATION_WARN_INTERVAL_MS = 5_000;
let lastSaturationWarnAt = 0;

function isAcquireTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message);
}

/**
 * Logs (throttled) when every connection is checked out, so the caller about
 * to acquire one will have to queue.
 */
function warnIfSaturated(): void {
  const stats = getPoolStats();
  if (stats.total < stats.max || stats.idle > 0) return;
  const now = Date.now();
  if (now - lastSaturationWarnAt < SATURATION_WARN_INTERVAL_MS) return;
  lastSaturationWarnAt = now;
  logger.warn(
    { pool: stats },
    "[db] Connection pool saturated — all connections in use, new requests will queue"
  );
}

/**
 * Logs a pool-exhaustion warning and tags the error as a 503 so the API
 * responds "Service Unavailable" rather than a generic 500. The original
 * error is re-thrown to the caller after logging.
 */
function onAcquireError(err: unknown): void {
  if (!isAcquireTimeout(err)) return;
  logger.warn(
    { pool: getPoolStats(), connectTimeoutMs: poolConfig.connectionTimeoutMillis },
    "[db] Connection pool exhausted — timed out waiting for a free connection"
  );
  Object.assign(err as Error, { status: 503, code: DB_POOL_EXHAUSTED });
}

type ConnectCallback = (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void;

/*
 * Instrument pool.connect(). pg's `pool.query()` acquires its client through
 * `this.connect(callback)`, so patching the instance covers both direct
 * `pool.connect()` callers and every `pool.query()` call across the codebase.
 */
const originalConnect = pool.connect.bind(pool) as unknown as (
  callback?: ConnectCallback
) => Promise<PoolClient> | void;

(pool as unknown as { connect: (callback?: ConnectCallback) => Promise<PoolClient> | void }).connect = (
  callback?: ConnectCallback
) => {
  warnIfSaturated();

  if (typeof callback === "function") {
    return originalConnect((err, client, done) => {
      if (err) onAcquireError(err);
      callback(err, client, done);
    });
  }

  return (originalConnect() as Promise<PoolClient>).catch((err: unknown) => {
    onAcquireError(err);
    throw err;
  });
};

/**
 * db.query(text, params) - The only way routes interact with the database.
 * Delegates to pool.query with proper error handling.
 *
 * @param text - SQL query string with placeholders ($1, $2, etc.)
 * @param params - Array of parameter values to bind
 * @returns Query result rows
 */
export async function query(text: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}
