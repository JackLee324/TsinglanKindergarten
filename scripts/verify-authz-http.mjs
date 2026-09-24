/**
 * scripts/verify-authz-http.mjs — live HTTP authorization gate.
 *
 * FIXTURES
 *   This suite creates its OWN accounts for the run (a `principal` and a
 *   `prek_assistant`) and deletes them afterwards. It deliberately does NOT reset,
 *   demote or reuse a shared fixture account: `teachers.permissions_version` is
 *   ACCOUNT-WIDE, so demoting a shared account (section D, which exists to prove
 *   instant revocation) would revoke the session of every other suite using that
 *   account, in every process. See tests/helpers/reset-fixtures.mjs.
 */
const BASE = process.env.AUTHZ_BASE || process.env.MFA_BASE || 'http://127.0.0.1:3200';
let jar = {};
function cookieHeader() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
function store(res) { const sc = res.headers.getSetCookie?.() ?? []; for (const c of sc) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } }
async function req(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (Object.keys(jar).length) headers['cookie'] = cookieHeader();
  if (jar['suda-csrf-token']) headers['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  store(res);
  let data = null; try { data = await res.json(); } catch { /* a redirect or HTML body has no JSON */ }
  return { status: res.status, data };
}
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(58) + '-> ' + actual + (ok ? '' : '   expected ' + expected));
  ok ? pass++ : fail++;
}

const { startVerificationRun } = await import('../tests/helpers/reset-fixtures.mjs');

/** Set when anything other than an assertion failed; forces a non-zero exit. */
let FATAL = null;

const run = await startVerificationRun(process.env.AUTHZ_TEST_DB, {
  suite: 'authz',
  accounts: ['admin', 'low'],
});
const sql = run.sql;
const admin = run.account('admin');
const low = run.account('low');

async function login(user) {
  jar = {};
  await req('GET', '/');                      // obtain suda-csrf-token cookie
  const r = await req('POST', '/api/auth/login', { username: user.username, password: user.password });
  // A successful login is 201 (the suite asserts that below). This guard used to
  // test for 200, so it printed "LOGIN FAILED" on every successful login and
  // trained the reader to ignore the one diagnostic that matters when a later
  // check fails.
  if (r.status !== 201) { console.log('  LOGIN FAILED for ' + user.username + ': ' + r.status + ' ' + JSON.stringify(r.data)); }
  return r;
}

try {
  const sv = await req('GET', '/');
  console.log('=== CSRF BOOTSTRAP ===');
  check('GET / issues suda-csrf-token cookie', !!jar['suda-csrf-token'], true);
  check('GET /api/auth/me without session', (await req('GET', '/api/auth/me')).status, 401);

  console.log('\n=== A. LOW-PRIVILEGE ACCOUNT (prek_assistant) ===');
  check('login succeeds', (await login(low)).status, 201);
  check('GET /api/auth/me', (await req('GET', '/api/auth/me')).status, 200);
  const perms = (await req('GET', '/api/auth/me/permissions')).data;
  console.log('       effective permissions count: ' + perms.permissions.length + ' roles=' + JSON.stringify(perms.roles));
  check('has resource.view', perms.permissions.includes('resource.view'), true);
  check('does NOT have account.view', perms.permissions.includes('account.view'), false);
  check('does NOT have audit.view', perms.permissions.includes('audit.view'), false);
  check('does NOT have resource.create', perms.permissions.includes('resource.create'), false);
  check('GET /api/teachers (admin API)', (await req('GET', '/api/teachers')).status, 403);
  check('GET /api/audit/logs (admin API)', (await req('GET', '/api/audit/logs')).status, 403);
  check('POST /api/teachers (create account)', (await req('POST', '/api/teachers', { name: 'x', roles: ['visitor'] })).status, 403);
  check('GET /api/resources (allowed)', (await req('GET', '/api/resources')).status, 200);
  check('POST /api/resources (needs resource.create)', (await req('POST', '/api/resources', { title: 'x', program: 'prek', subject: 'virtue', folderType: 'curriculum_outline' })).status, 403);

  console.log('\n=== B. PRINCIPAL (business admin) ===');
  check('login succeeds', (await login(admin)).status, 201);
  const pperms = (await req('GET', '/api/auth/me/permissions')).data;
  check('has account.view', pperms.permissions.includes('account.view'), true);
  check('has audit.view', pperms.permissions.includes('audit.view'), true);
  check('does NOT have system.manage', pperms.permissions.includes('system.manage'), false);
  check('does NOT have system.restore', pperms.permissions.includes('system.restore'), false);
  check('GET /api/teachers', (await req('GET', '/api/teachers')).status, 200);
  check('GET /api/audit/logs', (await req('GET', '/api/audit/logs')).status, 200);

  console.log('\n=== C. PRIVILEGE ESCALATION: principal -> super_admin ===');
  // The escalation target is this run's own low-privilege account rather than a
  // seeded one: the property under test ("a principal may not mint a super_admin")
  // does not depend on WHICH account is targeted, and using a private target keeps
  // the suite from writing to a row another suite is reading.
  const r = await req('PATCH', '/api/teachers/' + low.id, { roles: ['super_admin'] });
  check('principal CANNOT promote to super_admin', r.status, [400, 403, 500]);
  console.log('       response: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 160));
  const me = await req('GET', '/api/auth/me');
  check('principal still principal (no self-escalation)', JSON.stringify(me.data?.roles), '["principal"]');

  console.log('\n=== D. INSTANT REVOCATION (permissions_version) ===');
  const before = (await req('GET', '/api/resources')).status;
  check('resources reachable before change', before, 200);
  if (!process.env.AUTHZ_TEST_DB) {
    console.log('  (AUTHZ_TEST_DB not set; skipping revocation assertion)');
  } else {
    // Bumps THIS run's account only; the database trigger moves
    // permissions_version and AuthGuard must reject the existing session.
    await sql`update teachers set roles = array['visitor'] where id = ${admin.id}`;
    const after = await req('GET', '/api/resources');
    check('session invalidated immediately after role change', after.status, 401);
    console.log('       response: ' + after.status + ' ' + JSON.stringify(after.data).slice(0, 120));
  }
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
