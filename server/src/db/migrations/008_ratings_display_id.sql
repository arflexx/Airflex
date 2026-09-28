-- Migration 008: Survive account anonymisation in ratings (issue #362).
--
-- Problem: the LATERAL subquery in GET /api/v1/trades joins on
--   ratings.reviewee_id = trade_offers.seller_id
-- When a seller is anonymised the UUID in users is preserved but the profile
-- row is scrubbed, so the join still works — HOWEVER, the acceptance criteria
-- for #362 require joining on a stable display handle / anonymised hash that
-- is written to the rating row at creation time and is never altered by the
-- anonymisation job.  This makes ratings completely decoupled from the live
-- users table.
--
-- Changes:
--   1. Add reviewee_display_id (TEXT NOT NULL) to ratings.
--   2. Backfill existing rows from the users table (phone hash for deleted
--      accounts, plain id cast to text as a safe fallback for active ones).
--   3. Add a NOT NULL constraint once backfilled.
--   4. Replace the old index with one on the new column.

-- Step 1 – add the column as nullable first so the backfill can run.
ALTER TABLE ratings
  ADD COLUMN IF NOT EXISTS reviewee_display_id TEXT;

-- Step 2 – backfill.
-- For accounts that have been hard-anonymised the phone will already be a
-- "deleted:<sha256>" hash written by the anonymisation job; use that directly.
-- For every other row fall back to the UUID cast as text so the column is
-- never null after this statement.
UPDATE ratings r
SET    reviewee_display_id = COALESCE(
         NULLIF(u.phone, ''),   -- non-empty phone → use as display id
         u.id::text             -- deleted/tombstoned rows → use UUID text
       )
FROM   users u
WHERE  u.id = r.reviewee_id
  AND  r.reviewee_display_id IS NULL;

-- Catch any orphaned rating rows whose users row was already hard-deleted
-- (ON DELETE CASCADE would have removed them, but guard just in case).
UPDATE ratings
SET    reviewee_display_id = reviewee_id::text
WHERE  reviewee_display_id IS NULL;

-- Step 3 – enforce NOT NULL now that every row has a value.
ALTER TABLE ratings
  ALTER COLUMN reviewee_display_id SET NOT NULL;

-- Step 4 – replace the old index so the LATERAL join stays fast.
DROP INDEX IF EXISTS idx_ratings_reviewee;

CREATE INDEX IF NOT EXISTS idx_ratings_reviewee_display
  ON ratings (reviewee_display_id, created_at DESC);
