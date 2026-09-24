-- =============================================================================
-- 0003 — RBAC database layer + session revocation
-- =============================================================================
-- Implements the persistence and DATABASE-LEVEL ENFORCEMENT for the model
-- designed in RBAC.md. The application layer is added in phase 5; this migration
-- makes the guarantees hold even if the application has a bug.
--
-- CONTENTS
--   1. teachers.permissions_version          — instant revocation (RBAC.md §8)
--   2. account_permission_overrides          — per-account grant / deny
--   3. account_scopes                        — data scope bindings
--   4. automatic permissions_version bumping — DB-enforced, cannot be forgotten
--   5. super_admin protection trigger        — privilege escalation guard
--   6. last-super_admin protection           — cannot lock everyone out
--   7. sessions.permissions_version + revocation metadata
--
-- WHY THE GUARD IS IN THE DATABASE AND NOT ONLY IN THE SERVICE
--   The requirement is explicit: a compromised or buggy administrator path must
--   not be able to turn a `principal` into a `super_admin`, and a `principal`
--   must not be able to modify a `super_admin`. Application checks can be
--   bypassed by any code path that forgets to call them — and this codebase
--   demonstrated exactly that failure mode (37 scattered `roles.includes(...)`
--   checks, several controllers with none at all). The trigger is the backstop.
--
--   The actor must DECLARE itself as a super admin for the connection/transaction
--   by running:
--       SELECT set_config('app.rbac_actor_super_admin', 'on', true);
--       SELECT set_config('app.rbac_actor_id', '<actor uuid>', true);
--   Failing to declare is treated as NOT a super admin (fail closed).
--
-- COLUMNS THAT ARE *NOT* GUARDED, AND WHY
--   `last_login_at`, `failed_login_attempts`, `locked_until` and
--   `password_updated_at` are operational state written during the login flow,
--   *before* the caller's identity is established. Guarding them would either
--   break login for super admins or let an unauthenticated attacker trigger
--   errors. They confer no privilege, so they are exempt.
--   `permissions_version` is written by the bump trigger itself and only ever
--   forces re-authentication (a denial), never an escalation, so it is exempt
--   too — otherwise the bump trigger would block its own write.
--
--   `password_hash` IS guarded, with one exception: an account changing its own
--   password (`app.rbac_actor_id` = the row being changed) is allowed, because
--   that grants no new privilege and must keep working.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. permissions_version
-- ---------------------------------------------------------------------------
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS permissions_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN teachers.permissions_version IS
  'Monotonic counter of this account''s authorization state. Sessions carry the '
  'value they were created with; a mismatch forces re-authentication, which is '
  'what makes permission revocation take effect immediately (RBAC.md §8).';

-- ---------------------------------------------------------------------------
-- 2. per-account permission overrides (grant / deny)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_permission_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid         NOT NULL,
  permission  varchar(120) NOT NULL,
  effect      varchar(10)  NOT NULL,
  reason      text,
  granted_by  uuid,
  created_at  timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  timestamptz,
  CONSTRAINT account_permission_overrides_effect_check
    CHECK (effect IN ('grant', 'deny')),
  CONSTRAINT account_permission_overrides_unique
    UNIQUE (teacher_id, permission),
  CONSTRAINT account_permission_overrides_teacher_fkey
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
  CONSTRAINT account_permission_overrides_granted_by_fkey
    FOREIGN KEY (granted_by) REFERENCES teachers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_apo_teacher ON account_permission_overrides(teacher_id);

COMMENT ON TABLE account_permission_overrides IS
  'Per-account deltas on top of ROLE_PERMISSIONS (shared/rbac.ts). '
  'Effective permissions = (role defaults UNION grants) MINUS denies; deny wins.';

