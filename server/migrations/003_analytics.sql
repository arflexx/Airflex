-- Analytics indexes for issue #110.
--
-- The admin analytics endpoints (server/src/routes/analytics.ts) aggregate over
-- trade_offers by created_at, by (status, created_at), and by asset_type. These
-- indexes keep those window-function style aggregations under 200 ms on large
-- datasets. Idempotent — safe to re-run.

CREATE INDEX IF NOT EXISTS idx_trade_offers_created_at
    ON trade_offers (created_at);

CREATE INDEX IF NOT EXISTS idx_trade_offers_status_created_at
    ON trade_offers (status, created_at);

CREATE INDEX IF NOT EXISTS idx_trade_offers_asset_type
    ON trade_offers (asset_type);
