-- Allow KYC rate-limit attempts to fall back to the request IP when there is
-- no authenticated user identity. Existing authenticated rows remain intact.
ALTER TABLE kyc_submission_attempts
    ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE kyc_submission_attempts
    ADD COLUMN IF NOT EXISTS ip_address INET;

ALTER TABLE kyc_submission_attempts
    ADD CONSTRAINT kyc_submission_attempts_has_identity
    CHECK (user_id IS NOT NULL OR ip_address IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_kyc_submission_attempts_ip_time
    ON kyc_submission_attempts (ip_address, requested_at DESC)
    WHERE user_id IS NULL;
