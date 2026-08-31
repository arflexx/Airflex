ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(8) UNIQUE;

CREATE TABLE IF NOT EXISTS referrals (
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  rewarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (referrer_id <> referred_id)
);

CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id);
