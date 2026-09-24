-- =============================================================================
-- 0004 — RLS role alignment  (ROLLBACK)
-- =============================================================================
-- Removes only the policies this migration created (identified by the
-- `rls0004_` name prefix). It does NOT drop the roles and does NOT touch
-- privileges: on a standalone deployment the application depends on adopting
-- `anon_` / `authenticated_` / `service_role_` on every request
-- (SqlExecutionContextMiddleware), so dropping them would make every request
-- fail. Reverse that deliberately, by hand, with a backup.
--
-- No table, row or column is modified.
-- =============================================================================

DO $$
DECLARE
  pol record;
  dropped integer := 0;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND policyname LIKE 'rls0004\_%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
    dropped := dropped + 1;
  END LOOP;

  RAISE NOTICE '0004 down: dropped % policy(ies)', dropped;
  RAISE NOTICE '0004 down: roles anon_ / authenticated_ / service_role_ were KEPT on '
               'purpose — the application adopts them per request and cannot run without them.';
END
$$;
