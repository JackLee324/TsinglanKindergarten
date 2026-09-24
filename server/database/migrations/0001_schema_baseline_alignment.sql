-- =============================================================================
-- 0001 — schema baseline alignment
-- =============================================================================
-- PURPOSE
--   Make the database match what the v1.3.0 application code actually requires,
--   on BOTH a 妙搭-platform-provisioned database and a plain PostgreSQL instance,
--   without dropping data and without a rebuild.
--
-- WHY EACH STEP IS NEEDED (all verified against a real PostgreSQL 16.14)
--
--   1. `user_profile` composite type
--      `init.sql` uses `_created_by user_profile` but nothing in the repository
--      ever creates that type (`CREATE TYPE` appears nowhere). Verified failure:
--        42704  type "user_profile" does not exist   (init.sql line 21)
--      On the platform the type already exists, so this step is a no-op there.
--
--   2. `anon` / `authenticated` / `service_role` roles
--      `init.sql` creates policies `TO anon`, `TO authenticated`,
--      `TO service_role`, but no `CREATE ROLE` exists anywhere. Verified: none of
--      the three exist in a vanilla cluster.
--
--   3. teachers authentication columns
--      Verified on a database built from the shipped `init.sql`: the `teachers`
--      table has NO `username`, `password_hash`, `must_change_password`,
--      `failed_login_attempts`, `locked_until` or `password_updated_at`.
--      Every login and every seed insert therefore fails with 42703, and the
--      failures are swallowed, so the app reports "successfully started" with
--      zero usable accounts.
--
--   4. `teachers.wecom_user_id` nullability
--      `init.sql` declares it `NOT NULL`, but `AuthService.seedTeachers()` never
--      sets it (v1.3.0 replaced WeCom OAuth with username/password). On a
--      database created from `init.sql` all 20 seed inserts violate NOT NULL.
--      The generated `schema.ts` has it nullable + unique, i.e. the live
--      platform database is already nullable. Aligning to nullable is safe:
--      existing non-null values are preserved and the unique index stays.
--
--   5. functional unique index on lower(username)
--      `AuthService.login()` queries `lower(username) = $1`, but
--      `schema.ts` records that index only as a COMMENT (line 311), so it was
--      never created by any DDL file. Without it the query is not sargable and
--      username uniqueness is case-sensitive only.
--
-- SAFETY
--   * No DROP of any column, table or row.
--   * All statements are idempotent; re-running is a no-op.
--   * Wrapped by the migration runner in a single transaction.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. platform composite type (no-op where it already exists)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_profile') THEN
    CREATE TYPE user_profile AS (user_id text);
    RAISE NOTICE '0001: created composite type user_profile(user_id text)';
  ELSE
    RAISE NOTICE '0001: user_profile already exists, left untouched';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. platform roles (no-op where they already exist)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
      RAISE NOTICE '0001: created role %', r;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. teachers authentication columns
-- ---------------------------------------------------------------------------
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS username              varchar(50);
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS password_hash         varchar(255);
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS must_change_password  boolean NOT NULL DEFAULT false;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS locked_until          timestamptz(6);

-- NOTE on `password_updated_at`: a `NOT NULL DEFAULT CURRENT_TIMESTAMP` column
-- added to a table with existing rows would silently claim that every existing
-- account had its password rotated just now, which is false and would defeat any
-- future password-age policy. It is therefore added NULLable; existing rows stay
-- NULL meaning "unknown", which is the truthful value.
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS password_updated_at   timestamptz(6);

-- ---------------------------------------------------------------------------
-- 4. wecom_user_id must be nullable (v1.3.0 does not populate it)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'teachers'
      AND column_name = 'wecom_user_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE teachers ALTER COLUMN wecom_user_id DROP NOT NULL;
    RAISE NOTICE '0001: teachers.wecom_user_id is now nullable';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. case-insensitive unique username index (the one schema.ts only documented)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_username
  ON teachers USING btree (lower(username))
  WHERE username IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. performance indexes referenced by application queries
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_teachers_status ON teachers(status);

-- ---------------------------------------------------------------------------
-- 7. sanity assertion: the columns the auth stack needs must now exist.
--    Fails the transaction loudly rather than letting the app boot broken.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(need.col, ', ')
    INTO missing
  FROM unnest(ARRAY[
         'username', 'password_hash', 'must_change_password',
         'failed_login_attempts', 'locked_until', 'password_updated_at'
       ]) AS need(col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'teachers'
      AND c.column_name = need.col
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0001 failed: teachers is still missing required column(s): %', missing;
  END IF;
  RAISE NOTICE '0001: all required teachers columns present';
END
$$;
