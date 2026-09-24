/**
 * tests/helpers/reset-fixtures.mjs
 * ================================
 * Gives every live verification suite its OWN fixture accounts and its own rows,
 * so a suite depends on no state another suite (or another process) can change.
 *
 * WHY THIS EXISTS — AND WHY IT IS NOT CALLED `resetFixtures` ANY MORE
 * -------------------------------------------------------------------
 * The HTTP verification suites share ONE PostgreSQL database and ONE running
 * server. The first version of this helper solved order-dependence by RESETTING
 * the shared fixture accounts before every suite: restore role/status/password,
 * clear MFA, and revoke EVERY session in the database.
 *
 * That worked while only one suite existed at a time, and it was still wrong,
 * because two pieces of state are GLOBAL and cannot be "reset" without
 * disturbing whoever else is using them:
 *
 *   1. `teachers.permissions_version` is ACCOUNT-WIDE. The database trigger
 *      (migration 0003) bumps it on any change to `roles` or `status`, and
 *      `AuthGuard` turns a version mismatch into a 401 and destroys the session
 *      — in EVERY process, not just the one that made the change. So
 *      `verify-authz-http` demoting the shared administrator is indistinguishable,
 *      from another process's point of view, from an attacker revoking its
 *      session mid-run.
 *   2. `sessions` is GLOBAL. `update sessions set revoked = true` (which the old
 *      reset ran unconditionally) logs out every live suite at once.
 *
 * Verified consequence, reproduced on demand with two concurrent copies of
 * `verify-files-http.mjs`: both collapsed into a cascade of 401s
 * (`pass=50 fail=22`), which is a fake failure that says nothing about the
 * product. The same overlap produced `the resource is listed before deletion ->
 * 0 expected 1` / `submit-review -> 404`, because the two runs also shared one
 * literal probe-row title prefix and one run's cleanup deleted the other's row.
 *
 * THE FIX IS OWNERSHIP, NOT RETRIES
 * ---------------------------------
 * A suite must not depend on shared mutable state, so it is given its own:
 *
 *   * a fresh set of accounts per RUN (`__qt_<suite>_<key>_<runid>`), created
 *     here and deleted by the same run. A concurrent run cannot bump their
 *     `permissions_version`, cannot revoke their sessions, and cannot be
 *     disturbed by them.
 *   * probe rows namespaced per run (see the suites).
 *   * NO global reset: nothing in this file touches a seeded account, a session
 *     it does not own, or a row it did not create.
 *
 * Concurrency is therefore SAFE, not merely tolerated — which is why the
 * suites can keep running while another suite runs. What still must not overlap
 * is a whole GATE, because the gate runs `npm run build`, whose first step is
 * `rm -rf dist`, and the running server serves covers out of `dist/`
 * (see scripts/verify-files-http.mjs section J). That is enforced by an
 * advisory lock: `acquireGateLock()` (exclusive) for `scripts/verify-all.sh`,
 * `acquireSuiteLock()` (shared) for a suite started on its own.
 *
 * TWO NON-OBVIOUS RULES, both learned by hitting them
 * --------------------------------------------------
 * 1. Any write to a row holding `super_admin`, and any DELETE of a teacher, must
 *    declare super-admin authority INSIDE a transaction. The setting is
 *    transaction-local, so issuing `set_config(..., true)` and the statement as
 *    separate autocommit statements loses the flag and the trigger refuses with
 *    42501.
 *
 * 2. A KEEPER super_admin must exist before any suite promotes its own account.
 *    Otherwise that account becomes the LAST super_admin and
 *    `rbac_protect_last_super_admin` correctly refuses to demote or delete it,
 *    leaving a fixture no suite can clean up. `ensureKeeper()` is deliberately
 *    idempotent: once the keeper is already `{super_admin}:active` the UPDATE
 *    changes nothing, the version trigger returns early, and no other process's
 *    session is invalidated.
 */

import postgres from 'postgres';
import crypto from 'node:crypto';

export const KEEPER_USERNAME = '__rbac_keeper';
export const TEST_PASSWORD = 'TestPassw0rd!';

/** Prefix of every per-run account this helper creates. Never used by fixtures. */
export const RUN_ACCOUNT_PREFIX = '__qt_';

/**
 * Advisory-lock identity for "the shared verification environment".
 * The two-int form of the advisory-lock functions is used so the parameter types
 * are unambiguous; the values themselves are arbitrary but must not collide with
 * any other advisory-lock user in this database.
 */
const LOCK_NAMESPACE = 20812; // 'QL'
const LOCK_RESOURCE = 1;

