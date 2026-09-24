/**
 * scripts/verify-mfa.mjs — end-to-end TOTP verification over real HTTP.
 *   AUTHZ_TEST_DB=postgres://... node scripts/verify-mfa.mjs
 * Requires a running server with MFA_ENCRYPTION_KEY set.
 */
const BASE = process.env.MFA_BASE || 'http://127.0.0.1:3200';
const PW = 'TestPassw0rd!';
let jar = {};
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function store(r) { for (const c of (r.headers.getSetCookie?.() ?? [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } }
async function req(m, p, b) {
  const h = { 'content-type': 'application/json' };
  if (Object.keys(jar).length) h['cookie'] = ch();
  if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  store(r);
  let d = null; try { d = await r.json(); } catch {}
  return { s: r.status, d, setCookie: r.headers.getSetCookie?.() ?? [] };
}
let pass = 0, fail = 0;
function check(l, a, e) { const ok = Array.isArray(e) ? e.includes(a) : a === e; console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + l.padEnd(56) + '-> ' + String(a) + (ok ? '' : '   expected ' + e)); ok ? pass++ : fail++; }

const Pg = (await import('postgres')).default;
const sql = Pg(process.env.AUTHZ_TEST_DB, { onnotice: () => {} });
const crypto = await import('node:crypto');
const h = (() => { const salt = crypto.randomBytes(16).toString('base64'); return 'scrypt$16384$8$1$' + salt + '$' + crypto.scryptSync(PW, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64'); })();
// Reset fixtures so the run is repeatable. The role reset MUST declare
// super-admin authority: if a previous interrupted run left the account as
// super_admin, the migration-0003 trigger refuses the demotion with 42501
// ('a principal cannot manage a super_admin') — which is the guard behaving
// correctly, and which made this script non-re-runnable until it was fixed.
const TID = (await sql`select id from teachers where username='qlsadmin'`)[0].id;
await sql`delete from teacher_mfa where teacher_id=${TID}`;
await sql`delete from mfa_recovery_codes where teacher_id=${TID}`;
await sql`delete from mfa_challenges where teacher_id=${TID}`;
await sql.begin(async (tx) => {
  await tx.unsafe("select set_config('app.rbac_actor_super_admin','on',true)");
  await tx`update teachers set password_hash=${h}, roles=array['principal'], status='active' where id=${TID}`;
});

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

await req('GET', '/');
const l1 = await req('POST', '/api/auth/login', { username: 'qlsadmin', password: PW });
check('login without MFA enrolled succeeds', l1.s, 201);
check('  -> response says mfaRequired=false', l1.d?.mfaRequired, false);

console.log('\n=== A. ENROLMENT ===');
const st0 = await req('GET', '/api/auth/mfa/status');
check('status before enrolment: enabled=false', st0.d?.enabled, false);
const enr = await req('POST', '/api/auth/mfa/enroll');
check('enrol returns 201', enr.s, 201);
check('enrol returns a secret', typeof enr.d?.secret === 'string' && enr.d.secret.length > 20, true);
check('enrol returns an otpauth URI', /^otpauth:\/\/totp\//.test(enr.d?.otpauthUri || ''), true);
const secret = enr.d.secret;

const rowAfterEnroll = await sql`select secret_encrypted, confirmed from teacher_mfa where teacher_id=(select id from teachers where username='qlsadmin')`;
check('secret stored ENCRYPTED (not plaintext)', rowAfterEnroll[0]?.secret_encrypted?.includes(secret) === false, true);
check('  -> stored format is v1:iv:tag:ct', /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(rowAfterEnroll[0]?.secret_encrypted || ''), true);
check('not yet confirmed before code verification', rowAfterEnroll[0]?.confirmed, false);

const badConfirm = await req('POST', '/api/auth/mfa/confirm', { code: '000000' });
check('wrong code cannot confirm enrolment', badConfirm.s, 400);
const conf = await req('POST', '/api/auth/mfa/confirm', { code: totp(secret) });
check('correct code confirms enrolment', conf.s, 201);
check('recovery codes returned once', Array.isArray(conf.d?.recoveryCodes) && conf.d.recoveryCodes.length === 10, true);
const recoveryCodes = conf.d.recoveryCodes;
const hashed = await sql`select code_hash from mfa_recovery_codes where teacher_id=(select id from teachers where username='qlsadmin') limit 1`;
check('recovery codes stored HASHED (not plaintext)', hashed[0]?.code_hash !== recoveryCodes[0], true);
check('  -> stored as sha256 hex(64)', /^[0-9a-f]{64}$/.test(hashed[0]?.code_hash || ''), true);

console.log('\n=== B. LOGIN WITH MFA ===');
jar = {};
await req('GET', '/');
const l2 = await req('POST', '/api/auth/login', { username: 'qlsadmin', password: PW });
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
const l3 = await req('POST', '/api/auth/login', { username: 'qlsadmin', password: PW });
const rec = await req('POST', '/api/auth/mfa/verify', { challengeToken: l3.d.challengeToken, code: recoveryCodes[0] });
check('recovery code completes login', rec.s, 201);
jar = {}; await req('GET', '/');
const l4 = await req('POST', '/api/auth/login', { username: 'qlsadmin', password: PW });
const rec2 = await req('POST', '/api/auth/mfa/verify', { challengeToken: l4.d.challengeToken, code: recoveryCodes[0] });
check('recovery code is SINGLE-USE (replay rejected)', rec2.s, 401);

console.log('\n=== E. MANDATORY MFA FOR super_admin ===');
const sid = (await sql`select id from teachers where username='qlsadmin'`)[0].id;

// A KEEPER super_admin is required, and the reason is a guard working correctly:
// `rbac_protect_last_super_admin` refuses to demote the LAST active super_admin
// (verified: 42501 'refused to remove, demote or deactivate the last active
// super_admin'). Promoting qlsadmin without one made the fixture impossible to
// restore, which is exactly the "never lock everyone out" property the migration
// was written to provide.
const KEEPER = '__rbac_keeper';
await sql.begin(async (tx) => {
  await tx.unsafe("select set_config('app.rbac_actor_super_admin','on',true)");
  const ex = await tx`select id from teachers where username=${KEEPER}`;
  if (ex.length === 0) {
    await tx`insert into teachers (username, name, name_en, roles, status)
             values (${KEEPER}, 'RBAC 守护账号', 'RBAC Keeper', array['super_admin'], 'active')`;
  } else {
    await tx`update teachers set roles=array['super_admin'], status='active' where username=${KEEPER}`;
  }
});
// Now qlsadmin may be promoted (two super_admins exist), and restored afterwards.
await sql.begin(async (tx) => {
  await tx.unsafe("select set_config('app.rbac_actor_super_admin','on',true)");
  await tx`update teachers set roles=array['super_admin'] where id=${sid}`;
});
// The promotion bumps permissions_version, so the existing session is now stale.
// Re-login to obtain a fresh one before exercising the super_admin rules.
jar = {}; await req('GET', '/');
const lx = await req('POST', '/api/auth/login', { username: 'qlsadmin', password: PW });
await req('POST', '/api/auth/mfa/verify', { challengeToken: lx.d.challengeToken, code: totp(secret) });
const dis = await req('POST', '/api/auth/mfa/disable', { code: totp(secret) });
check('super_admin CANNOT disable MFA', dis.s, 403);
const st1 = await req('GET', '/api/auth/mfa/status');
check('status reports required=true for super_admin', st1.d?.required, true);
check('still enabled', st1.d?.enabled, true);

// ---------------------------------------------------------------------------
// CLEANUP — required, and the reason it exists is instructive.
// Section E promotes the account to super_admin. The migration-0003 trigger then
// REFUSES to let a non-super actor demote it again (verified: 42501, 'a principal
// cannot manage a super_admin'), so without this block the fixture is left in a
// state that blocks every other suite. The demotion must therefore itself be
// performed with declared super-admin authority.
// ---------------------------------------------------------------------------
await sql.begin(async (tx) => {
  await tx.unsafe("select set_config('app.rbac_actor_super_admin','on',true)");
  await tx`update teachers set roles=array['principal'], status='active' where username='qlsadmin'`;
});
await sql`delete from mfa_challenges where teacher_id=${sid}`;

console.log('\n=== RESULT ===');
console.log('  pass=' + pass + ' fail=' + fail);
await sql.end();
process.exit(fail ? 1 : 0);
