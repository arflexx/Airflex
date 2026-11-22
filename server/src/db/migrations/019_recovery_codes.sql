-- Recovery codes for 2FA backup (issue #108).
--
-- At OTP signup, 8 single-use 16-character recovery codes are generated,
-- bcrypt-hashed (cost 12), and stored. The plaintext codes are shown to the
-- user exactly once and never stored.
--
-- Redemption looks up a code by SHA-256(code), verifies with bcrypt.compare(),
-- and marks it used inside a transaction so each code can only be redeemed once.
--
-- Reverse: down/019_recovery_codes.sql

CREATE TABLE IF NOT EXISTS recovery_codes (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_sha256     CHAR(64)     NOT NULL,  -- SHA-256 of the plaintext code for deterministic lookup
    code_hash       TEXT         NOT NULL,  -- bcrypt hash (cost 12) for verification
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index for fast lookup by SHA-256 during redemption.
CREATE INDEX IF NOT EXISTS idx_recovery_codes_sha256
    ON recovery_codes(code_sha256);

-- Index for counting remaining codes per user.
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_used
    ON recovery_codes(user_id, used_at) WHERE used_at IS NULL;
