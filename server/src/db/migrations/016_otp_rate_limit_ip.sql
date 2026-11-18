-- Track OTP requests by source IP as well as identifier.
-- Existing records remain valid and are excluded from IP counts.

CREATE TABLE IF NOT EXISTS otp_requests (
    id           BIGSERIAL PRIMARY KEY,
    phone        VARCHAR(320) NOT NULL,
    ip           VARCHAR(64),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE otp_requests
    ADD COLUMN IF NOT EXISTS ip VARCHAR(64);

ALTER TABLE otp_requests
    ALTER COLUMN phone TYPE VARCHAR(320);

CREATE INDEX IF NOT EXISTS idx_otp_requests_phone_time
    ON otp_requests (phone, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_requests_ip_time
    ON otp_requests (ip, requested_at DESC);