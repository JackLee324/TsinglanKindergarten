-- =============================================================================
-- 0008 — resource file presence  (ROLLBACK)
-- =============================================================================
-- This rollback is UNLIKE 0007's, and the difference is deliberate.
--
-- 0007 dropped columns that HELD data (who deleted a row, when it becomes
-- eligible for purge). Dropping those destroyed the recycle bin, so its rollback
-- refuses while any row is in the bin.
--
-- `has_stored_file`, `resource_file_coverage` and `resource_file_totals` hold NO
-- data of their own. Every value is derived from `file_path` and
-- `file_bucket_id`, which this rollback does not touch. Removing them therefore
-- loses nothing that cannot be recomputed, and the rollback is unconditional.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does NOT touch `file_path`, `file_bucket_id`, `file_name`, `file_size`,
--     `file_type` or any other file column — those are the data.
--   * It does NOT delete, update or re-seed a single `resources` row.
--   * It does NOT touch the soft-delete columns, indexes or policies from 0007.
--
-- AFTER ROLLING BACK, the application must not be expected to read
-- `resources.has_stored_file`: `ResourcesService` selects it, so a rolled-back
-- database needs the pre-0008 code as well. That dependency is the reason this
-- rollback exists at all — it makes "go back to the previous release" a supported
-- operation rather than a schema/code mismatch.
-- =============================================================================

-- Views first: they reference the column, so PostgreSQL would refuse to drop the
-- column while they exist.
DROP VIEW IF EXISTS resource_file_totals;
DROP VIEW IF EXISTS resource_file_coverage;

DROP INDEX IF EXISTS idx_resources_missing_file;

ALTER TABLE resources DROP COLUMN IF EXISTS has_stored_file;

-- ---------------------------------------------------------------------------
-- assert the rollback actually happened
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  leftovers text := '';
BEGIN
  IF to_regclass('public.resources') IS NULL THEN
    RAISE NOTICE '0008 down: resources table absent, nothing to reverse';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'resources'
               AND column_name = 'has_stored_file') THEN
    leftovers := leftovers || 'resources.has_stored_file ';
  END IF;

  IF to_regclass('public.idx_resources_missing_file') IS NOT NULL THEN
    leftovers := leftovers || 'idx_resources_missing_file ';
  END IF;

  IF to_regclass('public.resource_file_coverage') IS NOT NULL THEN
    leftovers := leftovers || 'resource_file_coverage ';
  END IF;

  IF to_regclass('public.resource_file_totals') IS NOT NULL THEN
    leftovers := leftovers || 'resource_file_totals ';
  END IF;

  IF leftovers <> '' THEN
    RAISE EXCEPTION '0008 down incomplete: %', leftovers;
  END IF;

  -- The data columns must be untouched. This is the assertion that makes the
  -- "no business data is lost" claim checkable instead of asserted in prose.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'resources'
                   AND column_name = 'file_path')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'resources'
                      AND column_name = 'file_bucket_id') THEN
    RAISE EXCEPTION '0008 down DAMAGED the file columns — file_path/file_bucket_id must survive';
  END IF;

  RAISE NOTICE '0008 down: derived column, index and views removed; file columns and all rows untouched';
END
$$;
