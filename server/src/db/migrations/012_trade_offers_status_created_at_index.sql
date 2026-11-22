-- Migration 012: composite index for filtered trade lists (issue #543).
--
-- Trades live in `trade_offers`. Both list endpoints filter on status and
-- page newest-first:
--
--   GET /api/v1/trades        WHERE t.status = 'Active' AND t.expires_at > NOW()
--                             ORDER BY t.created_at DESC LIMIT $n OFFSET $m
--   GET /api/v1/admin/trades  WHERE status = $1 ORDER BY created_at DESC ...
--
-- Without this index Postgres scans every row of the matching status and
-- sorts them. With (status, created_at DESC) it walks the index in order and
-- stops after LIMIT rows. Query results are unchanged; only the plan differs.
--
-- Plain CREATE INDEX (no concurrent build) because the migration runner wraps
-- each file in a transaction. Idempotent via IF NOT EXISTS.
--
-- Verify the plan with server/sql/explain_trade_offers_status_created_at.sql.
-- Reverse: down/012_trade_offers_status_created_at_index.sql

CREATE INDEX IF NOT EXISTS idx_trade_offers_status_created_at
    ON trade_offers (status, created_at DESC);
