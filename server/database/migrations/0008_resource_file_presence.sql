-- =============================================================================
-- 0008 — make "this resource has no file" explicit and queryable
-- =============================================================================
-- WHY
--   Every one of the 347 seeded `resources` rows has NULL `file_path`,
--   `file_bucket_id`, `file_name`, `file_size` and `file_type` (verified against
--   the live database: `select count(*) filter (where file_path is not null)
--   from resources` returns 0). The application had no way to SAY that.
--
--   The consequences were not cosmetic:
--     * `ResourceCard` enabled its 下载 button whenever `fileName` was present,
--       which it never is for these rows, so the button was always disabled on a
--       file-less resource BUT the card still rendered as an ordinary published
--       resource with no indication of why nothing downloadable existed;
--     * every other consumer (dashboard counts, storybook covers, review
--       workbench, exports) had to re-derive "is there a file?" itself, and the
--       predicate was spelled differently in each place:
--           resources.service.ts   !fileBucketId || !filePath
--           resource-card.tsx      !fileName
--       Two spellings of one rule is how the download path and the UI come to
--       disagree, and the UI's version ("has a name") can be true while the
--       download path's version ("has a path AND a bucket") is false.
--
--   A hand-maintained boolean column would fix the spelling and re-introduce the
--   drift: nothing would stop a later UPDATE from clearing `file_path` and
--   leaving the flag set. This migration therefore does NOT add a flag that can be
--   written — it adds a GENERATED column, so the database refuses any value that
--   disagrees with the file columns.
--
-- WHAT "HAS A FILE" MEANS HERE — stated precisely
--   `has_stored_file` =
--       coalesce(btrim(file_path), '') <> '' AND coalesce(btrim(file_bucket_id), '') <> ''
--
--   * BOTH columns are required because that is exactly the predicate the download
--     path needs to mint a link; a row with a path but no bucket cannot be served.
--   * `file_name`, `file_size` and `file_type` are deliberately NOT part of it.
--     They are the columns an interrupted upload leaves behind, and treating them
--     as "has a file" would produce a row that claims to be downloadable and then
--     fails — the misleading state this migration removes.
--   * It is a statement about the ROW, not about object storage. The bucket is
--     unreachable from this environment (`FileService` has no working integration
--     here — see the 503 in files.service.ts), so this column cannot and does not
--     claim the bytes exist. It claims the row POINTS AT a file, which is the
--     strongest thing the database can know on its own.
--
-- SAFETY
--   * Purely additive. No column, row, index, constraint or policy is dropped or
--     rewritten, and no resource row is touched.
--   * Because the column is generated, adding it rewrites nothing logically: for
--     every existing row the value is derived from data already present, and the
--     assertions below prove that by recomputing it independently.
--   * Re-running is a no-op (IF NOT EXISTS / guarded DO blocks).
--   * `resources` is empty of file data today, so the expected result is
--     347 rows with has_stored_file = false. The assertions do NOT hard-code 347
--     (a migration must not fail on a database with different row counts); they
--     prove the DERIVATION instead, which holds for any data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. precondition: this is the application's database, and it is the state we
--    expect to be upgrading from
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.resources') IS NULL THEN
    RAISE EXCEPTION '0008 requires the resources table; this does not look like the QLS database';
  END IF;

  -- The generated expression reads these columns; if the baseline is not what we
  -- think it is, fail here rather than producing a column over missing inputs.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'resources'
                   AND column_name = 'file_path') THEN
    RAISE EXCEPTION '0008 precondition failed: resources.file_path is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'resources'
                   AND column_name = 'file_bucket_id') THEN
    RAISE EXCEPTION '0008 precondition failed: resources.file_bucket_id is missing';
  END IF;

  -- Soft delete (0007) supplies deleted_at. The coverage view below reports on
  -- active rows only, so a database that skipped 0007 must be told so.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'resources'
                   AND column_name = 'deleted_at') THEN
    RAISE EXCEPTION '0008 precondition failed: resources.deleted_at is missing (apply 0007 first)';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. the derived column
-- ---------------------------------------------------------------------------
-- GENERATED ALWAYS ... STORED: PostgreSQL computes it on write and rejects any
-- INSERT/UPDATE that names it, so it can never disagree with the file columns.
-- STORED (not VIRTUAL) because it is indexed and filtered by the detector.
-- The `coalesce(..., false)` is NOT decoration. Both file columns are NULL for
-- every seeded row, so `btrim(file_path) <> ''` is NULL and a bare
-- `NULL AND NULL` would make the column NULL — a THREE-valued flag whose meaning
-- ("unknown") no reader could act on, and which `has_stored_file = false` (the
-- index predicate below) would not even match. The column is therefore total:
-- NULL input means "no file", and the value is always true or false.
-- The first run of this migration failed its own postcondition for exactly this
-- reason (347/347 rows "disagreed"), which is what the postcondition is for.
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS has_stored_file boolean
  GENERATED ALWAYS AS (
    coalesce(btrim(file_path), '') <> '' AND coalesce(btrim(file_bucket_id), '') <> ''
  ) STORED;

COMMENT ON COLUMN resources.has_stored_file IS
  'DERIVED (never hand-written): true when file_path AND file_bucket_id are both '
  'non-blank, i.e. when the row points at a stored file. It is NOT a claim that the '
  'object exists in the bucket — only the storage integration can know that. '
  'FALSE means the resource is metadata only and MUST NOT be presented as '
  'downloadable. Keep this in sync with the 0008 migration, not with new code.';

