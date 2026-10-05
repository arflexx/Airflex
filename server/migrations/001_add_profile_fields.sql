ALTER TABLE users
  ADD COLUMN IF NOT EXISTS alias VARCHAR(30),
  ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS virtual_account_number VARCHAR(64);

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_kyc_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_kyc_status_check
  CHECK (kyc_status IN ('unverified', 'pending', 'verified'));

CREATE INDEX IF NOT EXISTS users_kyc_status_idx ON users (kyc_status);
