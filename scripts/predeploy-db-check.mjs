#!/usr/bin/env node
/**
 * scripts/predeploy-db-check.mjs — machine-readable production state probe
 * ========================================================================
 *
 * Companion to `scripts/predeploy-check.sh`. Every check below is a REAL query
 * against the REAL database or the REAL source tree; nothing here is inferred
 * from "the variable is set".
 *
 * USAGE
 *   node scripts/predeploy-db-check.mjs <subcommand>
 *
 * SUBCOMMANDS
 *   connectivity   connect, report server version + the current database (never
 *                  the credentials, never the full connection string)
 *   super-admin    is there >=1 ACTIVE super_admin that can ACTUALLY sign in?
 *   mfa            MFA_ENCRYPTION_KEY well-formedness + super_admin enrolment
 *   storage        is a platform object-storage context configured for this box?
 *   cors           does the source tree configure any CORS layer?
 *   gate-lock      is the exclusive verification gate lock currently held?
 *
 * OUTPUT CONTRACT
 *   One JSON object on stdout, always with `"ok": true|false` and a `status` of
 *   PASS / FAIL / WARN / INFO, plus `lines` (human-readable, secret-free detail).
 *   Diagnostics go to stderr so stdout stays parseable.
 *
 * WHY JSON: the shell script owns the PASS/FAIL/WARN presentation and the final
 * exit code. If this helper cannot decide, it must say so rather than guessing,
 * so `ok: false` is the answer for "not verified" as well as "verified broken" —
 * `status` distinguishes them (FAIL vs WARN) and `unverified` marks the cases
 * the caller must refuse to call READY.
 *
 * SECRETS: this file never prints an environment value. It prints variable
 * NAMES, whether they are non-empty, and (for keys) whether they decode to the
 * size the application demands. `redact()` exists so a driver error message —
 * which embeds host/user/database — is never echoed verbatim.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------
const out = [];
const say = (line) => out.push(line);
const warn = (line) => process.stderr.write(`[predeploy-db-check] ${line}\n`);

function emit(status, ok, unverified = false) {
  process.stdout.write(
    JSON.stringify({ status, ok, unverified, lines: out }, null, 2) + '\n',
  );
  process.exit(0);
}
function pass() { emit('PASS', true, false); }
function fail() { emit('FAIL', false, false); }
function warnStatus() { emit('WARN', false, true); }
function info() { emit('INFO', true, false); }
function die(message) {
  process.stderr.write(`[predeploy-db-check] ${message}\n`);
  process.exit(2);
}

/**
 * The driver error message can contain `postgres://user:password@host/db`.
 * Never echo it: report the shape, not the secret.
 */
function redact(error) {
  const raw = String(error?.message ?? error ?? '');
  const code = error?.code ? ` (code ${String(error.code)})` : '';
  const safeClass = /password|authentication/i.test(raw)
    ? 'authentication or password rejected'
    : /does not exist/i.test(raw)
      ? 'target database does not exist'
      : /ECONNREFUSED|connect/i.test(raw)
        ? 'connection refused or unreachable host'
        : /timeout|timed out/i.test(raw)
          ? 'connection timed out'
          : 'driver-level failure';
  return `${safeClass}${code}`;
}

// ---------------------------------------------------------------------------
// connection string (same precedence as scripts/migrate.mjs)
// ---------------------------------------------------------------------------
function resolveDbUrl() {
  return (
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.SUDA_DATABASE_URL ||
    ''
  );
}

