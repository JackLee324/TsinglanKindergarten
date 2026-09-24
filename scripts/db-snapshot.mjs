#!/usr/bin/env node
/**
 * scripts/db-snapshot.mjs — pre/post migration data + schema snapshot
 * ===================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The hardening plan requires, BEFORE any schema change:
 *   L-3 save data statistics      L-4 resource count
 *   L-5 teacher account count     L-6 permission count
 *   L-7 review record count       L-8 audit log count
 *   L-9 record the pre-migration version
 * and AFTER the change, a comparison proving nothing was lost.
 *
 * This tool cannot run against a database it has no credentials for. When no
 * connection string is available it says so and exits non-zero — it never
 * reports a successful snapshot it did not take.
 *
 * USAGE
 *   node scripts/db-snapshot.mjs --out snapshots/before.json
 *   node scripts/db-snapshot.mjs --out snapshots/after.json
 *   node scripts/db-snapshot.mjs --compare snapshots/before.json --against snapshots/after.json
 *
 * ENVIRONMENT: DATABASE_URL | SUDA_DATABASE_URL | MIGRATION_DATABASE_URL
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';

const c = {
  reset: '\u001b[0m', red: '\u001b[31m', green: '\u001b[32m',
  yellow: '\u001b[33m', bold: '\u001b[1m', dim: '\u001b[2m',
};
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const fail = (m) => console.error(`${c.red}✗${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`);

/** Business tables whose row counts must never silently decrease. */
const CRITICAL_TABLES = [
  'teachers',
  'resources',
  'subject_permissions',
  'review_records',
  'audit_logs',
  'sessions',
];

