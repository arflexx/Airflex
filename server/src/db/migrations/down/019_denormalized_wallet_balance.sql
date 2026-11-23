-- Reverses migration 019_denormalized_wallet_balance.sql
-- (run by `pnpm db:migrate:rollback`).

ALTER TABLE users DROP COLUMN IF EXISTS balance;
