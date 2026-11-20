-- explain_transactions_user_date_index.sql
--
-- Verification that transactions history query uses idx_transactions_user_id_created_at
-- (migration 017_transactions_user_date_index.sql, issue #622).
--
-- Usage:
--   psql "$DATABASE_URL" -f server/sql/explain_transactions_user_date_index.sql
--
-- Expected:
--   An "Index Scan using idx_transactions_user_id_created_at on transactions"
--   with no separate Sort node.

BEGIN;

ANALYZE transactions;

EXPLAIN (ANALYZE, BUFFERS, COSTS)
SELECT id, trade_id, amount::text AS amount, direction, type, external_reference, created_at
  FROM transactions
 WHERE user_id = '00000000-0000-0000-0000-000000000001'
 ORDER BY created_at DESC;

ROLLBACK;
