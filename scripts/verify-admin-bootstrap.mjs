/**
 * scripts/verify-admin-bootstrap.mjs —— §6 超级管理员安全引导的**端到端**验证。
 *
 *   MFA_ENFORCE_SUPER_ADMIN=true 的服务已在运行，然后：
 *   BROWSER_E2E_BASE=http://127.0.0.1:3200 \
 *   DATABASE_URL=postgresql://… node scripts/verify-admin-bootstrap.mjs
 *
 * 覆盖用户点名的整条链：
 *   super_admin bootstrap → 首次登录 → 修改高强度密码 →
 *   MFA enrollment → MFA confirmation → recovery code → 重新登录验证
 * 外加两条同样重要的：
 *   · **INITIAL_ADMIN_PASSWORD 不长期保留**：再次引导**不得**覆盖已改过的密码；
 *   · **秘密不外泄**：TOTP 密钥 / 恢复码不出现在响应日志、审计详情或前端产物里。
 *
 * 做法：用 `provision-super-admin.mjs` 建一个**独立探针账号**（不动生产/既有账号），
 * 走完整条链，最后删掉它。这样既跑的是真实代码路径，又不会污染任何既有账号。
 *
 * ⚠️ 本套件要求服务进程设置了 MFA_ENFORCE_SUPER_ADMIN=true；
 *    未设置时"强制"这一层不成立，会**大声跳过**而不是假装通过。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (l, d = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); PASSED++; };
const bad = (l, d = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); FAILED++; };
const skip = (l, r) => { console.log(`  \x1b[33mSKIP\x1b[0m  ${l}  -> ${r}`); SKIPPED++; };

// TOTP 独立实现（与被测代码不共享任何一行，避免"同错同对"）
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32d(s) {
  let bits = 0, v = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/=+$/, '')) {
    v = (v << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, atMs = Date.now(), period = 30, digits = 6) {
  const buf = Buffer.alloc(8);
  const c = Math.floor(Math.floor(atMs / 1000) / period);
  buf.writeUInt32BE(Math.floor(c / 2 ** 32), 0); buf.writeUInt32BE(c >>> 0, 4);
  const d = crypto.createHmac('sha1', b32d(secret)).update(buf).digest();
  const o = d[d.length - 1] & 15;
  const n = ((d[o] & 127) << 24) | ((d[o + 1] & 255) << 16) | ((d[o + 2] & 255) << 8) | (d[o + 3] & 255);
  return String(n % 10 ** digits).padStart(digits, '0');
}

function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  };
  async function req(m, p, b) {
    const h = { 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = cookie();
    if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
    const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    store(r);
    const text = await r.text();
    let d = null; try { d = JSON.parse(text); } catch { /* 非 JSON */ }
    return { s: r.status, d, text };
  }
  return { req, cookie };
}

