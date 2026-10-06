#!/usr/bin/env node
/**
 * scripts/verify-prod-signed-url.mjs —— **生产**预签名 URL 的安全属性实测。
 *
 *   PROD_BASE_URL=… PROD_ADMIN_CREDENTIALS=… ALLOW_PROD_WRITE=1 \
 *     node scripts/verify-prod-signed-url.mjs
 *   # 连"过期签名被拒"一起验（需要真的等过有效期）：
 *   … WAIT_FOR_EXPIRY=1 node scripts/verify-prod-signed-url.mjs
 *
 * 用户要求的检查项，逐条落在这里：
 *   · R2 object key 正确
 *   · bucket 正确
 *   · 错误签名被拒绝
 *   · 过期签名被拒绝
 *   · 篡改 key 被拒绝
 *   （"CORS 不允许其他 Origin" 在 `verify-prod-cors.mjs`，那条不需要签名。）
 *
 * ===========================================================================
 * 为什么"过期"要单独开一个开关
 * ===========================================================================
 * 上传地址的有效期是服务端**硬编码 900 秒**（`resources.service.ts` 里
 * `const expiresInSeconds = 900`），没有环境变量可以调短。
 * 所以想在生产上真正验一次"过期之后 R2 会拒"，就必须真的等过 15 分钟 ——
 * 那是 15 分钟的墙钟时间，不该是默认行为。
 *
 * 默认不跑时打印的是 **SKIP 并写明原因**，而不是悄悄算通过。
 * 过期签名的确定性覆盖在受控环境里已有：`verify-storage-sigv4.mjs`
 * 对真正重算签名的测试后端跑了 8 个用例（含过期）。
 *
 * 清理：跑完 **DELETE → purge**，不在回收站留任何一行。
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.env.PROD_BASE_URL || '').replace(/\/$/, '');
const CRED = process.env.PROD_ADMIN_CREDENTIALS || '';
const APPLY = process.env.ALLOW_PROD_WRITE === '1';
const WAIT_EXPIRY = process.env.WAIT_FOR_EXPIRY === '1';
const EXPECTED_BUCKET = process.env.PROD_S3_BUCKET || 'tsinglan-curriculum';

if (!BASE || !CRED) { console.error('需要 PROD_BASE_URL / PROD_ADMIN_CREDENTIALS'); process.exit(2); }
if (!APPLY) {
  console.error('本脚本会在生产建一条探针资源（跑完 DELETE→purge 彻底清掉）。要执行请设 ALLOW_PROD_WRITE=1。');
  process.exit(2);
}
const cred = JSON.parse(readFileSync(resolve(CRED), 'utf8'));
const require = createRequire(resolve(process.cwd()) + '/');
const mfaMod = resolve(process.cwd(), 'dist/server/common/crypto/mfa-crypto.js');
if (!existsSync(mfaMod)) { console.error('先跑 npm run build'); process.exit(2); }
const mfa = require(mfaMod);

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (l, d = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); PASSED++; };
const bad = (l, d = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); FAILED++; };
const skip = (l, r) => { console.log(`  \x1b[33mSKIP\x1b[0m  ${l}  -> ${r}`); SKIPPED++; };

const jar = {};
const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const store = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } };
async function req(m, p, b) {
  const h = { 'content-type': 'application/json' };
  if (Object.keys(jar).length) h.cookie = cookie();
  if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b), redirect: 'manual' });
  store(r);
  // 必须把响应头一起带出去：下载接口是 `302 + Location`，只返回 body 的话
  // 拿不到跳转地址，注释块就只会写成一个 "undefined.get" 的崩溃。
  const h2 = { get: (n) => r.headers.get(n) };
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 300); }
  return { s: r.status, d, h: h2 };
}

const STAMP = Date.now();
let resourceId = null;
let exitCode = 1;

/** R2 的错误 XML：抽出 <Code> 便于断言"因为签名不对"而不是"因为别的原因"。 */
const errCode = (body) => (String(body).match(/<Code>([^<]+)<\/Code>/) ?? [])[1] ?? null;

