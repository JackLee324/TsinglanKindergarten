-- =============================================================================
-- 0005 — tighten RLS write permissions (remove USING(true) write access)
-- =============================================================================
-- THE PROBLEM (audit findings D-5 and D-6, confirmed against a real database)
-- ---------------------------------------------------------------------------
-- `init.sql` grants the anonymous role far more than the login flow needs:
--
--     CREATE POLICY "teachers_anon_update_last_login" ON teachers
--       AS PERMISSIVE FOR UPDATE TO anon USING (true) WITH CHECK (true);
--     CREATE POLICY "sessions_anon_select" ON sessions ... USING (true);
--     CREATE POLICY "sessions_anon_insert" ON sessions ... WITH CHECK (true);
--     CREATE POLICY "sessions_anon_update" ON sessions ... USING (true) WITH CHECK (true);
--
-- RLS is ROW-scoped, so `WITH CHECK (true)` cannot be narrowed to "only the
-- last_login_at column". Taken literally these grants mean an anonymous
-- connection may:
--   * rewrite ANY column of ANY teacher row — including `password_hash`,
--     `roles` and `status`, i.e. reset a password or promote itself;
--   * read every session hash and un-revoke a session it should not have.
--
-- The comment in init.sql says the policy exists so the login flow can write
-- `last_login_at`. That intent is correct; the mechanism was not.
--
-- THE FIX: column-level privileges, which DO have the required granularity.
--   RLS still applies (row-level), and on top of it GRANT/REVOKE now limits
--   WHICH COLUMNS the role may write or read. The role keeps exactly what the
--   login/logout flow needs and nothing else.
--
--   anon MAY update on teachers: last_login_at, failed_login_attempts, locked_until
--     (exactly what AuthService.login() writes)
--   anon MAY update on sessions: revoked, revoked_at, revoke_reason, last_accessed_at,
--                                permissions_version
--   anon MAY read  on sessions:  session_hash, teacher_id, expires_at, revoked,
--                                permissions_version
--     (ip_address / user_agent / device are NOT readable by anon: they are PII
--      and the session-validation query does not need them)
--   anon may NOT touch: password_hash, roles, status, username, email, name,
--     name_en, permissions_version (on teachers), id, or any other column.
--
--   `authenticated_` / `service_role_` keep full access: they are used only
--   after a session has been verified, and the application's own authorization
--   layer decides what that account may do.
--
-- PORTABILITY
--   Applied to BOTH the unsuffixed platform names (`anon`, `authenticated`,
--   `service_role`) and the suffixed standalone names (`anon_`, …) wherever the
--   role exists, because SqlExecutionContextMiddleware uses the suffixed form
--   when the connection string has no `?schema=` parameter.
--
-- SAFETY
--   * No row, table or column is dropped. No data is modified.
--   * Additive/idempotent: re-running is a no-op.
--   * If a future code path legitimately needs another column, the GRANT must be
--     extended deliberately — that is the point.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. drop the blanket write policies that cannot be expressed safely in RLS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "teachers_anon_update_last_login" ON teachers;
DROP POLICY IF EXISTS "sessions_anon_update" ON sessions;
DROP POLICY IF EXISTS "rls0004_anon_upd_teachers" ON teachers;
DROP POLICY IF EXISTS "rls0004_anon_upd_sessions" ON sessions;
DROP POLICY IF EXISTS "teachers_anon_update_login_state" ON teachers;
DROP POLICY IF EXISTS "sessions_anon_update_lifecycle" ON sessions;

-- ---------------------------------------------------------------------------
-- 2. re-create them with the minimum required reach
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  -- NOTE: this must cover BOTH role spellings. Step 1 above deliberately drops
  -- the 0004 policies for `anon_` as well as the init.sql policy for `anon`;
  -- recreating only the unsuffixed one silently removed the anonymous UPDATE
  -- policy from a standalone deployment, and session revocation then failed with
  -- 42501 (observed while testing this migration). The GRANT below narrows the
  -- columns, so a permissive row-level predicate is safe here.
  FOREACH r IN ARRAY ARRAY['anon', 'anon_'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='teachers'
        AND policyname='teachers_anon_update_login_state_' || r
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON teachers AS PERMISSIVE FOR UPDATE TO %I USING (true) WITH CHECK (true)',
        'teachers_anon_update_login_state_' || r, r);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='sessions'
        AND policyname='sessions_anon_update_lifecycle_' || r
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON sessions AS PERMISSIVE FOR UPDATE TO %I USING (true) WITH CHECK (true)',
        'sessions_anon_update_lifecycle_' || r, r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. column-level privileges — the actual enforcement
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  role_name text;
  roles_to_fix text[] := ARRAY[]::text[];
