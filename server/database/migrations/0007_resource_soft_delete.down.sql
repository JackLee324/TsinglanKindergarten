-- =============================================================================
-- 0007 — soft delete (recycle bin)  (ROLLBACK)
-- =============================================================================
-- Dropping these columns DESTROYS the recycle bin:
--   * every soft-deleted resource row becomes permanently invisible — the rows
--     stay in the table but nothing can list or restore them, because the data
--     that identifies them as deleted is gone. From the application's point of
--     view that is equivalent to the hard delete this feature exists to prevent;
--   * the retention state (`purge_after`) is lost, so a later purge decision
--     cannot be reconstructed.
--
-- The rollback therefore REFUSES while any row is in the recycle bin, unless
-- QLS_SOFT_DELETE_FORCE_DOWN=on is set deliberately. The refusal is the same
-- shape as 0006's: fail closed, explain, and offer the explicit escape hatch.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does NOT revoke SELECT/UPDATE on `resources` from anon_ /
--     authenticated_ / service_role_. Those grants predate this migration (0004)
--     and revoking them would break every page — the exact regression 0005 warns
--     about. Only the policies THIS migration created are removed.
--   * It does NOT touch any other table, row or column.
-- =============================================================================

DO $$
DECLARE
  in_bin integer := 0;
  force boolean := coalesce(current_setting('qls.soft_delete_force_down', true), '') = 'on';
BEGIN
  IF to_regclass('public.resources') IS NULL THEN
    RAISE NOTICE '0007 down: resources table absent, nothing to reverse';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'resources' AND column_name = 'deleted_at'
  ) THEN
    EXECUTE 'SELECT count(*) FROM resources WHERE deleted_at IS NOT NULL' INTO in_bin;
  END IF;

  IF in_bin > 0 AND NOT force THEN
    RAISE EXCEPTION
      '0007 down refused: % resource(s) are in the recycle bin. Dropping the '
      'soft-delete columns would make them permanently invisible with no way to '
      'restore them. Take a backup, restore or purge those rows first, or re-run '
      'with QLS_SOFT_DELETE_FORCE_DOWN=on if this is genuinely intended.',
      in_bin
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RAISE NOTICE '0007 down: proceeding (rows in bin=%, forced=%)', in_bin, force;
END
$$;

-- policies created by 0007 (permissive SELECT/UPDATE reinforcement)
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon_', 'authenticated_', 'service_role_'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON resources', 'rls0007_resources_sel_' || r);
    EXECUTE format('DROP POLICY IF EXISTS %I ON resources', 'rls0007_resources_upd_' || r);
  END LOOP;
END
$$;

DROP INDEX IF EXISTS idx_resources_active_uploader;
DROP INDEX IF EXISTS idx_resources_active_status;
DROP INDEX IF EXISTS idx_resources_purge_after;
DROP INDEX IF EXISTS idx_resources_deleted_at;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_soft_delete_pairing;
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_deleted_by_fkey;

ALTER TABLE resources DROP COLUMN IF EXISTS purge_after;
ALTER TABLE resources DROP COLUMN IF EXISTS deleted_by;
ALTER TABLE resources DROP COLUMN IF EXISTS deleted_at;
