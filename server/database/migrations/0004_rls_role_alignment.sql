-- =============================================================================
-- 0004 — RLS role alignment for non-platform (VPS / Docker) deployments
-- =============================================================================
-- THE PROBLEM THIS FIXES (found by running the app, not by reading it)
-- ---------------------------------------------------------------------
-- `@lark-apaas/nestjs-datapaas` SqlExecutionContextMiddleware runs on EVERY
-- request and issues, as a pre-statement:
--
--     SET LOCAL app.user_id  = '<userId>';
--     SET LOCAL ROLE         'anon_<roleSchema>' | 'authenticated_<roleSchema>'
--                                        | 'service_role_<roleSchema>';
--
-- where `<roleSchema>` comes from the `schema` query parameter of the database
-- connection string (empty when absent). Consequence for a standalone deploy:
--
--   1. The role the app adopts mid-request is NOT the connection role but
--      `anon_` / `authenticated_` / `service_role_`. Roles named exactly
--      `anon` / `authenticated` / `service_role` (which is what init.sql creates
--      policies for) are therefore never used.
--
--   2. `teachers`, `resources`, … have RLS ENABLED. A role with NO matching
--      policy sees ZERO ROWS — silently, without an error. Observed live:
--           SET LOCAL ROLE "anon_"; SELECT ... FROM teachers;  -->  0 rows
--      which made login answer "用户名或密码错误" for a correct password, and wrote
--      no audit row (the audit INSERT was blocked by the same mechanism).
--      A silent empty result is far worse than a 42704 error.
--
--   3. Therefore a standalone deployment must have policies that target the
--      SUFFIXED role names actually in use.
--
-- WHAT THIS MIGRATION DOES
--   Creates RLS policies for the empty-suffix role triple (`anon_`,
--   `authenticated_`, `service_role_`), mirroring exactly what init.sql already
--   defines for the unsuffixed names.
--
-- SAFETY / PORTABILITY
--   * On a platform deployment the suffixed roles for roleSchema='' do not exist,
--     so these policies are inert: PostgreSQL accepts a policy referencing a
--     non-existent role only if the role exists… **it does not**, so this file
--     CREATES the roles first when missing. On the platform, creating
--     `anon_` / `authenticated_` / `service_role_` is harmless because nothing
--     connects as them.
--   * `IF NOT EXISTS`-style guards on every step; re-running is a no-op.
--   * No table, row or column is modified. No policy is dropped.
--   * Platform deployments that use a non-empty roleSchema keep using
--     `fix-rls-policies.sql`; this file is additive and does not conflict.
--
-- AFTER APPLYING
--   The application connection role must be a MEMBER of these three roles,
--   because `SET LOCAL ROLE x` requires membership:
--       GRANT anon_           TO <app_db_role>;
--       GRANT authenticated_  TO <app_db_role>;
--       GRANT service_role_   TO <app_db_role>;
--   See DEPLOYMENT_PRODUCTION.md → "standalone database roles".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the role triple with an empty suffix
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon_', 'authenticated_', 'service_role_'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
      RAISE NOTICE '0004: created role %', r;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. privileges so the adopted role can actually run the application's queries
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon_', 'authenticated_', 'service_role_'] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
    -- future tables created by later migrations
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', r);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. policies mirroring init.sql, but for the suffixed role names
--    FOR INSERT, PostgreSQL permits ONLY a WITH CHECK clause — using
--    `USING (...) WITH CHECK (...)` raises
--      "only WITH CHECK expression allowed for INSERT"
--    which is why the INSERT policies below are written with WITH CHECK alone.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t          text;
  pol_exists boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'teachers', 'subject_permissions', 'resources',
    'review_records', 'audit_logs', 'sessions'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '0004: table % absent, skipping', t;
      CONTINUE;
    END IF;

    -- service_role_ : full access (platform convention)
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'rls0004_service_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
      'rls0004_service_' || t, t, 'service_role_');

    -- authenticated_ : full access (platform convention)
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'rls0004_auth_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
      'rls0004_auth_' || t, t, 'authenticated_');

    -- anon_ : read + the minimum the login flow needs
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'rls0004_anon_sel_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR SELECT TO %I USING (true)',
      'rls0004_anon_sel_' || t, t, 'anon_');

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'rls0004_anon_ins_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR INSERT TO %I WITH CHECK (true)',
      'rls0004_anon_ins_' || t, t, 'anon_');

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'rls0004_anon_upd_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR UPDATE TO %I USING (true) WITH CHECK (true)',
      'rls0004_anon_upd_' || t, t, 'anon_');
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. assertion: the roles must exist and each table must carry a policy they match
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing_roles text;
  missing_policy text := '';
  t text;
  n integer;
BEGIN
  SELECT string_agg(need.r, ', ')
    INTO missing_roles
  FROM unnest(ARRAY['anon_', 'authenticated_', 'service_role_']) AS need(r)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = need.r);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION '0004 failed: role(s) still missing: %', missing_roles;
  END IF;

  FOREACH t IN ARRAY ARRAY['teachers', 'sessions', 'audit_logs', 'resources'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    SELECT count(*) INTO n
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t
      AND 'anon_' = ANY(roles);
    IF n = 0 THEN
      missing_policy := missing_policy || t || ' ';
    END IF;
  END LOOP;

  IF missing_policy <> '' THEN
    RAISE EXCEPTION '0004 incomplete: no anon_ policy on: %', missing_policy;
  END IF;

  RAISE NOTICE '0004: RLS role alignment installed';
END
$$;