function connectionString() {
  const url =
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.SUDA_DATABASE_URL;
  if (!url) {
    fail('No database connection string available.');
    fail('  Set DATABASE_URL (or SUDA_DATABASE_URL / MIGRATION_DATABASE_URL).');
    fail('  A snapshot CANNOT be produced without database access.');
    fail('  Do not proceed with migrations until this succeeds.');
    process.exit(2);
  }
  return url;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

async function collect(sql) {
  const meta = await sql`
    SELECT current_database() AS database,
           current_user     AS db_user,
           version()        AS server_version,
           now()            AS taken_at
  `;

  // which expected tables actually exist
  const tableRows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const tables = tableRows.map((r) => r.table_name);

  // row counts
  const counts = {};
  for (const t of CRITICAL_TABLES) {
    if (!tables.includes(t)) { counts[t] = null; continue; }
    const r = await sql.unsafe(`SELECT count(*)::bigint AS c FROM "${t}"`);
    counts[t] = Number(r[0].c);
  }
  // any extra tables
  const otherTables = {};
  for (const t of tables) {
    if (CRITICAL_TABLES.includes(t)) continue;
    const r = await sql.unsafe(`SELECT count(*)::bigint AS c FROM "${t}"`);
    otherTables[t] = Number(r[0].c);
  }

  // column shape of every table (schema fingerprint)
  const cols = await sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  const columns = {};
  for (const r of cols) {
    (columns[r.table_name] ??= []).push({
      column: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
      has_default: r.column_default !== null,
    });
  }

  // indexes
  const idx = await sql`
    SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' ORDER BY tablename, indexname
  `;
  const indexes = {};
  for (const r of idx) (indexes[r.tablename] ??= []).push({ name: r.indexname, def: r.indexdef });

  // RLS status + policies (security-relevant)
  const rls = await sql`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
  `;
  const policies = await sql`
    SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `;

  // applied migrations (may not exist yet on a pre-migration database)
  let migrations = null;
  if (tables.includes('schema_migrations')) {
    const m = await sql`SELECT version, name, checksum FROM schema_migrations ORDER BY version`;
    migrations = m.map((r) => ({ version: r.version, name: r.name, checksum: r.checksum }));
  }

  // role distribution (business-critical: must not lose accounts)
  let roleDistribution = null;
  if (tables.includes('teachers')) {
    const r = await sql`
      SELECT unnest(roles) AS role, count(*)::int AS accounts
      FROM teachers GROUP BY 1 ORDER BY 2 DESC
    `;
    roleDistribution = r.map((x) => ({ role: x.role, accounts: x.accounts }));
  }

  const snapshot = {
    takenAt: new Date().toISOString(),
    database: meta[0].database,
    dbUser: meta[0].db_user,
    serverVersion: meta[0].server_version.split(',')[0],
    tables,
    counts,
    otherTables,
    roleDistribution,
    columns,
    indexes,
    rls: rls.map((r) => ({
      table: r.table_name,
      enabled: r.rls_enabled,
      forced: r.rls_forced,
    })),
    policies: policies.map((p) => ({
      table: p.tablename,
      name: p.policyname,
      cmd: p.cmd,
      roles: p.roles,
      using: p.qual,
      withCheck: p.with_check,
    })),
    migrations,
  };

  // deterministic fingerprint of the structure + counts (for quick comparison)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ counts, columns, indexes }))
    .digest('hex');

  snapshot.fingerprint = fingerprint;
  return snapshot;
}

function diff(before, after) {
  const problems = [];
  const warnings = [];
  const notes = [];

  // 1. row counts must not decrease for critical tables
  for (const t of CRITICAL_TABLES) {
    const b = before.counts?.[t];
    const a = after.counts?.[t];
    if (b === undefined || a === undefined) { warnings.push(`table ${t}: missing from one snapshot`); continue; }
    if (b === null && a !== null) notes.push(`${t}: created (${b} -> ${a})`);
    else if (b !== null && a === null) problems.push(`${t}: TABLE LOST (was ${b} rows)`);
    else if (b !== null && a !== null) {
      if (a < b) problems.push(`${t}: ROW COUNT DECREASED ${b} -> ${a} (lost ${b - a})`);
      else if (a > b) notes.push(`${t}: ${b} -> ${a} (+${a - b})`);
      else notes.push(`${t}: unchanged (${a})`);
    }
  }

  // 2. accounts must not disappear
  const beforeAccounts = before.roleDistribution?.reduce((s, r) => s + r.accounts, 0) ?? null;
  const afterAccounts = after.roleDistribution?.reduce((s, r) => s + r.accounts, 0) ?? null;
  if (beforeAccounts !== null && afterAccounts !== null && afterAccounts < beforeAccounts) {
    problems.push(`teacher accounts decreased: ${beforeAccounts} -> ${afterAccounts}`);
  }

  // 3. no columns may be dropped from existing tables
  for (const [table, cols] of Object.entries(before.columns ?? {})) {
    const afterCols = after.columns?.[table];
    if (!afterCols) { problems.push(`table ${table} no longer exists`); continue; }
    const afterNames = new Set(afterCols.map((x) => x.column));
    for (const col of cols) {
      if (!afterNames.has(col.column)) problems.push(`${table}.${col.column}: COLUMN DROPPED`);
    }
  }

  // 4. RLS must not be silently weakened (enabled -> disabled, or forced -> not forced)
  const beforeRls = new Map((before.rls ?? []).map((r) => [r.table, r]));
  for (const r of after.rls ?? []) {
    const b = beforeRls.get(r.table);
    if (!b) continue;
    if (b.enabled && !r.enabled) problems.push(`${r.table}: RLS was DISABLED`);
    if (b.forced && !r.forced) warnings.push(`${r.table}: FORCE RLS removed`);
  }

  return { problems, warnings, notes };
}

async function main() {
  const out = arg('--out');
  const compare = arg('--compare');
  const against = arg('--against');

  if (compare) {
    if (!against) {
      fail('--compare requires --against <file>');
      process.exit(1);
    }
    const before = JSON.parse(readFileSync(resolve(compare), 'utf8'));
    const after = JSON.parse(readFileSync(resolve(against), 'utf8'));
    console.log(`${c.bold}Data-integrity comparison${c.reset}`);
    console.log(`  before: ${compare}  (${before.takenAt})`);
    console.log(`  after : ${against}  (${after.takenAt})`);
    console.log('');
    const { problems, warnings, notes } = diff(before, after);
    for (const n of notes) console.log(`  ${c.dim}${n}${c.reset}`);
    for (const w of warnings) warn(w);
    for (const p of problems) fail(p);
    console.log('');
    if (problems.length > 0) {
      fail(`${problems.length} integrity problem(s) detected.`);
      process.exit(1);
    }
    ok('No data loss, no dropped columns, no weakened RLS.');
    process.exit(0);
  }

  if (!out) {
    fail('Nothing to do. Use --out <file> to snapshot, or --compare/--against to diff.');
    process.exit(1);
  }

  const sql = postgres(connectionString(), { max: 1, onnotice: () => {} });
  try {
    const snapshot = await collect(sql);
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(snapshot, null, 2) + '\n');

    ok(`Snapshot written: ${target}`);
    console.log(`  database        : ${snapshot.database} (as ${snapshot.dbUser})`);
    console.log(`  server          : ${snapshot.serverVersion}`);
    console.log(`  tables          : ${snapshot.tables.length}`);
    console.log(`  ${c.bold}row counts${c.reset}`);
    for (const t of CRITICAL_TABLES) {
      console.log(`    ${t.padEnd(20)} ${snapshot.counts[t] === null ? '(table absent)' : snapshot.counts[t]}`);
    }
    if (snapshot.roleDistribution) {
      console.log(`  ${c.bold}accounts by role${c.reset}`);
      for (const r of snapshot.roleDistribution) console.log(`    ${String(r.role).padEnd(20)} ${r.accounts}`);
    }
    if (snapshot.migrations) {
      console.log(`  ${c.bold}migrations applied${c.reset} ${snapshot.migrations.length}`);
      for (const m of snapshot.migrations) console.log(`    ${m.version}_${m.name}`);
    } else {
      warn('schema_migrations table absent — database predates the migration framework.');
    }
    console.log(`  fingerprint     : ${snapshot.fingerprint}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((e) => {
  fail(`Unexpected error: ${e.message}`);
  process.exit(1);
});
