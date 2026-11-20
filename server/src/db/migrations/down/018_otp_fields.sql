ALTER TABLE users
    DROP COLUMN IF EXISTS otp_pin_id;

ALTER TABLE users
    DROP COLUMN IF EXISTS otp_expires_at;
