/**
 * tests/rbac-database.test.mjs — database-level RBAC enforcement
 * ==============================================================
 * Proves the guarantees in migration 0003 hold IN THE DATABASE, so they survive
 * an application-layer bug — which is the whole point of putting them in triggers.
 *
 * Everything here runs against real PostgreSQL. The expectations were established
 * empirically first and are asserted here so they cannot silently regress.
 *
 * IMPORTANT IMPLEMENTATION CONSTRAINT DISCOVERED WHILE WRITING THIS
 *   `set_config('app.rbac_actor_super_admin', 'on', true)` is TRANSACTION-LOCAL.
 *   Across separate autocommit statements the flag is immediately lost:
 *
 *       await sql`select set_config(...,true)`      // flag = 'on'
 *       await sql`update teachers ...`              // flag already gone  <-- BLOCKED
 *
 *   Therefore the service layer MUST wrap super-admin writes in an explicit
 *   transaction, and the tests below do the same. Getting this wrong makes every
 *   legitimate super-admin operation fail closed with 42501.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { buildLegacyFixture, dbUrl } from './helpers/legacy-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = 'qls_test_rbac_db';
const DB_URL = dbUrl(TEST_DB);

let dbAvailable = false;
try {
  const probe = postgres(dbUrl('postgres'), { max: 1, onnotice: () => {} });
  await probe`SELECT 1`;
  await probe.end({ timeout: 5 });
  dbAvailable = true;
} catch (err) {
  if (process.env.QLS_ALLOW_NO_DB === '1') {
    console.warn(`\n  ⚠ SKIPPING RBAC database tests: ${err.message}\n`);
  } else {
    throw new Error(
      `RBAC database tests require PostgreSQL:\n  ${err.message}\n` +
        '  Start one with:  bash scripts/dev-postgres.sh start',
    );
  }
}

const describeIfDb = () => (dbAvailable ? describe : describe.skip);

/** Run `fn` with super-admin authority declared, inside one transaction. */
function asSuperAdmin(sql, fn) {
  return sql.begin(async (tx) => {
    await tx.unsafe("select set_config('app.rbac_actor_super_admin', 'on', true)");
    return fn(tx);
  });
}

/** Run `fn` with only an actor id (i.e. a NON super-admin caller) in one transaction. */
function asActor(sql, actorId, fn) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`select set_config('app.rbac_actor_id', '${actorId}', true)`);
    return fn(tx);
  });
}

/** Assert the statement is refused with the privilege error the trigger raises. */
async function assertBlocked(promise, label) {
  await assert.rejects(
    promise,
    (err) => {
      assert.equal(err.code, '42501', `${label}: expected insufficient_privilege (42501), got ${err.code}`);
      return true;
    },
    `${label}: the database must refuse this`,
  );
}

