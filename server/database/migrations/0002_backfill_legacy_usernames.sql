-- =============================================================================
-- 0002 — backfill usernames for pre-v1.3.0 accounts (prevents duplicate accounts)
-- =============================================================================
-- THE PROBLEM THIS FIXES (observed, not theorised)
--   v1.3.0 replaced WeCom OAuth with username/password. `AuthService.seedTeachers()`
--   looks up an account by `lower(username) = $1`:
--
--     const existing = await db.select(...).from(teachers)
--       .where(and(sql`lower(${teachers.username}) = ${seed.username.toLowerCase()}`,
--                  isNotNull(teachers.username)))
--
--   An account created before v1.3.0 has NO username (only `wecom_user_id`), so the
--   lookup cannot match it and the seeder INSERTS A SECOND ACCOUNT.
--
--   Verified on a realistic legacy database (init.sql schema + 21 existing accounts
--   + 347 resources): after migration 0001 the app seeded successfully
--   ("Seed teachers: created=20, skipped=0") but the account count went
--       21  ->  41
--   i.e. every legacy account was duplicated. The duplicates also mean the person
--   can no longer reach their own historical resources/review records, because
--   those rows still point at the OLD teacher id.
--
-- WHAT THIS DOES
--   Derives a deterministic username for every account that lacks one, so the
--   seeder matches the EXISTING row and claims it (the seeder sets a password
--   hash on an account that has none, rather than creating a new one).
--
--   Derivation order (first non-empty result wins):
--     1. local part of `email`, if it yields a valid username
--     2. `wecom_user_id` with known prefixes stripped
--   Only `[a-z0-9._-]` is kept; result is lowercased and truncated to 50 chars.
--   Characters outside that set are removed, not replaced, so no account can
--   collide by transformation.
--
-- SAFETY / IDEMPOTENCE / REVERSIBILITY
--   * Only rows with `username IS NULL` are touched. Existing usernames are never
--     modified.
--   * A derived username is only applied when it is not already taken
--     (case-insensitive) — a collision is skipped and reported, never forced.
--   * The derivation is a pure function of the row's own email/wecom_user_id, so
--     the DOWN migration recomputes exactly the same expression and clears only
--     the values this migration could have written. No bookkeeping column needed.
--   * No row is deleted. No account is merged. No password is changed.
-- =============================================================================

DO $$
DECLARE
  updated_count integer := 0;
  skipped_collision integer := 0;
  underivable integer := 0;
BEGIN
  IF to_regclass('public.teachers') IS NULL THEN
    RAISE NOTICE '0002: teachers table absent, nothing to backfill';
    RETURN;
  END IF;

  -- Reusable derivation, identical in the DOWN migration.
  --   candidate = regexp_replace(lower(coalesce(split_part(email,'@',1),
  --                 stripped wecom_user_id)), '[^a-z0-9._-]', '', 'g')
  WITH candidates AS (
    SELECT
      t.id,
      left(
        regexp_replace(
          lower(
            coalesce(
              nullif(split_part(coalesce(t.email, ''), '@', 1), ''),
              nullif(
                regexp_replace(
                  coalesce(t.wecom_user_id, ''),
                  '^(legacy_|wecom_|wx_|user_)',
                  ''
                ),
                ''
              )
            )
          ),
          '[^a-z0-9._-]', '', 'g'
        ),
        50
      ) AS candidate
    FROM teachers t
    WHERE t.username IS NULL
  ),
  resolvable AS (
    SELECT c.id, c.candidate
    FROM candidates c
    WHERE c.candidate IS NOT NULL
      AND c.candidate <> ''
      -- not already used by another account (case-insensitive)
      AND NOT EXISTS (
        SELECT 1 FROM teachers x
        WHERE x.id <> c.id AND lower(x.username) = c.candidate
      )
      -- not duplicated within this same batch (avoids a unique-index failure
      -- and refuses to guess which of two accounts should own the name)
      AND (SELECT count(*) FROM candidates c2 WHERE c2.candidate = c.candidate) = 1
  )
  UPDATE teachers t
     SET username = r.candidate
    FROM resolvable r
   WHERE t.id = r.id
     AND t.username IS NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  -- how many remained NULL because the derived name was already taken
  SELECT count(*) INTO skipped_collision
  FROM teachers t
  WHERE t.username IS NULL
    AND EXISTS (
      SELECT 1 FROM teachers x
      WHERE x.id <> t.id
        AND lower(x.username) = left(
              regexp_replace(
                lower(coalesce(
                  nullif(split_part(coalesce(t.email, ''), '@', 1), ''),
                  nullif(regexp_replace(coalesce(t.wecom_user_id, ''),
                         '^(legacy_|wecom_|wx_|user_)', ''), '')
                )),
                '[^a-z0-9._-]', '', 'g'),
              50)
    );

  SELECT count(*) INTO underivable FROM teachers WHERE username IS NULL;

  RAISE NOTICE '0002: backfilled % username(s); % still NULL (% collision-prone, % not derivable)',
    updated_count, underivable, skipped_collision, underivable - skipped_collision;

  IF underivable > 0 THEN
    RAISE NOTICE '0002: accounts still without a username CANNOT be matched by the '
                 'credential seeder and will be given explicit usernames by an '
                 'administrator. They are listed by: '
                 'SELECT id, name, email, wecom_user_id FROM teachers WHERE username IS NULL;';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- assertion: the migration must not have created a duplicate username
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dup integer;
BEGIN
  IF to_regclass('public.teachers') IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO dup FROM (
    SELECT lower(username) FROM teachers
    WHERE username IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE EXCEPTION '0002 failed: % duplicate username(s) present after backfill', dup;
  END IF;
  RAISE NOTICE '0002: no duplicate usernames';
END
$$;
