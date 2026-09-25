#!/usr/bin/env node
/**
 * scripts/db-bootstrap.mjs — build a database from ZERO
 * =====================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The rehearsal in `scripts/backup-rehearse.mjs` proved that neither of the two
 * obvious build orders works on a vanilla PostgreSQL cluster:
 *
 *   Order A: `init.sql` then `node scripts/migrate.mjs up`
 *     0001 fails: 42P01 relation "teachers" does not exist
 *     -> `init.sql` is the baseline DDL, but it does not create the
 *        `user_profile` composite type or the `anon`/`authenticated`/
 *        `service_role` roles it references, so it cannot run first on a plain
 *        cluster.
 *
 *   Order B: `node scripts/migrate.mjs up` then `init.sql`
 *     `init.sql` has no tables to align, and 0001's ALTERs fail for the same
 *     reason.
 *
 * The two orders are mutually dependent: `init.sql` needs the type and the roles;
 * `0001` needs the tables. Neither file can go first alone. On the 妙搭 platform
 * this never surfaced, because the platform provisions the database (including
 * the type and the roles) before either file is ever run — which is exactly why
 * the defect stayed hidden until a standalone build was attempted.
 *
 * This script supplies the missing prelude and then runs the two steps in the
 * only order that works:
 *
 *     1. idempotent prelude  — `user_profile` type + the three DB roles
 *     2. `init.sql`          — baseline tables, indexes, RLS policies
 *     3. `migrations up`     — the versioned, checksummed evolution
 *
 * The prelude is SOURCED FROM `0001_schema_baseline_alignment.sql` ITSELF rather
 * than copied here, so the two can never drift apart. `0001` already wraps both
 * steps in idempotent `DO $$ ... IF NOT EXISTS ... $$` guards precisely because
 * they are no-ops on the platform; running them early is therefore safe, and
 * running the whole file again afterwards is still a no-op for that part.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT a way to rebuild a production database. It is for standing up a
 * new environment and for rehearsing a restore. It never drops anything, and it
 * refuses to run against a database that already contains application tables
 * unless `--force` is given — see the guard below. Migrating an existing
 * production database is `scripts/migrate.mjs up`, and disaster recovery is
 * `pg_restore`, not this.
 *
 * USAGE
 *   node scripts/db-bootstrap.mjs --url "postgresql://user:pw@host:5432/dbname"
 *   DATABASE_URL=... node scripts/db-bootstrap.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) args[k] = true;
  else {
    args[k] = v;
    i += 1;
  }
}

const url =
  (typeof args.url === 'string' ? args.url : '') ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_CONNECTION_STRING ||
  process.env.POSTGRES_URI ||
  process.env.SUDA_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  '';

if (!url) {
  console.error(
    '[bootstrap] no database URL. Pass --url <url> or set DATABASE_URL.',
  );
  process.exit(2);
}

const ROOT = process.cwd();
const MIGRATION_0001 = resolve(
  ROOT,
  'server/database/migrations/0001_schema_baseline_alignment.sql',
);
const INIT_SQL = resolve(ROOT, 'server/database/init.sql');

for (const f of [MIGRATION_0001, INIT_SQL]) {
  if (!existsSync(f)) {
    console.error(`[bootstrap] required file not found: ${f}`);
    process.exit(2);
  }
}

/**
 * Pull the first two idempotent `DO $$ ... $$;` blocks out of migration 0001.
 * Those are, in file order, the `user_profile` type guard and the
 * `anon`/`authenticated`/`service_role` role guard — the two things `init.sql`
 * needs to exist. Any later block in that file operates on application tables and
 * must NOT run before `init.sql`, so the count is asserted rather than assumed.
 */
function extractPrelude() {
  const sql = readFileSync(MIGRATION_0001, 'utf8');
  const blocks = sql.match(/DO \$\$[\s\S]*?\$\$;/g) ?? [];
  if (blocks.length < 2) {
    console.error(
      `[bootstrap] expected at least 2 DO $$ blocks in 0001, found ${blocks.length}. ` +
        'The file changed shape; refusing to guess which blocks are safe to run early.',
    );
    process.exit(1);
  }
  return blocks.slice(0, 2);
}

const prelude = extractPrelude();

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  // ---------------------------------------------------------------------------
  // Guard: never run this against a database that already holds the application.
  // ---------------------------------------------------------------------------
  const existing = await sql`
    SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `;
  const tables = existing.map((r) => r.name);
  const looksPopulated = tables.includes('teachers') || tables.includes('resources');

  if (looksPopulated && args.force !== true) {
    console.error(
      `[bootstrap] REFUSING: this database already has application tables ` +
        `(${tables.length} tables, includes teachers/resources).\n` +
        '  Bootstrapping is for a NEW environment. To evolve an existing\n' +
        '  database use:  node scripts/migrate.mjs status && node scripts/migrate.mjs up\n' +
        '  Re-run with --force only if you are certain.',
    );
    process.exit(1);
  }

  console.log('=== 1/3 prelude (user_profile type + DB roles) ===');
  for (const [i, block] of prelude.entries()) {
    await sql.unsafe(block);
    console.log(`  applied prelude block ${i + 1}/${prelude.length}`);
  }

  console.log('=== 2/3 init.sql (baseline DDL) ===');
  const initSql = readFileSync(INIT_SQL, 'utf8');
  try {
    await sql.unsafe(initSql);
  } catch (error) {
    // init.sql re-creating objects is the expected outcome on a partially built
    // database. Report precisely; never swallow.
    console.error(
      `  init.sql failed: [${error.code ?? '?'}] ${error.message ?? error}`,
    );
    if (error.hint) console.error(`  hint: ${error.hint}`);
    console.error(
      '  init.sql is not written to be re-runnable. If the database was already\n' +
        '  partially built, inspect it and use migrations instead of re-bootstrapping.',
    );
    process.exit(1);
  }
  console.log('  init.sql applied');

  console.log('=== 3/3 migrations up ===');
  const run = spawnSync(
    process.execPath,
    [resolve(ROOT, 'scripts/migrate.mjs'), 'up'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: url,
        SUDA_DATABASE_URL: url,
        MIGRATION_DATABASE_URL: url,
      },
    },
  );
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status !== 0) {
    console.error('[bootstrap] migrations failed — database is NOT ready.');
    process.exit(1);
  }

  console.log('');
  console.log('[bootstrap] database built from zero and migrated.');
} finally {
  await sql.end();
}
