/**
 * tests/migration.test.mjs — migration framework + schema-hardening tests
 * =======================================================================
 * Run with:  npm test          (or: node --test tests/migration.test.mjs)
 *
 * These are REAL tests against a REAL PostgreSQL server. They build a legacy
 * database in the exact broken state the shipped code produces, migrate it, and
 * assert that no data was lost, no account was duplicated and the application's
 * authentication stack now works.
 *
 * DATABASE REQUIREMENT
 *   A PostgreSQL server is required. If none is reachable the suite FAILS with
 *   an actionable message rather than silently passing — a green run must mean
 *   the database work was actually verified.
 *
 *   Start one with:   bash scripts/dev-postgres.sh start
 *   Escape hatch for environments that genuinely cannot run PostgreSQL (CI lint
 *   jobs only):  QLS_ALLOW_NO_DB=1  — the suite then reports SKIPPED loudly.
 */

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { buildLegacyFixture, dbUrl } from './helpers/legacy-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = 'qls_test_migration';
const DB_URL = dbUrl(TEST_DB);
const MIG_0001 = join(ROOT, 'server/database/migrations/0001_schema_baseline_alignment.sql');

function runMigrate(args, extraEnv = {}) {
  return execFileSync('node', [join(ROOT, 'scripts/migrate.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB_URL, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runMigrateExpectFail(args) {
  try {
    execFileSync('node', [join(ROOT, 'scripts/migrate.mjs'), ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: DB_URL },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { failed: false, code: 0, output: '' };
  } catch (err) {
    return { failed: true, code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

async function withSql(fn) {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

const AUTH_COLUMNS = [
  'username',
  'password_hash',
  'must_change_password',
  'failed_login_attempts',
  'locked_until',
  'password_updated_at',
];

let dbAvailable = false;
let skipReason = '';

// NOTE: this check MUST run at module load (top-level await), not inside a
// `before()` hook. `describe`/`describe.skip` is evaluated while the file is being
// parsed, i.e. before any hook executes, so deciding availability in a hook made
// the whole suite report SKIP even when PostgreSQL was up — a silently green run,
// which is exactly what these tests exist to prevent.
try {
  const admin = postgres(dbUrl('postgres'), { max: 1, onnotice: () => {} });
  await admin`SELECT 1`;
  await admin.end({ timeout: 5 });
  dbAvailable = true;
} catch (err) {
  dbAvailable = false;
  skipReason = err.message;
  if (process.env.QLS_ALLOW_NO_DB === '1') {
    console.warn(`\n  ⚠ SKIPPING migration tests: no PostgreSQL reachable (${skipReason})`);
    console.warn('    QLS_ALLOW_NO_DB=1 was set. These tests were NOT run.\n');
  } else {
    throw new Error(
      `Migration tests require PostgreSQL, which is not reachable:\n  ${skipReason}\n` +
        '  Start one with:  bash scripts/dev-postgres.sh start\n' +
        '  (Set QLS_ALLOW_NO_DB=1 only for lint-only CI jobs; that skips these tests.)',
    );
  }
}

const describeIfDb = () => (dbAvailable ? describe : describe.skip);

describeIfDb()('migration framework', () => {
  test('legacy fixture reproduces the broken shipped state', async () => {
    const summary = await buildLegacyFixture(TEST_DB);
    assert.equal(summary.hasAuthColumns, 0, 'fixture must start WITHOUT auth columns');
    assert.equal(summary.resources, 347, 'fixture must contain the 347 seeded resources');
    assert.ok(summary.teachers >= 21, 'fixture must contain the legacy accounts');
  });

  test('status reports pending migrations before they are applied', () => {
    const out = runMigrate(['status']);
    assert.match(out, /pending/, 'status should list pending migrations');
  });

  test('up applies migrations and adds every required auth column', async () => {
    const out = runMigrate(['up']);
    assert.match(out, /applied/, 'up should report an applied migration');

    await withSql(async (sql) => {
      const cols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='teachers'`;
      const have = new Set(cols.map((c) => c.column_name));
      for (const c of AUTH_COLUMNS) {
        assert.ok(have.has(c), `teachers.${c} must exist after migration`);
      }
      const nullable = await sql`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name='teachers' AND column_name='wecom_user_id'`;
      assert.equal(nullable[0].is_nullable, 'YES', 'wecom_user_id must be nullable');
      const idx = await sql`
        SELECT 1 FROM pg_indexes WHERE tablename='teachers' AND indexname='idx_teachers_username'`;
      assert.equal(idx.length, 1, 'case-insensitive username index must exist');
    });
  });

  test('NO DATA LOSS: row counts are identical before and after migration', async () => {
    // Rebuild, snapshot, migrate, compare — using the shipped tools, so the test
    // exercises the same code path an operator would run.
    await buildLegacyFixture(TEST_DB);
    const snapBefore = join('/tmp', 'qls-mig-test-before.json');
    const snapAfter = join('/tmp', 'qls-mig-test-after.json');

    execFileSync('node', [join(ROOT, 'scripts/db-snapshot.mjs'), '--out', snapBefore], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe',
    });
    const before = JSON.parse(readFileSync(snapBefore, 'utf8'));

    runMigrate(['up']);

    execFileSync('node', [join(ROOT, 'scripts/db-snapshot.mjs'), '--out', snapAfter], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe',
    });
    const after = JSON.parse(readFileSync(snapAfter, 'utf8'));

    for (const t of ['teachers', 'resources', 'review_records', 'audit_logs']) {
      assert.equal(after.counts[t], before.counts[t], `${t} row count must not change`);
    }
    assert.equal(after.counts.resources, 347, 'all 347 curriculum resources must survive');

    // and the shipped comparison tool must also agree
    const cmp = execFileSync(
      'node',
      [join(ROOT, 'scripts/db-snapshot.mjs'), '--compare', snapBefore, '--against', snapAfter],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.match(cmp, /No data loss/, 'db-snapshot comparison must report no data loss');
  });

  test('DUPLICATE PREVENTION: legacy accounts are backfilled, not duplicated', async () => {
    // This is the exact bug the 0002 migration exists to prevent: a pre-v1.3.0
    // account has no username, so the credential seeder cannot match it and
    // inserts a second account.
    await withSql(async (sql) => {
      const before = await sql`SELECT count(*)::int c FROM teachers`;
      const noUsername = await sql`
        SELECT count(*)::int c FROM teachers WHERE username IS NULL`;
      assert.equal(noUsername[0].c, 0, 'every legacy account must have a username after 0002');

      // simulate what the seeder does: look up by lower(username)
      const seeded = await sql`
        SELECT count(*)::int c FROM teachers WHERE lower(username) = 'qlsadmin'`;
      assert.equal(seeded[0].c, 1, 'exactly one account must answer to each seeded username');
      assert.ok(before[0].c >= 21);
    });
  });

  test('idempotency: a second `up` changes nothing', async () => {
    const out = runMigrate(['up']);
    assert.match(out, /Nothing to apply|up to date/);
  });

  test('CHECKSUM DRIFT: editing an applied migration makes `up` fail with a non-zero code', () => {
    const backup = readFileSync(MIG_0001);
    try {
      writeFileSync(MIG_0001, Buffer.concat([backup, Buffer.from('\n-- tampered by test\n')]));
      const result = runMigrateExpectFail(['up']);
      assert.ok(result.failed, 'up must fail when an applied migration was modified');
      assert.notEqual(result.code, 0, 'exit code must be non-zero');
      assert.match(result.output, /drift|Refusing/i, 'failure must explain the drift');
    } finally {
      writeFileSync(MIG_0001, backup); // restore
    }
  });

  test('verify passes once the file is restored', () => {
    const out = runMigrate(['verify']);
    assert.match(out, /Checksums verified/);
  });

  test('ROLLBACK SAFETY: down refuses to destroy credential data', async () => {
    // Give an account a password hash, then attempt to roll back 0001.
    await withSql(async (sql) => {
      await sql`UPDATE teachers SET password_hash = 'scrypt$test' WHERE username = 'qlsadmin'`;
    });

    const downSql = readFileSync(
      join(ROOT, 'server/database/migrations/0001_schema_baseline_alignment.down.sql'),
      'utf8',
    );
    await withSql(async (sql) => {
      await assert.rejects(
        () => sql.unsafe(downSql),
        (err) => {
          assert.match(err.message, /refused|destroy credential/i);
          return true;
        },
        'the 0001 rollback must refuse while any teacher holds credentials',
      );
    });
  });

  test('ROLLBACK works when it is safe, and preserves data', async () => {
    // Fresh fixture with no credentials set, so the guard should allow the rollback.
    const SAFE_DB = 'qls_test_rollback';
    await buildLegacyFixture(SAFE_DB);
    const safeUrl = dbUrl(SAFE_DB);
    const env = { ...process.env, DATABASE_URL: safeUrl };

    execFileSync('node', [join(ROOT, 'scripts/migrate.mjs'), 'up', '0001'], { cwd: ROOT, env, stdio: 'pipe' });
    const up = postgres(safeUrl, { max: 1, onnotice: () => {} });
    const added = await up`
      SELECT count(*)::int c FROM information_schema.columns
      WHERE table_name='teachers' AND column_name='password_hash'`;
    assert.equal(added[0].c, 1, 'column added by up');
    await up.end({ timeout: 5 });

    execFileSync('node', [join(ROOT, 'scripts/migrate.mjs'), 'down', '0001'], { cwd: ROOT, env, stdio: 'pipe' });

    const down = postgres(safeUrl, { max: 1, onnotice: () => {} });
    const removed = await down`
      SELECT count(*)::int c FROM information_schema.columns
      WHERE table_name='teachers' AND column_name='password_hash'`;
    assert.equal(removed[0].c, 0, 'column removed by down');
    const teachers = await down`SELECT count(*)::int c FROM teachers`;
    const resources = await down`SELECT count(*)::int c FROM resources`;
    await down.end({ timeout: 5 });

    assert.ok(teachers[0].c >= 21, 'accounts preserved through the round-trip');
    assert.equal(resources[0].c, 347, 'resources preserved through the round-trip');
  });
});
