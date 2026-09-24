#!/usr/bin/env node
/**
 * scripts/report-missing-files.mjs — how many resources have a REAL file?
 * ==========================================================================
 * WHY THIS EXISTS
 *   All 347 seeded `resources` rows have NULL file columns, so nothing in the
 *   curriculum is actually downloadable. That fact was invisible: the API
 *   returned the rows, the UI rendered them, and the download button simply
 *   failed with a 404 per click. A number that nobody prints is a number nobody
 *   acts on.
 *
 * WHAT IT REPORTS
 *   Per program / subject / sub-subject / folder type, and as a whole:
 *     total, with_file, without_file
 *   computed by the DATABASE from the generated column `resources.has_stored_file`
 *   (migration 0008), NOT by this script re-deriving a predicate. That is the
 *   point: if the script computed its own WHERE clause it would be a fifth
 *   spelling of the rule, and the day it disagreed with the server nobody would
 *   notice. The views `resource_file_coverage` / `resource_file_totals` are read
 *   verbatim.
 *
 * WHAT "WITH A FILE" MEANS (and does not)
 *   `has_stored_file` is true when `file_path` AND `file_bucket_id` are both
 *   non-blank — i.e. the row POINTS AT a stored file. It is NOT a statement that
 *   the object exists in the bucket; this process cannot reach object storage.
 *   A non-zero `with_file` therefore means "these rows would attempt a download",
 *   not "these rows will succeed".
 *
 * EXIT CODES
 *   0  report produced (regardless of how many files are missing — a missing file
 *      is a data situation to report, not a script failure)
 *   1  the report could NOT be produced. Connection refused, wrong credentials,
 *      missing table/view, or migration 0008 not applied: all fail loudly with an
 *      actionable message. It never prints a table of zeros and exits 0 — that is
 *      the "reports success when it cannot connect" failure this script must not
 *      have.
 *
 * USAGE
 *   node scripts/report-missing-files.mjs
 *   node scripts/report-missing-files.mjs --json
 *   DATABASE_URL=postgres://... node scripts/report-missing-files.mjs
 *   # SUDA_DATABASE_URL is accepted as a fallback (the platform runtime's name)
 */

import postgres from 'postgres';

const AS_JSON = process.argv.includes('--json');

const c = {
  reset: '\u001b[0m', red: '\u001b[31m', green: '\u001b[32m',
  yellow: '\u001b[33m', blue: '\u001b[34m', dim: '\u001b[2m', bold: '\u001b[1m',
};
const log = (...a) => { if (!AS_JSON) console.log(...a); };

function die(message, code = 1) {
  if (AS_JSON) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`${c.red}✗${c.reset} ${message}`);
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------
function resolveConnectionString() {
  const url =
    process.env.DATABASE_URL ||
    process.env.SUDA_DATABASE_URL ||
    process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    die(
      'No database connection string — cannot report anything.\n' +
        '  Set DATABASE_URL (or SUDA_DATABASE_URL / MIGRATION_DATABASE_URL).\n' +
        '  Example: DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/qls node scripts/report-missing-files.mjs',
    );
  }
  return url;
}

const connectionString = resolveConnectionString();
const sql = postgres(connectionString, {
  max: 2,
  // A report must not hang forever on an unreachable host; fail instead.
  connect_timeout: 10,
  idle_timeout: 5,
  onnotice: () => {},
});