-- ---------------------------------------------------------------------------
-- 3. data scope bindings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid         NOT NULL,
  -- NULL permission = this binding applies to every data-scoped permission.
  permission  varchar(120),
  kind        varchar(10)  NOT NULL,
  program     varchar(20),
  subject     varchar(50),
  sub_subject varchar(50),
  created_by  uuid,
  created_at  timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT account_scopes_kind_check
    CHECK (kind IN ('ALL', 'PROGRAM', 'SUBJECT', 'OWN')),
  CONSTRAINT account_scopes_shape_check CHECK (
    (kind IN ('ALL', 'OWN') AND program IS NULL AND subject IS NULL AND sub_subject IS NULL)
    OR (kind = 'PROGRAM' AND program IS NOT NULL AND subject IS NULL AND sub_subject IS NULL)
    OR (kind = 'SUBJECT' AND program IS NOT NULL AND subject IS NOT NULL)
  ),
  CONSTRAINT account_scopes_teacher_fkey
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_scopes_teacher ON account_scopes(teacher_id);

COMMENT ON TABLE account_scopes IS
  'Data scope bindings (RBAC.md §7). Absence of rows means "unrestricted by this '
  'table"; teaching roles remain additionally constrained by subject_permissions, '
  'so existing accounts keep their current behaviour.';

-- ---------------------------------------------------------------------------
-- 4. automatic permissions_version bumping
--    A permission change that does not bump the version would leave old sessions
--    running with revoked rights, so the bump is enforced by the database rather
--    than trusted to every call site.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rbac_bump_permissions_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_teacher uuid;
BEGIN
  IF TG_TABLE_NAME = 'teachers' THEN
    target_teacher := NEW.id;
    -- only bump when the authorization surface actually changed
    IF NEW.roles IS NOT DISTINCT FROM OLD.roles
       AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    IF NEW.permissions_version IS DISTINCT FROM OLD.permissions_version + 1 THEN
      NEW.permissions_version := OLD.permissions_version + 1;
    END IF;
    RETURN NEW;
  END IF;

  -- override / scope tables
  target_teacher := COALESCE(NEW.teacher_id, OLD.teacher_id);
  UPDATE teachers
     SET permissions_version = permissions_version + 1
   WHERE id = target_teacher;

  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_teachers_bump_permissions_version ON teachers;
CREATE TRIGGER trg_teachers_bump_permissions_version
  BEFORE UPDATE ON teachers
  FOR EACH ROW
  EXECUTE FUNCTION rbac_bump_permissions_version();

DROP TRIGGER IF EXISTS trg_apo_bump_permissions_version ON account_permission_overrides;
CREATE TRIGGER trg_apo_bump_permissions_version
  AFTER INSERT OR UPDATE OR DELETE ON account_permission_overrides
  FOR EACH ROW
  EXECUTE FUNCTION rbac_bump_permissions_version();

DROP TRIGGER IF EXISTS trg_account_scopes_bump_permissions_version ON account_scopes;
CREATE TRIGGER trg_account_scopes_bump_permissions_version
  AFTER INSERT OR UPDATE OR DELETE ON account_scopes
  FOR EACH ROW
  EXECUTE FUNCTION rbac_bump_permissions_version();

