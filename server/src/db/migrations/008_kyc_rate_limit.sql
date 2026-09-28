-- Rate limiting for KYC submissions.
--
-- POST /api/kyc/submit had no rate limit, so a user (or a script running as
-- one) could resubmit KYC documents unlimited times. One row per submission
-- attempt, counted over a sliding window — mirrors the otp_requests table in
-- sql/002_webhooks_and_rate_limit.sql. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS kyc_submission_attempts (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The limiter's only query is "count rows for this user since T".
CREATE INDEX IF NOT EXISTS idx_kyc_submission_attempts_user_time
    ON kyc_submission_attempts (user_id, requested_at DESC);