describeIfDb()('RBAC database enforcement (migration 0003)', () => {
  /** @type {import('postgres').Sql} */
  let sql;
  let A; // becomes super_admin
  let B; // a second account
  let C; // a plain account used for version-bump checks

  test('fixture + migrations 0001-0003 apply cleanly', async () => {
    await buildLegacyFixture(TEST_DB);
    execFileSync('node', [join(ROOT, 'scripts/migrate.mjs'), 'up'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: DB_URL },
      stdio: 'pipe',
    });
    sql = postgres(DB_URL, { max: 1, onnotice: () => {} });

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'teachers' AND column_name = 'permissions_version'`;
    assert.equal(cols.length, 1, 'teachers.permissions_version must exist');

    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN
        ('account_permission_overrides','account_scopes')`;
    assert.equal(tables.length, 2, 'RBAC tables must exist');

    const accounts = await sql`
      SELECT id FROM teachers WHERE username IS NOT NULL ORDER BY username LIMIT 3`;
    assert.ok(accounts.length >= 3, 'fixture must provide accounts');
    [A, B, C] = accounts.map((r) => r.id);
  });

  test('set_config(local) does NOT persist across autocommit statements', async () => {
    // This documents the constraint the service layer must respect. If a future
    // PostgreSQL or driver version changes this, the test fails and forces a
    // deliberate decision rather than a silent behaviour change.
    await sql.unsafe("select set_config('app.rbac_actor_super_admin', 'on', true)");
    const [{ v }] = await sql`
      SELECT coalesce(current_setting('app.rbac_actor_super_admin', true), '') AS v`;
    assert.equal(v, '', 'a transaction-local setting must be gone after the statement');
  });

  test('ESCALATION: a non-super-admin cannot grant super_admin', async () => {
    await assertBlocked(
      sql`update teachers set roles = array['super_admin'] where id = ${B}`,
      'grant super_admin without authority',
    );
  });

  test('bootstrap: a super_admin can promote the first super_admin', async () => {
    const changed = await asSuperAdmin(sql, (tx) =>
      tx`update teachers set roles = array['super_admin'] where id = ${A}`.then((r) => r.count),
    );
    assert.equal(changed, 1, 'bootstrap promotion must succeed inside a super transaction');
  });

  test('PROTECTION: a non-super-admin cannot modify a super_admin', async () => {
    await assertBlocked(sql`update teachers set roles = array['principal'] where id = ${A}`, 'demote');
    await assertBlocked(sql`update teachers set status = 'inactive' where id = ${A}`, 'disable');
    await assertBlocked(sql`delete from teachers where id = ${A}`, 'delete');
    await assertBlocked(sql`update teachers set password_hash = 'evil' where id = ${A}`, 'reset password');
    await assertBlocked(sql`update teachers set username = 'hacked' where id = ${A}`, 'rename');
    await assertBlocked(sql`update teachers set name = 'hacked' where id = ${A}`, 'rename name');
  });

  test('LOGIN MUST NOT BREAK: operational counters on a super_admin are allowed', async () => {
    // If the trigger guarded these, a super_admin could never log in: the login
    // flow writes failed_login_attempts / last_login_at before identity is known.
    const changed = await sql`
      update teachers
         set last_login_at = now(), failed_login_attempts = 2, locked_until = null
       where id = ${A}`.then((r) => r.count);
    assert.equal(changed, 1, 'login counters must remain writable');
  });

  test('LAST SUPER ADMIN: cannot be demoted, deleted or deactivated', async () => {
    await assertBlocked(
      asSuperAdmin(sql, (tx) => tx`update teachers set roles = array['principal'] where id = ${A}`),
      'demote last super_admin',
    );
    await assertBlocked(
      asSuperAdmin(sql, (tx) => tx`delete from teachers where id = ${A}`),
      'delete last super_admin',
    );
    await assertBlocked(
      asSuperAdmin(sql, (tx) => tx`update teachers set status = 'inactive' where id = ${A}`),
      'deactivate last super_admin',
    );
  });

  test('a second super_admin may be created, after which the first can be demoted', async () => {
    await asSuperAdmin(sql, (tx) =>
      tx`update teachers set roles = array['super_admin'] where id = ${B}`,
    );
    const count = await sql`
      SELECT count(*)::int c FROM teachers WHERE status='active' AND 'super_admin' = ANY(roles)`;
    assert.equal(count[0].c, 2, 'two active super admins expected');

    const demoted = await asSuperAdmin(sql, (tx) =>
      tx`update teachers set roles = array['principal'] where id = ${A}`.then((r) => r.count),
    );
    assert.equal(demoted, 1, 'demoting one of two super admins must be allowed');

    await assertBlocked(
      asSuperAdmin(sql, (tx) => tx`update teachers set roles = array['principal'] where id = ${B}`),
      'demote the now-last super_admin',
    );
  });

  test('SELF-SERVICE: a super_admin may change its own password', async () => {
    const changed = await asActor(sql, B, (tx) =>
      tx`update teachers set password_hash = 'scrypt$self' where id = ${B}`.then((r) => r.count),
    );
    assert.equal(changed, 1, 'an account must be able to rotate its own password');
  });

  test('permissions_version bumps on role change, override and scope change', async () => {
    const version = async () =>
      (await sql`SELECT permissions_version v FROM teachers WHERE id = ${C}`)[0].v;

    let before = await version();
    await sql`UPDATE teachers SET roles = array['k_head','prek_assistant'] WHERE id = ${C}`;
    let after = await version();
    assert.ok(after > before, `role change must bump (${before} -> ${after})`);

    before = after;
    await sql`
      INSERT INTO account_permission_overrides (teacher_id, permission, effect, reason)
      VALUES (${C}, 'review.approve', 'grant', 'test')`;
    after = await version();
    assert.ok(after > before, `override insert must bump (${before} -> ${after})`);

    before = after;
    await sql`
      INSERT INTO account_scopes (teacher_id, kind, program) VALUES (${C}, 'PROGRAM', 'prek')`;
    after = await version();
    assert.ok(after > before, `scope insert must bump (${before} -> ${after})`);

    before = after;
    await sql`DELETE FROM account_permission_overrides WHERE teacher_id = ${C}`;
    after = await version();
    assert.ok(after > before, `override delete must bump (${before} -> ${after})`);
  });

  test('an operational update that changes nothing privileged does NOT bump', async () => {
    const before = (await sql`SELECT permissions_version v FROM teachers WHERE id = ${C}`)[0].v;
    await sql`UPDATE teachers SET last_login_at = now() WHERE id = ${C}`;
    const after = (await sql`SELECT permissions_version v FROM teachers WHERE id = ${C}`)[0].v;
    assert.equal(after, before, 'login activity must not invalidate sessions');
  });

  test('scope table rejects shapes that cannot be evaluated', async () => {
    await assert.rejects(
      () => sql`INSERT INTO account_scopes (teacher_id, kind, subject) VALUES (${C}, 'SUBJECT', 'math')`,
      (err) => {
        assert.equal(err.code, '23514', 'a SUBJECT scope without a program must violate the CHECK');
        return true;
      },
    );
    await assert.rejects(
      () => sql`INSERT INTO account_scopes (teacher_id, kind, program) VALUES (${C}, 'OWN', 'prek')`,
      (err) => {
        assert.equal(err.code, '23514', 'an OWN scope must not carry a program');
        return true;
      },
    );
  });

  test('override table rejects an unknown effect and duplicate permissions', async () => {
    await assert.rejects(
      () => sql`INSERT INTO account_permission_overrides (teacher_id, permission, effect)
                VALUES (${C}, 'resource.view', 'maybe')`,
      (err) => {
        assert.equal(err.code, '23514');
        return true;
      },
    );
    await sql`INSERT INTO account_permission_overrides (teacher_id, permission, effect)
              VALUES (${C}, 'resource.view', 'deny')`;
    await assert.rejects(
      () => sql`INSERT INTO account_permission_overrides (teacher_id, permission, effect)
                VALUES (${C}, 'resource.view', 'grant')`,
      (err) => {
        assert.equal(err.code, '23505', 'one row per (teacher, permission)');
        return true;
      },
    );
  });

  test('cleanup', async () => {
    await sql.end({ timeout: 5 }).catch(() => {});
  });
});
