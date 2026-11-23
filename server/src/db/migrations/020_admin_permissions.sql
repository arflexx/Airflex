-- Granular admin permissions (issue #674).
--
-- Adds a JSON array column `admin_permissions` to the users table to store
-- granular permissions for admin users. This replaces the binary is_admin flag
-- with least-privilege access control.
--
-- Existing admins with role='admin' or role='super_admin' are granted all
-- permissions to maintain backward compatibility.
--
-- Reverse: down/020_admin_permissions.sql

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS admin_permissions JSONB DEFAULT '[]'::jsonb;

-- Grant all permissions to existing admins for backward compatibility.
-- This ensures existing admin accounts continue to work after the migration.
UPDATE users
SET admin_permissions = '[
  "queues.view",
  "trades.view",
  "trades.resolve",
  "users.view",
  "users.kyc_approve",
  "fraud_flags.view",
  "fraud_flags.review",
  "webhooks.view",
  "webhooks.replay",
  "audit_logs.view"
]'::jsonb
WHERE role IN ('admin', 'super_admin');

-- Add index for efficient permission checks (GIN index for JSONB array containment).
CREATE INDEX IF NOT EXISTS idx_users_admin_permissions
    ON users USING GIN (admin_permissions);