/** Redact the password so the connection target can be printed safely. */
function describeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname} as ${u.username}`;
  } catch {
    return '(unparseable connection string)';
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  let server;
  try {
    const rows = await sql`select current_database() as db, current_user as usr, version() as v`;
    server = rows[0];
  } catch (err) {
    die(
      `Cannot connect to PostgreSQL at ${describeTarget(connectionString)}.\n` +
        `  code   : ${err.code ?? 'n/a'}\n` +
        `  message: ${err.message}\n` +
        '  This report is produced FROM the database; without a connection there is no report.',
    );
  }

  // The report depends on migration 0008. Check for its objects explicitly, so a
  // database that has not been migrated produces "apply 0008" rather than
  // `relation "resource_file_coverage" does not exist`.
  const [{ view_ok, column_ok }] = await sql`
    select
      to_regclass('public.resource_file_coverage') is not null as view_ok,
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'resources'
          and column_name = 'has_stored_file'
      ) as column_ok
  `;
  if (!view_ok || !column_ok) {
    die(
      'Migration 0008 is not applied to this database ' +
        `(resource_file_coverage: ${view_ok ? 'present' : 'MISSING'}, ` +
        `resources.has_stored_file: ${column_ok ? 'present' : 'MISSING'}).\n` +
        '  Apply it first:  DATABASE_URL=... node scripts/migrate.mjs up\n' +
        '  There is no fallback: re-deriving the predicate here would be a second ' +
        'definition of "has a file" that could disagree with the server.',
    );
  }

  const totals = (await sql`select total::int, with_file::int, without_file::int from resource_file_totals`)[0];
  const groups = await sql`
    select program, subject, sub_subject, folder_type,
           total::int, with_file::int, without_file::int
    from resource_file_coverage
    order by program, subject, sub_subject nulls first, folder_type
  `;

  // Cross-check the grouped view against the totals view. Two views over the same
  // predicate that disagree would mean one of them is wrong, and this is the
  // cheapest possible place to find that out.
  const sumTotal = groups.reduce((n, g) => n + g.total, 0);
  const sumWith = groups.reduce((n, g) => n + g.with_file, 0);
  const sumWithout = groups.reduce((n, g) => n + g.without_file, 0);
  const consistent =
    sumTotal === totals.total &&
    sumWith === totals.with_file &&
    sumWithout === totals.without_file;

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          database: server.db,
          user: server.usr,
          totals,
          groups,
          consistent,
        },
        null,
        2,
      ),
    );
  } else {
    log(`${c.bold}资源文件覆盖报告 / Resource file coverage${c.reset}`);
    log(`${c.bold}Database${c.reset}  ${server.db} as ${server.usr}`);
    log(`${c.bold}Server${c.reset}    ${server.v.split(',')[0]}`);
    log('');
    log('  A row counts as having a file when BOTH file_path and file_bucket_id are');
    log('  non-blank (resources.has_stored_file, migration 0008 — a generated column,');
    log('  so it cannot drift from the columns it is computed from).');
    log('  "has file" means the row POINTS AT a stored object; object storage is not');
    log('  reachable from this script, so it is not a claim that the bytes exist.');
    log('');

    if (groups.length === 0) {
      log(`  ${c.yellow}!${c.reset} No active resources at all (empty table or all soft-deleted).`);
    } else {
      const w = (s, n) => String(s).padEnd(n);
      log(
        `  ${c.dim}${w('program', 8)}${w('subject', 13)}${w('sub_subject', 18)}${w('folder_type', 20)}` +
          `${w('total', 7)}${w('with', 7)}without${c.reset}`,
      );
      log(`  ${c.dim}${'-'.repeat(8 + 13 + 18 + 20 + 7 + 7 + 7)}${c.reset}`);
      for (const g of groups) {
        const flag = g.with_file === 0 ? c.yellow : c.green;
        log(
          `  ${w(g.program, 8)}${w(g.subject, 13)}${w(g.sub_subject ?? '-', 18)}${w(g.folder_type, 20)}` +
            `${w(g.total, 7)}${flag}${w(g.with_file, 7)}${c.reset}${w(g.without_file, 7)}`,
        );
      }
    }

    log('');
    log(`  ${c.bold}TOTAL${c.reset}            ${totals.total}`);
    log(`  ${c.bold}with a file${c.reset}      ${totals.with_file}`);
    log(`  ${c.bold}without a file${c.reset}   ${c.yellow}${totals.without_file}${c.reset}`);
    log('');
    log(
      `  ${c.dim}Grouped view sums to total=${sumTotal} with=${sumWith} without=${sumWithout}` +
        ` — ${consistent ? 'consistent' : 'INCONSISTENT'}${c.reset}`,
    );

    if (!consistent) {
      // A mismatch is a defect in the views, not a data situation. Do not exit 0.
      die(
        'resource_file_coverage and resource_file_totals disagree. One of the two ' +
          'views is wrong; the report cannot be trusted.',
      );
    }

    if (totals.total > 0 && totals.with_file === 0) {
      log('');
      log(
        `  ${c.yellow}!${c.reset} No active resource has a file. Every download attempt ` +
          'will answer 404 资源文件不存在.',
      );
    }
  }

  await sql.end({ timeout: 5 });
}

try {
  await main();
} catch (err) {
  // Any unexpected error is a failure to produce the report, and must not be
  // swallowed into a zero-filled table or a silent exit 0.
  die(`Report failed: ${err.code ?? ''} ${err.message}`.trim());
}
