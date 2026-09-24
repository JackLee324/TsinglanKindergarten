/**
 * tests/helpers/reset-fixtures.mjs
 * ================================
 * Puts the shared verification database into a KNOWN state before a suite runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The three HTTP verification scripts (verify-authz-http, verify-hardening,
 * verify-mfa) run against the SAME database and each mutates it:
 *
 *   * verify-authz-http demotes an administrator to prove instant revocation;
 *   * verify-mfa enrols TOTP, promotes an account to super_admin, and leaves MFA
 *     state behind unless it cleans up;
 *   * verify-hardening resets passwords.
 *
 * Running them in sequence therefore produced failures that had nothing to do
 * with what each suite was testing — verified symptoms were:
 *   - "login succeeds -> 201 expected" then a later suite seeing `mfaRequired`
 *     because a previous run had left MFA enabled;
 *   - a fixture account stuck AS super_admin and impossible to demote, because
 *     `rbac_protect_last_super_admin` correctly refuses to remove the LAST one;
 *   - the shared per-IP login rate limit being exhausted.
 *
 * A suite that only passes when run first, or only when run alone, is not a
 * regression gate. Each suite now calls this helper first, so order does not
 * matter and a run is repeatable.
 *
 * TWO NON-OBVIOUS RULES, both learned by hitting them
 * --------------------------------------------------
 * 1. Any write to a row holding `super_admin` must declare super-admin authority
 *    INSIDE a transaction. The setting is transaction-local, so issuing
 *    `set_config(..., true)` and the UPDATE as separate autocommit statements
 *    loses the flag and the trigger refuses with 42501.
 *
 * 2. A KEEPER super_admin must exist. Otherwise promoting a fixture account makes
 *    it the last super_admin, and the guard then refuses to demote it — leaving
 *    the database in a state no suite can reset. The keeper is deliberately left
 *    in place; deleting it re-creates the deadlock.
 */

import postgres from 'postgres';
import crypto from 'node:crypto';

export const KEEPER_USERNAME = '__rbac_keeper';
export const TEST_PASSWORD = 'TestPassw0rd!';

/** Fixture accounts and the role each suite expects to start from. */
export const FIXTURE_ROLES = {
  qlsadmin: ['principal'],
  'prek-teacher01': ['prek_assistant'],
  qlsdirector: ['curriculum_director'],
};

function passwordHash(password) {
  // Same parameters as the application: scrypt N=16384, r=8, p=1, 16-byte salt.
  const salt = crypto.randomBytes(16).toString('base64');
  const derived = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('base64')}`;
}

/**
 * Reset the shared fixtures. Returns the connection so a suite can reuse it.
 * Throws if the database is unreachable — a suite must not silently proceed
 * against an inconsistent fixture.
 */
export async function resetFixtures(dbUrl, options = {}) {
  const password = options.password ?? TEST_PASSWORD;
  const sql = postgres(dbUrl, { onnotice: () => {}, max: 1 });

  const hash = passwordHash(password);

  // ---- keeper first: without a second super_admin, promoting a fixture account
  //      makes it the last one and it can never be demoted again.
  await sql.begin(async (tx) => {
    await tx.unsafe("select set_config('app.rbac_actor_super_admin', 'on', true)");
    const existing = await tx`select id from teachers where username = ${KEEPER_USERNAME}`;
    if (existing.length === 0) {
      await tx`
        insert into teachers (username, name, name_en, roles, status)
        values (${KEEPER_USERNAME}, 'RBAC 守护账号', 'RBAC Keeper',
                array['super_admin'], 'active')`;
    } else {
      await tx`
        update teachers set roles = array['super_admin'], status = 'active'
        where username = ${KEEPER_USERNAME}`;
    }
  });

  // ---- restore every fixture account: role, status, password, and NO MFA
  for (const [username, roles] of Object.entries(FIXTURE_ROLES)) {
    const rows = await sql`select id from teachers where username = ${username}`;
    if (rows.length === 0) continue;
    const id = rows[0].id;

    // MFA state must be cleared for EVERY fixture account, not just the one the
    // MFA suite happens to use: a leftover enrolment makes the account's login
    // stop at the second factor, and every other suite then reports a misleading
    // failure.
    await sql`delete from teacher_mfa where teacher_id = ${id}`;
    await sql`delete from mfa_recovery_codes where teacher_id = ${id}`;
    await sql`delete from mfa_challenges where teacher_id = ${id}`;

    await sql.begin(async (tx) => {
      await tx.unsafe("select set_config('app.rbac_actor_super_admin', 'on', true)");
      await tx`
        update teachers
           set password_hash = ${hash},
               roles = ${roles}::varchar[],
               status = 'active',
               failed_login_attempts = 0,
               locked_until = null
         where id = ${id}`;
    });
  }

  // ---- clear any session left over from a previous run so the suites start
  //      unauthenticated
  await sql`update sessions set revoked = true, revoked_at = now(),
            revoke_reason = 'test_fixture_reset' where revoked = false`;

  return sql;
}