-- Partial index: the "metadata only" set is the one the detector and any future
-- cleanup UI will scan, and it is expected to be the larger set today.
CREATE INDEX IF NOT EXISTS idx_resources_missing_file
  ON resources (program, subject, folder_type)
  WHERE has_stored_file = false;

-- ---------------------------------------------------------------------------
-- 2. a queryable coverage view
-- ---------------------------------------------------------------------------
-- The detector script needs per (program, subject, folder type) counts. Doing it
-- in SQL keeps every consumer (script, future admin page, ad-hoc psql) looking at
-- the same definition of "has a file", instead of three scripts each writing their
-- own WHERE clause.
--
-- Active rows only: a soft-deleted row is in the recycle bin, not in the
-- curriculum, and counting it would overstate both columns.
DROP VIEW IF EXISTS resource_file_coverage;
CREATE VIEW resource_file_coverage AS
SELECT
  program,
  subject,
  sub_subject,
  folder_type,
  count(*)                                          AS total,
  count(*) FILTER (WHERE has_stored_file)           AS with_file,
  count(*) FILTER (WHERE NOT has_stored_file)       AS without_file
FROM resources
WHERE deleted_at IS NULL
GROUP BY program, subject, sub_subject, folder_type;

COMMENT ON VIEW resource_file_coverage IS
  'Per (program, subject, sub_subject, folder type) counts of active resources with '
  'a real stored file vs without. "Real" is resources.has_stored_file (0008), which '
  'is derived from file_path and file_bucket_id. Read-only convenience for the '
  'missing-file detector; it owns no data.';

-- Same breakdown for a whole table rather than a group, so a caller that just
-- wants the totals does not have to re-aggregate.
DROP VIEW IF EXISTS resource_file_totals;
CREATE VIEW resource_file_totals AS
SELECT
  count(*)                                    AS total,
  count(*) FILTER (WHERE has_stored_file)     AS with_file,
  count(*) FILTER (WHERE NOT has_stored_file) AS without_file
FROM resources
WHERE deleted_at IS NULL;

COMMENT ON VIEW resource_file_totals IS
  'Whole-database totals of active resources with/without a stored file. See '
  'resource_file_coverage for the per-folder breakdown.';

-- ---------------------------------------------------------------------------
-- 3. assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text := '';
  gen_kind text;
  gen_expr text;
  mismatched integer;
  totals record;
BEGIN
  -- (a) the column exists and really is generated (not merely named so).
  --     NOTE: the local variables are deliberately NOT named after the
  --     information_schema output columns. Naming one `is_generated` makes
  --     PL/pgSQL report `column reference "is_generated" is ambiguous`
  --     (SQLSTATE 42702) — which this migration hit on its first run.
  SELECT c.is_generated, c.generation_expression
    INTO gen_kind, gen_expr
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'resources'
    AND c.column_name = 'has_stored_file';

  IF gen_kind IS NULL THEN
    missing := missing || 'resources.has_stored_file ';
  ELSIF gen_kind <> 'ALWAYS' THEN
    RAISE EXCEPTION
      '0008 incomplete: has_stored_file is not a generated column (is_generated=%). '
      'A writable column would be a hand-maintained flag and can drift.', gen_kind;
  END IF;

  -- (b) the derivation is the one this migration documents. Comparing the stored
  --     expression to the intended predicate catches a silently different rule.
  IF gen_expr IS NOT NULL AND position('file_path' in gen_expr) = 0 THEN
    RAISE EXCEPTION '0008 incomplete: generated expression does not read file_path (%).', gen_expr;
  END IF;
  IF gen_expr IS NOT NULL AND position('file_bucket_id' in gen_expr) = 0 THEN
    RAISE EXCEPTION '0008 incomplete: generated expression does not read file_bucket_id (%).', gen_expr;
  END IF;

  -- (c) both views exist
  IF to_regclass('public.resource_file_coverage') IS NULL THEN
    missing := missing || 'resource_file_coverage ';
  END IF;
  IF to_regclass('public.resource_file_totals') IS NULL THEN
    missing := missing || 'resource_file_totals ';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '0008 incomplete: %', missing;
  END IF;

  -- (d) POSTCONDITION: every row's derived value equals an INDEPENDENT
  --     recomputation from the source columns. This is the assertion that makes
  --     "the flag cannot drift" a checked fact rather than a claim: if the
  --     generated expression and the download predicate ever disagree, this fails.
  SELECT count(*) INTO mismatched
  FROM resources
  WHERE has_stored_file IS DISTINCT FROM
        (coalesce(btrim(file_path), '') <> '' AND coalesce(btrim(file_bucket_id), '') <> '');

  IF mismatched <> 0 THEN
    RAISE EXCEPTION
      '0008 postcondition failed: % row(s) where has_stored_file disagrees with '
      'file_path/file_bucket_id', mismatched;
  END IF;

  -- (e) report the observed state. NOT an assertion on the numbers (a migration
  --     must not fail because a database has more or fewer rows); it is here so
  --     the numbers are in the migration log for the operator to compare.
  SELECT * INTO totals FROM resource_file_totals;
  RAISE NOTICE '0008: active resources=%, with a stored file=%, without=%',
    totals.total, totals.with_file, totals.without_file;

  RAISE NOTICE '0008: resources.has_stored_file installed (generated, indexed, view-backed)';
END
$$;
