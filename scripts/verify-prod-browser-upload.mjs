#!/usr/bin/env node
/**
 * scripts/verify-prod-browser-upload.mjs —— **生产浏览器直传**（§5 的 CORS 预检）。
 *
 *   PROD_BASE_URL=https://xxx.zeabur.app \
 *   PROD_ADMIN_CREDENTIALS=$PWD/credentials/prod-super-admin.json \
 *   ALLOW_PROD_WRITE=1 node scripts/verify-prod-browser-upload.mjs
 *
 * ===========================================================================
 * 为什么必须有这个脚本（它验证的东西别的脚本**证明不了**）
 * ===========================================================================
 * `verify-prod-storage.mjs` 从 Node 发 PUT 到预签名地址 —— 那是**普通 HTTP 请求**，
 * **不触发 CORS 语义**。所以无论生产 bucket 有没有 CORS 策略，它都会成功。
 *
 * 而老师点「保存草稿」时走的是**浏览器**：`fetch(uploadUrl, {method:'PUT', body:file})`
 * 是一个**跨域**请求，且 `File` 会带上 `content-type: application/pdf`
 * —— `application/pdf` **不在** CORS 安全名单里，于是浏览器**先发 OPTIONS 预检**。
 * bucket 没有 CORS 策略时，预检失败 ⇒ 直传必然失败，而且**服务端一行日志都没有**。
 *
 * 所以：这个脚本在**生产 origin 的页面上下文里**发起那次 PUT，
 * 让浏览器自己去走预检。只有它通过，才能说"生产浏览器直传可用"。
 *
 * 它是**写生产**的：会建一条探针资源并硬删除，跑完自查残留。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const BASE = (process.env.PROD_BASE_URL || '').replace(/\/$/, '');
const CRED_PATH = process.env.PROD_ADMIN_CREDENTIALS || '';
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PROD_CDP_PORT || 9311);

if (!BASE) { console.error('需要 PROD_BASE_URL'); process.exit(2); }
if (!CRED_PATH) { console.error('需要 PROD_ADMIN_CREDENTIALS'); process.exit(2); }
if (process.env.ALLOW_PROD_WRITE !== '1') {
  console.error('本脚本会往**生产**写一条探针资源（跑完删除）。要执行请显式 ALLOW_PROD_WRITE=1。');
  process.exit(2);
}
const credFile = resolve(CRED_PATH);
if (!existsSync(credFile)) { console.error(`凭据文件不存在：${credFile}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`找不到 Chrome：${CHROME}`); process.exit(2); }

const require = createRequire(resolve(process.cwd()) + '/');
const mfaModule = resolve(process.cwd(), 'dist/server/common/crypto/mfa-crypto.js');
if (!existsSync(mfaModule)) { console.error(`找不到 ${mfaModule} —— 先跑 npm run build。`); process.exit(2); }
const mfa = require(mfaModule);

const cred = JSON.parse(readFileSync(credFile, 'utf8'));
const USERNAME = cred.username || 'TsinglanAdmin';

let PASSED = 0, FAILED = 0;
const ok = (l, d = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); PASSED++; };
const bad = (l, d = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); FAILED++; };

const STAMP = Date.now();

// ---- Node 侧：登录、建探针、取预签名地址 ---------------------------------
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
  return { s: r.status, d };
}

let resourceId = null;
let chrome = null;
let profile = null;
let exitCode = 1;

try {
  console.log(`\n=== 生产浏览器直传（${BASE}）===`);
  console.log('（这一步验证的是 CORS 预检 —— 别的脚本都证明不了它）\n');

  await req('GET', '/');
  const login = await req('POST', '/api/auth/login', { username: USERNAME, password: cred.password });
  if (login.s !== 201) { bad('生产登录', `HTTP ${login.s}`); throw new Error('login'); }
  await req('POST', '/api/auth/mfa/verify', {
    challengeToken: login.d?.challengeToken, code: mfa.generateTotp(cred.totpSecret),
  });
  ok('生产登录 + 第二因子通过', `HTTP 201`);

  const tree = await req('GET', '/api/directories/tree');
  const flat = [];
  const walk = (ns) => { for (const n of ns ?? []) { flat.push(n); walk(n.children); } };
  walk(tree.d?.roots ?? []);
  const leaf = flat.find((n) => n.type === 'folder' && n.program && n.subject);
  if (!leaf) { bad('取到可归属的目录叶子', '无'); throw new Error('no leaf'); }

  const created = await req('POST', '/api/resources', {
    title: `浏览器直传探针 ${STAMP}`,
    program: leaf.program, subject: leaf.subject, directoryId: leaf.id,
    folderType: 'materials', semester: 'S1', week: 1,
    description: '生产浏览器直传（CORS 预检）验证，跑完硬删除',
  });
  resourceId = created.d?.id ?? created.d?.resource?.id ?? null;
  if (!resourceId) { bad('建探针资源', `HTTP ${created.s} ${JSON.stringify(created.d).slice(0, 180)}`); throw new Error('create'); }
  ok('建探针资源（草稿）', `id=${resourceId}`);

  const fileName = `browser-probe-${STAMP}.pdf`;
  const urlResp = await req('POST', `/api/resources/${resourceId}/upload-url`, { fileName });
  const putUrl = urlResp.d?.uploadUrl;
  if (!putUrl) { bad('取预签名 PUT 地址', `HTTP ${urlResp.s}`); throw new Error('no url'); }
  ok('取预签名 PUT 地址', `${String(putUrl).split('?')[0].slice(0, 80)}…`);

  // ---- 浏览器侧：在**生产 origin** 的页面上下文里做那次 PUT ---------------
  profile = mkdtempSync(join(tmpdir(), 'qls-prodcors-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--window-size=1280,900',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = l.find((t) => t.type === 'page') || null;
    } catch { /* 还没起来 */ }
    if (!target) await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) { bad('启动无头浏览器', 'CDP 未就绪'); throw new Error('cdp'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map();
  const consoleErrors = [];
  /** CDP Network 域的事件：只有它能给出 Chromium **确切**的 CORS 失败原因。 */
  const netEvents = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    // 收集页面控制台错误：CORS 失败在页面上表现为一条 console error
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Network.loadingFailed' || m.method === 'Network.responseReceived') {
      netEvents.push(m);
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return r.result?.result;
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Page.navigate', { url: BASE + '/login' });
  for (let i = 0; i < 60; i += 1) {
    if (await ev('location.origin')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const origin = (await ev('location.origin'))?.value;
  if (origin === new URL(BASE).origin) ok('页面已在生产 origin 上', origin);
  else bad('页面已在生产 origin 上', String(origin));

  // 关键：与真实客户端**逐字一致** —— fetch(url, {method:'PUT', body: file})，
  // 不显式设 header，让 File 自己带 content-type: application/pdf（非安全名单 ⇒ 触发预检）。
  const probe = await ev(`(async () => {
    const out = { steps: [] };
    try {
      const res = await fetch(${JSON.stringify(putUrl)}, { method: 'OPTIONS' });
      out.steps.push('raw-OPTIONS:' + res.status);
    } catch (e) { out.steps.push('raw-OPTIONS-threw:' + (e && e.message)); }
    try {
      const bytes = new Uint8Array(1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
      const file = new File([bytes], ${JSON.stringify(fileName)}, { type: 'application/pdf' });
      const r = await fetch(${JSON.stringify(putUrl)}, { method: 'PUT', body: file });
      out.put = r.status;
      out.putOk = r.ok;
      out.etag = r.headers.get('etag');
    } catch (e) {
      out.putError = (e && e.message) || String(e);
      out.putErrorName = (e && e.name) || '';
    }
    return JSON.stringify(out);
  })()`, true);

  let parsed = null;
  try { parsed = JSON.parse(probe?.value ?? '{}'); } catch { /* 忽略 */ }

  const putOk = parsed?.putOk === true;
  if (putOk) {
    ok('浏览器在生产 origin 上直传成功（CORS 预检通过）', `PUT HTTP ${parsed.put}`);
  } else {
    bad('浏览器在生产 origin 上直传成功（CORS 预检通过）',
      `PUT=${parsed?.put ?? 'n/a'} error=${parsed?.putError ?? '(none)'} steps=${JSON.stringify(parsed?.steps ?? [])}`);
    console.log('       ↑ 这条红意味着：老师在浏览器里点「保存草稿」时**传不上去**。');
    console.log('         服务端不会有任何日志 —— 这正是必须先配好 bucket CORS 策略的原因。');
    console.log('         策略见 DEPLOYMENT_PRODUCTION.md §2.5（origin 钉死、禁止通配符）。');

    // 把**浏览器自己给的**原因打出来。不然"Failed to fetch"会被误判成
    // 签名算错 / 网络不通 —— 这两种错误猜下去都要花很久，而真正的原因是 CORS。
    const preflights = netEvents.filter(
      (e) => e.method === 'Network.responseReceived' && e.params.type === 'Preflight',
    );
    for (const p of preflights) {
      const hdrs = Object.fromEntries(
        Object.entries(p.params.response.headers).filter(([k]) => /access-control/i.test(k)),
      );
      console.log(`      预检响应 status=${p.params.response.status} CORS 响应头=${JSON.stringify(hdrs)}`);
    }
    for (const e of netEvents) {
      if (e.method !== 'Network.loadingFailed') continue;
      const cors = e.params.corsErrorStatus;
      console.log(`      loadingFailed errorText=${e.params.errorText}` +
        (cors ? ` corsError=${cors.corsError}${cors.failedParameter ? ' param=' + cors.failedParameter : ''}` : ''));
    }
    if (preflights.length === 0 && netEvents.every((e) => e.method !== 'Network.loadingFailed')) {
      console.log('      （没有捕获到预检事件 —— 请确认 Network 域已启用，否则别从这条输出下结论）');
    }
  }
  if (parsed?.etag) console.log(`      ETag: ${parsed.etag}`);

  if (consoleErrors.length > 0) {
    console.log('      页面控制台错误（最多 3 条）：');
    for (const e of consoleErrors.slice(0, 3)) console.log('        · ' + String(e).slice(0, 200));
  }

  // 取回字节比对 —— Node 侧走"服务端代理下载"，确认对象确实落盘且内容正确。
  if (putOk) {
    const reg = await req('POST', `/api/resources/${resourceId}/file`, {
      fileName,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      head: Buffer.from(Array.from({ length: 16 }, (_, i) => i % 251)).toString('base64'),
      fileBucketId: urlResp.d?.bucketId,
      filePath: urlResp.d?.filePath,
    });
    if (reg.s === 200 || reg.s === 201) ok('登记浏览器直传的文件元数据', `HTTP ${reg.s}`);
    else bad('登记浏览器直传的文件元数据', `HTTP ${reg.s} ${JSON.stringify(reg.d).slice(0, 180)}`);

    const dl = await req('GET', `/api/resources/${resourceId}/download`);
    const loc = dl.h.get('location');
    if (loc) {
      let raw = await fetch(new URL(loc, BASE).toString(), { headers: { cookie: cookie() }, redirect: 'manual' });
      if (raw.status === 302) raw = await fetch(new URL(raw.headers.get('location'), BASE).toString(), { redirect: 'manual' });
      const got = Buffer.from(await raw.arrayBuffer());
      const expectSha = createHash('sha256')
        .update(Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 251))).digest('hex');
      const gotSha = createHash('sha256').update(got).digest('hex');
      if (got.length === 1024 && gotSha === expectSha) ok('浏览器直传的字节可被逐字节取回', `${got.length} bytes`);
      else bad('浏览器直传的字节可被逐字节取回', `len=${got.length} sha=${gotSha.slice(0, 12)} vs ${expectSha.slice(0, 12)}`);
    } else {
      bad('浏览器直传后可下载', `HTTP ${dl.s}`);
    }
  }

  exitCode = FAILED === 0 ? 0 : 1;
} catch (err) {
  console.error(`\n中断：${err?.message ?? err}`);
  exitCode = 1;
} finally {
  if (chrome) chrome.kill();
  if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  if (resourceId) {
    try { const del = await req('DELETE', `/api/resources/${resourceId}`); console.log(`\n清理：删除探针 -> HTTP ${del.s}`); }
    catch (e) { console.error(`清理删除失败：${e?.message ?? e}`); }
    try {
      const after = await req('GET', `/api/resources?pageSize=100&keyword=${encodeURIComponent(String(STAMP))}`);
      const residue = (after.d?.items ?? []).filter((r) => String(r.title).includes(String(STAMP)));
      console.log(`清理：**正常列表**里残留 ${residue.length} 条`);
      if (residue.length > 0) exitCode = 1;

      // ⚠️ 只查"正常列表"是不够的：`DELETE /api/resources/:id` 是**软删除**，
      // 行会移进回收站，而正常列表看不到它。上一版就因此打印了"残留 0 条"，
      // 而生产回收站里其实躺着我的 9 条探针 —— 那是**我自己造的假安心**。
      // 所以这里同时查回收站，并把"什么时候会被自动清掉"如实说出来。
      const bin = await req('GET', '/api/resources/recycle-bin?pageSize=100');
      const inBin = ((bin.d?.items ?? [])).filter((r) => String(r.title).includes(String(STAMP)));
      if (inBin.length === 0) {
        console.log('清理：回收站里也没有残留');
      } else {
        const eta = inBin.map((r) => r.purgeAfter).filter(Boolean).sort()[0];
        console.log(
          `清理：回收站里有 ${inBin.length} 条（软删除的正确行为，不是脏数据）。` +
            (eta ? `将在 ${eta} 由到期清理调度器永久删除。` : '（未返回 purgeAfter，无法给出预计时间）'),
        );
        console.log('      注意：**没有**按需 purge 的接口（`resource.purge` 是幽灵权限），');
        console.log('            所以这条记录只能等保留期到期，或由运维直接操作数据库。');
      }
    } catch (e) { console.error(`残留复查失败：${e?.message ?? e}`); exitCode = 1; }
  }
  console.log(`\n=== RESULT ===\n  pass=${PASSED} fail=${FAILED}`);
  process.exit(exitCode);
}
