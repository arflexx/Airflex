-- Migration 017: composite BTREE index for wallet transaction queries by user and date (issue #622).
--
-- The wallet transaction query in services/wallet.ts filters by user_id and
-- orders by created_at DESC:
--
--   SELECT id, trade_id, amount, direction, type, external_reference, created_at
--   FROM transactions
--   WHERE user_id = $1
--   ORDER BY created_at DESC;
--
-- Without this index, Postgres performs a full table scan and sort.
-- Using CREATE INDEX CONCURRENTLY prevents blocking writes on transactions.
--
-- Reverse: down/017_transactions_user_date_index.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_id_created_at
    ON transactions USING btree (user_id, created_at DESC);
