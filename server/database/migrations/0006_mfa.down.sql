-- =============================================================================
-- 0006 — MFA  (ROLLBACK)
-- =============================================================================
-- Dropping these tables destroys MFA state:
--   * every TOTP enrolment disappears, silently downgrading those accounts to
--     password-only authentication — including any super_admin, whose protection
--     the specification treats as mandatory;
--   * every recovery code is lost, so a user who has lost their device becomes
--     unrecoverable without manual intervention.
--
-- The rollback therefore REFUSES while any CONFIRMED enrolment exists, unless
-- QLS_MFA_FORCE_DOWN=on is set deliberately. Unconfirmed (abandoned) enrolments
-- and expired challenges are not user-visible state and are dropped freely.
--
-- No business table, row or column is touched.
-- =============================================================================

DO $$
DECLARE
  confirmed_count integer := 0;
  force boolean := coalesce(current_setting('qls.mfa_force_down', true), '') = 'on';
BEGIN
  IF to_regclass('public.teacher_mfa') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM teacher_mfa WHERE confirmed = true' INTO confirmed_count;
  END IF;

  IF confirmed_count > 0 AND NOT force THEN
    RAISE EXCEPTION
      '0006 down refused: % account(s) have MFA enabled. Dropping this table would '
      'silently downgrade them to single-factor authentication. Take a backup and '
      're-run with QLS_MFA_FORCE_DOWN=on if this is genuinely intended.',
      confirmed_count
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RAISE NOTICE '0006 down: proceeding (confirmed enrolments=%, forced=%)',
    confirmed_count, force;
END
$$;

DROP TABLE IF EXISTS mfa_challenges;
DROP TABLE IF EXISTS mfa_recovery_codes;
DROP TABLE IF EXISTS teacher_mfa;
