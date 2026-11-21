-- Constrain users.kyc_status to the three supported states (issue #74).
--
-- The column already exists (added in 002_kyc.sql as VARCHAR(20) DEFAULT
-- 'unverified') and every code path already only ever writes 'unverified',
-- 'pending' or 'verified' (see routes/kyc.ts, routes/profile.ts,
-- routes/trades.ts). This migration makes that contract explicit at the
-- database level with a CHECK constraint, without changing the column's
-- wire type (so existing rows and queries keep working unchanged).
ALTER TABLE users
    ALTER COLUMN kyc_status SET DEFAULT 'unverified';

ALTER TABLE users
    ADD CONSTRAINT users_kyc_status_check
    CHECK (kyc_status IN ('unverified', 'pending', 'verified'));