function describeDbUrl(url) {
  // Print the database NAME and whether credentials are present — never the URL.
  try {
    const parsed = new URL(url);
    const db = parsed.pathname.replace(/^\//, '') || '(none)';
    const hasCreds = Boolean(parsed.username);
    const scheme = parsed.protocol.replace(':', '');
    return `scheme=${scheme} host=${parsed.hostname} port=${parsed.port || 'default'} database=${db} credentials=${hasCreds ? 'present' : 'ABSENT'}`;
  } catch {
    return 'connection string is not a parseable URL';
  }
}

let postgresModule = null;
async function loadPostgres() {
  if (!postgresModule) {
    try {
      postgresModule = (await import('postgres')).default;
    } catch (error) {
      die(`cannot load the 'postgres' driver (is node_modules installed?): ${redact(error)}`);
    }
  }
  return postgresModule;
}

async function connect() {
  const url = resolveDbUrl();
  if (!url) {
    say('no connection string in MIGRATION_DATABASE_URL / DATABASE_URL / SUDA_DATABASE_URL');
    fail();
  }
  const postgres = await loadPostgres();
  try {
    const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
    await sql`select 1`;
    return sql;
  } catch (error) {
    say(`could not connect: ${redact(error)}`);
    fail();
  }
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdConnectivity() {
  const url = resolveDbUrl();
  if (!url) {
    say('no connection string in MIGRATION_DATABASE_URL / DATABASE_URL / SUDA_DATABASE_URL');
    say('the application requires one: SUDA_DATABASE_URL is the name the platform runtime reads');
    fail();
  }
  say(describeDbUrl(url));

  const sql = await connect();
  try {
    const [row] = await sql`
      select current_database() as db,
             current_user as usr,
             version() as version,
             (select count(*)::int from information_schema.tables
               where table_schema = 'public') as tables
    `;
    say(`connected: database=${row.db} user=${row.usr} public_tables=${row.tables}`);
    say(`server: ${String(row.version).split(',')[0]}`);

    const required = ['teachers', 'resources', 'subject_permissions', 'review_records', 'audit_logs', 'sessions'];
    const presentRows = await sql`
      select table_name from information_schema.tables where table_schema = 'public'
    `;
    const present = new Set(presentRows.map((r) => r.table_name));
    const missing = required.filter((t) => !present.has(t));
    if (missing.length > 0) {
      say(`missing required tables: ${missing.join(', ')}`);
      fail();
    }
    say(`all required tables present: ${required.join(', ')}`);

    const [{ migrationsTable }] = await sql`
      select to_regclass('public.schema_migrations') is not null as "migrationsTable"
    `;
    say(`schema_migrations present: ${migrationsTable}`);
    pass();
  } catch (error) {
    say(`query failed: ${redact(error)}`);
    fail();
  } finally {
    await sql.end();
  }
}

/**
 * Can a super_admin actually sign in?
 *
 * Product evidence (all verified by reading the code, not assumed):
 *   * `MfaService.requiresMfa()` returns true exactly for roles containing
 *     `super_admin` (server/modules/auth/mfa.service.ts:97-99).
 *   * `AuthGuard` refuses EVERY non-MFA-exempt route for such a role unless MFA
 *     is enrolled (server/modules/auth/auth.guard.ts:171-181).
 *   * `AuthService.login()` refuses with 401 when `password_hash` is null
 *     (server/modules/auth/auth.service.ts:375-383), and locks the account for
 *     15 minutes after 5 failed attempts (MAX_FAILED_ATTEMPTS = 5).
 *
 * So "a usable super_admin" requires, at minimum:
 *   status = 'active', password_hash present, not locked, and MFA enrolled
 *   (otherwise the guard blocks every request it makes).
 * Each condition is reported separately so the operator sees WHAT is missing.
 */
async function cmdSuperAdmin() {
  const sql = await connect();
  try {
    const rows = await sql`
      select t.id,
             t.username,
             t.status,
             (t.password_hash is not null)                              as has_password,
             t.failed_login_attempts,
             t.locked_until,
             (t.locked_until is not null and t.locked_until > now())     as locked_now,
             coalesce(m.confirmed, false)                                as mfa_enrolled
        from teachers t
        left join teacher_mfa m on m.teacher_id = t.id
       where t.roles @> array['super_admin']::varchar[]
       order by t.username
    `;

    if (rows.length === 0) {
      say('no teacher holds the super_admin role at all');
      say('an account with no password hash cannot log in, so this is not "just missing a lock-out"');
      fail();
    }

    say(`${rows.length} account(s) hold the super_admin role:`);
    const usable = [];
    for (const r of rows) {
      const problems = [];
      if (r.status !== 'active') problems.push(`status=${r.status}`);
      if (!r.has_password) problems.push('no password_hash (login refuses with 401)');
      if (r.locked_now) problems.push('locked_until is in the future');
      if (!r.mfa_enrolled) problems.push('MFA not enrolled (AuthGuard refuses every route)');
      const verdict = problems.length === 0 ? 'CAN LOG IN' : `CANNOT LOG IN: ${problems.join('; ')}`;
      say(`  - ${r.username}: ${verdict}`);
      if (problems.length === 0) usable.push(r.username);
    }

    if (usable.length === 0) {
      say('NOT READY: no super_admin can currently authenticate.');
      say('Note: the test fixture account `__rbac_keeper` is created WITHOUT a password on purpose');
      say('(tests/helpers/reset-fixtures.mjs:116-131) — it exists to keep the last-super_admin');
      say('trigger satisfiable during verification runs. It is not a production login.');
      say('Remediation (operator action, deliberately NOT performed by this check): create or');
      say('repair a real super_admin, set its password, then enrol TOTP.');
      fail();
    }

    say(`usable super_admin account(s): ${usable.join(', ')}`);
    if (usable.length === 1) {
      // Not fatal, but a single point of failure worth naming.
      warn('only one usable super_admin exists — a second one is the difference between a');
      warn('recoverable lock-out and an outage');
    }
    pass();
  } catch (error) {
    say(`query failed: ${redact(error)}`);
    fail();
  } finally {
    await sql.end();
  }
}

async function cmdMfa() {
  // ---- key well-formedness, mirroring server/common/crypto/mfa-crypto.ts ----
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    say('MFA_ENCRYPTION_KEY: NOT SET');
    say('TOTP secrets cannot be encrypted at rest; enrolment is refused (not silently downgraded)');
    say('and every login for an MFA-enabled account fails closed.');
    fail();
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    say(`MFA_ENCRYPTION_KEY: set but decodes to ${key.length} bytes; AES-256 requires exactly 32`);
    say('the application throws on this (mfa-crypto.ts:198-217), so MFA is NOT actually usable');
    fail();
  }
  say(`MFA_ENCRYPTION_KEY: set, decodes to ${key.length} bytes (valid AES-256 key)`);

  // ---- enforcement code path present and wired ----
  const mfaService = join(ROOT, 'server/modules/auth/mfa.service.ts');
  const authGuard = join(ROOT, 'server/modules/auth/auth.guard.ts');
  const authService = join(ROOT, 'server/modules/auth/auth.service.ts');
  for (const f of [mfaService, authGuard, authService]) {
    if (!existsSync(f)) {
      say(`missing source file: ${f} — cannot confirm enforcement`);
      fail();
    }
  }
  const svc = readFileSync(mfaService, 'utf8');
  const guard = readFileSync(authGuard, 'utf8');
  const service = readFileSync(authService, 'utf8');
  const checks = [
    ['mfa.service.ts defines requiresMfa()', /requiresMfa\s*\(\s*roles/.test(svc)],
    ['requiresMfa() keys on super_admin', /roles\.includes\(\s*SUPER_ADMIN_ROLE\s*\)/.test(svc)],
    ['AuthGuard blocks unenrolled MFA-required accounts', /requiresMfa\(.*\)[\s\S]{0,200}isEnabled\(/.test(guard)],
    ['login() issues a challenge instead of a session', /mfaRequired:\s*true/.test(service)],
  ];
  let enforcementOk = true;
  for (const [label, ok] of checks) {
    say(`  ${ok ? 'present' : 'MISSING'}: ${label}`);
    if (!ok) enforcementOk = false;
  }
  if (!enforcementOk) {
    say('MFA enforcement is not wired as expected — treat MFA as unverified');
    fail();
  }

  // ---- enrolment state of privileged accounts ----
  const sql = await connect();
  try {
    const rows = await sql`
      select t.username,
             t.status,
             (t.password_hash is not null)            as has_password,
             coalesce(m.confirmed, false)              as mfa_enrolled,
             (m.teacher_id is not null and not coalesce(m.confirmed, false)) as mfa_pending
        from teachers t
        left join teacher_mfa m on m.teacher_id = t.id
       where t.roles @> array['super_admin']::varchar[]
       order by t.username
    `;
    if (rows.length === 0) {
      say('no super_admin accounts exist, so there is no privileged account to check enrolment for');
      // The absence itself is reported by the super-admin check; here it is only
      // noted, because "MFA enforcement is in place" is still true of the code.
      say('MFA enforcement is in place in code; enrolment is vacuously satisfied');
      pass();
    }

    const privilegedThatCanLogIn = rows.filter((r) => r.status === 'active' && r.has_password);
    say(`${rows.length} super_admin account(s); ${privilegedThatCanLogIn.length} with a password hash`);
    for (const r of rows) {
      const state = r.mfa_enrolled ? 'enrolled' : r.mfa_pending ? 'enrolment started, NOT confirmed' : 'NOT enrolled';
      say(`  - ${r.username}: ${state}`);
    }

    if (privilegedThatCanLogIn.length === 0) {
      say('no super_admin with a password hash exists; enrolment cannot be demonstrated');
      say('MFA enforcement code is present, but privileged-account enrolment is UNVERIFIED');
      warnStatus();
    }
    const unenrolled = privilegedThatCanLogIn.filter((r) => !r.mfa_enrolled);
    if (unenrolled.length > 0) {
      say(`privileged account(s) without confirmed MFA: ${unenrolled.map((r) => r.username).join(', ')}`);
      say('AuthGuard denies every non-exempt route for these accounts until they enrol.');
      fail();
    }
    say('every super_admin that can log in has MFA confirmed');
    pass();
  } catch (error) {
    say(`query failed: ${redact(error)}`);
    fail();
  } finally {
    await sql.end();
  }
}

/**
 * Object storage.
 *
 * Downloads are served by asking an `ObjectStorage` backend for a signed URL
 * (server/modules/files/object-storage.ts). This deployment registers the default
 * backend, `UnconfiguredObjectStorage`, which is the honest implementation of
 * "there is no object store here": the application then refuses to invent a URL and
 * answers 503 STORAGE_NOT_CONFIGURED (or 503 STORAGE_UNAVAILABLE when a backend is
 * configured but the signing call fails).
 *
 * The platform-era version of this probe looked for a 妙搭 request context
 * (SUDA_APP_ID, dataloom bucket, …). Those variables are no longer read by
 * anything, so the probe now checks the CONTRACT THAT ACTUALLY HOLDS: no backend is
 * registered, a real backend can be plugged in through the OBJECT_STORAGE token, and
 * the service fails closed with the two named codes instead of returning a URL that
 * cannot work.
 *
 * It never fabricates a download URL and never treats "no evidence of storage" as
 * "storage works".
 */
async function cmdStorage() {
  // The interface file and the service, both quoted, so every claim below is checkable.
  const objectStorage = join(ROOT, 'server/modules/files/object-storage.ts');
  const filesService = join(ROOT, 'server/modules/files/files.service.ts');
  const filesModule = join(ROOT, 'server/modules/files/files.module.ts');
  for (const path of [objectStorage, filesService, filesModule]) {
    if (!existsSync(path)) {
      say(`missing ${path} — cannot confirm the storage contract`);
      fail();
    }
  }

  const storageSrc = readFileSync(objectStorage, 'utf8');
  const serviceSrc = readFileSync(filesService, 'utf8');
  const moduleSrc = readFileSync(filesModule, 'utf8');

  const interfaceOk =
    /export interface ObjectStorage/.test(storageSrc) &&
    /createSignedUrl\(/.test(storageSrc) &&
    /OBJECT_STORAGE/.test(storageSrc);
  say(`a replaceable backend interface exists (ObjectStorage / OBJECT_STORAGE token): ${interfaceOk ? 'confirmed' : 'NOT confirmed'}`);
  if (!interfaceOk) {
    say('without it, wiring S3/R2/MinIO later would mean editing the download path itself');
    fail();
  }

  const noFakeUrl =
    /STORAGE_NOT_CONFIGURED_MESSAGE/.test(storageSrc) &&
    /STORAGE_UNAVAILABLE_MESSAGE/.test(storageSrc) &&
    /STORAGE_NOT_CONFIGURED/.test(serviceSrc) &&
    /STORAGE_UNAVAILABLE/.test(serviceSrc) &&
    /ServiceUnavailableException/.test(serviceSrc) &&
    /isStorageConfigured/.test(serviceSrc);
  say(`application fails closed with 503 STORAGE_NOT_CONFIGURED / STORAGE_UNAVAILABLE: ${noFakeUrl ? 'confirmed' : 'NOT confirmed'}`);
  if (!noFakeUrl) {
    say('the storage service no longer refuses on missing configuration — that would be a REGRESSION,');
    say('because the only alternative is returning a URL that cannot work');
    fail();
  }

  const defaultIsUnconfigured = /provide: OBJECT_STORAGE, useClass: UnconfiguredObjectStorage/.test(moduleSrc);
  say(`the registered backend is the honest "not configured" one: ${defaultIsUnconfigured ? 'confirmed' : 'NOT confirmed'}`);

  if (defaultIsUnconfigured) {
    say('RESULT: object storage is NOT configured for this process.');
    say('Reason: UnconfiguredObjectStorage is bound to OBJECT_STORAGE, so the service has no backend');
    say('to sign with. Downloads return 503 STORAGE_NOT_CONFIGURED, never a fabricated URL.');
    say('To serve real bytes, implement ObjectStorage (S3 / Cloudflare R2 / MinIO) and bind it in');
    say('server/modules/files/files.module.ts. Until then this check reports a WAIVER, not a pass.');
    warnStatus();
  }

  say('RESULT: an object-storage backend is registered.');
  say('Presence is NOT proof that it is reachable or that a bucket resolves: signing happens per');
  say('request. Call the download endpoint on the deployed instance to verify it. Treat as UNVERIFIED.');
  warnStatus();
}

/**
 * CORS.
 *
 * The ticket's claim is "the app sets no CORS headers by default, which is the
 * restrictive default". That is a claim to be CHECKED, not assumed. Two independent
 * checks: the source tree configures no CORS layer, and a live response to a
 * cross-origin request carries no Access-Control-* header.
 */
async function cmdCors() {
  const suspicious = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry)) continue;
      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/enableCors\s*\(|Access-Control-Allow-Origin\s*['"`:)]|res\.setHeader\(\s*['"]Access-Control/i.test(line)) {
          suspicious.push(`${full.replace(`${ROOT}/`, '')}:${i + 1}`);
        }
      });
    }
  };
  walk(join(ROOT, 'server'));
  walk(join(ROOT, 'shared'));

  if (suspicious.length > 0) {
    say(`CORS configuration FOUND in source (${suspicious.length} site(s)):`);
    for (const s of suspicious) say(`  - ${s}`);
    say('CORS is no longer the restrictive default — review who may call this API cross-origin');
    fail();
  }
  say('source tree: no enableCors() call and no Access-Control-* header is set anywhere in server/ or shared/');
  say('=> CORS is at the restrictive default: a cross-origin browser request gets no CORS grant');
  say('   (that is correct for this app: the SPA is served same-origin from this process)');

  // Live confirmation, if a server is reachable. Absence of a server is not a
  // CORS failure — but it must not be reported as a live confirmation either, so
  // the live state is emitted explicitly as a marker the caller can read.
  const base = (process.env.MFA_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/health`, {
      headers: { Origin: 'https://cors-probe.invalid' },
      signal: AbortSignal.timeout(5000),
    });
    const acao = res.headers.get('access-control-allow-origin');
    const acac = res.headers.get('access-control-allow-credentials');
    say(`live probe ${base}/api/health with Origin: https://cors-probe.invalid -> HTTP ${res.status}`);
    if (acao || acac) {
      say(`live response DID carry CORS headers: allow-origin=${acao ?? '(none)'} allow-credentials=${acac ?? '(none)'}`);
      fail();
    }
    say('live response carried no Access-Control-* header — restrictive default confirmed live');
    say('CORS_LIVE=CONFIRMED');
  } catch (error) {
    say(`live probe not possible (${redact(error)})`);
    say('the SOURCE-LEVEL finding stands, but it was NOT confirmed against a running instance');
    say('the health/readiness check reports whether a server is running at all');
    say('CORS_LIVE=NOT_VERIFIED');
  }
  pass();
}