try {
  console.log(`\n=== 生产预签名 URL 安全属性（${BASE}）===\n`);
  await req('GET', '/');
  const l = await req('POST', '/api/auth/login', { username: cred.username, password: cred.password });
  if (l.s !== 201) { bad('生产登录', `HTTP ${l.s}`); throw new Error('login'); }
  await req('POST', '/api/auth/mfa/verify', { challengeToken: l.d?.challengeToken, code: mfa.generateTotp(cred.totpSecret) });
  ok('生产登录 + 第二因子');

  const tree = await req('GET', '/api/directories/tree');
  const flat = [];
  const walk = (ns) => { for (const n of ns ?? []) { flat.push(n); walk(n.children); } };
  walk(tree.d?.roots ?? []);
  const leaf = flat.find((n) => n.type === 'folder' && n.program && n.subject);
  if (!leaf) { bad('取到目录叶子', '无'); throw new Error('leaf'); }

  const created = await req('POST', '/api/resources', {
    title: `签名探针 ${STAMP}`, program: leaf.program, subject: leaf.subject, directoryId: leaf.id,
    // §7：legacy folderType **不再由调用方指定** —— 服务端按 directoryId 推导。
    // 探针必须走真实契约，否则它验证的是一条用户根本走不到的路。
    semester: 'S1', week: 1, description: '预签名安全属性验证（跑完删除并 purge）',
  });
  resourceId = created.d?.id ?? created.d?.resource?.id ?? null;
  if (!resourceId) { bad('建探针资源', `HTTP ${created.s}`); throw new Error('create'); }
  ok('建探针资源（草稿）', `id=${resourceId}`);

  const fileName = `sig-${STAMP}.pdf`;
  const u = await req('POST', `/api/resources/${resourceId}/upload-url`, { fileName });
  const putUrl = u.d?.uploadUrl;
  if (!putUrl) { bad('取预签名 PUT 地址', `HTTP ${u.s} ${JSON.stringify(u.d).slice(0, 200)}`); throw new Error('url'); }
  ok('取预签名 PUT 地址', u.d?.filePath);

  const url = new URL(putUrl);
  console.log(`\n1) bucket 与 object key 是否正确`);
  // 路径式寻址：/{bucket}/{key...}
  const segs = url.pathname.replace(/^\/+/, '').split('/');
  const bucket = decodeURIComponent(segs.shift() ?? '');
  const key = segs.map(decodeURIComponent).join('/');
  if (bucket === EXPECTED_BUCKET) ok('URL 里的 bucket 正确', bucket);
  else bad('URL 里的 bucket 正确', `得到 ${bucket}，期望 ${EXPECTED_BUCKET}`);

  const expectedKey = new RegExp(`^uploads/${resourceId}/\\d+-${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  if (expectedKey.test(key)) ok('object key 形如 uploads/<resourceId>/<ts>-<name>', key);
  else bad('object key 形状正确', `得到 ${key}`);
  if (u.d?.filePath === key) ok('服务端登记的 filePath 与 URL 里的 key 一致', u.d.filePath);
  else bad('服务端登记的 filePath 与 URL 里的 key 一致', `filePath=${u.d?.filePath} key=${key}`);
  if (url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') ok('声明了 AWS4-HMAC-SHA256', url.searchParams.get('X-Amz-Algorithm') ?? '');
  else bad('声明了 AWS4-HMAC-SHA256', url.searchParams.get('X-Amz-Algorithm') ?? 'null');
  const expires = Number(url.searchParams.get('X-Amz-Expires'));
  ok('有效期声明', `${expires} 秒`);

  // ---- 2) 正确签名：必须被接受 --------------------------------------------
  console.log(`\n2) 正确签名必须被接受`);
  const payload = Buffer.concat([
    Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary'),
    randomBytes(8 * 1024),
    Buffer.from(`\n%%EOF\n# sig probe ${STAMP}\n`, 'utf8'),
  ]);
  const sha = createHash('sha256').update(payload).digest('hex');
  const good = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: payload });
  if (good.status === 200 || good.status === 204) ok('正确签名的 PUT 被接受', `HTTP ${good.status}`);
  else bad('正确签名的 PUT 被接受', `HTTP ${good.status} ${errCode(await good.text())}`);

  // ---- 3) 错误签名：必须被拒，且原因是签名 ---------------------------------
  console.log(`\n3) 错误签名必须被拒绝`);
  const sigTamper = new URL(putUrl);
  const sig = sigTamper.searchParams.get('X-Amz-Signature') ?? '';
  sigTamper.searchParams.set('X-Amz-Signature', sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
  const badSig = await fetch(sigTamper.toString(), { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: payload });
  const badSigCode = badSig.status >= 400 ? errCode(await badSig.text()) : null;
  if (badSig.status === 403) ok('篡改签名的 PUT 被 403 拒绝', `code=${badSigCode}`);
  else bad('篡改签名的 PUT 被 403 拒绝', `HTTP ${badSig.status} code=${badSigCode}`);
  // 只接受 403 不够 —— 要确认拒的是"签名"，不是别的（比如缺参数）。
  if (badSigCode && /SignatureDoesNotMatch|AccessDenied|InvalidSignature/i.test(badSigCode)) {
    ok('拒绝原因是签名不匹配', badSigCode);
  } else {
    bad('拒绝原因是签名不匹配', `code=${badSigCode} —— 403 可能来自别的原因，不能算签名校验在起作用`);
  }

  // ---- 4) 篡改 key：必须被拒 ---------------------------------------------
  console.log(`\n4) 篡改 object key 必须被拒绝`);
  // key 在 canonical URI 里，所以改 key 一定导致签名失配 —— 正是要验的。
  const keyTamper = new URL(putUrl);
  keyTamper.pathname = keyTamper.pathname.replace(/(uploads\/)[^/]+/, `$1${'00000000-0000-0000-0000-000000000000'}`);
  const badKey = await fetch(keyTamper.toString(), { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: payload });
  const badKeyCode = badKey.status >= 400 ? errCode(await badKey.text()) : null;
  if (badKey.status === 403) ok('篡改 key 的 PUT 被 403 拒绝', `code=${badKeyCode}`);
  else bad('篡改 key 的 PUT 被 403 拒绝', `HTTP ${badKey.status} code=${badKeyCode}`);

  // 顺带：确认篡改 key 之后**没有**在别的路径下写出对象
  const altKey = decodeURIComponent(new URL(keyTamper).pathname).replace(`/${EXPECTED_BUCKET}/`, '');
  const altGet = await fetch(`${url.origin}/${EXPECTED_BUCKET}/${altKey}`);
  if (altGet.status >= 400) ok('篡改 key 的路径下没有被写入任何对象', `GET -> HTTP ${altGet.status}`);
  else bad('篡改 key 的路径下没有被写入任何对象', `GET -> HTTP ${altGet.status}（竟然有对象）`);

  // ---- 5) 过期签名 -------------------------------------------------------
  console.log(`\n5) 过期签名必须被拒绝`);
  const amzDate = url.searchParams.get('X-Amz-Date') ?? '';
  // X-Amz-Date 形如 20261006T070000Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  let expiresAt = null;
  if (m && Number.isFinite(expires)) {
    expiresAt = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) + expires * 1000;
  }
  if (!expiresAt) {
    skip('过期签名被拒绝', `无法从 URL 推导过期时刻（X-Amz-Date=${amzDate} Expires=${expires}）`);
  } else if (!WAIT_EXPIRY) {
    const mins = Math.ceil((expiresAt - Date.now()) / 60000);
    skip('过期签名被拒绝',
      `服务端硬编码 900 秒有效期（无可配 TTL），真的验要等约 ${mins} 分钟；` +
        `加 WAIT_FOR_EXPIRY=1 才会等。受控环境下的确定性覆盖见 verify-storage-sigv4.mjs（8 个用例含过期）`);
  } else {
    const waitMs = expiresAt - Date.now() + 5000;
    console.log(`  等 ${Math.ceil(waitMs / 1000)} 秒直到签名过期（${new Date(expiresAt).toISOString()} + 5s 余量）…`);
    await new Promise((r) => setTimeout(r, waitMs));
    const expired = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: payload });
    const expiredCode = expired.status >= 400 ? errCode(await expired.text()) : null;
    if (expired.status === 403) ok('过期后的 PUT 被 403 拒绝', `code=${expiredCode}`);
    else bad('过期后的 PUT 被 403 拒绝', `HTTP ${expired.status} code=${expiredCode}`);
    if (expiredCode && /Expired|AccessDenied|RequestTimeTooSkewed/i.test(expiredCode)) ok('拒绝原因是过期', expiredCode);
    else bad('拒绝原因是过期', `code=${expiredCode}`);
  }

  // ---- 6) 对象确实存在且内容正确 ------------------------------------------
  console.log(`\n6) 对象确实落到正确的 key 上，且字节正确`);
  const reg = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName, mimeType: 'application/pdf', sizeBytes: payload.length,
    head: payload.subarray(0, 4096).toString('base64'),
    fileBucketId: u.d?.bucketId, filePath: u.d?.filePath,
  });
  if (reg.s === 200 || reg.s === 201) ok('登记文件元数据', `HTTP ${reg.s}`);
  else bad('登记文件元数据', `HTTP ${reg.s} ${JSON.stringify(reg.d).slice(0, 160)}`);

  const dl = await req('GET', `/api/resources/${resourceId}/download`);
  const loc = dl.h.get('location');
  if (loc) {
    let raw = await fetch(new URL(loc, BASE).toString(), { headers: { cookie: cookie() }, redirect: 'manual' });
    if (raw.status === 302) raw = await fetch(new URL(raw.headers.get('location'), BASE).toString(), { redirect: 'manual' });
    const got = Buffer.from(await raw.arrayBuffer());
    const gotSha = createHash('sha256').update(got).digest('hex');
    if (got.length === payload.length && gotSha === sha) ok('取回字节与上传逐字节一致（sha256 相同）', `${got.length} bytes`);
    else bad('取回字节与上传逐字节一致', `len=${got.length}/${payload.length} sha=${gotSha.slice(0, 12)} vs ${sha.slice(0, 12)}`);
  } else {
    bad('能取回刚上传的对象', `HTTP ${dl.s}`);
  }

  exitCode = FAILED === 0 ? 0 : 1;
} catch (err) {
  console.error(`\n中断：${err?.message ?? err}`);
  exitCode = 1;
} finally {
  // 清理：DELETE（软删除）→ purge（永久删除）。两步都走，不在回收站留行。
  if (resourceId) {
    try {
      const del = await req('DELETE', `/api/resources/${resourceId}`);
      console.log(`\n清理：移入回收站 -> HTTP ${del.s}`);
      const pg = await req('POST', `/api/resources/${resourceId}/purge`, {
        reason: `预签名安全属性探针清理（sig-probe-${STAMP}）`,
      });
      console.log(`清理：purge 永久删除 -> HTTP ${pg.s}`);
      if (!(pg.s === 200 || pg.s === 201)) exitCode = 1;
      const bin = await req('GET', '/api/resources/recycle-bin?pageSize=100');
      const left = ((bin.d?.items ?? [])).filter((r) => String(r.title).includes(String(STAMP)));
      console.log(`清理：回收站复查残留 ${left.length} 条（应为 0）`);
      if (left.length > 0) exitCode = 1;
    } catch (e) { console.error(`清理失败：${e?.message}`); exitCode = 1; }
  }
  console.log(`\n=== RESULT ===\n  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
  if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
  process.exit(exitCode);
}
