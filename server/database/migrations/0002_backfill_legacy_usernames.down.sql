-- =============================================================================
-- 0002 — backfill legacy usernames  (ROLLBACK)
-- =============================================================================
-- Reverses the backfill by recomputing the SAME derivation used in the UP
-- migration and clearing only those usernames. Because the derivation is a pure
-- function of each row's own `email` / `wecom_user_id`, no bookkeeping column was
-- needed and the rollback is exact.
--
-- SAFETY
--   * Never touches a username that does not match its own row's derivation, so
--     usernames created by the seeder, by an administrator, or edited by hand are
--     left completely alone.
--   * Refuses to run if it would leave the system with NO login-capable account,
--     because that would lock everyone out — a worse outcome than the bug being
--     rolled back.
--   * Does not delete rows and does not touch password hashes.
-- =============================================================================

DO $$
DECLARE
  would_clear integer;
  login_capable_before integer;
  login_capable_after integer;
  actually_cleared integer := 0;
BEGIN
  IF to_regclass('public.teachers') IS NULL THEN
    RAISE NOTICE '0002 down: teachers absent, nothing to do';
    RETURN;
  END IF;

  -- Rows whose CURRENT username is exactly what this migration would have derived,
  -- and which therefore may be safely reverted.
  CREATE TEMP TABLE _rb0002 ON COMMIT DROP AS
  SELECT t.id
  FROM teachers t
  WHERE t.username IS NOT NULL
    AND t.username = left(
          regexp_replace(
            lower(coalesce(
              nullif(split_part(coalesce(t.email, ''), '@', 1), ''),
              nullif(regexp_replace(coalesce(t.wecom_user_id, ''),
                     '^(legacy_|wecom_|wx_|user_)', ''), '')
            )),
            '[^a-z0-9._-]', '', 'g'),
          50);

  SELECT count(*) INTO would_clear FROM _rb0002;

  IF would_clear = 0 THEN
    RAISE NOTICE '0002 down: no derived usernames found, nothing to revert';
    RETURN;
  END IF;

  -- Safety: never leave the system with zero login-capable accounts.
  -- A login-capable account = has a username AND a password hash.
  SELECT count(*) INTO login_capable_before
  FROM teachers WHERE username IS NOT NULL AND password_hash IS NOT NULL;

  SELECT count(*) INTO login_capable_after
  FROM teachers
  WHERE username IS NOT NULL AND password_hash IS NOT NULL
    AND id NOT IN (SELECT id FROM _rb0002);

  IF login_capable_after = 0 AND login_capable_before > 0 THEN
    RAISE EXCEPTION
      '0002 down refused: reverting the username backfill would leave 0 accounts able '
      'to log in (% currently can). Doing so would lock every user out of the system. '
      'Create a super_admin account first, or restore from a backup.',
      login_capable_before;
  END IF;

  UPDATE teachers t
     SET username = NULL
    FROM _rb0002 r
   WHERE t.id = r.id;

  GET DIAGNOSTICS actually_cleared = ROW_COUNT;

  RAISE NOTICE '0002 down: cleared % backfilled username(s)', actually_cleared;
  RAISE NOTICE '0002 down: NOTE — accounts that had no username before this migration '
               'are, again, not matchable by the credential seeder; starting the app '
               'will create a NEW account for each of them. Re-apply 0002 (or assign '
               'usernames manually) to avoid duplicate accounts.';
END
$$;
