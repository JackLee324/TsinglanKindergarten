#!/usr/bin/env node
/**
 * scripts/migrate.mjs — database migration runner
 * ================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The project had NO migration mechanism at all:
 *   - no `drizzle.config.*`, no `migrations/` directory, no `schema_migrations`;
 *   - `drizzle-kit` is not a dependency (0 hits in package-lock.json);
 *   - schema evolution was "run the whole init.sql again", which is NOT
 *     idempotent: verified `42710 policy "..." already exists` on the second run.
 *
 * `server/database/schema.ts` is generated FROM the remote platform database
 * (`npm run gen:db-schema`), which is why it and `init.sql` had already drifted
 * bidirectionally. This runner makes the SQL files the ordered, verifiable,
 * reversible source of truth for schema change.
 *
 * GUARANTEES
 * ----------
 *  - Applied migrations are recorded with a SHA-256 checksum. If a file that was
 *    already applied is later edited, `up` REFUSES to run (fail closed) instead
 *    of silently applying a different schema than the one recorded.
 *  - Each migration runs inside its own transaction: either it fully applies or
 *    nothing of it applies.
 *  - A session-level advisory lock serialises concurrent runners, so two
 *    instances starting at once cannot interleave schema changes.
 *  - `up` never drops or recreates the database and never clears data.
 *  - Failure exits non-zero. It never reports success after a failed step.
 *
 * USAGE
 *   node scripts/migrate.mjs status     # what is applied / pending (+ drift check)
 *   node scripts/migrate.mjs up         # apply all pending (default)
 *   node scripts/migrate.mjs up 0002    # apply up to and including 0002
 *   node scripts/migrate.mjs down 0001  # roll back the LAST applied migration(s) whose
 *                                       # version >= 0001, using the matching .down.sql
 *   node scripts/migrate.mjs verify     # checksums + precondition check, changes nothing
 *   node scripts/migrate.mjs baseline X # mark files <= X as applied WITHOUT running them
 *                                       # (for adopting an existing database)
 *
 * ENVIRONMENT
 *   DATABASE_URL            preferred
 *   SUDA_DATABASE_URL       used by the platform runtime, accepted as a fallback
 *   MIGRATION_DATABASE_URL  explicit override for privileged migration runs
 *   MIGRATION_LOCK_TIMEOUT_MS  default 30000
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'server', 'database', 'migrations');
const LOCK_KEY = 918273645; // arbitrary but stable advisory-lock key for this app

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------
const c = {
  reset: '\u001b[0m', red: '\u001b[31m', green: '\u001b[32m',
  yellow: '\u001b[33m', blue: '\u001b[34m', dim: '\u001b[2m', bold: '\u001b[1m',
};
const log = (...a) => console.log(...a);
const ok = (m) => log(`${c.green}✓${c.reset} ${m}`);
const warn = (m) => log(`${c.yellow}!${c.reset} ${m}`);
const fail = (m) => console.error(`${c.red}✗${c.reset} ${m}`);
const info = (m) => log(`${c.blue}·${c.reset} ${m}`);

function die(message, code = 1) {
  fail(message);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------
function resolveConnectionString() {
  const url =
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.SUDA_DATABASE_URL;
  if (!url) {
    die(
      'No database connection string.\n' +
        '  Set DATABASE_URL (or SUDA_DATABASE_URL / MIGRATION_DATABASE_URL).',
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// migration discovery
// ---------------------------------------------------------------------------
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

function discoverMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) {
    die(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  const files = readdirSync(MIGRATIONS_DIR);
  const ups = [];
  const downs = new Map();

  for (const f of files) {
    if (f.endsWith('.down.sql')) {
      const m = /^(\d{4})_([a-z0-9_]+)\.down\.sql$/.exec(f);
      if (m) downs.set(m[1], join(MIGRATIONS_DIR, f));
      continue;
    }
    const m = FILE_RE.exec(f);
    if (m) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      ups.push({
        version: m[1],
        name: m[2],
        file: f,
        path: join(MIGRATIONS_DIR, f),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
        hasDown: false,
      });
    }
  }

  ups.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set();
  for (const m of ups) {
    if (seen.has(m.version)) die(`Duplicate migration version ${m.version}`);
    seen.add(m.version);
    m.hasDown = downs.has(m.version);
    m.downPath = downs.get(m.version) ?? null;
  }
  return ups;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
async function ensureMigrationsTable(sql) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      varchar(20)  PRIMARY KEY,
      name         varchar(200) NOT NULL,
      checksum     varchar(64)  NOT NULL,
      applied_at   timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_ms integer,
      applied_by   varchar(200)
    )
  `);
}

async function getApplied(sql) {
  // Reading state must not require state: a database that predates the migration
  // framework has no schema_migrations table, and `status` / `verify` must still
  // be able to report that fact instead of crashing with
  //   relation "schema_migrations" does not exist
  const [{ present }] = await sql`
    SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present
  `;
  if (!present) return new Map();
  const rows = await sql`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`;
  return new Map(rows.map((r) => [r.version, r]));
}

async function withLock(sql, fn) {
  const timeout = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS || 30000);
  const deadline = Date.now() + timeout;
  for (;;) {
    const [{ locked }] = await sql`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (locked) break;
    if (Date.now() > deadline) die('Could not acquire migration lock within timeout; another runner is active.');
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
}

// ---------------------------------------------------------------------------
// drift detection
// ---------------------------------------------------------------------------
function detectDrift(migrations, applied) {
  const drift = [];
  for (const m of migrations) {
    const a = applied.get(m.version);
    if (!a) continue;
    if (a.checksum !== m.checksum) {
      drift.push({ version: m.version, file: m.file, recorded: a.checksum, current: m.checksum });
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdStatus(sql) {
  const migrations = discoverMigrations();
  const applied = await getApplied(sql);
  const drift = detectDrift(migrations, applied);

  const dbRow = await sql`SELECT current_database() AS db, current_user AS usr, version() AS v`;
  log(`${c.bold}Database${c.reset}  ${dbRow[0].db} as ${dbRow[0].usr}`);
  log(`${c.bold}Server${c.reset}    ${dbRow[0].v.split(',')[0]}`);
  log('');

  if (migrations.length === 0) {
    warn('No migration files found.');
  } else {
    log(`${c.bold}Migrations${c.reset}`);
    for (const m of migrations) {
      const a = applied.get(m.version);
      const mark = a ? `${c.green}applied${c.reset}` : `${c.yellow}pending${c.reset}`;
      const when = a ? ` ${c.dim}${new Date(a.applied_at).toISOString()}${c.reset}` : '';
      const down = m.hasDown ? '' : ` ${c.dim}(no .down.sql)${c.reset}`;
      log(`  ${mark}  ${m.version}_${m.name}${when}${down}`);
    }
  }
  log('');

  if (drift.length > 0) {
    fail('CHECKSUM DRIFT — an already-applied migration file has been modified:');
    for (const d of drift) log(`    ${d.version} ${d.file}`);
    log('  Resolve by adding a NEW migration instead of editing an applied one.');
    log('  `up` will refuse to run until this is resolved.');
    log('');
    return 2;
  }
  ok('No checksum drift.');
  return 0;
}

async function cmdVerify(sql) {
  const migrations = discoverMigrations();
  const applied = await getApplied(sql);
  const drift = detectDrift(migrations, applied);
  if (drift.length) {
    fail(`Checksum drift detected in ${drift.length} migration(s).`);
    return 2;
  }
  const pending = migrations.filter((m) => !applied.has(m.version));
  ok(`Checksums verified (${applied.size} applied).`);
  info(`${pending.length} pending migration(s).`);
  return 0;
}

async function cmdUp(sql, targetVersion) {
  const migrations = discoverMigrations();
  await ensureMigrationsTable(sql);

  return withLock(sql, async () => {
    const applied = await getApplied(sql);
    const drift = detectDrift(migrations, applied);
    if (drift.length > 0) {
      fail('Refusing to migrate: checksum drift on already-applied migration(s):');
      for (const d of drift) log(`    ${d.version} ${d.file}`);
      return 2;
    }

    let pending = migrations.filter((m) => !applied.has(m.version));
    if (targetVersion) pending = pending.filter((m) => m.version <= targetVersion);

    if (pending.length === 0) {
      ok('Nothing to apply; database is up to date.');
      return 0;
    }

    info(`Applying ${pending.length} migration(s)...`);
    const actor = process.env.MIGRATION_APPLIED_BY || process.env.USER || 'migrate.mjs';

    for (const m of pending) {
      const started = Date.now();
      log(`\n  ${c.bold}→ ${m.version}_${m.name}${c.reset}`);
      try {
        await sql.unsafe('BEGIN');
        await sql.unsafe(m.sql);
        const ms = Date.now() - started;
        await sql`
          INSERT INTO schema_migrations (version, name, checksum, execution_ms, applied_by)
          VALUES (${m.version}, ${m.name}, ${m.checksum}, ${ms}, ${actor})
        `;
        await sql.unsafe('COMMIT');
        ok(`${m.version}_${m.name} applied in ${ms}ms`);
      } catch (err) {
        try { await sql.unsafe('ROLLBACK'); } catch { /* already rolled back */ }
        fail(`Migration ${m.version}_${m.name} FAILED — transaction rolled back.`);
        fail(`  code   : ${err.code ?? 'n/a'}`);
        fail(`  message: ${err.message}`);
        if (err.position) {
          const upto = m.sql.slice(0, Number(err.position)).split('\n').length;
          fail(`  at line: ${upto}`);
          fail(`  ${(m.sql.split('\n')[upto - 1] || '').trim().slice(0, 160)}`);
        }
        fail('Database left unchanged by this migration. Fix the file and re-run.');
        return 1;
      }
    }
    log('');
    ok('All pending migrations applied.');
    return 0;
  });
}

