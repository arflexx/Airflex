import { Pool } from "pg";

// Validate DATABASE_URL before creating pool
if (!process.env["DATABASE_URL"]) {
  throw new Error("DATABASE_URL environment variable is required");
}

/**
 * Shared PostgreSQL connection pool.
 * Configured with:
 * - max: 10 concurrent connections
 * - idleTimeoutMillis: 30000ms (30 seconds)
 * - connectionTimeoutMillis: 5000ms (5 seconds)
 */
export const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
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
