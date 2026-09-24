-- =============================================================================
-- 0007 — soft delete (recycle bin) for resources
-- =============================================================================
-- WHY
--   `DELETE /api/resources/:id` performed a HARD delete: `delete resources where
--   id = $1`. One mis-click — or one stolen session — and a teacher's whole
--   term's 教案 were gone with no undo and no copy. The audit log recorded the
--   event but the row itself was unrecoverable, and the file in object storage
--   was orphaned (nothing referenced it, nothing would ever clean it up).
--
--   The platform's own permission catalog already describes the intended
--   behaviour: `resource.delete` = "将资源移入回收站（软删除）", plus separate
--   `resource.restore` and `resource.purge` capabilities. This migration supplies
--   the persistence those permissions describe.
--
-- DESIGN NOTES
--   * `deleted_at`  — when the row entered the recycle bin. NULL = active. This
--     is the ONLY column the application's read paths filter on, so every list,
--     search, dashboard and review query must add `deleted_at IS NULL`.
--   * `deleted_by`  — which account performed the delete. Kept so a restore can
--     be attributed and so an administrator can see who emptied a folder.
--   * `purge_after` — when the row becomes eligible for a permanent purge
--     (deleted_at + the retention window, 30 days by default, configurable).
--     Storing it on the row rather than computing it means the retention policy
--     can change without changing the fate of rows already in the bin.
--   * `resources_soft_delete_pairing` makes "both or neither" a DATABASE
--     invariant: a row can never be half-deleted (which would make a purge scan
--     or a restore behave inconsistently depending on which column was read).
--
-- WHY RLS IS NOT NARROWED HERE
--   A previous migration round narrowed SELECT policies and broke ordinary pages
--   (see the long note in 0005). Two things are therefore deliberate:
--
--   1. This migration does NOT add `USING (deleted_at IS NULL)` to any policy.
--      RLS cannot express soft delete correctly: the recycle bin must be able to
--      READ deleted rows and restore must be able to UPDATE them, both of which
--      run under the same database role as ordinary reads (`anon_` in a
--      standalone deployment, per 0004). Filtering here would hide the recycle
--      bin, break restore with a silent zero-row UPDATE, and re-create exactly
--      the class of failure 0005 documents. Soft-delete visibility is an
--      APPLICATION concern, enforced in every query path.
--
--   2. Access that already existed is preserved explicitly and asserted at the
--      end. `anon_` / `authenticated_` / `service_role_` keep SELECT and UPDATE
--      on `resources` (0004 already granted these; the statements below are
--      idempotent reinforcement, not a widening). NOTHING is granted to a role
--      that did not already hold the privilege.
--
-- SAFETY
--   * Purely additive. No existing column, row, index or policy is dropped.
--   * Re-running is a no-op (IF NOT EXISTS / guarded DO blocks).
--   * All 347 existing rows have NULL soft-delete state, so the new CHECK
--     constraint validates without rewriting any row's meaning.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. precondition: this is the application's database
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.resources') IS NULL THEN
    RAISE EXCEPTION '0007 requires the resources table; this does not look like the QLS database';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. soft-delete columns
-- ---------------------------------------------------------------------------
ALTER TABLE resources ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS deleted_by  uuid;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS purge_after timestamptz;

-- `deleted_by` must not block deleting a teacher account: if the account is ever
-- removed the soft-delete state survives, only the attribution is dropped.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resources_deleted_by_fkey'
  ) THEN
    ALTER TABLE resources
      ADD CONSTRAINT resources_deleted_by_fkey
      FOREIGN KEY (deleted_by) REFERENCES teachers(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- "both or neither": a row is either active (both NULL) or in the recycle bin
-- (both set). Prevents a half-deleted row that a purge scan or a restore would
-- treat inconsistently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resources_soft_delete_pairing'
  ) THEN
    ALTER TABLE resources
      ADD CONSTRAINT resources_soft_delete_pairing CHECK (
        (deleted_at IS NULL AND purge_after IS NULL)
        OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL)
      );
  END IF;
END
$$;

COMMENT ON COLUMN resources.deleted_at IS
  'Soft-delete timestamp. NULL = active row. EVERY application read path must '
  'filter "deleted_at IS NULL"; RLS deliberately does not, because the recycle '
  'bin and restore run under the same database role as ordinary reads.';
COMMENT ON COLUMN resources.deleted_by IS
  'teachers.id that moved the row to the recycle bin (NULL when the account was '
  'removed, or for a row that is still active).';
COMMENT ON COLUMN resources.purge_after IS
  'When the row becomes eligible for permanent purge (deleted_at + retention '
  'window). Paired with deleted_at by the resources_soft_delete_pairing check.';

