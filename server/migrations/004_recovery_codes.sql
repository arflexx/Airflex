-- 2FA recovery flow (issue #108).
--
-- recovery_codes: 8 single-use backup codes issued at the end of OTP signup.
--   - code_sha256 is a deterministic SHA-256 of the plaintext code. It is the
--     lookup key so a redemption can find its row without comparing bcrypt
--     hashes against every code in the table.
--   - code_hash is the bcrypt hash of the plaintext code and is what gets
--     verified on redemption.
--   - A row is invalidated by setting used_at; reusing a redeemed code returns
--     401.
--
-- recovery_attempts: one row per failed redemption, keyed by client IP, used
-- to enforce a 5-failures-per-hour lockout (HTTP 429).

CREATE TABLE IF NOT EXISTS recovery_codes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_sha256   CHAR(64) NOT NULL UNIQUE,
    code_hash     TEXT NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Queried on signup ("does this user have any codes?") and on status checks
-- ("how many unused codes remain?").
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user
    ON recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS recovery_attempts (
    id            BIGSERIAL PRIMARY KEY,
    ip            VARCHAR(64) NOT NULL,
    attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The limiter's only query is "count failed attempts for this IP since T".
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_ip_time
    ON recovery_attempts (ip, attempted_at DESC);
