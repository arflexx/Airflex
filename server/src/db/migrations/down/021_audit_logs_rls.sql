-- Reverses migration 021_audit_logs_rls.sql.
--
-- Removes the RLS policies and disables Row-Level Security on audit_logs.
-- Reverts privileges to allow the current user UPDATE and DELETE again (as
-- they were before the migration).  Does NOT drop the retention role because
-- other objects may depend on it; a DBA should drop it manually if required.

DROP POLICY IF EXISTS audit_logs_retention_delete ON audit_logs;
DROP POLICY IF EXISTS audit_logs_insert          ON audit_logs;
DROP POLICY IF EXISTS audit_logs_select          ON audit_logs;

ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;

-- Restore broad privileges on the table so the app role can operate without
-- RLS (matches the state before this migration).
GRANT UPDATE, DELETE ON audit_logs TO PUBLIC;
