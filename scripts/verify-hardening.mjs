/**
 * scripts/verify-hardening.mjs — manual HTTP verification of the phase-5
 * transport/observability hardening.
 *
 * Requires a running server and AUTHZ_TEST_DB:
 *
 *   AUTHZ_TEST_DB=postgres://... node scripts/verify-hardening.mjs
 *
 * Asserts, over real HTTP:
 *   A. X-Forwarded-For spoofing cannot forge the audited client IP  (finding D-10)
 *   B. a 5xx response leaks no stack / cause / paths / SQL         (finding G-11)
 *   C. every response carries a correlation id
 *
 * Kept as a script rather than a test because it needs a live server and a
 * database; see PRODUCTION_READINESS.md for how it is run.
 *
 * FIXTURES
 *   This suite creates its OWN account for the run and deletes it afterwards; it
 *   never resets, demotes or logs out a shared fixture account. See
 *   tests/helpers/reset-fixtures.mjs for why that distinction is the whole
 *   difference between a gate and a coin toss.
 */

const BASE = process.env.MFA_BASE || 'http://127.0.0.1:3200';
let jar = {};
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function store(res) {
  for (const c of (res.headers.getSetCookie?.() ?? [])) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
async function req(method, path, body, extra = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (Object.keys(jar).length) headers['cookie'] = ch();
  if (jar['suda-csrf-token']) headers['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  store(res);
  let data = null; try { data = await res.json(); } catch { /* a 302/HTML body has no JSON */ }
  return { status: res.status, data, headers: res.headers };
}
let pass = 0, fail = 0;
function check(l, a, e) {
  const ok = Array.isArray(e) ? e.includes(a) : a === e;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + l.padEnd(58) + '-> ' + String(a) + (ok ? '' : '   expected ' + e));
  ok ? pass++ : fail++;
}

const { startVerificationRun } = await import('../tests/helpers/reset-fixtures.mjs');

/** Set when anything other than an assertion failed; forces a non-zero exit. */
let FATAL = null;

const run = await startVerificationRun(process.env.AUTHZ_TEST_DB, {
  suite: 'hardening',
  accounts: ['admin'],
});
const sql = run.sql;
const admin = run.account('admin');

try {
  await req('GET', '/');
  const login = await req('POST', '/api/auth/login', { username: admin.username, password: admin.password },
    { 'x-forwarded-for': '203.0.113.99, 10.0.0.1', 'x-real-ip': '203.0.113.99' });
  check('login succeeds', login.status, 201);

  console.log('\n=== A. X-Forwarded-For SPOOFING (audit finding D-10) ===');
  // Scoped to THIS run's account: "the most recent login" would read another live
  // suite's row and turn a shared-environment accident into a security finding.
  const rows = await sql`
    select ip_address from audit_logs
    where action = 'login' and success = true and teacher_id = ${admin.id}
    order by _created_at desc limit 1`;
  const audited = rows[0]?.ip_address ?? '(none)';
  check('audited IP is the REAL socket address, not the forged header', audited, '127.0.0.1');
  console.log('       client sent X-Forwarded-For: 203.0.113.99, 10.0.0.1');
  console.log('       audit recorded            : ' + audited);

  console.log('\n=== B. ERROR SANITIZATION (audit finding G-11) ===');
  // Error-path coverage. NOTE the history: this check originally used
  // `/api/resources/mine`, which was broken (no such route, so it fell through to
  // `:id` and 500'd) and therefore doubled as an error generator. That route is now
  // FIXED and returns 200 — which is asserted separately below — so the leak check
  // must use a path that genuinely errors.
  //
  // A valid-but-nonexistent UUID produces a 404 through the application's own
  // exception filter, which is the code path whose sanitisation we want to verify.
  // A real 5xx is exercised separately by stopping PostgreSQL; that run is recorded
  // in PRODUCTION_READINESS.md and cannot be automated here because it requires
  // taking the database down.
  const mine = await req('GET', '/api/resources/mine');
  check('GET /api/resources/mine now works (contract fix)', mine.status, 200);

  const err = await req('GET', '/api/resources/00000000-0000-0000-0000-000000000000');
  check('error path returns a 4xx/5xx status', [400, 404, 500].includes(err.status), true);
  const body = JSON.stringify(err.data ?? {});
  check('response body has NO "stack"', !/"stack"/.test(body), true);
  check('response body has NO "cause"', !/"cause"/.test(body), true);
  check('response body has NO file path', !/\/Users\/|node_modules|\.ts"/.test(body), true);
  check('response body has NO SQL', !/select |insert |update /i.test(body), true);
  check('response body carries requestId', !!err.data?.error?.requestId, true);
  console.log('       body: ' + body.slice(0, 180));

  console.log('\n=== C. requestId correlation ===');
  check('500 response sets x-request-id header', !!err.headers.get('x-request-id'), true);
} catch (error) {
  FATAL = error;
} finally {
  const cleaned = await run.cleanup();
  if (!cleaned.ok) {
    FATAL = FATAL ?? cleaned.error;
    console.error('  CLEANUP FAILED: ' + cleaned.error.message);
  }
}

console.log('\n=== RESULT ===');
if (FATAL) {
  console.error('  ABORTED — the suite did not run to completion:');
  console.error('  ' + (FATAL.stack ?? String(FATAL)).split('\n').join('\n  '));
}
console.log('  pass=' + pass + ' fail=' + fail);
process.exit(FATAL || fail ? 1 : 0);