/**
 * Is the exclusive verification-gate lock held right now?
 *
 * scripts/verify-all.sh takes an EXCLUSIVE advisory lock (namespace 20812,
 * resource 1 — tests/helpers/reset-fixtures.mjs:87-88) because it runs
 * `npm run build`, whose first step is `rm -rf dist`, while the running server
 * serves static assets out of `dist/`. Two concurrent gates were proven to poison
 * each other. This probe uses pg_try_advisory_lock (non-blocking) and releases it
 * immediately, so it can never steal or block the lock.
 */
async function cmdGateLock() {
  const sql = await connect();
  try {
    const [row] = await sql`select pg_try_advisory_lock(20812, 1) as ok`;
    if (row?.ok) {
      await sql`select pg_advisory_unlock(20812, 1)`;
      say('GATE_LOCK=FREE (probe lock acquired and released immediately)');
      pass();
    }
    say('GATE_LOCK=HELD (another verification run owns the shared environment)');
    say('a gate or a standalone suite is live; the security gate must NOT be started concurrently');
    emit('INFO', true, false);
  } catch (error) {
    say(`could not probe the gate lock: ${redact(error)}`);
    fail();
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
/**
 * Which of the interesting variables is the RUNNING instance actually started
 * with? Reported as present/absent only — never as values.
 *
 * WHY THIS EXISTS
 *   `npm run predeploy` judges the environment it inherits. That is the right
 *   subject (it is the environment you are about to deploy with), but it creates
 *   a trap: on this machine the live instance was started with NODE_ENV=production
 *   and both signing keys, while the operator's shell has neither. Reporting the
 *   difference turns a confusing "NODE_ENV is ''" into an actionable statement
 *   about which start recipe is really running.
 *
 * HOW
 *   `ps eww -p <pid>` exposes the environment block of a process you own. It is
 *   platform-shaped (space-separated on macOS, NUL-separated on Linux) and needs a
 *   visible pid, so the result is labelled INFERRED and never decides a verdict.
 */
async function cmdProcessEnv() {
  const { execFileSync } = await import('node:child_process');
  const interesting = [
    'NODE_ENV', 'HTTPS_ENABLED', 'TRUST_PROXY', 'SERVER_HOST', 'SERVER_PORT',
    'SUDA_DATABASE_URL', 'DATABASE_URL', 'MFA_ENCRYPTION_KEY',
    'DOWNLOAD_TOKEN_SECRET', 'DOWNLOAD_TOKEN_TTL_SECONDS', 'LOGIN_IP_RATE_LIMIT_MAX',
  ];
  let psOut = '';
  try {
    psOut = execFileSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  } catch (error) {
    say(`could not list processes: ${redact(error)}`);
    emit('INFO', true, false);
  }
  const line = psOut
    .split('\n')
    .find((l) => /node\s+(\.\/)?(dist\/)?server\/main\.js/.test(l));
  const pid = line ? line.trim().split(/\s+/)[0] : '';
  if (!pid) {
    say('no running `node server/main.js` process is visible to this user');
    emit('INFO', true, false);
  }
  let envOut = '';
  try {
    envOut = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' });
  } catch (error) {
    say(`could not read the environment of pid ${pid}: ${redact(error)}`);
    emit('INFO', true, false);
  }
  const tokens = envOut.split(/[\s\u0000]+/).filter(Boolean);
  say(`running instance pid=${pid} (INFERRED from ps; not part of the verdict)`);
  for (const name of interesting) {
    const hit = tokens.find((t) => t.startsWith(`${name}=`));
    if (!hit) {
      say(`  ${name}: absent from the process environment`);
      continue;
    }
    const isSecret = /KEY|SECRET|DATABASE_URL/.test(name);
    say(`  ${name}: ${isSecret ? '<set, value withheld>' : hit.slice(name.length + 1)}`);
  }
  const keys = ['NODE_ENV', 'MFA_ENCRYPTION_KEY', 'DOWNLOAD_TOKEN_SECRET', 'SUDA_DATABASE_URL'];
  const have = keys.filter((k) => tokens.some((t) => t.startsWith(`${k}=`) && t.length > k.length + 1));
  say(`process claims to have: ${have.length > 0 ? have.join(', ') : '(none)'}`);
  emit('INFO', true, false);
}

// ---------------------------------------------------------------------------
const [, , subcommand] = process.argv;
const commands = {
  connectivity: cmdConnectivity,
  'super-admin': cmdSuperAdmin,
  mfa: cmdMfa,
  storage: cmdStorage,
  cors: cmdCors,
  'gate-lock': cmdGateLock,
  'process-env': cmdProcessEnv,
};

const handler = commands[subcommand];
if (!handler) {
  die(`unknown subcommand '${subcommand ?? ''}'. One of: ${Object.keys(commands).join(', ')}`);
}
await handler();