/** 直接调用仓库里的引导脚本（与 entrypoint.sh 走的是同一个入口）。 */
function provision(username, password, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'qls-admin-'));
  const pwFile = join(dir, 'pw');
  writeFileSync(pwFile, password, { mode: 0o600 });
  try {
    const out = execFileSync(
      process.execPath,
      ['scripts/provision-super-admin.mjs', '--username', username, '--password-file', pwFile,
        '--name', '引导验证探针', '--yes-create-account', ...extraArgs],
      { encoding: 'utf8', env: process.env },
    );
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const stamp = Date.now().toString().slice(-6);
  const username = `boot_probe_${stamp}`;
  const bootstrapPw = `Boot!${stamp}InitAa1`;
  const strongPw = `Boot!${stamp}StrongZz9`;

  console.log(`\n=== §6 超级管理员安全引导验证（${BASE}）===  探针账号：${username}\n`);

  // ---- 前置：强制开关是否打开 -------------------------------------------
  const probe = makeClient();
  await probe.req('GET', '/');
  const statusProbe = await probe.req('GET', '/api/auth/mfa/status');
  if (statusProbe.s === 401) {
    // 未登录时该端点 401 是正常的；强制开关只能从行为上判断 —— 放到第 5 步。
  }

  // ---- 1) bootstrap：创建 super_admin -----------------------------------
  console.log('1) super_admin bootstrap（复用 entrypoint 调用的同一个脚本）');
  const created = provision(username, bootstrapPw);
  if (created.ok) {
    ok('provision-super-admin 建号成功');
    const mustChange = /must_change_password 已置为 true/.test(created.out);
    if (mustChange) ok('引导时把 must_change_password 置为 true（首次登录必须改密）');
    else bad('引导时置 must_change_password=true', created.out.split('\n').slice(-3).join(' | '));
  } else {
    bad('provision-super-admin 建号', created.out.split('\n').slice(-4).join(' | '));
    return;
  }

  const roles = /super_admin/.test(created.out);
  if (roles) ok('账号角色为 super_admin');
  else skip('账号角色为 super_admin', '脚本输出里未直接打印角色，改由后续 /api/auth/me 验证');

  // ---- 2) 首次登录：必须被强制改密 --------------------------------------
  console.log('\n2) 首次登录（bootstrap 口令）');
  const s1 = makeClient();
  await s1.req('GET', '/');
  const login1 = await s1.req('POST', '/api/auth/login', { username, password: bootstrapPw });
  if (login1.s === 201 || login1.s === 200) ok('用 bootstrap 口令登录成功', `HTTP ${login1.s}`);
  else { bad('用 bootstrap 口令登录', `HTTP ${login1.s}`); return; }

  const flagged = login1.d?.teacher?.mustChangePassword === true;
  if (flagged) ok('响应里 mustChangePassword=true');
  else bad('响应里 mustChangePassword=true', JSON.stringify(login1.d?.teacher ?? {}).slice(0, 120));

  if (flagged) {
    const blocked = await s1.req('GET', '/api/resources');
    const code = String(blocked.d?.error?.code ?? '') + String(blocked.d?.error?.details ?? '');
    if (blocked.s === 403 && /PASSWORD_CHANGE_REQUIRED/.test(code)) {
      ok('未改密前受保护接口被拦（403 + PASSWORD_CHANGE_REQUIRED）', String(blocked.s));
    } else {
      bad('未改密前受保护接口被拦', `HTTP ${blocked.s} ${code.slice(0, 80)}`);
    }
  }

  // ---- 2b) §13：超管必须持有全部能力，因此**每一条客户端路由守卫都放行** ----
  //
  // WHY 这一段：`client/src/app.tsx` 原本用手写的角色数组守路由，
  // 而那四张数组**全部漏掉了 super_admin** —— 超管登录后会被 `<Layout>` 那一层
  // 直接挡在门外，整个应用进不去。这是"客户端与 shared/rbac.ts 各写一份"的
  // 典型后果：分叉了既不报错、也没有任何测试发现（本套件此前只走
  // /change-password 与 /account/security，从不进 `<Layout>`）。
  //
  // 现在守卫改用能力码，这一段就断言"超管确实拿得到那些能力"，
  // 而这些能力码正是 app.tsx 里每一个 `requiredPermission` 的值 ——
  // 逐一对照，任何一个从超管身上掉下来都会红。
  console.log('\n2b) §13 super_admin 持有全部客户端路由守卫所需的能力');
  {
    const guardCodes = [
      'curriculum.view', 'resource.create', 'curriculum.manage', 'review.view',
      'account.view', 'permission.view', 'resource.restore', 'audit.view',
    ];
    const perms = await s1.req('GET', '/api/auth/me/permissions');
    const held = new Set(perms.d?.permissions ?? []);
    if (held.size === 0) {
      bad('取到生效权限集合', JSON.stringify(perms.d).slice(0, 120));
    } else {
      ok('取到生效权限集合', `${held.size} 条`);
      for (const code of guardCodes) {
        if (held.has(code)) ok(`  → 超管持有守卫能力 ${code}`);
        else bad(`  → 超管持有守卫能力 ${code}`, '缺失 —— 该路由会把超管挡在门外');
      }
    }
  }

  // ---- 3) 修改高强度密码 -------------------------------------------------
  //
  // 这一步曾经**被 MFA 强制挡住**（403「请先完成绑定后再使用系统」）：AuthGuard 的
  // 两套豁免各自为政 —— 强制改密那一关豁免了本接口，MFA 那一关没有。
  // 结果是首次登录的管理员被送到改密页、却在改密页被挡回来，引导顺序走不通。
  // 已给 change-password 加 `@MfaExempt()` 让两条规则共存（见该处注释）。
  console.log('\n3) 修改为高强度密码（与 MFA 强制共存）');
  const changed = await s1.req('POST', '/api/auth/change-password', {
    currentPassword: bootstrapPw, newPassword: strongPw,
  });
  if (changed.s === 200 || changed.s === 201) ok('改密成功', `HTTP ${changed.s}`);
  else bad('改密成功', `HTTP ${changed.s} ${JSON.stringify(changed.d).slice(0, 120)}`);

  // 弱密码必须被拒（"高强度"不能只是我们自称）
  const s3 = makeClient();
  await s3.req('GET', '/');
  await s3.req('POST', '/api/auth/login', { username, password: strongPw });
  const weak = await s3.req('POST', '/api/auth/change-password', {
    currentPassword: strongPw, newPassword: 'abc123',
  });
  if (weak.s >= 400) ok('弱口令被服务端拒绝', `HTTP ${weak.s}`);
  else bad('弱口令被服务端拒绝', `HTTP ${weak.s} —— 它被接受了`);

  // ---- 4) 重新登录：确认 must_change_password 已清除 ---------------------
  console.log('\n4) 用新密码重新登录');
  const s4 = makeClient();
  await s4.req('GET', '/');
  const login4 = await s4.req('POST', '/api/auth/login', { username, password: strongPw });
  if (login4.s === 201 || login4.s === 200) ok('新密码登录成功', `HTTP ${login4.s}`);
  else bad('新密码登录成功', `HTTP ${login4.s}`);
  const stillFlagged = login4.d?.teacher?.mustChangePassword === true;
  if (!stillFlagged) ok('mustChangePassword 已清除');
  else bad('mustChangePassword 已清除', '仍为 true');

  // ---- 5) MFA 强制：super_admin 必须绑 ------------------------------------
  console.log('\n5) MFA 强制（依赖服务端 MFA_ENFORCE_SUPER_ADMIN=true）');
  // 判定要看**行为**，不能看 `mfaRequired`。
  //   `mfaRequired` 表示"密码已过、需要第二因素挑战"（即**已经绑定**过的账号）；
  //   而"强制绑定但尚未绑定"表现为：登录照常 201，mfaRequired=false，
  //   但**除登记流程外的一切请求 403**「该账号角色强制要求 MFA」。
  // 第一版就是只看 mfaRequired，于是把"强制已开启"误判成"未开启"而整段跳过。
  const enforcementProbe = await s4.req('GET', '/api/resources?pageSize=1');
  const enforcementMsg = String(enforcementProbe.d?.error?.message ?? '');
  const enforcementOn =
    enforcementProbe.s === 403 && /强制要求 MFA|MFA.*required/i.test(enforcementMsg);
  if (!enforcementOn) {
    skip('super_admin 被要求绑定 MFA', `未观察到强制行为（GET /api/resources → HTTP ${enforcementProbe.s}）。要用 MFA_ENFORCE_SUPER_ADMIN=true 重启服务后重跑 —— **不算通过**。`);
  } else {
    ok('未绑 MFA 的 super_admin 被拦在受保护接口外（403 强制绑定）', enforcementMsg.slice(0, 28));
  }

  // ---- 6) enrollment：拿密钥 --------------------------------------------
  console.log('\n6) MFA enrollment');
  const s6 = makeClient();
  await s6.req('GET', '/');
  await s6.req('POST', '/api/auth/login', { username, password: strongPw });
  const enroll = await s6.req('POST', '/api/auth/mfa/enroll');
  let secret = null;
  if (enroll.s === 201 || enroll.s === 200) {
    secret = enroll.d?.secret ?? enroll.d?.data?.secret ?? null;
    if (secret) ok('登记返回 TOTP 密钥', String(secret).slice(0, 4) + '…（已截断，不落日志）');
    else bad('登记返回 TOTP 密钥', JSON.stringify(enroll.d).slice(0, 120));
    const uri = enroll.d?.otpauthUri ?? enroll.d?.otpauth_url ?? enroll.d?.data?.otpauthUri;
    if (uri && String(uri).startsWith('otpauth://')) ok('返回 otpauth URI（可手工录入验证器）');
    else skip('返回 otpauth URI', '实现未返回该字段');
  } else {
    bad('MFA 登记', `HTTP ${enroll.s} ${JSON.stringify(enroll.d).slice(0, 120)}`);
  }

  // ---- 7) confirmation：用真 TOTP 码确认，拿恢复码 ------------------------
  console.log('\n7) MFA confirmation + recovery codes');
  if (!secret) {
    skip('MFA confirmation', '未拿到密钥');
  } else {
    const confirm = await s6.req('POST', '/api/auth/mfa/confirm', { code: totp(secret) });
    if (confirm.s === 201 || confirm.s === 200) ok('用真实 TOTP 码确认启用成功', `HTTP ${confirm.s}`);
    else bad('用真实 TOTP 码确认启用', `HTTP ${confirm.s} ${JSON.stringify(confirm.d).slice(0, 120)}`);

    const codes = confirm.d?.recoveryCodes ?? confirm.d?.data?.recoveryCodes ?? [];
    if (Array.isArray(codes) && codes.length >= 5) {
      ok('确认时一次性返回恢复码', `${codes.length} 个（不入日志）`);
    } else {
      bad('确认时一次性返回恢复码', JSON.stringify(codes).slice(0, 80));
    }

    const statusAfter = await s6.req('GET', '/api/auth/mfa/status');
    const d = statusAfter.d ?? {};
    if (d.enabled === true) ok('mfa/status 显示已启用', `recoveryCodesRemaining=${d.recoveryCodesRemaining}`);
    else bad('mfa/status 显示已启用', JSON.stringify(d).slice(0, 120));

    // ---- 8) 重新登录：必须走第二步，且错误码不放行 ----------------------
    console.log('\n8) 重新登录 → 第二因素');
    const s8 = makeClient();
    await s8.req('GET', '/');
    const login8 = await s8.req('POST', '/api/auth/login', { username, password: strongPw });
    if (login8.d?.mfaRequired === true && login8.d?.challengeToken) ok('密码正确后进入第二因素（拿到 challengeToken）', `HTTP ${login8.s}`);
    else bad('密码正确后进入第二因素（拿到 challengeToken）', JSON.stringify(login8.d).slice(0, 120));

    // 字段名是 challengeToken（见 auth.controller 的 login 分支）。
    // 猜错字段会得到 401「缺少验证信息」—— 那样「错误验证码被拒绝」也会通过，
    // 但它是**假 PASS**：拒绝的原因根本不是码错。
    const mfaToken = login8.d?.challengeToken ?? null;
    const badCode = await s8.req('POST', '/api/auth/mfa/verify', { challengeToken: mfaToken, code: '000000' });
    if (badCode.s >= 400) ok('错误验证码被拒绝', `HTTP ${badCode.s}`);
    else bad('错误验证码被拒绝', `HTTP ${badCode.s} —— 竟然放行了`);

    const s8b = makeClient();
    await s8b.req('GET', '/');
    const login8b = await s8b.req('POST', '/api/auth/login', { username, password: strongPw });
    const tok = login8b.d?.challengeToken ?? null;
    const good = await s8b.req('POST', '/api/auth/mfa/verify', { challengeToken: tok, code: totp(secret) });
    if (good.s === 200 || good.s === 201) ok('正确 TOTP 码通过第二因素', `HTTP ${good.s}`);
    else bad('正确 TOTP 码通过第二因素', `HTTP ${good.s} ${JSON.stringify(good.d).slice(0, 120)}`);

    const me = await s8b.req('GET', '/api/auth/me');
    if (me.s === 200) ok('第二因素通过后能访问受保护接口', `HTTP ${me.s}`);
    else bad('第二因素通过后能访问受保护接口', `HTTP ${me.s}`);
  }

  // ---- 9) INITIAL_ADMIN_PASSWORD 不得长期保留 ---------------------------
  //
  // ⚠️ 必须复刻 **entrypoint 的守卫**，而不是裸调 provision 脚本。
  //    provision-super-admin.mjs 是「强制创建/重置」的工具；真正的保护在
  //    scripts/entrypoint.sh：**先查账号是否存在，存在就不动密码**。
  //    第一版直接再跑一次脚本，于是把「密码被覆盖」记成产品缺陷 ——
  //    其实是我绕过了那层守卫，测的是生产启动路径上永远不会发生的调用。
  console.log('\n9) INITIAL_ADMIN_PASSWORD 不长期保留（复刻 entrypoint 的守卫）');
  let adminExists = null;
  try {
    execFileSync(process.execPath, ['scripts/admin-account-exists.mjs', '--username', username],
      { encoding: 'utf8', env: process.env });
    adminExists = true;
  } catch (e) {
    adminExists = e.status === 1 ? false : null; // 0=存在；1=不存在；其它=查不出来
  }
  if (adminExists !== true) {
    bad(`entrypoint 的存在性检查认出该账号`, `结果=${adminExists}（期望 true）`);
  } else {
    ok(`entrypoint 用的存在性检查认出该账号（→ 启动时不会重写密码）`);
  }

  if (process.env.RESET_ADMIN_PASSWORD_ON_BOOT !== 'true') {
    const s9 = makeClient();
    await s9.req('GET', '/');
    const newPwLogin = await s9.req('POST', '/api/auth/login', { username, password: strongPw });
    if (newPwLogin.s === 201 || newPwLogin.s === 200) {
      ok('按 entrypoint 的守卫路径，已改过的新密码仍然有效（bootstrap 口令没有被写回）', `HTTP ${newPwLogin.s}`);
    } else {
      bad('已改过的新密码仍然有效', `HTTP ${newPwLogin.s}`);
    }
    const bootPwLogin = await s9.req('POST', '/api/auth/login', { username, password: bootstrapPw });
    if (bootPwLogin.s === 401) ok('bootstrap 口令不能登录（已不再被系统保留）', 'HTTP 401');
    else bad('bootstrap 口令不能登录', `HTTP ${bootPwLogin.s} —— 它仍然有效`);
  } else {
    skip('bootstrap 口令不再有效', '本次设置了 RESET_ADMIN_PASSWORD_ON_BOOT=true —— 那是显式要求重置');
  }

  // ---- 10) 秘密不得出现在审计/日志/前端产物 ------------------------------
  console.log('\n10) 秘密不外泄（审计详情 / 前端产物）');
  if (DB_URL) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1 });
    try {
      const rows = await sql`
        SELECT detail FROM audit_logs
         WHERE action IN ('mfa_enrolled','mfa_enabled') AND teacher_name = '引导验证探针'
         ORDER BY _created_at DESC LIMIT 10
      `;
      const joined = rows.map((r) => String(r.detail ?? '')).join(' | ');
      if (/[A-Z2-7]{16,}/.test(joined)) bad('审计详情里不含 TOTP 密钥', joined.slice(0, 100));
      else ok('审计详情里不含 TOTP 密钥（只记事件，不记凭据）');
      if (secret && joined.includes(secret)) bad('审计详情里不含本次密钥', '包含');
      else ok('审计详情里不含本次密钥');
    } finally {
      await sql.end();
    }
  } else {
    skip('审计详情不含密钥', '未设置 DATABASE_URL');
  }
  const bundleDir = 'dist/dist/client/bundle';
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    const files = readdirSync(bundleDir);
    const leaked = files.filter((f) => secret && readFileSync(join(bundleDir, f), 'utf8').includes(secret));
    if (leaked.length === 0) ok('前端产物里不含 TOTP 密钥');
    else bad('前端产物里不含 TOTP 密钥', leaked.join(','));
  } catch {
    skip('前端产物不含密钥', `读不到 ${bundleDir}`);
  }

  // ---- 清理 --------------------------------------------------------------
  if (DB_URL) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1 });
    try {
      // 数据库层**有意**禁止普通角色改/删 super_admin（migration 0003 的守卫：
      // "A principal cannot manage a super_admin"）。第一版直接 DELETE，于是清理
      // 被数据库正确拒绝、探针账号留在库里。
      // 0003 给出的受认可方式是显式声明本次会话具备 super_admin 授权。
      let deleted = 0;
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.rbac_actor_super_admin', 'on', true)`;
        const r = await tx`DELETE FROM teachers WHERE username = ${username}`;
        deleted = r.count;
      });
      const left = await sql`SELECT count(*)::int AS n FROM teachers WHERE username = ${username}`;
      if (left[0]?.n === 0) console.log(`\n清理：删除引导探针账号 ${username} → ${deleted} 行，复查残留 0`);
      else console.error(`  ⚠️  探针账号未清理干净：${username}`);
    } finally {
      await sql.end();
    }
  }
}

try {
  await main();
} catch (error) {
  console.error('\n  ABORTED — ' + (error?.stack || String(error)));
  FAILED += 1;
}

console.log('\n' + '='.repeat(78));
console.log(`§6 引导链验证：${PASSED} 通过 / ${FAILED} 失败 / ${SKIPPED} 跳过   pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
process.exit(FAILED ? 1 : 0);
