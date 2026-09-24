/**
 * scripts/verify-mfa.mjs — end-to-end TOTP verification over real HTTP.
 *   AUTHZ_TEST_DB=postgres://... node scripts/verify-mfa.mjs
 * Requires a running server with MFA_ENCRYPTION_KEY set.
 *
 * FIXTURES
 *   This suite creates its OWN account for the run, promotes it to super_admin to
 *   exercise the mandatory-MFA rules, and deletes it afterwards. It does NOT use a
 *   shared fixture account: `permissions_version` is account-wide, so promoting a
 *   shared account would force every other live suite on that account to
 *   re-authenticate mid-run. See tests/helpers/reset-fixtures.mjs.
 *
 *   A KEEPER super_admin (`__rbac_keeper`, created idempotently by the helper) must
 *   exist before the promotion, and the reason is a guard working correctly:
 *   `rbac_protect_last_super_admin` refuses to demote or delete the LAST active
 *   super_admin. Without a second one, this run's account could never be cleaned up.
 */
const BASE = process.env.MFA_BASE || 'http://127.0.0.1:3200';
let jar = {};
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function store(r) { for (const c of (r.headers.getSetCookie?.() ?? [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } }
async function req(m, p, b) {
  const h = { 'content-type': 'application/json' };
  if (Object.keys(jar).length) h['cookie'] = ch();
  if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  store(r);
  let d = null; try { d = await r.json(); } catch { /* a redirect or HTML body has no JSON */ }
  return { s: r.status, d, setCookie: r.headers.getSetCookie?.() ?? [] };
}
let pass = 0, fail = 0;
function check(l, a, e) {
  const ok = Array.isArray(e) ? e.includes(a) : a === e;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + l.padEnd(56) + '-> ' + String(a) + (ok ? '' : '   expected ' + e));
  ok ? pass++ : fail++;
}

const { startVerificationRun } = await import('../tests/helpers/reset-fixtures.mjs');
const crypto = await import('node:crypto');

/** Set when anything other than an assertion failed; forces a non-zero exit. */
let FATAL = null;

const run = await startVerificationRun(process.env.AUTHZ_TEST_DB, {
  suite: 'mfa',
  // `admin` is promoted to super_admin by section E; `target` is a PRINCIPAL — a
  // privileged account, so resetting its password additionally requires the
  // super-admin-only `account.reset_privileged_password` permission.
  accounts: ['admin', 'admin2'],
});
const sql = run.sql;
const admin = run.account('admin');
const target = run.account('admin2');
const PW = admin.password;
const TID = admin.id;

// TOTP implemented independently of the server code, so the test cannot pass by
// sharing a bug with the implementation.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32d(s) { let bits = 0, v = 0; const out = []; for (const c of s.toUpperCase().replace(/=+$/, '')) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totp(secret, t = Math.floor(Date.now() / 1000), period = 30, digits = 6) {
  const buf = Buffer.alloc(8); const c = Math.floor(t / period);
  buf.writeUInt32BE(Math.floor(c / 2 ** 32), 0); buf.writeUInt32BE(c >>> 0, 4);
  const d = crypto.createHmac('sha1', b32d(secret)).update(buf).digest();
  const o = d[d.length - 1] & 15;
  const n = ((d[o] & 127) << 24) | ((d[o + 1] & 255) << 16) | ((d[o + 2] & 255) << 8) | (d[o + 3] & 255);
  return String(n % 10 ** digits).padStart(digits, '0');
}

let secret = null;

