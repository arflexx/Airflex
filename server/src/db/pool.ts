import { Pool } from "pg";

// Shared PostgreSQL connection pool configuration


/**
 * Parses a positive integer from an environment variable, falling back to
 * `fallback` when the variable is unset, empty, or not a valid positive
 * integer. Keeps a bad value (e.g. "abc" or "-5") from silently producing
 * NaN/negative pool settings that `pg` would otherwise accept.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Shared PostgreSQL connection pool.
 *
 * Configurable via environment variables so pool sizing can be tuned per
 * deployment (e.g. a small Railway instance vs. a larger box) without a code
 * change:
 * - DB_POOL_MAX:               max concurrent connections   (default: 10)
 * - DB_POOL_IDLE_TIMEOUT_MS:   idle connection timeout in ms (default: 30000)
 * - DB_POOL_CONN_TIMEOUT_MS:   connection acquire timeout ms (default: 5000)
 */
export const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  max: envInt("DB_POOL_MAX", 10),
  idleTimeoutMillis: envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000),
  connectionTimeoutMillis: envInt("DB_POOL_CONN_TIMEOUT_MS", 5_000),
});

// Handle unexpected client errors without crashing the process
pool.on("error", (err) => {
  console.error(`[db] Unexpected client error: ${err.message}`);
});

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
