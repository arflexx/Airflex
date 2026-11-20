-- Reverses migration 017_transactions_user_date_index.sql (issue #622).
--
-- Drops the composite index concurrently to avoid locking table writes.

DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_user_id_created_at;