-- ---------------------------------------------------------------------------
-- 5. super_admin protection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rbac_actor_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(current_setting('app.rbac_actor_super_admin', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION rbac_actor_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.rbac_actor_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION rbac_guard_super_admin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_is_super boolean := OLD.roles IS NOT NULL AND 'super_admin' = ANY (OLD.roles);
  new_is_super boolean;
  priv_change   boolean;
  actor         uuid := rbac_actor_id();
BEGIN
  new_is_super := TG_OP = 'UPDATE'
                  AND NEW.roles IS NOT NULL
                  AND 'super_admin' = ANY (NEW.roles);

  -- If nothing about this row is (or is becoming) a super admin, allow it.
  IF NOT old_is_super AND NOT new_is_super THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Does the change touch privilege-bearing columns?
  IF TG_OP = 'DELETE' THEN
    priv_change := true;
  ELSE
    priv_change :=
         NEW.roles      IS DISTINCT FROM OLD.roles
      OR NEW.status     IS DISTINCT FROM OLD.status
      OR NEW.username   IS DISTINCT FROM OLD.username
      OR NEW.name       IS DISTINCT FROM OLD.name
      OR NEW.name_en    IS DISTINCT FROM OLD.name_en
      OR NEW.email      IS DISTINCT FROM OLD.email
      OR NEW.password_hash IS DISTINCT FROM OLD.password_hash;
  END IF;

  IF NOT priv_change THEN
    RETURN COALESCE(NEW, OLD);  -- operational update (login counters, timestamps)
  END IF;

  -- Self-service password change by the super admin themself is allowed.
  IF TG_OP = 'UPDATE'
     AND actor IS NOT NULL
     AND actor = OLD.id
     AND NEW.roles IS NOT DISTINCT FROM OLD.roles
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.username IS NOT DISTINCT FROM OLD.username
     AND NEW.email IS NOT DISTINCT FROM OLD.email
     AND NEW.name IS NOT DISTINCT FROM OLD.name
     AND NEW.name_en IS NOT DISTINCT FROM OLD.name_en
  THEN
    RETURN NEW;
  END IF;

  IF NOT rbac_actor_is_super_admin() THEN
    RAISE EXCEPTION
      'rbac: refused to modify or remove a super_admin account without super_admin '
      'authority (table=%, op=%, target=%). A principal cannot manage a super_admin.',
      TG_TABLE_NAME, TG_OP, OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_teachers_guard_super_admin ON teachers;
CREATE TRIGGER trg_teachers_guard_super_admin
  BEFORE UPDATE OR DELETE ON teachers
  FOR EACH ROW
  EXECUTE FUNCTION rbac_guard_super_admin();

-- ---------------------------------------------------------------------------
-- 6. never remove the last super_admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rbac_protect_last_super_admin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remaining integer;
  was_super boolean := OLD.roles IS NOT NULL AND 'super_admin' = ANY (OLD.roles);
  still_super boolean;
BEGIN
  IF NOT was_super THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  still_super := TG_OP = 'UPDATE'
                 AND NEW.roles IS NOT NULL
                 AND 'super_admin' = ANY (NEW.roles)
                 AND NEW.status = 'active';

  IF still_super THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO remaining
  FROM teachers
  WHERE id <> OLD.id
    AND status = 'active'
    AND roles IS NOT NULL
    AND 'super_admin' = ANY (roles);

  IF remaining = 0 THEN
    RAISE EXCEPTION
      'rbac: refused to remove, demote or deactivate the last active super_admin '
      '(target=%). Doing so would leave the system with no account able to manage '
      'super admins.', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_teachers_protect_last_super_admin ON teachers;
CREATE TRIGGER trg_teachers_protect_last_super_admin
  BEFORE UPDATE OR DELETE ON teachers
  FOR EACH ROW
  EXECUTE FUNCTION rbac_protect_last_super_admin();

-- ---------------------------------------------------------------------------
-- 7. session revocation metadata + permission version pinning
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permissions_version integer NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at      timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoke_reason   varchar(100);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device          varchar(200);

CREATE INDEX IF NOT EXISTS idx_sessions_revoked
  ON sessions(revoked) WHERE revoked = true;
CREATE INDEX IF NOT EXISTS idx_sessions_teacher_active
  ON sessions(teacher_id) WHERE revoked = false;

COMMENT ON COLUMN sessions.permissions_version IS
  'Value of teachers.permissions_version at session creation. AuthGuard rejects a '
  'session whose value no longer matches, forcing re-authentication.';

-- ---------------------------------------------------------------------------
-- 8. assertions — fail loudly rather than leaving a half-applied guard
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text := '';
BEGIN
  IF to_regclass('public.account_permission_overrides') IS NULL THEN
    missing := missing || 'account_permission_overrides ';
  END IF;
  IF to_regclass('public.account_scopes') IS NULL THEN
    missing := missing || 'account_scopes ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='teachers' AND column_name='permissions_version') THEN
    missing := missing || 'teachers.permissions_version ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='sessions' AND column_name='permissions_version') THEN
    missing := missing || 'sessions.permissions_version ';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_teachers_guard_super_admin'
             AND tgrelid = 'public.teachers'::regclass AND tgenabled = 'D') THEN
    missing := missing || 'super_admin trigger is DISABLED ';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '0003 incomplete: %', missing;
  END IF;
  RAISE NOTICE '0003: RBAC database layer installed (version bumping + super_admin guards)';
END
$$;
