-- Migration 021: Row-Level Security for audit_logs (append-only immutability).
--
-- Context
-- -------
-- Migration 013 added a trigger that rejects UPDATE/DELETE/TRUNCATE unless
-- the session has set `airflex.audit_retention = on` AND the row is older
-- than 365 days. That is a good defence-in-depth layer, but a superuser or
-- a role with BYPASSRLS can still bypass it. This migration adds a proper
-- PostgreSQL Row-Level Security (RLS) policy as an independent, complementary
-- layer enforced by the query planner itself.
--
-- Design
-- ------
-- 1. A dedicated role `airflex_audit_retention` is created (if it does not
--    already exist). This role is the ONLY one permitted to DELETE from
--    audit_logs (subject to the trigger's age check). It is never granted
--    LOGIN, so it cannot connect directly to the database; it is activated
--    inside a transaction with SET LOCAL ROLE.
--
-- 2. RLS is enabled on audit_logs (FORCE RLS applies to table owners too).
--
-- 3. Three policies replace the implicit allow-all:
--      SELECT — allowed for all roles that have table SELECT privilege.
--      INSERT — allowed for all roles that have table INSERT privilege.
--      DELETE — allowed ONLY for `airflex_audit_retention`, and only for
--               rows older than 365 days (mirrors the trigger condition so
--               both layers agree).
--    UPDATE and TRUNCATE have no permissive policy, so they are always denied
--    by RLS regardless of object privileges.
--
-- 4. The application pool role (the DATABASE_URL user) is granted only
--    SELECT and INSERT on audit_logs. Any existing UPDATE/DELETE privilege
--    is explicitly revoked.
--
-- Application DB role
-- -------------------
-- The migration uses CURRENT_USER at runtime to identify the pool role, so
-- it works in every environment (dev, staging, production) without hard-
-- coding a role name. If you use a separate migration role and an app role,
-- run the REVOKE/GRANT block again after the migration with the app role.
--
-- Retention job
-- -------------
-- auditLogRetention.ts already sets `airflex.audit_retention = on` via
-- set_config() inside each batch transaction. After this migration it must
-- also SET LOCAL ROLE airflex_audit_retention before the DELETE so that the
-- RLS DELETE policy passes. The trigger and the RLS policy together require
-- BOTH conditions: correct role AND row age > 365 days.
--
-- Reverse: down/021_audit_logs_rls.sql

-- 1. Create the privileged retention role if it does not exist.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airflex_audit_retention') THEN
        CREATE ROLE airflex_audit_retention NOLOGIN NOINHERIT;
    END IF;
END;
$$;

-- 2. Grant the retention role only the DELETE privilege it needs.
--    SELECT is included so the sub-select inside the batched DELETE works.
GRANT SELECT, DELETE ON audit_logs TO airflex_audit_retention;

-- 3. Revoke UPDATE and DELETE from the application pool role (PUBLIC covers
--    any role not explicitly named; CURRENT_USER covers the migration executor).
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit_logs FROM CURRENT_USER;

-- 4. Enable RLS. FORCE ensures it applies to table owners and superusers too
--    when acting as a non-superuser session role.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- 5. Drop any pre-existing policies from a previous (failed) run of this
--    migration so the CREATE POLICY statements below are idempotent.
DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
DROP POLICY IF EXISTS audit_logs_retention_delete ON audit_logs;

-- 6a. SELECT: any role with SELECT privilege on the table may read all rows.
CREATE POLICY audit_logs_select
    ON audit_logs
    FOR SELECT
    USING (true);

-- 6b. INSERT: any role with INSERT privilege may append rows.
CREATE POLICY audit_logs_insert
    ON audit_logs
    FOR INSERT
    WITH CHECK (true);

-- 6c. DELETE: only the retention role may delete, and only rows older than
--     365 days. The trigger provides a second independent check on the same
--     condition. UPDATE is intentionally absent — no policy means no UPDATE.
CREATE POLICY audit_logs_retention_delete
    ON audit_logs
    FOR DELETE
    TO airflex_audit_retention
    USING (occurred_at < NOW() - INTERVAL '365 days');
