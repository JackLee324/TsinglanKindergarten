#!/usr/bin/env node
/**
 * scripts/verify-prod-storage.mjs —— **生产**对象存储真实往返回测。
 *
 *   PROD_BASE_URL=https://xxx.zeabur.app \
 *   PROD_ADMIN_CREDENTIALS=$PWD/credentials/prod-super-admin.json \
 *   ALLOW_PROD_WRITE=1 node scripts/verify-prod-storage.mjs
 *
 * 证明的是这条链在生产环境里成立：
 *   建草稿 → 预签名 PUT → 直传真实字节到 bucket → 登记元数据
 *   → 下载 302 → 换令牌 → 302 到对象存储预签名 GET → **逐字节 sha256 一致**
 *   → 篡改令牌被拒 → 删除探针 → 复查 0 残留
 *
 * ===========================================================================
 * 三条必须说清楚的边界
 * ===========================================================================
 * 1. 它**写生产**，因此必须显式 `ALLOW_PROD_WRITE=1` 才动。跑完会把探针资源
 *    硬删除并复查残留为 0；失败路径也会尽力清理（见 finally）。
 *
 * 2. 它**不测浏览器 CORS**。CORS 是浏览器行为（预检、Origin 头），脚本发的
 *    是普通 HTTP 请求，无论 bucket 有没有 CORS 策略都会成功。拿它冒充
 *    "浏览器直传已验证"就是假证据。CORS 的最小权限策略见
 *    DEPLOYMENT_PRODUCTION.md §2.5，需要用真人浏览器单独验。
 *
 * 3. 它**不测签名校验的 8 种失败情形**。那 8 种（错误签名 / 过期 / 篡改 key /
 *    篡改过期 / 错 bucket / 错凭据等）由 `verify-storage-sigv4.mjs` 在受控
 *    环境里逐条覆盖 —— 对一个**真实**的对象存储逐条打畸形请求既不礼貌也没必要。
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const BASE = (process.env.PROD_BASE_URL || '').replace(/\/$/, '');
const CRED_PATH = process.env.PROD_ADMIN_CREDENTIALS || '';
if (!BASE) { console.error('需要 PROD_BASE_URL'); process.exit(2); }
if (!CRED_PATH) { console.error('需要 PROD_ADMIN_CREDENTIALS=<凭据 JSON 路径>'); process.exit(2); }
if (process.env.ALLOW_PROD_WRITE !== '1') {
  console.error('本脚本会往**生产**写一条探针资源（跑完删除）。要执行请显式 ALLOW_PROD_WRITE=1。');
  process.exit(2);
}
const credFile = resolve(CRED_PATH);
if (!existsSync(credFile)) { console.error(`凭据文件不存在：${credFile}`); process.exit(2); }

const require = createRequire(resolve(process.cwd()) + '/');
const mfaModule = resolve(process.cwd(), 'dist/server/common/crypto/mfa-crypto.js');
if (!existsSync(mfaModule)) { console.error(`找不到 ${mfaModule} —— 先跑 npm run build。`); process.exit(2); }
const mfa = require(mfaModule);

const cred = JSON.parse(readFileSync(credFile, 'utf8'));
const USERNAME = cred.username || 'TsinglanAdmin';
if (!cred.password || !cred.totpSecret) { console.error('凭据文件里缺 password 或 totpSecret。'); process.exit(2); }

let PASSED = 0, FAILED = 0;
const ok = (l, d = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); PASSED++; };
const bad = (l, d = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); FAILED++; };

const STAMP = Date.now();
const TITLE = `存储往返探针 ${STAMP}`;
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
    method: m, headers: h,
    body: b === undefined ? undefined : JSON.stringify(b),
    redirect: 'manual',
  });
  store(r);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 200); }
  return { s: r.status, d, h: r.headers };
}

let resourceId = null;
let exitCode = 1;

try {
  console.log(`\n=== 生产对象存储往返（${BASE}）===\n`);

  await req('GET', '/');
  const login = await req('POST', '/api/auth/login', { username: USERNAME, password: cred.password });
  if (login.s !== 201) { bad('生产登录', `HTTP ${login.s}`); throw new Error('login failed'); }
  await req('POST', '/api/auth/mfa/verify', {
    challengeToken: login.d?.challengeToken, code: mfa.generateTotp(cred.totpSecret),
  });

  // 目录归属从真实目录树里取，不硬编码 code —— 硬编码会在目录重构后静默失效。
  const tree = await req('GET', '/api/directories/tree');
  const flat = [];
  const walk = (ns) => { for (const n of ns ?? []) { flat.push(n); walk(n.children); } };
  walk(tree.d?.roots ?? []);
  const leaf = flat.find((n) => n.type === 'folder' && n.program && n.subject);
  if (!leaf) { bad('目录树里取到可归属的叶子节点', '没有带 program/subject 的 folder 节点'); throw new Error('no leaf'); }
  ok('目录树里取到可归属的叶子节点', `${leaf.code} (${leaf.program}/${leaf.subject})`);

  const created = await req('POST', '/api/resources', {
    title: TITLE, program: leaf.program, subject: leaf.subject, directoryId: leaf.id,
    folderType: 'materials', semester: 'S1', week: 1,
    description: '生产对象存储往返验证（跑完硬删除）',
  });
  resourceId = created.d?.id ?? created.d?.resource?.id ?? null;
  if (resourceId) ok('在生产建探针资源（草稿）', `id=${resourceId}`);
  else { bad('在生产建探针资源', `HTTP ${created.s} ${JSON.stringify(created.d).slice(0, 200)}`); throw new Error('create failed'); }

  // 真实字节：用合法 PDF 头 —— 服务端会校验 magic bytes，随机字节被拒是**对的**行为。
  const payload = Buffer.concat([
    Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary'),
    randomBytes(64 * 1024),
    Buffer.from(`\n%%EOF\n# prod probe ${STAMP}\n`, 'utf8'),
  ]);
  const sha = createHash('sha256').update(payload).digest('hex');
  const fileName = `prod-probe-${STAMP}.pdf`;
  console.log(`  待上传 ${payload.length} bytes, sha256=${sha.slice(0, 16)}…`);

  const urlResp = await req('POST', `/api/resources/${resourceId}/upload-url`, { fileName });
  const putUrl = urlResp.d?.uploadUrl;
  if (!putUrl) { bad('拿到预签名 PUT 地址', `HTTP ${urlResp.s} ${JSON.stringify(urlResp.d).slice(0, 200)}`); throw new Error('no put url'); }
  ok('拿到预签名 PUT 地址', `${String(putUrl).split('?')[0].slice(0, 90)}…`);

  const put = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: payload });
  if (put.status === 200 || put.status === 204) ok('直传真实字节到生产 bucket', `HTTP ${put.status}`);
  else bad('直传真实字节到生产 bucket', `HTTP ${put.status} ${String(await put.text()).slice(0, 160)}`);

  const reg = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName,
    mimeType: 'application/pdf',
    sizeBytes: payload.length,
    head: payload.subarray(0, 4096).toString('base64'),
    fileBucketId: urlResp.d?.bucketId,
    filePath: urlResp.d?.filePath,
  });
  if (reg.s === 200 || reg.s === 201) ok('登记文件元数据', `HTTP ${reg.s}`);
  else bad('登记文件元数据', `HTTP ${reg.s} ${JSON.stringify(reg.d).slice(0, 200)}`);

  const dl = await req('GET', `/api/resources/${resourceId}/download`);
  const loc = dl.h.get('location');
  if (dl.s === 302 && loc) ok('下载接口 302 到签名 URL', `令牌 ${(new URL(loc, BASE).searchParams.get('token') || '').length} 字符`);
  else bad('下载接口 302 到签名 URL', `HTTP ${dl.s} ${JSON.stringify(dl.d).slice(0, 150)}`);

  if (loc) {
    // 第一跳的 location 是**相对**地址；第二跳才是对象存储的预签名 GET。
    // 两跳是设计如此（应用令牌换对象存储签名），不是多余跳转。
    let raw = await fetch(new URL(loc, BASE).toString(), { headers: { cookie: cookie() }, redirect: 'manual' });
    if (raw.status === 302) {
      const second = raw.headers.get('location');
      console.log(`  第二跳 -> ${String(second).split('?')[0].slice(0, 80)}…`);
      raw = await fetch(new URL(second, BASE).toString(), { redirect: 'manual' });
    }
    const got = Buffer.from(await raw.arrayBuffer());
    const gotSha = createHash('sha256').update(got).digest('hex');
    if (raw.status === 200 && gotSha === sha) {
      ok('取回的字节与上传**逐字节一致**（sha256 相同）', `${got.length} bytes, ${gotSha.slice(0, 16)}…`);
    } else {
      bad('取回的字节与上传一致',
        `HTTP ${raw.status} len=${got.length}/${payload.length} sha=${gotSha.slice(0, 16)} vs ${sha.slice(0, 16)}`);
    }

    const u = new URL(loc, BASE);
    const tok = u.searchParams.get('token') || '';
    u.searchParams.set('token', tok.slice(0, -4) + 'AAAA');
    const tampered = await fetch(u.toString(), { headers: { cookie: cookie() }, redirect: 'manual' });
    if (tampered.status >= 400) ok('篡改令牌被拒（签名确实在校验）', `HTTP ${tampered.status}`);
    else bad('篡改令牌被拒', `HTTP ${tampered.status} —— 篡改后仍可取到`);
  }

  exitCode = FAILED === 0 ? 0 : 1;
} catch (err) {
  console.error(`\n中断：${err?.message ?? err}`);
  exitCode = 1;
} finally {
  // 失败路径也必须清理 —— 探针留在生产里比测试失败更糟。
  if (resourceId) {
    try { const del = await req('DELETE', `/api/resources/${resourceId}`); console.log(`\n清理：删除探针 -> HTTP ${del.s}`); }
    catch (e) { console.error(`清理删除失败：${e?.message ?? e}`); }
    try {
      const after = await req('GET', `/api/resources?pageSize=100&keyword=${encodeURIComponent(String(STAMP))}`);
      const residue = (after.d?.items ?? []).filter((r) => String(r.title).includes(String(STAMP)));
      console.log(`清理：关键字复查残留 ${residue.length} 条`);
      if (residue.length > 0) { console.error('⚠️ 仍有残留，需人工处理'); exitCode = 1; }
    } catch (e) { console.error(`残留复查失败：${e?.message ?? e}`); exitCode = 1; }
  }
  console.log(`\n=== RESULT ===\n  pass=${PASSED} fail=${FAILED}`);
  process.exit(exitCode);
}
