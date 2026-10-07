-- Token revocation support for session JWTs.
--
-- POST /api/v1/auth/verify-otp issues a 7-day JWT with no way to invalidate
-- it before expiry — a stolen token stayed valid for up to 7 days no matter
-- what the account owner did. `token_version` gives us that: every session
-- JWT carries the version that was current when it was issued, and
-- POST /api/v1/auth/revoke bumps this column, immediately invalidating every
-- token issued before the bump (see middleware/authenticate.ts).
--
-- Idempotent — safe to re-run.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