-- ---------------------------------------------------------------------------
-- 2. indexes for the two access patterns this feature introduces
-- ---------------------------------------------------------------------------
-- (a) the recycle bin itself, and the purge scan: the deleted set is SMALL, so a
--     partial index over it is cheap and keeps the scan proportional to the bin.
CREATE INDEX IF NOT EXISTS idx_resources_deleted_at
  ON resources (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resources_purge_after
  ON resources (purge_after) WHERE deleted_at IS NOT NULL;

-- (b) the ACTIVE set. Every ordinary list/search/dashboard path now carries
--     `deleted_at IS NULL`; a partial index over the active rows lets the planner
--     satisfy both the predicate and the ordering without walking the bin. These
--     are additive — the pre-existing full indexes stay exactly as they are.
CREATE INDEX IF NOT EXISTS idx_resources_active_status
  ON resources (status, _created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_resources_active_uploader
  ON resources (uploader_id, _created_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. preserve (never widen) access for the roles that actually use this table
-- ---------------------------------------------------------------------------
-- 0004 granted SELECT/INSERT/UPDATE/DELETE on all tables to the suffixed role
-- triple and installed permissive policies for it. Those grants are table-level,
-- so they already cover the new columns — but this is a security-relevant
-- property, so it is stated here and asserted in section 4 rather than assumed.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon_', 'authenticated_', 'service_role_'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE NOTICE '0007: role % absent, skipping', r;
      CONTINUE;
    END IF;

    EXECUTE format('GRANT SELECT, UPDATE ON resources TO %I', r);

    -- Permissive policies over ALL rows, matching 0004/0005's style. They exist
    -- so the property "this role can still SELECT and UPDATE resources" is
    -- guaranteed by POLICY as well as by GRANT, and they deliberately do not
    -- mention deleted_at (see the header).
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'resources'
        AND policyname = 'rls0007_resources_sel_' || r
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON resources AS PERMISSIVE FOR SELECT TO %I USING (true)',
        'rls0007_resources_sel_' || r, r);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'resources'
        AND policyname = 'rls0007_resources_upd_' || r
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON resources AS PERMISSIVE FOR UPDATE TO %I USING (true) WITH CHECK (true)',
        'rls0007_resources_upd_' || r, r);
    END IF;

    RAISE NOTICE '0007: % keeps SELECT/UPDATE on resources', r;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text := '';
  r text;
  can_select boolean;
  can_update boolean;
  n integer;
BEGIN
  -- columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='resources' AND column_name='deleted_at' AND data_type='timestamp with time zone') THEN
    missing := missing || 'resources.deleted_at ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='resources' AND column_name='deleted_by' AND data_type='uuid') THEN
    missing := missing || 'resources.deleted_by ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='resources' AND column_name='purge_after' AND data_type='timestamp with time zone') THEN
    missing := missing || 'resources.purge_after ';
  END IF;

  -- indexes
  IF to_regclass('public.idx_resources_deleted_at') IS NULL THEN
    missing := missing || 'idx_resources_deleted_at ';
  END IF;
  IF to_regclass('public.idx_resources_purge_after') IS NULL THEN
    missing := missing || 'idx_resources_purge_after ';
  END IF;

  -- pairing invariant
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='resources_soft_delete_pairing') THEN
    missing := missing || 'resources_soft_delete_pairing ';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '0007 incomplete: %', missing;
  END IF;

  -- the access property this migration must not break
  FOREACH r IN ARRAY ARRAY['anon_', 'authenticated_', 'service_role_'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      CONTINUE;
    END IF;

    SELECT has_column_privilege(r, 'resources', 'deleted_at', 'SELECT') INTO can_select;
    SELECT has_column_privilege(r, 'resources', 'deleted_at', 'UPDATE') INTO can_update;
    IF NOT can_select THEN
      missing := missing || r || ' cannot SELECT resources.deleted_at; ';
    END IF;
    IF NOT can_update THEN
      missing := missing || r || ' cannot UPDATE resources.deleted_at (soft delete/restore would fail with 42501); ';
    END IF;

    SELECT count(*) INTO n FROM pg_policies
    WHERE schemaname='public' AND tablename='resources' AND cmd='SELECT' AND r = ANY(roles);
    IF n = 0 THEN
      missing := missing || r || ' has no SELECT policy on resources; ';
    END IF;

    SELECT count(*) INTO n FROM pg_policies
    WHERE schemaname='public' AND tablename='resources' AND cmd='UPDATE' AND r = ANY(roles);
    IF n = 0 THEN
      missing := missing || r || ' has no UPDATE policy on resources; ';
    END IF;
  END LOOP;

  IF missing <> '' THEN
    RAISE EXCEPTION '0007 incomplete — access regression: %', missing;
  END IF;

  RAISE NOTICE '0007: resource recycle bin installed';
END
$$;
