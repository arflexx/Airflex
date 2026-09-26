-- Migration 009: transactions ledger, fiat balances, payment events, and
-- seller_handle on trade_offers.
--
-- Consolidates several schema gaps that exist in the codebase but have no
-- prior migration:
--
--   1. `transactions` table — ledger for wallet debits/credits (referenced by
--      WalletService, tradeVerification, and the admin balance queries).
--   2. `wallets.fiat_balance` — running NGN fiat balance, updated by deposits
--      and withdrawals (referenced by WalletService.credit and wallet route).
--   3. `transactions.external_reference` — Paystack reference column needed by
--      paystackWebhookHandlers and the withdrawal route.
--   4. `transactions.display_user_id` — sentinel column for GDPR anonymisation
--      (written as "[deleted]" by the profile deletion flow).
--   5. `payment_events` table — idempotent Paystack event log used by the
--      applyChargeSuccess / applyDVAAssigned handlers.
--   6. `trade_offers.seller_handle` — denormalised display handle snapshotted
--      from users.display_handle at listing creation time so the marketplace
--      feed never needs a JOIN to users and the handle survives account
--      anonymisation.
--   7. `users.pending_deletion` / `users.scheduled_deletion_at` — columns
--      written by the GDPR deletion flow in profile.ts.
--   8. `users.opt_out_notifications` — respects the user preference checked by
--      NotificationService before dispatching SMS.
--   9. `users.role` — "user" | "admin" column used by the authorize middleware
--      and the admin dashboard.
--
-- All statements are idempotent (IF NOT EXISTS / IF NOT EXISTS / DO NOTHING).

-- ---------------------------------------------------------------------------
-- 1. transactions table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transactions (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trade_id           UUID         REFERENCES trade_offers(id) ON DELETE SET NULL,
    amount             NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
    direction          VARCHAR(6)   NOT NULL CHECK (direction IN ('credit', 'debit')),
    type               VARCHAR(32)  NOT NULL,
    external_reference TEXT,
    display_user_id    TEXT,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user
    ON transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_trade
    ON transactions (trade_id);

-- ---------------------------------------------------------------------------
-- 2. wallets.fiat_balance
-- ---------------------------------------------------------------------------

ALTER TABLE wallets
    ADD COLUMN IF NOT EXISTS fiat_balance NUMERIC(18,2) NOT NULL DEFAULT 0
        CHECK (fiat_balance >= 0);

-- ---------------------------------------------------------------------------
-- 3. payment_events table (idempotent Paystack event log)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_events (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    provider     VARCHAR(32)  NOT NULL,
    event_type   VARCHAR(64)  NOT NULL,
    reference    TEXT         NOT NULL,
    payload      JSONB        NOT NULL,
    status       VARCHAR(16)  NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'processed', 'unmatched', 'failed')),
    user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
    processed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT payment_events_provider_reference_unique UNIQUE (provider, reference)
);

CREATE INDEX IF NOT EXISTS idx_payment_events_reference
    ON payment_events (provider, reference);

CREATE INDEX IF NOT EXISTS idx_payment_events_status
    ON payment_events (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. trade_offers.seller_handle  (snapshotted at listing time)
-- ---------------------------------------------------------------------------

ALTER TABLE trade_offers
    ADD COLUMN IF NOT EXISTS seller_handle VARCHAR(32);

-- Backfill existing rows from the users table so the column is populated for
-- all pre-migration listings. New rows are set by the POST /trades route.
UPDATE trade_offers t
SET    seller_handle = u.display_handle
FROM   users u
WHERE  u.id = t.seller_id
  AND  t.seller_handle IS NULL;

-- ---------------------------------------------------------------------------
-- 5. users.pending_deletion / scheduled_deletion_at
-- ---------------------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pending_deletion       BOOLEAN      NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS scheduled_deletion_at  TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 6. users.opt_out_notifications
-- ---------------------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS opt_out_notifications BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- 7. users.role
-- ---------------------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin'));

CREATE INDEX IF NOT EXISTS idx_users_role
    ON users (role) WHERE role = 'admin';