/** Non-super roles a suite may ask for, mapped to their fixture key. */
export const ACCOUNT_ROLES = {
  admin: ['principal'],
  low: ['prek_assistant'],
  /**
   * A SECOND principal. "A principal may not reset a peer principal's password"
   * is a rule about EQUAL rank, so asserting it needs two accounts at one level.
   */
  admin2: ['principal'],
  /** A third principal: the IDOR target for `admin2` in the reset-password suite. */
  admin3: ['principal'],
  /**
   * Holds `account.view` (it can read the account list) but NOT
   * `account.reset_password` — the case that proves the reset route is
   * permission-gated rather than merely login-gated.
   */
  director: ['curriculum_director'],
  /** An ordinary teaching account: the legitimate reset TARGET for a principal. */
  head: ['prek_head'],
  /**
   * A system super administrator. Created directly (there is no BEFORE INSERT
   * trigger on `teachers`, only BEFORE UPDATE/DELETE, so `ensureKeeper()` is what
   * makes this reversible). Suites that only need it as a TARGET never log into
   * it: an un-enrolled super_admin is refused by AuthGuard's mandatory-MFA gate,
   * which is exactly the behaviour the MFA suite asserts.
   */
  superadmin: ['super_admin'],
};

function passwordHash(password) {
  // Same parameters as the application: scrypt N=16384, r=8, p=1, 16-byte salt.
  const salt = crypto.randomBytes(16).toString('base64');
  const derived = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('base64')}`;
}

function newRunId() {
  return `${process.pid.toString(36)}${Date.now().toString(36)}`;
}

/** Declare super-admin authority for the current transaction (transaction-local). */
async function declareSuperAdmin(tx) {
  await tx.unsafe("select set_config('app.rbac_actor_super_admin', 'on', true)");
}

/**
 * Guarantee a second super_admin exists. Idempotent, and a no-op (no trigger
 * bump, so no side effects for anyone else) once the keeper is already correct.
 */
export async function ensureKeeper(sql) {
  await sql.begin(async (tx) => {
    await declareSuperAdmin(tx);
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
}

/**
 * Take an EXCLUSIVE advisory lock on the shared verification environment.
 * Used by the gate (`scripts/verify-all.sh`), which mutates `dist/` and therefore
 * cannot share the environment with anything.
 *
 * Advisory locks are released by PostgreSQL when the holding connection ends, so
 * a crashed gate leaves no stale lock behind — unlike a lock file.
 */
export async function acquireGateLock(dbUrl) {
  const sql = postgres(dbUrl, { onnotice: () => {}, max: 1 });
  const [row] = await sql`select pg_try_advisory_lock(${LOCK_NAMESPACE}, ${LOCK_RESOURCE}) as ok`;
  if (!row?.ok) {
    await sql.end();
    throw new Error(
      'another verification run holds the shared environment: a gate is already running, ' +
        'or a suite started on its own is still live. Wait for it to finish (the gate rebuilds ' +
        'dist/, which the running server serves assets from).',
    );
  }
  return {
    release: async () => {
      await sql`select pg_advisory_unlock(${LOCK_NAMESPACE}, ${LOCK_RESOURCE})`;
      await sql.end();
    },
  };
}

/**
 * Take a SHARED advisory lock on the shared verification environment.
 * Shared locks coexist with each other (concurrent suites are safe now that each
 * one owns its accounts and rows) but not with the gate's exclusive lock.
 */
export async function acquireSuiteLock(dbUrl) {
  const sql = postgres(dbUrl, { onnotice: () => {}, max: 1 });
  const [row] = await sql`select pg_try_advisory_lock_shared(${LOCK_NAMESPACE}, ${LOCK_RESOURCE}) as ok`;
  if (!row?.ok) {
    await sql.end();
    throw new Error(
      'a verification GATE is running against this database right now. The gate rebuilds dist/, ' +
        'and the running server serves downloaded covers out of dist/, so a suite started while a ' +
        'gate is building would report a fake failure. Re-run this suite after the gate finishes.',
    );
  }
  return {
    release: async () => {
      await sql`select pg_advisory_unlock_shared(${LOCK_NAMESPACE}, ${LOCK_RESOURCE})`;
      await sql.end();
    },
  };
}

/**
 * Start a verification run.
 *
 * @param {string} dbUrl                AUTHZ_TEST_DB
 * @param {object} options
 * @param {string} options.suite        short suite name, part of every account name
 * @param {string[]} [options.accounts] account keys to create (default: all of ACCOUNT_ROLES)
 * @param {boolean} [options.lock]      take the shared suite lock (default: unless the
 *                                      gate says it already holds it)
 * @returns {Promise<{
 *   runId: string, sql: import('postgres').Sql,
 *   account: (key: string) => { id: string, username: string, roles: string[], password: string },
 *   ownUsernames: string[], ownUsernamesSql: (tx: any) => string[],
 *   cleanup: () => Promise<{ ok: boolean, error?: Error }>,
 * }>}
 */
export async function startVerificationRun(dbUrl, options = {}) {
  if (!dbUrl) {
    throw new Error(
      'AUTHZ_TEST_DB is not set. Every live suite needs it: it is how the suite creates its own ' +
        'fixture accounts and cleans them up again.',
    );
  }
  const suite = String(options.suite ?? 'suite').replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const keys = options.accounts ?? Object.keys(ACCOUNT_ROLES);
  const runId = newRunId();
  const wantsLock = options.lock ?? process.env.QLS_GATE_LOCK_HELD !== '1';

  const lock = wantsLock ? await acquireSuiteLock(dbUrl) : null;
  const sql = postgres(dbUrl, { onnotice: () => {}, max: 1 });
  const accounts = new Map();

  try {
    await ensureKeeper(sql);

    for (const key of keys) {
      const roles = ACCOUNT_ROLES[key];
      if (!roles) throw new Error(`unknown fixture account key: ${key}`);
      const username = `${RUN_ACCOUNT_PREFIX}${suite}_${key}_${runId}`;
      const hash = passwordHash(TEST_PASSWORD);
      // No BEFORE INSERT trigger guards `teachers` (only BEFORE UPDATE/DELETE), so a
      // fixture account can be created without declaring an actor. It holds no
      // privilege until a test grants it one, which those tests do explicitly.
      const [row] = await sql`
        insert into teachers (username, name, name_en, roles, status, password_hash)
        values (${username}, ${`验证账号 ${key}`}, ${`Verify ${key}`},
                ${roles}::varchar[], 'active', ${hash})
        returning id, username, roles`;
      accounts.set(key, {
        id: row.id,
        username: row.username,
        roles: roles.slice(),
        password: TEST_PASSWORD,
      });
    }
  } catch (error) {
    // Do not leave half a run behind: drop whatever was created, release the lock.
    await sql.end();
    if (lock) await lock.release();
    throw error;
  }

  const ownUsernames = [...accounts.values()].map((a) => a.username);
  const ownIds = [...accounts.values()].map((a) => a.id);

  let cleaned = false;

  return {
    runId,
    sql,
    ownUsernames,
    account(key) {
      const found = accounts.get(key);
      if (!found) throw new Error(`fixture account not created for this run: ${key}`);
      return found;
    },

    /**
     * Delete everything this run created and nothing else.
     *
     * Order matters: `resources.uploader_id` is ON DELETE NO ACTION, so a probe
     * row left behind by a crashed step would block the account delete. Rows
     * belonging to seeded accounts are never touched.
     *
     * Never throws: the caller reports a failed cleanup as a test failure rather
     * than losing the assertion results to an exception inside `finally`.
     */
    async cleanup() {
      if (cleaned) return { ok: true };
      cleaned = true;
      let result = { ok: true };
      try {
        await sql.begin(async (tx) => {
          await declareSuperAdmin(tx);
          const ids = tx(ownIds);
          const names = tx(ownUsernames);

          // Resources this run uploaded (and their audit trail) go first.
          await tx`delete from audit_logs where resource_id in (
                     select id from resources where uploader_id in ${ids})`;
          await tx`delete from resources where uploader_id in ${ids}`;
          // A run must never leave a review attribution pointing at a deleted account.
          await tx`update resources set reviewer_id = null where reviewer_id in ${ids}`;
          await tx`update review_records set reviewer_id = null where reviewer_id in ${ids}`;
          // Audit rows are not FK-linked to teachers, so remove them explicitly.
          await tx`delete from audit_logs where teacher_id in ${ids}`;
          // sessions / teacher_mfa / mfa_* / account_* / subject_permissions cascade.
          await tx`delete from teachers where username in ${names}`;
        });

        const leftovers = await sql`
          select count(*)::int as n from teachers where username in ${sql(ownUsernames)}`;
        if (leftovers[0].n !== 0) {
          throw new Error(`${leftovers[0].n} fixture account(s) survived cleanup`);
        }
      } catch (error) {
        result = { ok: false, error };
      }

      // Close the run's resources whatever happened above. A failure here is
      // reported, never discarded: it means a connection (and with it an advisory
      // lock) outlived the run.
      try {
        await sql.end();
      } catch (error) {
        result = { ok: false, error: result.error ?? error, closeError: error };
      }
      if (lock) {
        try {
          await lock.release();
        } catch (error) {
          result = { ok: false, error: result.error ?? error, lockError: error };
        }
      }
      return result;
    },
  };
}
