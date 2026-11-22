-- Reverses migration 015_kyc_expiry_notifications.sql
-- (run by `pnpm db:migrate:rollback`).

DROP TABLE IF EXISTS kyc_expiry_notifications;
ALTER TABLE users DROP COLUMN IF EXISTS kyc_document_expiry;
