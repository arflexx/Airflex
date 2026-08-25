-- =============================================================================
-- AirFlex test database schema
-- =============================================================================
-- Applied by src/__tests__/globalSetup.ts to a freshly created `airflex_test`
-- database before the integration suite runs, and dropped again in teardown.
--
-- This mirrors the production tables as used by every query in src/ (there is
-- no migration framework yet, so this file is the canonical DDL for tests).
-- =============================================================================

CREATE TABLE users (
  id                 UUID PRIMARY KEY,
  phone              TEXT NOT NULL UNIQUE,
  otp_pin_id         TEXT,
  otp_expires_at     TIMESTAMPTZ,
  stellar_public_key TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallets (
  id                 UUID PRIMARY KEY,
  user_id            UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stellar_public_key TEXT NOT NULL,
  stellar_secret_key TEXT NOT NULL
);

CREATE TABLE trade_offers (
  id                  UUID PRIMARY KEY,
  seller_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  asset_type          TEXT NOT NULL,
  amount              NUMERIC(18,7) NOT NULL CHECK (amount > 0),
  status              TEXT NOT NULL DEFAULT 'Active'
                      CHECK (status IN ('Active','Locked','Completed','Cancelled','Disputed')),
  contract_listing_id TEXT,
  escrow_tx_hash      TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trade_offers_status_expires ON trade_offers (status, expires_at);
CREATE INDEX idx_trade_offers_seller         ON trade_offers (seller_id);
CREATE INDEX idx_trade_offers_buyer          ON trade_offers (buyer_id);
