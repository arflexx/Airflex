-- `users.otp_pin_id` / `users.otp_expires_at` support the Termii pin-based
-- OTP flow in routes/auth.ts (POST /request-otp stores the Termii pinId and
-- a 10-minute expiry; POST /verify-otp reads and then clears them). Neither
-- column had a migration — a pre-existing gap that blocked building a real
-- integration test for the signup flow covered by issue #79, since a freshly
-- migrated database (000 through 017) had no otp columns for auth.ts to
-- read or write.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS otp_pin_id TEXT;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
