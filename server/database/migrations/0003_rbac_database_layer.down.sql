-- =============================================================================
-- 0003 — RBAC database layer  (ROLLBACK)
-- =============================================================================
-- Reverses the RBAC persistence and the super_admin guards.
--
-- DATA SAFETY
--   `account_permission_overrides` and `account_scopes` hold AUTHORIZATION
--   CONFIGURATION, not derived cache: dropping them silently discards grants,
--   denies and scope limits that an administrator deliberately configured, and
--   the next deploy would come up with different (wider) effective permissions
--   than intended. The rollback therefore REFUSES when those tables hold rows,
--   unless QLS_RBAC_FORCE_DOWN is explicitly set — a deliberate, auditable act.
--
--   Removed structurally only when provably empty:
--     - the two RBAC tables (when empty)
--     - session revocation metadata columns (when never populated)
--   Never touched: teachers.permissions_version (a counter; harmless), any
--   business data, any account, any password.
-- =============================================================================

DO $$
DECLARE
  override_rows integer := 0;
  scope_rows    integer := 0;
  force         boolean := coalesce(current_setting('qls.rbac_force_down', true), '') = 'on';
BEGIN
  IF to_regclass('public.account_permission_overrides') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM account_permission_overrides' INTO override_rows;
  END IF;
  IF to_regclass('public.account_scopes') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM account_scopes' INTO scope_rows;
  END IF;

  IF (override_rows > 0 OR scope_rows > 0) AND NOT force THEN
    RAISE EXCEPTION
      '0003 down refused: authorization configuration would be destroyed '
      '(% permission override(s), % scope binding(s)). Dropping these tables would '
      'silently change every affected account''s effective permissions. '
      'Take a backup and re-run with QLS_RBAC_FORCE_DOWN=on if this is intended.',
      override_rows, scope_rows
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RAISE NOTICE '0003 down: proceeding (overrides=%, scopes=%, forced=%)',
    override_rows, scope_rows, force;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. drop the guards FIRST, so later changes to `teachers` cannot be blocked
--    by a trigger that is about to disappear.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_teachers_protect_last_super_admin ON teachers;
DROP TRIGGER IF EXISTS trg_teachers_guard_super_admin ON teachers;
DROP FUNCTION IF EXISTS rbac_protect_last_super_admin();
DROP FUNCTION IF EXISTS rbac_guard_super_admin();

-- ---------------------------------------------------------------------------
-- 2. drop the version-bump triggers and function
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_account_scopes_bump_permissions_version ON account_scopes;
DROP TRIGGER IF EXISTS trg_apo_bump_permissions_version ON account_permission_overrides;
DROP TRIGGER IF EXISTS trg_teachers_bump_permissions_version ON teachers;
DROP FUNCTION IF EXISTS rbac_bump_permissions_version();

-- ---------------------------------------------------------------------------
-- 3. drop the actor helper functions
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS rbac_actor_id();
DROP FUNCTION IF EXISTS rbac_actor_is_super_admin();

-- ---------------------------------------------------------------------------
-- 4. session revocation metadata — only when never used, so no audit trail is lost
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  used integer := 0;
BEGIN
  IF to_regclass('public.sessions') IS NULL THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sessions' AND column_name='revoked_at') THEN
    EXECUTE 'SELECT count(*) FROM sessions WHERE revoked_at IS NOT NULL' INTO used;
  END IF;

  IF used > 0 THEN
    RAISE NOTICE
      '0003 down: % session(s) carry revocation metadata; keeping revoked_at / '
      'revoke_reason / device columns so the audit trail is not destroyed.', used;
  ELSE
    ALTER TABLE sessions DROP COLUMN IF EXISTS device;
    ALTER TABLE sessions DROP COLUMN IF EXISTS revoke_reason;
    ALTER TABLE sessions DROP COLUMN IF EXISTS revoked_at;
    RAISE NOTICE '0003 down: session revocation columns removed (none were populated)';
  END IF;
END
$$;

ALTER TABLE sessions DROP COLUMN IF EXISTS permissions_version;

DROP INDEX IF EXISTS idx_sessions_teacher_active;
DROP INDEX IF EXISTS idx_sessions_revoked;

-- ---------------------------------------------------------------------------
-- 5. drop the RBAC configuration tables (reached only when empty or forced)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS account_scopes;
DROP TABLE IF EXISTS account_permission_overrides;

-- ---------------------------------------------------------------------------
-- 6. permissions_version on teachers is intentionally KEPT.
--    It is a monotonic counter holding no business meaning; removing it would
--    invalidate every session for no benefit, and keeping it lets a re-apply of
--    0003 be a clean no-op.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE '0003 down complete. teachers.permissions_version was kept on purpose.';
END
$$;
