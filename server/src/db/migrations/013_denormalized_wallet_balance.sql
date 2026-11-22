-- Migration 013: denormalised ledger balance on users.
--
-- Balance queries (admin user list / user detail) previously summed every
-- `transactions` row for a user on each request. That cost grows linearly with
-- ledger size. `users.balance` now holds the running net of the ledger
-- (credits minus debits) and is moved by WalletService in the same database
-- transaction as each ledger insert, so the two can never drift apart on a
-- committed write.
--
-- Not constrained to >= 0: a buyer's ledger is debited at settlement for funds
-- that were escrowed on-chain, so the net can legitimately go negative.
--
-- Verify consistency at any time with server/sql/reconcile_wallet_balance.sql.
--
-- Idempotent: safe to re-run.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS balance NUMERIC(18,2) NOT NULL DEFAULT 0;

-- Backfill from the existing ledger. Only rows that disagree are touched, so a
-- re-run on an already-consistent table is a no-op.
UPDATE users u
SET    balance = agg.net
FROM (
    SELECT user_id,
           SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS net
    FROM   transactions
    GROUP  BY user_id
) agg
WHERE  agg.user_id = u.id
  AND  u.balance IS DISTINCT FROM agg.net;
