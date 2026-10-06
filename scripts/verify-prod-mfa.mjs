#!/usr/bin/env node
/**
 * scripts/verify-prod-mfa.mjs —— §6：**生产环境**的"强制 MFA"链路实测。
 *
 *   PROD_BASE_URL=https://xxx.zeabur.app \
 *   PROD_ADMIN_CREDENTIALS=$PWD/credentials/prod-super-admin.json \
 *   node scripts/verify-prod-mfa.mjs
 *
 * ===========================================================================
 * 这个脚本打的是**生产**。因此有两条自我约束：
 * ===========================================================================
 * 1. 默认**只读**：不改密码、不改 MFA 状态、不消费恢复码。
 *    要连"恢复码一次性"一起验，必须显式 `ALLOW_RECOVERY_CODE_CONSUMPTION=1`
 *    —— 那会真的用掉一个恢复码，而恢复码是运维在手机上丢了 TOTP 时的救命材料。
 *
 * 2. 退出码只在**断言失败**时为 1；跳过项不计入 pass。想让"跳过"也算不通过，
 *    用 `--strict`。这跟仓库里其它套件的口径一致：**跳过不算通过**。
 *
 * 为什么不把它放进 verify-all.sh：它依赖生产凭据与生产网络。放进默认门禁
 * 会让"跑一次门禁"变成"对生产做一次操作"，那是不该有的耦合。
 *
 * 凭据文件格式（必须放在 gitignored 的 credentials/ 下，绝不进 Git）：
 *   { "username": "...", "password": "...", "totpSecret": "..." }
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.PROD_BASE_URL || '').replace(/\/$/, '');
const CRED_PATH = process.env.PROD_ADMIN_CREDENTIALS || '';
const STRICT = process.argv.includes('--strict');
const CONSUME_RECOVERY = process.env.ALLOW_RECOVERY_CODE_CONSUMPTION === '1';

if (!BASE) {
  console.error('需要 PROD_BASE_URL（例如 https://tsinglankindergarten.zeabur.app）');
  process.exit(2);
}
if (!CRED_PATH) {
  console.error('需要 PROD_ADMIN_CREDENTIALS=<凭据 JSON 路径>');
  process.exit(2);
}
const credFile = resolve(CRED_PATH);
if (!existsSync(credFile)) {
  console.error(`凭据文件不存在：${credFile}`);
  process.exit(2);
}

// TOTP 用**服务端自己编译出来的实现**。另写一份算法等于"用我的实现验证我的实现"，
// 那样的绿说明不了任何事 —— 两边同时算错时它照样绿。
const require = createRequire(resolve(process.cwd()) + '/');
const mfaModule = resolve(process.cwd(), 'dist/server/common/crypto/mfa-crypto.js');
if (!existsSync(mfaModule)) {
  console.error(`找不到 ${mfaModule} —— 先跑 npm run build。`);
  process.exit(2);
}
const mfa = require(mfaModule);

const cred = JSON.parse(readFileSync(credFile, 'utf8'));
const USERNAME = cred.username || 'TsinglanAdmin';
const PASSWORD = cred.password;
const SECRET = cred.totpSecret;
if (!PASSWORD || !SECRET) {
  console.error('凭据文件里缺 password 或 totpSecret。');
  process.exit(2);
}

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
const skip = (label, reason) => { console.log(`  \x1b[33mSKIP\x1b[0m  ${label}  -> ${reason}`); SKIPPED++; };

let jar = {};
const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const store = (r) => {
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
};
async function req(m, p, b) {
  const h = { 'content-type': 'application/json' };
  if (Object.keys(jar).length) h.cookie = cookie();
  if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const r = await fetch(BASE + p, {
    method: m,
    headers: h,
    body: b === undefined ? undefined : JSON.stringify(b),
    redirect: 'manual',
  });
  store(r);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 200); }
  return { s: r.status, d };
}
const resetJar = () => { jar = {}; };
const totp = () => mfa.generateTotp(SECRET);

console.log(`\n=== §6 生产 MFA 强制链（${BASE}）===`);
console.log(`（默认只读；消费恢复码：${CONSUME_RECOVERY ? '已显式开启' : '关闭'}）\n`);

// ---- 1) 密码 + 第二因子 ---------------------------------------------------
console.log('1) 登录 → 第二因子');
resetJar();
await req('GET', '/');
const login = await req('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
if (login.s === 201) ok('密码登录成功', `HTTP ${login.s}`);
else bad('密码登录成功', `HTTP ${login.s} ${String(login.d?.error?.message ?? '').slice(0, 90)}`);

if (login.d?.mfaRequired === true) {
  ok('登录要求第二因子（MFA_ENFORCE_SUPER_ADMIN 生效）', 'mfaRequired=true');
} else {
  bad('登录要求第二因子', `mfaRequired=${login.d?.mfaRequired} —— 生产未强制 MFA`);
}

// 挑战态下业务接口必须拿不到数据。这里是 401 而不是 403：
// 第二因子没过时，这个会话按"未登录"处理才是对的 —— 断言要写对期望值，
// 否则"行为正确但期望写错"会被记成产品缺陷。
const before = await req('GET', '/api/resources?pageSize=5');
if (before.s === 401) ok('未过第二因子前拿不到业务数据（挑战态按未登录处理）', `HTTP ${before.s}`);
else bad('未过第二因子前拿不到业务数据', `HTTP ${before.s}（期望 401）`);

const wrongTotp = await req('POST', '/api/auth/mfa/verify', {
  challengeToken: login.d?.challengeToken, code: '000000',
});
if (wrongTotp.s >= 400) {
  ok('错误的 TOTP 被拒（不是"随便填都过"）', `HTTP ${wrongTotp.s} ${String(wrongTotp.d?.error?.message ?? '').slice(0, 50)}`);
} else {
  bad('错误的 TOTP 被拒', `HTTP ${wrongTotp.s} —— 错码竟然通过`);
}

const goodTotp = await req('POST', '/api/auth/mfa/verify', {
  challengeToken: login.d?.challengeToken, code: totp(),
});
if (goodTotp.s === 200 || goodTotp.s === 201) ok('正确 TOTP 通过第二因子', `HTTP ${goodTotp.s}`);
else bad('正确 TOTP 通过第二因子', `HTTP ${goodTotp.s} ${String(goodTotp.d?.error?.message ?? '').slice(0, 90)}`);

const after = await req('GET', '/api/resources?pageSize=5');
if (after.s === 200) ok('通过后业务接口可用（强制 MFA 闭环成立）', `HTTP ${after.s}`);
else bad('通过后业务接口可用', `HTTP ${after.s}`);

// ---- 2) MFA 状态与恢复码 --------------------------------------------------
console.log('\n2) MFA 状态与恢复码');
const status = await req('GET', '/api/auth/mfa/status');
if (status.d?.enabled === true && status.d?.required === true) {
  ok('状态：已绑定且仍为强制', JSON.stringify(status.d));
} else {
  bad('状态：已绑定且仍为强制', JSON.stringify(status.d));
}

const noCode = await req('POST', '/api/auth/mfa/recovery-codes', {});
if (noCode.s >= 400) ok('不带当前验证码重新生成恢复码被拒', `HTTP ${noCode.s}`);
else bad('不带当前验证码重新生成恢复码被拒', `HTTP ${noCode.s} —— 竟然允许`);

// 重新生成会**作废已有全部恢复码**，属于破坏性操作 —— 默认不做。
if (!CONSUME_RECOVERY) {
  skip('重新生成恢复码 / 恢复码一次性 / 已用过的码不能再用',
    '会作废现有全部恢复码；要验请显式 ALLOW_RECOVERY_CODE_CONSUMPTION=1');
} else {
  const rc = await req('POST', '/api/auth/mfa/recovery-codes', { code: totp() });
  const codes = rc.d?.recoveryCodes ?? [];
  if (Array.isArray(codes) && codes.length > 0) ok('带当前验证码可重新生成恢复码', `${codes.length} 个`);
  else bad('带当前验证码可重新生成恢复码', `HTTP ${rc.s} ${JSON.stringify(rc.d).slice(0, 140)}`);

  const stA = await req('GET', '/api/auth/mfa/status');
  if (stA.d?.recoveryCodesRemaining === codes.length) ok('状态余额与刚生成的一致', String(stA.d.recoveryCodesRemaining));
  else bad('状态余额与刚生成的一致', `${stA.d?.recoveryCodesRemaining} vs ${codes.length}`);

  resetJar();
  await req('GET', '/');
  const l3 = await req('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  const recV = await req('POST', '/api/auth/mfa/verify', { challengeToken: l3.d?.challengeToken, code: codes[0] });
  if (recV.s === 200 || recV.s === 201) ok('恢复码可替代 TOTP 通过第二因子', `HTTP ${recV.s}`);
  else bad('恢复码可替代 TOTP 通过第二因子', `HTTP ${recV.s} ${String(recV.d?.error?.message ?? '').slice(0, 90)}`);

  const stB = await req('GET', '/api/auth/mfa/status');
  if (stB.d?.recoveryCodesRemaining === codes.length - 1) ok('恢复码一次性：用掉一个余额 -1', `${codes.length} -> ${stB.d.recoveryCodesRemaining}`);
  else bad('恢复码一次性：用掉一个余额 -1', `剩余 ${stB.d?.recoveryCodesRemaining}，期望 ${codes.length - 1}`);

  resetJar();
  await req('GET', '/');
  const l4 = await req('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  const reuse = await req('POST', '/api/auth/mfa/verify', { challengeToken: l4.d?.challengeToken, code: codes[0] });
  if (reuse.s >= 400) ok('已用过的恢复码不能再用', `HTTP ${reuse.s}`);
  else bad('已用过的恢复码不能再用', `HTTP ${reuse.s} —— 同一个码可以重复使用`);

  console.log(`\n  ⚠️ 本次已作废旧恢复码并消费 1 个新码；未使用的 ${codes.length - 1} 个新码请从运维侧另存。`);
}

console.log(`\n=== RESULT ===\n  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0 && STRICT) { console.log('  （--strict）跳过项按不通过处理。'); process.exit(1); }
process.exit(FAILED === 0 ? 0 : 1);
