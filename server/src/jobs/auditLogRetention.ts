/**
 * auditLogRetention.ts — 365-day retention for audit_logs (issue #539).
 *
 * Deletes audit entries older than AUDIT_LOG_RETENTION_DAYS in bounded
 * batches. Two independent database-level guards must both be satisfied for a
 * DELETE to succeed:
 *
 *   1. Trigger (migration 013): rejects every DELETE unless the session has
 *      set `airflex.audit_retention = on` AND the row is older than 365 days.
 *
 *   2. Row-Level Security (migration 021): the RLS DELETE policy only permits
 *      the `airflex_audit_retention` role to delete rows older than 365 days.
 *      The application pool role has no DELETE privilege.
 *
 * Both are enforced per batch transaction via:
 *   SELECT set_config('airflex.audit_retention', 'on', true)  -- for trigger
 *   SET LOCAL ROLE airflex_audit_retention                     -- for RLS
 *
 * SET LOCAL is transaction-scoped and reverts on COMMIT/ROLLBACK, so the
 * privileged role never leaks to other connections in the pool.
 *
 * A transaction-scoped advisory lock ensures only one server instance purges
 * at a time when several replicas run the same schedule.
 */

import type { Pool } from "pg";
import pool from "../db";
import logger from "../utils/logger";

/** Retention window. Must not be lower than the trigger's 365-day floor. */
export const AUDIT_LOG_RETENTION_DAYS = 365;

/** Rows deleted per transaction, to keep lock times and WAL bursts small. */
export const AUDIT_LOG_PURGE_BATCH_SIZE = 5_000;

/** Arbitrary constant identifying this job's advisory lock. */
const RETENTION_LOCK_KEY = 539_001;

/**
 * Purges expired audit entries. Returns the number of rows deleted, or 0 when
 * another instance holds the lock.
 */
export async function purgeExpiredAuditLogs(
  db: Pool = pool,
  batchSize = AUDIT_LOG_PURGE_BATCH_SIZE
): Promise<number> {
  let total = 0;

  for (;;) {
    const client = await db.connect();
    let deleted = 0;
    try {
      await client.query("BEGIN");

      const { rows: lockRows } = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock($1) AS locked`,
        [RETENTION_LOCK_KEY]
      );
      if (!lockRows[0]?.locked) {
        await client.query("ROLLBACK");
        logger.info("[audit-retention] Another instance is purging — skipping");
        return total;
      }

      await client.query(`SELECT set_config('airflex.audit_retention', 'on', true)`);

      // Switch to the privileged retention role so the RLS DELETE policy
      // (migration 021) passes. SET LOCAL is transaction-scoped and reverts
      // automatically on COMMIT/ROLLBACK, so it never leaks to other callers.
      await client.query(`SET LOCAL ROLE airflex_audit_retention`);

      const result = await client.query(
        `DELETE FROM audit_logs
         WHERE id IN (
           SELECT id FROM audit_logs
           WHERE occurred_at < NOW() - make_interval(days => $1)
           ORDER BY occurred_at
           LIMIT $2
         )`,
        [AUDIT_LOG_RETENTION_DAYS, batchSize]
      );
      deleted = result.rowCount ?? 0;

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    total += deleted;
    if (deleted < batchSize) break;
  }

  logger.info(
    { deleted: total, retentionDays: AUDIT_LOG_RETENTION_DAYS },
    "[audit-retention] Purged expired audit log entries"
  );
  return total;
}