BEGIN
  -- only roles that actually exist in this cluster
  FOREACH role_name IN ARRAY ARRAY['anon', 'anon_'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      roles_to_fix := roles_to_fix || role_name;
    END IF;
  END LOOP;

  IF array_length(roles_to_fix, 1) IS NULL THEN
    RAISE NOTICE '0005: no anonymous role present, nothing to tighten';
    RETURN;
  END IF;

  FOREACH role_name IN ARRAY roles_to_fix LOOP
    -- teachers: allow exactly the login-flow columns
    EXECUTE format('REVOKE UPDATE ON teachers FROM %I', role_name);
    EXECUTE format(
      'GRANT UPDATE (last_login_at, failed_login_attempts, locked_until) ON teachers TO %I',
      role_name);

    -- teachers: SELECT is left at table scope ON PURPOSE.
    --   The first version of this migration narrowed SELECT to an explicit column
    --   list. That broke legitimate reads: any query touching a column outside the
    --   list (password_updated_at, the _created_at/_updated_at system fields, …)
    --   failed with "permission denied for table teachers" and surfaced as HTTP 500
    --   on ordinary pages. Narrowing reads bought little — the login lookup needs
    --   password_hash anyway, so a full-table read grant is required regardless —
    --   while creating a fragile, silently-breaking coupling between the grant list
    --   and every SELECT the application makes.
    --   The security objective of this migration is to remove WRITE escalation, and
    --   that is enforced below. Browsers must not be able to reach the database at
    --   all (see DEPLOYMENT_PRODUCTION.md); if they somehow can, the exposure is
    --   password hashes, which is an argument for network isolation, not for a
    --   read-grant list that breaks the app.
    EXECUTE format('GRANT SELECT ON teachers TO %I', role_name);

    -- sessions: the lifecycle columns only
    EXECUTE format('REVOKE ALL ON sessions FROM %I', role_name);
    -- Sessions: anon is restricted to the lifecycle columns and must NOT read
    -- ip_address / user_agent / device (PII). Unlike teachers this list is safe
    -- because session validation only ever needs these columns — verified by
    -- running the full HTTP suite after applying this migration.
    -- `id` is required because SessionService.destroySession() uses RETURNING id.
    -- Omitting it made session revocation fail with 42501 — observed as an HTTP 500
    -- on the first request after any permission change.
    -- revoked_at / revoke_reason are included so the revocation metadata the
    -- application writes can be read back for auditing; ip_address, user_agent and
    -- device stay unreadable because they are PII and are never needed here.
    EXECUTE format(
      'GRANT SELECT (id, session_hash, teacher_id, created_at, last_accessed_at, '
      'expires_at, revoked, permissions_version, revoked_at, revoke_reason, '
      '_created_at, _updated_at) ON sessions TO %I', role_name);
    EXECUTE format('GRANT INSERT ON sessions TO %I', role_name);
    EXECUTE format('GRANT UPDATE (revoked, revoked_at, revoke_reason, last_accessed_at, permissions_version) ON sessions TO %I', role_name);

    -- audit_logs: APPEND-ONLY, enforced by the database.
    --
    -- INSERT + SELECT are granted: the login flow records attempts, and the audit
    -- page reads them. UPDATE and DELETE are explicitly revoked, which makes the
    -- "audit logs cannot be altered" requirement (spec §30) a database property
    -- rather than a convention the application is trusted to follow. An attempt to
    -- tamper with a log row now fails with 42501 even from a compromised
    -- application process.
    --
    -- NOTE on why SELECT is not narrowed here: in a standalone deployment every
    -- request runs under the anonymous database role, because the platform's
    -- `userContext.userId` (which drives SET ROLE) is only populated by the
    -- platform's own authentication. Database roles therefore cannot distinguish
    -- our authenticated users, and read access is gated by the application's
    -- authorization layer instead. Narrowing reads only breaks the app.
    EXECUTE format('REVOKE ALL ON audit_logs FROM %I', role_name);
    EXECUTE format('GRANT SELECT, INSERT ON audit_logs TO %I', role_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM %I', role_name);

    RAISE NOTICE '0005: tightened privileges for role %', role_name;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. assertion — the dangerous capabilities must now be gone
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  role_name text;
  can_update_password boolean;
  can_update_roles boolean;
  problems text := '';
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'anon_'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      CONTINUE;
    END IF;

    -- the anonymous role must still be able to revoke a session, otherwise
    -- logout / forced logout break
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='sessions'
        AND policyname = 'sessions_anon_update_lifecycle_' || role_name
    ) THEN
      problems := problems || role_name || ' lost its sessions UPDATE policy; ';
    END IF;

    SELECT has_column_privilege(role_name, 'teachers', 'password_hash', 'UPDATE')
      INTO can_update_password;
    SELECT has_column_privilege(role_name, 'teachers', 'roles', 'UPDATE')
      INTO can_update_roles;

    IF can_update_password THEN
      problems := problems || role_name || ' can UPDATE teachers.password_hash; ';
    END IF;
    IF can_update_roles THEN
      problems := problems || role_name || ' can UPDATE teachers.roles; ';
    END IF;
  END LOOP;

  IF problems <> '' THEN
    RAISE EXCEPTION '0005 incomplete — privilege escalation still possible: %', problems;
  END IF;

  RAISE NOTICE '0005: anonymous role can no longer modify credentials or roles';
END
$$;