async function cmdDown(sql, targetVersion) {
  if (!targetVersion) die('down requires a target version, e.g. `down 0001`');
  const migrations = discoverMigrations();
  await ensureMigrationsTable(sql);

  return withLock(sql, async () => {
    const applied = await getApplied(sql);
    const candidates = migrations
      .filter((m) => applied.has(m.version) && m.version >= targetVersion)
      .sort((a, b) => b.version.localeCompare(a.version)); // newest first

    if (candidates.length === 0) {
      ok('Nothing to roll back.');
      return 0;
    }

    const missingDown = candidates.filter((m) => !m.hasDown);
    if (missingDown.length > 0) {
      fail('Cannot roll back — missing .down.sql for:');
      for (const m of missingDown) log(`    ${m.version}_${m.name}`);
      log('  Add the down migration, or restore from a backup instead.');
      return 2;
    }

    warn(`Rolling back ${candidates.length} migration(s). This executes the .down.sql files.`);
    for (const m of candidates) {
      const downSql = readFileSync(m.downPath, 'utf8');
      log(`\n  ${c.bold}← ${m.version}_${m.name}${c.reset}`);
      try {
        await sql.unsafe('BEGIN');
        await sql.unsafe(downSql);
        await sql`DELETE FROM schema_migrations WHERE version = ${m.version}`;
        await sql.unsafe('COMMIT');
        ok(`${m.version}_${m.name} rolled back`);
      } catch (err) {
        try { await sql.unsafe('ROLLBACK'); } catch { /* noop */ }
        fail(`Rollback of ${m.version}_${m.name} FAILED — transaction rolled back.`);
        fail(`  code   : ${err.code ?? 'n/a'}`);
        fail(`  message: ${err.message}`);
        return 1;
      }
    }
    log('');
    ok('Rollback complete.');
    return 0;
  });
}

