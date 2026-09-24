-- =============================================================================
-- 0001 — schema baseline alignment  (ROLLBACK)
-- =============================================================================
-- ROLLBACK PHILOSOPHY FOR THIS PROJECT
--   A rollback must reverse STRUCTURE, never DATA. Several columns introduced by
--   0001 hold security-critical material (`password_hash`) or account state
--   (`locked_until`, `failed_login_attempts`). Dropping them would silently
--   destroy every account's credentials.
--
--   This file therefore drops only objects that carry no data — indexes — and
--   refuses to drop the columns unless they are provably empty. If a genuine
--   full reversal is required, it must be done deliberately, with a backup
--   taken first (see DEPLOYMENT_PRODUCTION.md and DISASTER_RECOVERY.md).
--
--   The composite type `user_profile` and the roles created in step 1 and 2 are
--   deliberately NOT dropped: on a platform-provisioned database they pre-existed
--   and are owned by the platform; dropping them could break unrelated objects.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. refuse to proceed if the auth columns hold any data
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  populated bigint;
BEGIN
  IF to_regclass('public.teachers') IS NULL THEN
    RAISE NOTICE '0001 down: teachers does not exist, nothing to check';
    RETURN;
  END IF;

  EXECUTE $q$
    SELECT count(*) FROM teachers
    WHERE password_hash IS NOT NULL
       OR username IS NOT NULL
       OR must_change_password IS DISTINCT FROM false
       OR COALESCE(failed_login_attempts, 0) <> 0
       OR locked_until IS NOT NULL
       OR password_updated_at IS NOT NULL
  $q$ INTO populated;

  IF populated > 0 THEN
    RAISE EXCEPTION
      '0001 down refused: % teacher row(s) contain authentication data. '
      'Dropping username/password_hash/locked_until/etc. would destroy credentials. '
      'Take a backup and perform a deliberate manual rollback if this is really intended.',
      populated;
  END IF;

  RAISE NOTICE '0001 down: authentication columns are empty, safe to drop';
END
$$;

-- ---------------------------------------------------------------------------
-- 2. drop the indexes created by 0001 (no data loss)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_teachers_status;
DROP INDEX IF EXISTS idx_teachers_username;

-- ---------------------------------------------------------------------------
-- 3. drop the authentication columns (reached only when step 1 proved them empty)
-- ---------------------------------------------------------------------------
ALTER TABLE teachers DROP COLUMN IF EXISTS password_updated_at;
ALTER TABLE teachers DROP COLUMN IF EXISTS locked_until;
ALTER TABLE teachers DROP COLUMN IF EXISTS failed_login_attempts;
ALTER TABLE teachers DROP COLUMN IF EXISTS must_change_password;
ALTER TABLE teachers DROP COLUMN IF EXISTS password_hash;
ALTER TABLE teachers DROP COLUMN IF EXISTS username;

-- ---------------------------------------------------------------------------
-- 4. restore the original NOT NULL constraint on wecom_user_id.
--    Only possible while no row has a NULL value; otherwise keeping it nullable
--    is the only data-safe choice, so we warn instead of failing the rollback.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  nulls bigint;
BEGIN
  IF to_regclass('public.teachers') IS NULL THEN RETURN; END IF;
  EXECUTE 'SELECT count(*) FROM teachers WHERE wecom_user_id IS NULL' INTO nulls;
  IF nulls = 0 THEN
    BEGIN
      ALTER TABLE teachers ALTER COLUMN wecom_user_id SET NOT NULL;
      RAISE NOTICE '0001 down: wecom_user_id NOT NULL restored';
    EXCEPTION WHEN others THEN
      RAISE NOTICE '0001 down: could not restore NOT NULL on wecom_user_id (%). Left nullable.', SQLERRM;
    END;
  ELSE
    RAISE NOTICE
      '0001 down: % row(s) have NULL wecom_user_id; leaving the column nullable '
      'because setting NOT NULL would fail and dropping those rows would lose accounts.', nulls;
  END IF;
END
$$;
