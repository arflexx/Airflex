-- Supporting tables for the Paystack webhook (#9) and OTP rate limiting (#7).
--
-- This repo has no migration runner, so the file is applied manually or by
-- whatever bootstraps the schema. Every statement is idempotent, so re-running
-- it is safe.

-- ---------------------------------------------------------------------------
-- Webhook event log (#9)
-- ---------------------------------------------------------------------------
--
-- Doubles as the audit record and the idempotency key store. Keeping both in
-- one table is deliberate: a separate dedupe set could drift from the log,
-- and then "did we process this?" has two answers.

CREATE TABLE IF NOT EXISTS payment_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      VARCHAR(32)  NOT NULL,
    event_type    VARCHAR(64)  NOT NULL,
    reference     VARCHAR(128),
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    payload       JSONB        NOT NULL,
    -- processing | processed | duplicate | unmatched | ignored | failed
    status        VARCHAR(24)  NOT NULL DEFAULT 'processing',
    error         TEXT,
    received_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processed_at  TIMESTAMPTZ
);

-- THE idempotency guarantee. The handler relies on ON CONFLICT against this
-- index rather than a check-then-insert, so that two concurrent deliveries of
-- the same event are arbitrated by the database instead of racing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_provider_reference
    ON payment_events (provider, reference)
    WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events (status);
CREATE INDEX IF NOT EXISTS idx_payment_events_user ON payment_events (user_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_received ON payment_events (received_at DESC);

-- ---------------------------------------------------------------------------
-- OTP request log (#7)
-- ---------------------------------------------------------------------------
--
-- One row per request, counted over a sliding window. Rows rather than a
-- counter because a sliding window needs timestamps: a fixed counter lets
-- someone send 5 at 10:59 and 5 more at 11:00.

CREATE TABLE IF NOT EXISTS otp_requests (
    id           BIGSERIAL PRIMARY KEY,
    phone        VARCHAR(32)  NOT NULL,
    requested_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The limiter's only query is "count rows for this phone since T".
CREATE INDEX IF NOT EXISTS idx_otp_requests_phone_time
    ON otp_requests (phone, requested_at DESC);

-- ---------------------------------------------------------------------------
-- Columns the deposit path expects
-- ---------------------------------------------------------------------------

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS external_reference VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_transactions_external_reference
    ON transactions (external_reference)
    WHERE external_reference IS NOT NULL;

ALTER TABLE wallets
    ADD COLUMN IF NOT EXISTS fiat_balance NUMERIC(20, 2) NOT NULL DEFAULT 0;

-- Admin role flag, used by requireAdmin (#23).
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'user';