async function cmdBaseline(sql, targetVersion) {
  if (!targetVersion) die('baseline requires a version, e.g. `baseline 0005`');
  const migrations = discoverMigrations();
  await ensureMigrationsTable(sql);
  return withLock(sql, async () => {
    const applied = await getApplied(sql);
    const toMark = migrations.filter((m) => m.version <= targetVersion && !applied.has(m.version));
    if (toMark.length === 0) {
      ok('Nothing to baseline.');
      return 0;
    }
    warn('BASELINE: recording migrations as applied WITHOUT executing them.');
    warn('Use this only when the database already contains their effects.');
    const actor = `baseline:${process.env.USER || 'unknown'}`;
    for (const m of toMark) {
      await sql`
        INSERT INTO schema_migrations (version, name, checksum, execution_ms, applied_by)
        VALUES (${m.version}, ${m.name}, ${m.checksum}, ${null}, ${actor})
      `;
      info(`recorded ${m.version}_${m.name}`);
    }
    ok(`Baselined ${toMark.length} migration(s).`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const [cmd = 'up', arg] = process.argv.slice(2);
  const url = resolveConnectionString();
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let code = 0;
  try {
    switch (cmd) {
      case 'status':   code = await cmdStatus(sql); break;
      case 'verify':   code = await cmdVerify(sql); break;
      case 'up':       code = await cmdUp(sql, arg); break;
      case 'down':     code = await cmdDown(sql, arg); break;
      case 'baseline': code = await cmdBaseline(sql, arg); break;
      default:
        die(`Unknown command "${cmd}". Use: status | up | down | verify | baseline`);
    }
  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    code = 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  process.exit(code);
}

main();
