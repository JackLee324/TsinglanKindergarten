-- =============================================================================
-- 0005 — tighten RLS writes  (ROLLBACK)
-- =============================================================================
-- Restores the pre-0005 privilege state: full table-level UPDATE on `teachers`
-- and `sessions` for the anonymous role, and read/write on `audit_logs`.
--
-- ⚠ THIS ROLLBACK RE-OPENS A PRIVILEGE-ESCALATION PATH.
--   After it runs, the anonymous database role can again:
--     * UPDATE teachers.password_hash / roles / status on ANY row;
--     * un-revoke any session;
--     * UPDATE and DELETE audit log rows.
--   It exists so the change can be reversed deliberately during an incident; if
--   it is applied, treat the database as compromised-capable and re-run `up` as
--   soon as possible.
--
-- No table, row or column is dropped and no business data is modified.
-- =============================================================================

DO $$
DECLARE
  r text;
  roles_found text[] := ARRAY[]::text[];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'anon_'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      roles_found := roles_found || r;
    END IF;
  END LOOP;

  IF array_length(roles_found, 1) IS NULL THEN
    RAISE NOTICE '0005 down: no anonymous role present, nothing to revert';
    RETURN;
  END IF;

  FOREACH r IN ARRAY roles_found LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON teachers TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO %I', r);
    RAISE NOTICE '0005 down: restored broad privileges for role % (escalation path RE-OPENED)', r;
  END LOOP;
END
$$;

-- the narrow per-role policies are left in place: they are row-permissive and
-- therefore harmless once the column grants above are restored.
