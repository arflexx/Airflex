DROP INDEX IF EXISTS idx_otp_requests_ip_time;

ALTER TABLE otp_requests
    DROP COLUMN IF EXISTS ip;