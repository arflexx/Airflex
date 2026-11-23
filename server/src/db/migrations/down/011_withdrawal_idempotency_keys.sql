-- Reverses migration 011_withdrawal_idempotency_keys.sql
-- (run by `pnpm db:migrate:rollback`).

DROP INDEX IF EXISTS idx_withdrawal_idempotency_keys_created;
DROP TABLE IF EXISTS withdrawal_idempotency_keys;
