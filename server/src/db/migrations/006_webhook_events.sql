-- Webhook ingestion queue (issue #118). Raw Paystack payloads are stored before
-- async processing so transient DB failures can be retried or replayed.

CREATE TABLE IF NOT EXISTS webhook_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider     VARCHAR(32)  NOT NULL,
    event_type   VARCHAR(64)  NOT NULL,
    payload      JSONB        NOT NULL,
    processed_at TIMESTAMPTZ,
    status       VARCHAR(16)  NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processed', 'failed')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
    ON webhook_events (status, created_at DESC);
