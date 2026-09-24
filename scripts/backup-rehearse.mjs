#!/usr/bin/env node
/**
 * scripts/backup-rehearse.mjs — backup / restore REHEARSAL
 * ========================================================
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is a *logical data round-trip rehearsal*, driven by the project's own
 * schema and migration tooling. It is a genuine backup/restore exercise:
 * every table's rows are exported, a scratch database is created and migrated
 * from scratch, the rows are imported, and the result is compared against the
 * source by exact row count and per-table content checksum.
 *
 * IT IS NOT a substitute for `pg_dump` / PITR, and it does NOT prove that the
 * production backup is restorable. Specifically it does not cover:
 *   - roles, tablespace layout, extensions, or database-level settings
 *   - sequences/`serial` state beyond what the schema creates
 *   - RLS policy definitions beyond those the migrations install
 *   - large-object (`lo`) storage, which this application does not use
 *   - point-in-time recovery / WAL archiving
 * The production rehearsal must be done with `pg_dump`/`pg_restore` against the
 * real cluster. This script prints those commands and refuses to imply it ran
 * them.
 *
 * WHY THE ENVIRONMENT CHECK MATTERS
 * ---------------------------------
 * On the development machine this script was written on, the embedded
 * PostgreSQL distribution ships ONLY `initdb`, `pg_ctl` and `postgres`
 * (verified: `ls .devtools/pg/node_modules/@embedded-postgres/darwin-arm64/native/bin`
 * returns exactly those three). There is no `pg_dump`, no `pg_restore`, no
 * `psql`, no Homebrew `postgresql`, and no `libpq`. A logical backup of the
 * conventional kind is therefore IMPOSSIBLE here, and this script says so out
 * loud instead of pretending. That is the whole point of the preflight below.
 *
 * USAGE
 *   node scripts/backup-rehearse.mjs \
 *     --source  "postgresql://user:pw@127.0.0.1:55432/qls_test_0005" \
 *     --scratch "postgresql://user:pw@127.0.0.1:55432/qls_rehearsal" \
 *     --out     backups/rehearsal.ndjson
 *
 * Exit codes: 0 = round-trip verified, 1 = failed or refused, 2 = preflight
 * prerequisite missing.
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Safety: this script DROPs a database. It must be impossible to aim it at a
// real one by accident, so a scratch URL whose database name does not look like
// a scratch database is refused outright.
// ---------------------------------------------------------------------------
const SCRATCH_NAME_PATTERN = /(scratch|rehearsal|restore_test|tmp|temp)/i;

function dbNameOf(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function preferredUrl() {
  return (
    process.env.BACKUP_SOURCE_DB ||
    process.env.DATABASE_URL ||
    process.env.SUDA_DATABASE_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    ''
  );
}

const args = parseArgs(process.argv.slice(2));
const sourceUrl = args.source && args.source !== true ? args.source : preferredUrl();
const scratchUrl = args.scratch && args.scratch !== true ? args.scratch : '';
const outPath = resolve(
  typeof args.out === 'string' ? args.out : 'backups/backup-rehearsal.ndjson',
);
const keepScratch = args['keep-scratch'] === true;

function log(msg) {
  console.log(msg);
}
function ok(msg) {
  console.log(`  PASS  ${msg}`);
}
function bad(msg) {
  console.log(`  FAIL  ${msg}`);
}
function warn(msg) {
  console.log(`  WARN  ${msg}`);
}

// ---------------------------------------------------------------------------
// PREFLIGHT — never claim a capability the machine does not have.
// ---------------------------------------------------------------------------
log('=== PREFLIGHT ===');

const pgPaths = [
  process.env.PG_BIN,
  '/opt/homebrew/opt/libpq/bin',
  '/usr/local/opt/libpq/bin',
  '/usr/lib/postgresql/16/bin',
].filter(Boolean);

function findTool(name) {
  // 1. PATH
  const onPath = spawnSync('sh', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim();
  // 2. Well-known install locations
  for (const dir of pgPaths) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  // 3. The project's own embedded postgres, which ships a limited toolset
  const embedded = resolve(
    process.cwd(),
    '.devtools/pg/node_modules/@embedded-postgres/darwin-arm64/native/bin',
  );
  const candidate = `${embedded}/${name}`;
  if (existsSync(candidate)) return candidate;
  return null;
}

const pgDump = findTool('pg_dump');
const pgRestore = findTool('pg_restore');
const psql = findTool('psql');

log(`  pg_dump    : ${pgDump ?? 'NOT FOUND'}`);
log(`  pg_restore : ${pgRestore ?? 'NOT FOUND'}`);
log(`  psql       : ${psql ?? 'NOT FOUND'}`);

if (!pgDump || !psql) {
  warn('conventional logical backup tooling is NOT available on this machine.');
  warn('This is the documented, expected state of the development environment:');
  warn('the embedded PostgreSQL ships only initdb/pg_ctl/postgres, and there is');
  warn('no Homebrew postgresql and no libpq installed.');
  warn(
    'NO `pg_dump` BACKUP WAS TAKEN. The production backup MUST be supplied and',
  );
  warn('rehearsed by the deployment environment — see DISASTER_RECOVERY.md.');
  log('');
  log('  Production backup commands the deployment environment must provide:');
  log(
    `    ${pgDump ?? 'pg_dump'} --format=custom --no-owner --no-privileges \\`,
  );
  log('      --file=qls_$(date +%Y%m%dT%H%M%S).dump "$PRODUCTION_DATABASE_URL"');
  log('    # verify it is really restorable, into a SCRATCH database:');
  log('    createdb qls_restore_verify');
  log(
    `    ${pgRestore ?? 'pg_restore'} --no-owner --no-privileges --dbname=qls_restore_verify qls_*.dump`,
  );
  log(
    `    ${psql ?? 'psql'} -d qls_restore_verify -c "SELECT count(*) FROM resources;"`,
  );
  log('');
}

if (!sourceUrl) {
  bad('no source database URL. Set DATABASE_URL / SUDA_DATABASE_URL or pass --source.');
  process.exit(2);
}
if (!scratchUrl) {
  bad('no scratch database URL. Pass --scratch <url>.');
  process.exit(2);
}

const scratchName = dbNameOf(scratchUrl);
if (!SCRATCH_NAME_PATTERN.test(scratchName)) {
  bad(
    `refusing to run: scratch database name "${scratchName}" does not contain ` +
      'scratch/rehearsal. This script DROPs that database. Name it e.g. ' +
      '"qls_rehearsal" and pass --scratch again.',
  );
  process.exit(2);
}
if (dbNameOf(sourceUrl) === scratchName) {
  bad('source and scratch databases are the same database. Refusing to run.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// STEP 1 — export every table's rows from the source.
// ---------------------------------------------------------------------------
log('');
log('=== STEP 1: EXPORT (logical dump) ===');

const source = postgres(sourceUrl, {
  max: 2,
  onnotice: () => {},
  // The rehearsal is a maintenance operation: do not let a long export be
  // cancelled by an interactive timeout.
  idle_timeout: 0,
  connect_timeout: 30,
});

const TABLES = (
  await source`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `
).map((r) => r.name);

if (TABLES.length === 0) {
  bad('source database has no tables in schema public — nothing to back up.');
  await source.end();
  process.exit(1);
}
log(`  tables discovered: ${TABLES.length}`);

// ---------------------------------------------------------------------------
// Insert order. Export order is irrelevant, but IMPORT order is not: importing
// in name order was measured to fail with
//   23503 insert or update on table "resources" violates foreign key
//         constraint "resources_uploader_fkey"
// because a child row was inserted before its parent. Rather than disabling
// constraints (which needs superuser and would also mask genuine referential
// breakage), we topologically sort the tables by their foreign keys and import
// parents first. A genuine FK violation in the data still surfaces as an error.
// ---------------------------------------------------------------------------
const fkEdges = await source`
  SELECT child.relname AS child, parent.relname AS parent
  FROM pg_constraint c
  JOIN pg_class child  ON child.oid  = c.conrelid
  JOIN pg_class parent ON parent.oid = c.confrelid
  JOIN pg_namespace n  ON n.oid      = child.relnamespace
  WHERE c.contype = 'f' AND n.nspname = 'public'
    AND child.relname <> parent.relname
`;
const deps = new Map(TABLES.map((t) => [t, new Set()]));
for (const { child, parent } of fkEdges) {
  if (deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
}
const insertOrder = [];
const placed = new Set();
let progress = true;
while (progress && insertOrder.length < TABLES.length) {
  progress = false;
  for (const t of TABLES) {
    if (placed.has(t)) continue;
    if ([...deps.get(t)].every((d) => placed.has(d))) {
      insertOrder.push(t);
      placed.add(t);
      progress = true;
    }
  }
}
if (insertOrder.length !== TABLES.length) {
  // A cycle among tables. Impossible with these FKs, but do not silently
  // produce a partial order.
  bad('could not resolve a dependency order for every table (FK cycle?).');
  await source.end();
  process.exit(1);
}
log(`  insert order resolved over ${fkEdges.length} foreign key(s)`);

// The migration ledger is DERIVED STATE, not user data. The scratch database was
// built by running the real migrations, so its ledger already contains those
// rows; re-importing the source's copies collides on the primary key
// (measured: 23505 duplicate key value violates unique constraint
// "schema_migrations_pkey"). In a pg_restore the ledger arrives inside the dump,
// but here it is reconstructed — so we skip it and instead *verify* that the
// reconstructed ledger matches the source's, which is a stronger check than
// copying it would have been.
const SKIP_IMPORT = new Set(['schema_migrations']);

mkdirSync(dirname(outPath), { recursive: true });
const stream = createWriteStream(outPath, { encoding: 'utf8' });

function writeLine(obj) {
  return new Promise((res, rej) => {
    stream.write(`${JSON.stringify(obj)}\n`, (e) => (e ? rej(e) : res()));
  });
}

await writeLine({
  kind: 'header',
  tool: 'scripts/backup-rehearse.mjs',
  formatVersion: 1,
  createdAt: new Date().toISOString(),
  sourceDatabase: dbNameOf(sourceUrl),
  note:
    'Logical data rehearsal dump. NOT a pg_dump archive; see the tool header.',
});

const countsBefore = {};
const checksumsBefore = {};

for (const table of TABLES) {
  const rows = await source.unsafe(`SELECT * FROM "${table}"`);

  // Deterministic content checksum: sort by the row's canonical JSON so the
  // value is independent of physical row order.
  const canonical = rows
    .map((r) => JSON.stringify(r, Object.keys(r).sort()))
    .sort();
  const hash = createHash('sha256');
  for (const line of canonical) hash.update(line);
  checksumsBefore[table] = hash.digest('hex');
  countsBefore[table] = rows.length;

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  await writeLine({ kind: 'table', table, columns, rowCount: rows.length });
  for (const row of rows) {
    await writeLine({ kind: 'row', table, row });
  }
  log(`  ${table.padEnd(28)} rows=${String(rows.length).padStart(6)}`);
}

await writeLine({
  kind: 'footer',
  counts: countsBefore,
  checksums: checksumsBefore,
});
await new Promise((res) => stream.end(res));

const bytes = readFileSync(outPath).length;
log(`  dump written: ${outPath} (${bytes} bytes)`);

// ---------------------------------------------------------------------------
// STEP 2 — create the scratch database and migrate it from zero.
// ---------------------------------------------------------------------------
log('');
log('=== STEP 2: CREATE SCRATCH + MIGRATE ===');

const adminUrl = new URL(scratchUrl);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });

try {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
  ok(`scratch database "${scratchName}" created (previous copy dropped)`);
} finally {
  await admin.end();
}

// The scratch schema must be built exactly the way a NEW environment is built,
// which is: prelude type+roles -> init.sql -> migrations. Running the migrations
// alone was measured to FAIL with 42P01 relation "teachers" does not exist,
// because the numbered migrations are an *alignment* layer on top of the
// baseline DDL, not a self-sufficient schema. Rehearsing the real bootstrap path
// is the point: if this step breaks, a fresh restore target is unavailable.
const migrate = spawnSync(
  process.execPath,
  [resolve(process.cwd(), 'scripts/db-bootstrap.mjs'), '--url', scratchUrl],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: scratchUrl,
      SUDA_DATABASE_URL: scratchUrl,
      MIGRATION_DATABASE_URL: scratchUrl,
    },
  },
);
if (migrate.status !== 0) {
  bad('migrating the scratch database failed — restore cannot be verified');
  process.stdout.write(migrate.stdout ?? '');
  process.stderr.write(migrate.stderr ?? '');
  await source.end();
  process.exit(1);
}
ok('scratch database built from zero (prelude -> init.sql -> migrations)');

// ---------------------------------------------------------------------------
// STEP 3 — import the dump into the scratch database.
// ---------------------------------------------------------------------------
log('');
log('=== STEP 3: IMPORT ===');

const scratch = postgres(scratchUrl, {
  max: 1,
  onnotice: () => {},
  idle_timeout: 0,
});

const rl = createInterface({
  input: createReadStream(outPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let imported = 0;
// Rows are grouped per table first, then inserted in dependency order.
const rowsByTable = new Map(TABLES.map((t) => [t, []]));
let header = null;

for await (const line of rl) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  if (rec.kind === 'header') {
    header = rec;
    continue;
  }
  if (rec.kind === 'row') {
    if (!rowsByTable.has(rec.table)) rowsByTable.set(rec.table, []);
    rowsByTable.get(rec.table).push(rec.row);
  }
}

// One transaction: the restore either lands completely or not at all, which is
// the property a restore procedure actually needs.
await scratch.begin(async (tx) => {
  for (const table of insertOrder) {
    if (SKIP_IMPORT.has(table)) continue;
    const rows = rowsByTable.get(table) ?? [];
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const colSql = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const stmt = `INSERT INTO "${table}" (${colSql}) VALUES (${placeholders})`;
    for (const row of rows) {
      await tx.unsafe(
        stmt,
        cols.map((c) => row[c]),
      );
      imported += 1;
    }
  }
});
ok(`imported ${imported} rows`);
if (header) log(`  dump header: ${header.sourceDatabase} @ ${header.createdAt}`);

// ---------------------------------------------------------------------------
// STEP 4 — verify the round trip.
// ---------------------------------------------------------------------------
log('');
log('=== STEP 4: VERIFY ===');

const countsAfter = {};
const checksumsAfter = {};
let mismatches = 0;

// Migration ledger: compare version sets rather than row identity, because the
// scratch ledger was reconstructed by the migration runner (different applied_at
// timestamps, different checksum bookkeeping) while the *set of versions* is
// what must agree for the databases to be schema-compatible.
{
  const srcVersions = (
    await source.unsafe('SELECT version FROM schema_migrations ORDER BY version')
  ).map((r) => r.version);
  const dstVersions = (
    await scratch.unsafe('SELECT version FROM schema_migrations ORDER BY version')
  ).map((r) => r.version);
  const same =
    srcVersions.length === dstVersions.length &&
    srcVersions.every((v, i) => v === dstVersions[i]);
  if (same) {
    ok(
      `schema_migrations${' '.repeat(12)} versions match (${srcVersions.length}): ${srcVersions.join(', ')}`,
    );
  } else {
    mismatches += 1;
    bad(
      `schema_migrations versions differ — source=[${srcVersions.join(', ')}] restored=[${dstVersions.join(', ')}]`,
    );
    bad('the restored schema is NOT at the same migration version as the source');
  }
}

for (const table of TABLES) {
  if (SKIP_IMPORT.has(table)) continue;
  const rows = await scratch.unsafe(`SELECT * FROM "${table}"`);
  const canonical = rows
    .map((r) => JSON.stringify(r, Object.keys(r).sort()))
    .sort();
  const hash = createHash('sha256');
  for (const l of canonical) hash.update(l);
  checksumsAfter[table] = hash.digest('hex');
  countsAfter[table] = rows.length;

  const countOk = countsBefore[table] === countsAfter[table];
  const sumOk = checksumsBefore[table] === checksumsAfter[table];

  if (countOk && sumOk) {
    ok(`${table.padEnd(28)} rows=${countsAfter[table]} checksum=${checksumsAfter[
      table
    ].slice(0, 12)}`);
  } else {
    mismatches += 1;
    bad(
      `${table.padEnd(28)} before rows=${countsBefore[table]} checksum=${checksumsBefore[
        table
      ].slice(0, 12)} | after rows=${countsAfter[table]} checksum=${checksumsAfter[
        table
      ].slice(0, 12)}`,
    );
  }
}

await scratch.end();
await source.end();

// ---------------------------------------------------------------------------
// SUMMARY — state exactly what was and was not proven.
// ---------------------------------------------------------------------------
log('');
log('=== SUMMARY ===');
log(`  source database : ${dbNameOf(sourceUrl)}`);
log(`  scratch database: ${scratchName}`);
log(`  tables compared : ${TABLES.length}`);
log(`  dump file       : ${outPath}`);

if (mismatches > 0) {
  log('');
  bad(`${mismatches} table(s) did not survive the round trip`);
  log('');
  log('RESULT: REHEARSAL FAILED — the backup does not restore faithfully.');
  process.exit(1);
}

log('');
log('RESULT: logical round trip verified — every table restored with an');
log('        identical row count and an identical content checksum.');
log('');
log('SCOPE LIMITS (read these before quoting this result):');
log('  * This proves the DATA restores. It does not exercise pg_dump/pg_restore,');
log('    roles, tablespaces, extensions, or WAL/PITR.');
if (!pgDump) {
  log('  * pg_dump was NOT available, so NO conventional logical backup exists.');
  log('    The production rehearsal is still outstanding — see DISASTER_RECOVERY.md.');
}
log('  * The production database was NOT touched by this run and is NOT covered.');
log('');

if (keepScratch) {
  log(`  scratch database kept for inspection: ${scratchName}`);
} else {
  const admin2Url = new URL(scratchUrl);
  admin2Url.pathname = '/postgres';
  const admin2 = postgres(admin2Url.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin2.unsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    log(`  scratch database dropped (pass --keep-scratch to retain it)`);
  } finally {
    await admin2.end();
  }
}

if (existsSync(outPath)) {
  writeFileSync(
    `${outPath}.sha256`,
    `${createHash('sha256').update(readFileSync(outPath)).digest('hex')}  ${outPath}\n`,
  );
  log(`  dump checksum written: ${outPath}.sha256`);
}

process.exit(0);
