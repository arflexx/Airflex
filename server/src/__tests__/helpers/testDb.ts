import "./env"; // must run before ../../db constructs its pool
import type { PoolClient } from "pg";
import pool from "../../db";

/**
 * testDb.ts — per-test database isolation via rolled-back transactions.
 *
 * The application performs every query through the shared `pool` exported by
 * src/db.ts. Before each test we check a client out of that pool, open a
 * transaction, and monkey-patch `pool.query` so ALL queries made by the app
 * (routes, services, etc.) execute inside that single open transaction.
 *
 * After each test the transaction is rolled back, so no matter what the test
 * inserted/updated/deleted, the database is left byte-for-byte identical.
 * Tests never observe each other's data even though they share one database.
 *
 * NOTE: `--runInBand` in the test script keeps everything on one connection
 * pool; with parallel workers this pattern is still safe because each worker
 * uses its own connections.
 */

let poolEnded = false;

export function setupTestDatabase(): void {
  let txn: PoolClient | null = null;

  beforeEach(async () => {
    txn = await pool.connect();
    await txn.query("BEGIN");

    // Route every app-level query through the open transaction.
    jest
      .spyOn(pool, "query")
      .mockImplementation((...args: Parameters<typeof pool.query>) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (txn!.query as (...a: any[]) => ReturnType<typeof pool.query>).apply(txn, args)
      );
  });

  afterEach(async () => {
    jest.restoreAllMocks(); // restore pool.query BEFORE rolling back

    const client = txn;
    txn = null;
    if (client) {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  });

  afterAll(async () => {
    if (!poolEnded) {
      poolEnded = true;
      await pool.end();
    }
  });
}

/**
 * Convenience accessor for asserting against DB state inside tests.
 * Queries go through the same open transaction as the app (via the patched
 * pool), so they see uncommitted writes from the request under test.
 */
export async function queryOne<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const { rows } = await pool.query<T>(sql, params);
  return rows[0];
}
