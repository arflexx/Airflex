-- reconcile_wallet_balance.sql
--
-- Verifies that the denormalised users.balance column (migration 013) equals
-- the historical net of the transactions ledger (credits minus debits) for
-- every user.
--
-- Returns one row per drifted user; an empty result means the ledger and the
-- denormalised balance agree. Safe to run against production (read-only).
--
--   psql "$DATABASE_URL" -f server/sql/reconcile_wallet_balance.sql

SELECT
    u.id                                  AS user_id,
    u.balance                             AS denormalized_balance,
    COALESCE(agg.ledger_balance, 0)       AS ledger_balance,
    u.balance - COALESCE(agg.ledger_balance, 0) AS drift,
    COALESCE(agg.entry_count, 0)          AS ledger_entries
FROM users u
LEFT JOIN (
    SELECT
        user_id,
        SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS ledger_balance,
        COUNT(*)                                                         AS entry_count
    FROM transactions
    GROUP BY user_id
) agg ON agg.user_id = u.id
WHERE u.balance IS DISTINCT FROM COALESCE(agg.ledger_balance, 0)
ORDER BY ABS(u.balance - COALESCE(agg.ledger_balance, 0)) DESC;

-- To repair drift after investigating its cause, run inside a transaction:
--
--   BEGIN;
--   UPDATE users u
--   SET    balance = COALESCE((
--            SELECT SUM(CASE WHEN t.direction = 'credit' THEN t.amount ELSE -t.amount END)
--            FROM   transactions t
--            WHERE  t.user_id = u.id
--          ), 0);
--   COMMIT;
