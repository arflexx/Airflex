-- Baseline schema (issue #79).
--
-- Every migration from 001 onward assumes `users`, `wallets`, `trade_offers`
-- and `transactions` already exist and runs ALTER TABLE against them, but
-- the tables themselves were never captured as a migration — they only
-- existed as the manual "run this SQL once" snippet in
-- docs/getting-started.md ("Run the schema (once a migrations file exists,
-- use that instead)"). That meant `make`/`npm run db:migrate` could never
-- provision a database from scratch, which blocked building a real
-- integration test suite against a freshly migrated test database.
--
-- This migration is that promised migrations file: it is the same schema
-- from docs/getting-started.md, lifted verbatim so `runMigrations()` can
-- build a complete, working schema (000 through the latest numbered
-- migration) against an empty Postgres instance.
--
-- `transactions` is deliberately NOT included here even though
-- docs/getting-started.md lists it: migration 009_transactions_and_payments.sql
-- already does `CREATE TABLE IF NOT EXISTS transactions` with the complete,
-- correct column set (external_reference, display_user_id, NOT NULL
-- constraints, etc). Creating a slimmer version of that table here first
-- would make 009's CREATE TABLE IF NOT EXISTS a no-op and silently leave
-- those columns missing.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  stellar_public_key VARCHAR(60),
  stellar_secret_key TEXT, -- encrypt at rest in production
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_offers (
  id UUID PRIMARY KEY,
  seller_id UUID REFERENCES users(id),
  buyer_id UUID REFERENCES users(id),
  asset_type VARCHAR(50) NOT NULL,
  -- Naira: the platform ledger's unit. The API takes the amount in stroops
  -- (the escrow contract's unit) and stores the naira equivalent here.
  amount NUMERIC NOT NULL,
  fee_amount NUMERIC,
  seller_net_amount NUMERIC,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  contract_listing_id TEXT,
  escrow_tx_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_offers_status ON trade_offers(status);
CREATE INDEX IF NOT EXISTS idx_trade_offers_expires ON trade_offers(expires_at);

-- `transactions` is created by migration 009_transactions_and_payments.sql.
