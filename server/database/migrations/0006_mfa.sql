-- =============================================================================
-- 0006 — MFA / TOTP for privileged accounts
-- =============================================================================
-- WHY
--   The specification is explicit that a public deployment may not ship with
--   super_admin protected by a password alone ("不能用'以后再做'作为公网发布条件").
--   This migration adds the persistence for TOTP second-factor authentication and
--   for one-time recovery codes, plus the short-lived challenge that sits between
--   "password verified" and "session issued".
--
-- DESIGN NOTES
--   * The TOTP secret is stored ENCRYPTED (AES-256-GCM, key from
--     MFA_ENCRYPTION_KEY). A leaked database dump must not hand an attacker the
--     ability to generate valid codes. The column is `text` holding
--     "v1:<iv-b64>:<tag-b64>:<ciphertext-b64>" so the scheme can be rotated later
--     without a migration.
--   * Recovery codes are stored as SHA-256 hashes and are shown to the user ONCE.
--     A hash is sufficient because the code is high-entropy and is only ever
--     compared, never re-displayed.
--   * `mfa_challenges` exists so the second step works across MULTIPLE INSTANCES.
--     Keeping the pending challenge in process memory would mean a user who
--     verified their password on instance A and submitted their TOTP code to
--     instance B is rejected — an intermittent failure that is very hard to
--     diagnose in production. The row is single-use and expires in minutes.
--   * `attempts` on the challenge bounds TOTP brute force; without it an attacker
--     who already has the password could enumerate codes freely.
--
-- SAFETY
--   * Purely additive. No existing table, row or column is modified or dropped.
--   * Re-running is a no-op.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. TOTP enrolment per teacher
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teacher_mfa (
  teacher_id       uuid PRIMARY KEY,
  -- "v1:<iv>:<authTag>:<ciphertext>" — never the raw base32 secret.
  secret_encrypted text        NOT NULL,
  algorithm        varchar(10) NOT NULL DEFAULT 'SHA1',
  digits           smallint    NOT NULL DEFAULT 6,
  period_seconds   smallint    NOT NULL DEFAULT 30,
  -- false until the user has proved possession by submitting one valid code.
  -- Enrolment is not "on" merely because a secret was generated.
  confirmed        boolean     NOT NULL DEFAULT false,
  enabled_at       timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT teacher_mfa_digits_check CHECK (digits IN (6, 8)),
  CONSTRAINT teacher_mfa_period_check CHECK (period_seconds BETWEEN 15 AND 120),
  CONSTRAINT teacher_mfa_algorithm_check CHECK (algorithm IN ('SHA1', 'SHA256', 'SHA512')),
  CONSTRAINT teacher_mfa_teacher_fkey
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

COMMENT ON COLUMN teacher_mfa.secret_encrypted IS
  'AES-256-GCM encrypted TOTP secret, format "v1:<iv-b64>:<tag-b64>:<ct-b64>". '
  'Never store the raw secret: a database dump must not allow code generation.';

-- ---------------------------------------------------------------------------
-- 2. one-time recovery codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid        NOT NULL,
  -- SHA-256 of the code; the plaintext exists only in the single response that
  -- generated it.
  code_hash   varchar(64) NOT NULL,
  used_at     timestamptz,
  used_ip     varchar(50),
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mfa_recovery_codes_teacher_fkey
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_teacher
  ON mfa_recovery_codes(teacher_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfa_recovery_hash
  ON mfa_recovery_codes(code_hash);

-- ---------------------------------------------------------------------------
-- 3. short-lived login challenge (password verified, second factor pending)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Only the hash of the challenge token is stored, exactly like session ids: a
  -- database leak must not allow completing someone's half-finished login.
  token_hash   varchar(64) NOT NULL UNIQUE,
  teacher_id   uuid        NOT NULL,
  -- Bounds TOTP brute force by an attacker who already holds the password.
  attempts     smallint    NOT NULL DEFAULT 0,
  max_attempts smallint    NOT NULL DEFAULT 5,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  ip_address   varchar(50),
  user_agent   varchar(500),
  created_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mfa_challenges_teacher_fkey
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_teacher ON mfa_challenges(teacher_id);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expires ON mfa_challenges(expires_at);

-- ---------------------------------------------------------------------------
-- 4. assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text := '';
BEGIN
  IF to_regclass('public.teacher_mfa') IS NULL THEN missing := missing || 'teacher_mfa '; END IF;
  IF to_regclass('public.mfa_recovery_codes') IS NULL THEN missing := missing || 'mfa_recovery_codes '; END IF;
  IF to_regclass('public.mfa_challenges') IS NULL THEN missing := missing || 'mfa_challenges '; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='teacher_mfa' AND column_name='secret_encrypted'
  ) THEN
    missing := missing || 'teacher_mfa.secret_encrypted ';
  END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '0006 incomplete: %', missing;
  END IF;
  RAISE NOTICE '0006: MFA persistence installed';
END
$$;
