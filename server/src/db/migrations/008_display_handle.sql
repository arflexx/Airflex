-- Issue #330: give every user an opaque display handle so public trade
-- listings can show a seller without exposing any part of their UUID.
--
-- The handle is derived from the (already random) user id, so it is stable for
-- a given user while revealing nothing about the id. MD5 is used purely as a
-- fast, uniform mixing function for a non-secret label — not as a security
-- primitive. Keep the expression in sync with `generateDisplayHandle` in
-- src/utils/displayHandle.ts, which assigns the same value at registration.

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_handle VARCHAR(32);

-- Backfill users created before the column existed.
UPDATE users
   SET display_handle = '@airflex_' || substr(md5(id::text), 1, 4)
 WHERE display_handle IS NULL;

-- Every user must carry a handle: both the backfill above and the
-- registration path cover every row, so this can be enforced going forward.
ALTER TABLE users ALTER COLUMN display_handle SET NOT NULL;
