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
import { folderIdFor } from '../tests/helpers/directory-fixture.mjs';
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
  // `cacheControl` is exported so a suite can assert that a response carrying a
  // one-time credential is not cacheable. Additive: existing call sites keep
  // reading only `status` / `data`.
  return { status: res.status, data, cacheControl: res.headers.get('cache-control') };
}
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(58) + '-> ' + actual + (ok ? '' : '   expected ' + expected));
  // 写成 if/else 而不是 `ok ? pass++ : fail++`：后者是一条**没有副作用的表达式语句**，
  // eslint 的 no-unused-expressions 会正确报错，而且读的人需要多看一眼才知道它在计数。
  if (ok) pass++;
  else fail++;
}

const { startVerificationRun } = await import('../tests/helpers/reset-fixtures.mjs');

/** Set when anything other than an assertion failed; forces a non-zero exit. */
let FATAL = null;

const run = await startVerificationRun(process.env.AUTHZ_TEST_DB, {
  suite: 'authz',
  // `admin2`/`admin3` are two principals (equal rank), `director` holds account.view
  // but not account.reset_password, `head` is the legitimate reset target, and
  // `superadmin` is the highest-tier target nobody but a super_admin may touch.
  accounts: ['admin', 'low', 'admin2', 'admin3', 'director', 'head', 'superadmin'],
});
const sql = run.sql;
const admin = run.account('admin');
const low = run.account('low');
const admin2 = run.account('admin2');
const admin3 = run.account('admin3');
const director = run.account('director');
const head = run.account('head');
const superadmin = run.account('superadmin');

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
  await req('GET', '/');
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
  // ⚠️ 这个请求必须带一个**合法**的 directoryId。§8 之后缺 directoryId 会先被
  // DTO 以 400 拒绝，而这条断言期望的是 403 —— 若不补，它会"通过"但检验的
  // 是参数校验而不是权限。这类"因为错误的理由变绿"正是本仓库反复在防的。
  const authzProbeDir = await folderIdFor({ req }, { program: 'prek', subject: 'virtue' });
  check('POST /api/resources (needs resource.create)', (await req('POST', '/api/resources', { title: 'x', program: 'prek', subject: 'virtue', directoryId: authzProbeDir })).status, 403);

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
  // 这里以前写的是 [400, 403, 500] —— 一个"只要能失败就算过"的区间。
  // 实测那 400 来自 teachers.dto.ts 里一份漏掉 super_admin 的本地角色表（@IsIn 拒绝），
  // 也就是说这条断言当时**根本没碰到 RBAC**：把 DTO 的角色表修对（§10）之后，
  // 唯一还能挡住提权的就只剩 AuthorizationService。所以现在必须精确要求 403。
  check('principal CANNOT promote to super_admin (RBAC 403, 不是 DTO 400)', r.status, 403);
  console.log('       response: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 160));
  const eq = await req('PATCH', '/api/teachers/' + low.id, { roles: ['principal'] });
  check('principal CANNOT grant an EQUAL-rank role (principal)', eq.status, 403);
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

  // ===========================================================================
  // E. ADMIN PASSWORD RESET (audit finding G-18)
  // ===========================================================================
  // POST /api/auth/reset-password used to have NO @RequirePermission at all, and
  // authorised itself with `if (!operator.roles.includes('principal')) throw new
  // NotFoundException()` before resetting whatever `body.teacherId` named. This
  // section asserts the replaced model, end to end, over HTTP:
  //
  //   * 401 unauthenticated, 403 for an authenticated caller without the
  //     capability (both an ordinary account and one that holds account.view);
  //   * a legitimate administrator reset SUCCEEDS, the target can authenticate
  //     with the returned one-time password and NOT with the old one, and the
  //     stored value is a scrypt hash;
  //   * IDOR: a peer principal, a super_admin and the caller itself are all
  //     refused — and, the assertion that actually matters, the refused targets'
  //     `password_hash` is compared byte-for-byte afterwards to prove that nothing
  //     was written;
  //   * every reset and every refusal is audited, and no audit row, error body or
  //     API response contains the temporary password.
  console.log('\n=== E. ADMIN PASSWORD RESET: PERMISSION MODEL + IDOR + AUDIT (G-18) ===');
  const RESET = '/api/auth/reset-password';
  const MISSING_ID = '00000000-0000-4000-8000-000000000000';
  const hashOf = async (id) =>
    (await sql`select password_hash h from teachers where id = ${id}`)[0]?.h ?? null;

  check(
    'precondition: the "unknown account" id does not exist',
    (await sql`select count(*)::int n from teachers where id = ${MISSING_ID}`)[0].n,
    0,
  );

  // 401 — no session. The CSRF cookie IS present (GET / below), so this response
  // is the authentication decision and not a CSRF refusal.
  jar = {}; await req('GET', '/');
  const anonReset = await req('POST', RESET, { teacherId: head.id });
  check('unauthenticated reset -> 401', anonReset.status, 401);

  // 403 — authenticated, ordinary account.
  check('prek_assistant login', (await login(low)).status, 201);
  const lowReset = await req('POST', RESET, { teacherId: head.id });
  check('prek_assistant cannot reset another account -> 403', lowReset.status, 403);

  // 403 — authenticated AND holding account.view: the route is permission-gated,
  // not merely role- or login-gated.
  check('curriculum_director login', (await login(director)).status, 201);
  check('  -> director can read the account list', (await req('GET', '/api/teachers')).status, 200);
  const directorReset = await req('POST', RESET, { teacherId: head.id });
  check('director cannot reset (lacks account.reset_password) -> 403', directorReset.status, 403);

  // ---- the legitimate administrator reset --------------------------------
  check('principal (admin2) login', (await login(admin2)).status, 201);
  const adminPerms = (await req('GET', '/api/auth/me/permissions')).data;
  check('principal holds account.reset_password', adminPerms.permissions.includes('account.reset_password'), true);
  check('principal does NOT hold the privileged-reset permission',
    adminPerms.permissions.includes('account.reset_privileged_password'), false);

  const headHashBefore = await hashOf(head.id);
  const okReset = await req('POST', RESET, { teacherId: head.id });
  check('principal resets an ORDINARY account -> 201', okReset.status, 201);
  const temp = okReset.data?.temporaryPassword;
  if (typeof temp !== 'string' || temp.length < 12) {
    // Every assertion below depends on this value; continuing would report a
    // cascade of meaningless failures.
    throw new Error(
      'the reset response carried no usable temporary password: ' + JSON.stringify(okReset.data),
    );
  }
  check('the temporary password is not the previous password', temp !== head.password, true);
  check('response is not cacheable (Cache-Control: no-store)', okReset.cacheControl, 'no-store');
  check('the stored credential is a scrypt hash, not the plaintext',
    (await hashOf(head.id)).startsWith('scrypt$') && (await hashOf(head.id)) !== temp, true);
  check('the stored credential actually changed', (await hashOf(head.id)) !== headHashBefore, true);
  check('the issued password is marked temporary',
    (await sql`select must_change_password m from teachers where id = ${head.id}`)[0].m, true);

  const resetAudit = await sql`
    select detail, success from audit_logs
     where action = 'password_reset' and teacher_id = ${head.id}`;
  check('exactly one password_reset audit row for the target', resetAudit.length, 1);
  check('  -> it names the operator, the target roles and the factor used',
    /reset by .+; target roles=\[prek_head\]; secondFactor=not_enrolled/.test(resetAudit[0]?.detail ?? ''), true);
  check('the temporary password is in NO audit row',
    (await sql`select count(*)::int n from audit_logs
                where detail like ${'%' + temp + '%'}
                   or coalesce(error_message,'') like ${'%' + temp + '%'}`)[0].n, 0);

  // The reset must be real for the account itself. The OLD password is sent with
  // the raw request helper rather than login(): that helper prints a "LOGIN FAILED"
  // diagnostic for any non-201 login, which would be noise for a login that is
  // SUPPOSED to fail.
  jar = {}; await req('GET', '/');
  const oldPassword = await req('POST', '/api/auth/login', { username: head.username, password: head.password });
  check('the OLD password no longer works', oldPassword.status, 401);
  jar = {}; await req('GET', '/');
  const withTemp = await req('POST', '/api/auth/login', { username: head.username, password: temp });
  check('the account can log in with the temporary password', withTemp.status, 201);

  // ---- IDOR: a caller may only act inside its permitted set --------------
  check('principal (admin2) login', (await login(admin2)).status, 201);
  const hashesBefore = {
    admin3: await hashOf(admin3.id),
    superadmin: await hashOf(superadmin.id),
    admin2: await hashOf(admin2.id),
    director: await hashOf(director.id),
  };
  const idor = [];
  idor.push(await req('POST', RESET, { teacherId: admin3.id }));      // equal rank
  check('principal -> PEER principal -> 403', idor[0].status, 403);
  idor.push(await req('POST', RESET, { teacherId: superadmin.id }));  // higher rank
  check('principal -> super_admin target -> 403', idor[1].status, 403);
  idor.push(await req('POST', RESET, { teacherId: admin2.id }));      // the caller itself
  check('principal -> ITSELF -> 403', idor[2].status, 403);

  // Compared as booleans on purpose: the assertion is "the stored credential did
  // not change", and printing the hashes would put password material in the log.
  check('peer principal password_hash UNCHANGED after the refusals',
    (await hashOf(admin3.id)) === hashesBefore.admin3, true);
  check('super_admin password_hash UNCHANGED after the refusals',
    (await hashOf(superadmin.id)) === hashesBefore.superadmin, true);
  check('caller password_hash UNCHANGED after the refusals',
    (await hashOf(admin2.id)) === hashesBefore.admin2, true);
  check('the peer principal still authenticates with its own password', (await login(admin3)).status, 201);

  // ---- selectors: one shape only, refused rather than coerced ------------
  check('principal (admin2) login', (await login(admin2)).status, 201);
  const malformed = await req('POST', RESET, { teacherId: 'not-a-uuid' });
  check('malformed teacherId -> 400 (never a 500 from the uuid cast)', malformed.status, 400);
  const aliased = await req('POST', RESET, { accountId: director.id });
  check('accountId is NOT accepted as a selector -> 400', aliased.status, 400);
  const unknown = await req('POST', RESET, { teacherId: MISSING_ID });
  check('well-formed but unknown account -> 404', unknown.status, 404);
  check('director password_hash UNCHANGED after those attempts',
    (await hashOf(director.id)) === hashesBefore.director, true);

  // ---- refusals are auditable, and secrets never appear ------------------
  const refused = await sql`
    select detail from audit_logs
     where action = 'permission_denied' and teacher_id = ${admin2.id}
       and detail like '%password_reset refused%'`;
  check('scope refusals are audited', refused.length >= 2, true);
  check('  -> a refusal row names the targeted account',
    refused.some((r) => (r.detail ?? '').includes(admin3.id)), true);

  const refusedBodies = JSON.stringify([
    anonReset.data, lowReset.data, directorReset.data,
    ...idor.map((r) => r.data), malformed.data, aliased.data, unknown.data,
  ]);
  check('no refused response contains the temporary password', refusedBodies.includes(temp), false);
  check('no refused response contains a hash or the fixture password',
    /scrypt\$|TestPassw0rd/.test(refusedBodies), false);

  const auditApi = await req('GET', `/api/audit/logs?action=password_reset&teacherId=${head.id}`);
  check('GET /api/audit/logs returns the reset record', auditApi.status, 200);
  check('  -> the record is for the reset target', JSON.stringify(auditApi.data).includes(head.id), true);
  check('  -> the audit API never returns the temporary password',
    JSON.stringify(auditApi.data).includes(temp), false);
  const teacherDetail = await req('GET', `/api/teachers/${head.id}`);
  check('GET /api/teachers/:id exposes no credential material',
    /temporaryPassword|passwordHash|scrypt\$/.test(JSON.stringify(teacherDetail.data)), false);

  // ===========================================================================
  // F. SELF-SERVICE PASSWORD CHANGE
  // ===========================================================================
  // Found while verifying the reset route: `change-password` wrote `password_hash`
  // with a plain drizzle UPDATE, which runs as the `anon_` database role — and
  // migration 0005 grants `anon_` UPDATE on only three columns of `teachers`
  // (last_login_at, failed_login_attempts, locked_until). The endpoint answered
  // HTTP 500 and the password was never changed, for every account. These
  // assertions pin the repaired behaviour; the reset route above uses the same
  // repaired path.
  console.log('\n=== F. SELF-SERVICE PASSWORD CHANGE (was HTTP 500) ===');
  const CHPW = '/api/auth/change-password';
  const NEW_LOW_PASSWORD = 'NewLowPassw0rd!3';

  check('prek_assistant login', (await login(low)).status, 201);
  const wrongCurrent = await req('POST', CHPW, { currentPassword: 'WrongPassw0rd!', newPassword: NEW_LOW_PASSWORD });
  check('wrong current password -> 401', wrongCurrent.status, 401);
  const weak = await req('POST', CHPW, { currentPassword: low.password, newPassword: 'short' });
  check('new password that breaks the policy -> 400', weak.status, 400);
  const changed = await req('POST', CHPW, { currentPassword: low.password, newPassword: NEW_LOW_PASSWORD });
  check('changing your OWN password -> 201', changed.status, 201);
  check('  -> the response carries the account, never a credential',
    /newPassword|passwordHash|scrypt\$/.test(JSON.stringify(changed.data)), false);
  check('  -> and the change is audited',
    (await sql`select count(*)::int n from audit_logs
                where action = 'password_changed' and teacher_id = ${low.id} and success`)[0].n >= 1, true);

  jar = {}; await req('GET', '/');
  const withNew = await req('POST', '/api/auth/login', { username: low.username, password: NEW_LOW_PASSWORD });
  check('the NEW password works', withNew.status, 201);
  jar = {}; await req('GET', '/');
  const withOld = await req('POST', '/api/auth/login', { username: low.username, password: low.password });
  check('the OLD password no longer works', withOld.status, 401);
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
