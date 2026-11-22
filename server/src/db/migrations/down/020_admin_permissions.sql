-- Reverse migration 020: Drop admin_permissions column and index.

DROP INDEX IF EXISTS idx_users_admin_permissions;
ALTER TABLE users DROP COLUMN IF EXISTS admin_permissions;
