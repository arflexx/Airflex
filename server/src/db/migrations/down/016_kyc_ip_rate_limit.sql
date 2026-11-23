-- Reverses migration 016_kyc_ip_rate_limit.sql
-- (run by `pnpm db:migrate:rollback`).
-- IP-only attempt rows (no user_id) cannot satisfy the restored NOT NULL
-- constraint, so they are removed first.

DROP INDEX IF EXISTS idx_kyc_submission_attempts_ip_time;

ALTER TABLE kyc_submission_attempts
    DROP CONSTRAINT IF EXISTS kyc_submission_attempts_has_identity;

DELETE FROM kyc_submission_attempts WHERE user_id IS NULL;

ALTER TABLE kyc_submission_attempts
    ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE kyc_submission_attempts
    DROP COLUMN IF EXISTS ip_address;