try {
  await req('GET', '/');
  const l1 = await req('POST', '/api/auth/login', { username: admin.username, password: PW });
  check('login without MFA enrolled succeeds', l1.s, 201);
  check('  -> response says mfaRequired=false', l1.d?.mfaRequired, false);

  console.log('\n=== A. ENROLMENT ===');
  const st0 = await req('GET', '/api/auth/mfa/status');
  check('status before enrolment: enabled=false', st0.d?.enabled, false);
  const enr = await req('POST', '/api/auth/mfa/enroll');
  check('enrol returns 201', enr.s, 201);
  check('enrol returns a secret', typeof enr.d?.secret === 'string' && enr.d.secret.length > 20, true);
  check('enrol returns an otpauth URI', /^otpauth:\/\/totp\//.test(enr.d?.otpauthUri || ''), true);
  secret = enr.d.secret;

  const rowAfterEnroll = await sql`select secret_encrypted, confirmed from teacher_mfa where teacher_id = ${TID}`;
  check('secret stored ENCRYPTED (not plaintext)', rowAfterEnroll[0]?.secret_encrypted?.includes(secret) === false, true);
  check('  -> stored format is v1:iv:tag:ct', /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(rowAfterEnroll[0]?.secret_encrypted || ''), true);
  check('not yet confirmed before code verification', rowAfterEnroll[0]?.confirmed, false);

  const badConfirm = await req('POST', '/api/auth/mfa/confirm', { code: '000000' });
  check('wrong code cannot confirm enrolment', badConfirm.s, 400);
  const conf = await req('POST', '/api/auth/mfa/confirm', { code: totp(secret) });
  check('correct code confirms enrolment', conf.s, 201);
  check('recovery codes returned once', Array.isArray(conf.d?.recoveryCodes) && conf.d.recoveryCodes.length === 10, true);
  const recoveryCodes = conf.d.recoveryCodes;
  const hashed = await sql`select code_hash from mfa_recovery_codes where teacher_id = ${TID} limit 1`;
  check('recovery codes stored HASHED (not plaintext)', hashed[0]?.code_hash !== recoveryCodes[0], true);
  check('  -> stored as sha256 hex(64)', /^[0-9a-f]{64}$/.test(hashed[0]?.code_hash || ''), true);

  console.log('\n=== B. LOGIN WITH MFA ===');
  jar = {};
  await req('GET', '/');
  const l2 = await req('POST', '/api/auth/login', { username: admin.username, password: PW });
  check('login now requires the second factor', l2.d?.mfaRequired, true);
  check('challenge token returned', typeof l2.d?.challengeToken === 'string', true);
  check('NO session cookie issued at this stage', l2.setCookie.some(c => /qls_session=/.test(c) && !/qls_session=;/.test(c)), false);
  const guarded = await req('GET', '/api/teachers');
  check('half-authenticated caller cannot reach an API', guarded.s, 401);

  console.log('\n=== C. SECOND FACTOR ===');
  const bad = await req('POST', '/api/auth/mfa/verify', { challengeToken: l2.d.challengeToken, code: '000000' });
  check('wrong TOTP rejected', bad.s, 401);
  check('  -> attempts remaining reported', /还可尝试/.test(bad.d?.error?.message || ''), true);
  const good = await req('POST', '/api/auth/mfa/verify', { challengeToken: l2.d.challengeToken, code: totp(secret) });
  check('correct TOTP completes login', good.s, 201);
  check('session issued after second factor', good.setCookie.some(c => /qls_session=/.test(c)), true);
  const authed = await req('GET', '/api/teachers');
  check('session now works', authed.s, 200);
  const replay = await req('POST', '/api/auth/mfa/verify', { challengeToken: l2.d.challengeToken, code: totp(secret) });
  check('challenge token is single-use (replay rejected)', replay.s, 401);

  console.log('\n=== D. RECOVERY CODE ===');
  jar = {}; await req('GET', '/');
  const l3 = await req('POST', '/api/auth/login', { username: admin.username, password: PW });
  const rec = await req('POST', '/api/auth/mfa/verify', { challengeToken: l3.d.challengeToken, code: recoveryCodes[0] });
  check('recovery code completes login', rec.s, 201);
  jar = {}; await req('GET', '/');
  const l4 = await req('POST', '/api/auth/login', { username: admin.username, password: PW });
  const rec2 = await req('POST', '/api/auth/mfa/verify', { challengeToken: l4.d.challengeToken, code: recoveryCodes[0] });
  check('recovery code is SINGLE-USE (replay rejected)', rec2.s, 401);

  console.log('\n=== E. MANDATORY MFA FOR super_admin ===');
  // The keeper guaranteed by the helper is what makes this promotion reversible.
  await sql.begin(async (tx) => {
    await tx.unsafe("select set_config('app.rbac_actor_super_admin','on',true)");
    await tx`update teachers set roles = array['super_admin'] where id = ${TID}`;
  });
  // The promotion bumps permissions_version, so the existing session is now stale.
  // Re-login to obtain a fresh one before exercising the super_admin rules.
  jar = {}; await req('GET', '/');
  const lx = await req('POST', '/api/auth/login', { username: admin.username, password: PW });
  await req('POST', '/api/auth/mfa/verify', { challengeToken: lx.d.challengeToken, code: totp(secret) });
  const dis = await req('POST', '/api/auth/mfa/disable', { code: totp(secret) });
  check('super_admin CANNOT disable MFA', dis.s, 403);
  const st1 = await req('GET', '/api/auth/mfa/status');
  check('status reports required=true for super_admin', st1.d?.required, true);
  check('still enabled', st1.d?.enabled, true);

  console.log('\n=== F. MANDATORY MFA: un-enrolled super_admin is RESTRICTED ===');
  // Super_admin is currently enrolled from section A. Remove the enrolment while it
  // holds the role, then confirm the account can complete enrolment but cannot use
  // the rest of the system — the point being that "cannot DISABLE MFA" alone would
  // not stop a never-enrolled account from being password-only.
  await sql`delete from teacher_mfa where teacher_id = ${TID}`;
  await sql`delete from mfa_recovery_codes where teacher_id = ${TID}`;
  jar = {}; await req('GET', '/');
  const l5 = await req('POST', '/api/auth/login', { username: admin.username, password: PW });
  // No MFA is enrolled now, so login completes with a session...
  check('login succeeds when MFA not enrolled', l5.s, 201);
  const stRestricted = await req('GET', '/api/auth/mfa/status');
  check('status shows required=true, enabled=false', stRestricted.d?.required === true && stRestricted.d?.enabled === false, true);
  const blocked = await req('GET', '/api/teachers');
  check('un-enrolled super_admin is BLOCKED from other APIs', blocked.s, 403);
  check('  -> message points at MFA enrolment', /MFA/.test(blocked.d?.error?.message || ''), true);
  const canEnroll = await req('POST', '/api/auth/mfa/enroll');
  check('but CAN still start enrolment', canEnroll.s, 201);
  const canSeeSelf = await req('GET', '/api/auth/me');
  check('and CAN still read its own identity', canSeeSelf.s, 200);
  const blockedAudit = await req('GET', '/api/audit/logs');
  check('audit log also blocked while un-enrolled', blockedAudit.s, 403);

  // ===========================================================================
  // G. PASSWORD RESET: MANDATORY MFA + RE-AUTHENTICATION (audit finding G-18)
  // ===========================================================================
  // The administrative password reset is a high-risk operation, and the security
  // model already answers "who must prove more" in exactly one place:
  //   * AuthGuard refuses EVERY non-@MfaExempt route to an MFA-required account
  //     that has not enrolled — the state this suite is in right now — so the reset
  //     route must be refused here too (it is deliberately not exempt);
  //   * once enrolled, the caller must present a CURRENT second factor, verified
  //     with MfaService.verify() — the same step-up /auth/mfa/disable and
  //     /auth/mfa/recovery-codes already use.
  // Because only a super_admin may act on a privileged account (principal /
  // super_admin), and super_admin is the role MFA is mandatory for, every reset of
  // a privileged account is MFA-gated in practice.
  console.log('\n=== G. RESET PASSWORD: MANDATORY MFA + STEP-UP (G-18) ===');
  const RESET = '/api/auth/reset-password';

  const blockedReset = await req('POST', RESET, { teacherId: target.id });
  check('un-enrolled super_admin is BLOCKED from reset-password -> 403', blockedReset.s, 403);
  check('  -> the refusal is the MFA gate', /MFA/.test(blockedReset.d?.error?.message || ''), true);

  // Re-enrol: the previous enrolment was removed in section F, so the secret is new.
  const enr2 = await req('POST', '/api/auth/mfa/enroll');
  check('re-enrolment returns a fresh secret',
    typeof enr2.d?.secret === 'string' && enr2.d.secret.length > 20 && enr2.d.secret !== secret, true);
  secret = enr2.d?.secret;
  check('re-enrolment confirmed', (await req('POST', '/api/auth/mfa/confirm', { code: totp(secret) })).s, 201);

  const hashBeforeReset = (await sql`select password_hash h from teachers where id = ${target.id}`)[0].h;
  const noCode = await req('POST', RESET, { teacherId: target.id });
  check('reset WITHOUT a second factor -> 401', noCode.s, 401);
  const badCode = await req('POST', RESET, { teacherId: target.id, mfaCode: '000000' });
  check('reset with a WRONG second factor -> 401', badCode.s, 401);
  // Boolean comparison on purpose: the assertion is "the stored credential did not
  // change", and printing the hash would put password material in the test log.
  check('  -> neither refusal wrote anything',
    (await sql`select password_hash h from teachers where id = ${target.id}`)[0].h === hashBeforeReset, true);
  check('  -> and both refusals are audited',
    (await sql`select count(*)::int n from audit_logs
                where action = 'permission_denied' and teacher_id = ${TID}
                  and detail like '%password_reset refused%'`)[0].n >= 2, true);

  const didReset = await req('POST', RESET, { teacherId: target.id, mfaCode: totp(secret) });
  check('super_admin resets a PRINCIPAL account with a current code -> 201', didReset.s, 201);
  const temp = didReset.d?.temporaryPassword;
  if (typeof temp !== 'string' || temp.length < 12) {
    throw new Error(
      'the privileged reset carried no usable temporary password: ' + JSON.stringify(didReset.d),
    );
  }
  const resetAudit = await sql`
    select detail from audit_logs
     where action = 'password_reset' and teacher_id = ${target.id}`;
  check('the reset is audited exactly once', resetAudit.length, 1);
  check('  -> the audit row records the verified second factor',
    /secondFactor=totp/.test(resetAudit[0]?.detail ?? ''), true);
  check('  -> and it contains no credential', (resetAudit[0]?.detail ?? '').includes(temp), false);
  check('  -> the stored credential is a hash, not the plaintext',
    (await sql`select password_hash h from teachers where id = ${target.id}`)[0].h !== temp, true);

  jar = {}; await req('GET', '/');
  const targetLogin = await req('POST', '/api/auth/login', { username: target.username, password: temp });
  check('the reset target authenticates with the temporary password', targetLogin.s, 201);

  // ===========================================================================
  // H. SELF-SERVICE PASSWORD CHANGE BY A SUPER ADMIN
  // ===========================================================================
  // The migration 0003 trigger allows a super_admin to rotate its OWN password only
  // when the request declares the actor id (`app.rbac_actor_id`), and no application
  // code path ever declared it — so that branch was unreachable and the endpoint
  // additionally answered HTTP 500 because the write ran as the `anon_` database
  // role (migration 0005 grants it UPDATE on three columns of `teachers` only).
  // `tests/rbac-database.test.mjs` proves the DATABASE permits the self-service
  // write; this proves the APPLICATION now reaches it.
  console.log('\n=== H. SUPER ADMIN ROTATES ITS OWN PASSWORD ===');
  jar = {}; await req('GET', '/');
  const lSelf = await req('POST', '/api/auth/login', { username: admin.username, password: PW });
  check('super_admin login requires the second factor', lSelf.d?.mfaRequired, true);
  const vSelf = await req('POST', '/api/auth/mfa/verify', { challengeToken: lSelf.d.challengeToken, code: totp(secret) });
  check('second factor accepted', vSelf.s, 201);
  const selfChange = await req('POST', '/api/auth/change-password', {
    currentPassword: PW,
    newPassword: 'SuperAdminPassw0rd!4',
  });
  check('super_admin changes its OWN password -> 201', selfChange.s, 201);
  check('  -> the response carries the account, never a credential',
    /newPassword|passwordHash|scrypt\$/.test(JSON.stringify(selfChange.d)), false);
  jar = {}; await req('GET', '/');
  const afterChange = await req('POST', '/api/auth/login', { username: admin.username, password: 'SuperAdminPassw0rd!4' });
  check('  -> and the new password authenticates (MFA still required)', afterChange.d?.mfaRequired, true);
} catch (error) {
  FATAL = error;
} finally {
  // CLEANUP is the helper's: it deletes this run's account (declaring super-admin
  // authority inside the transaction, which is what the guard requires) together
  // with every row that cascades from it — sessions, teacher_mfa, mfa_challenges,
  // mfa_recovery_codes. Nothing shared is touched.
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
