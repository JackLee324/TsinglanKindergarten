#!/usr/bin/env node
/**
 * scripts/verify-prod-cors.mjs —— 生产 R2 bucket 的 **CORS 预检**验收（§5）。
 *
 *   PROD_CORS_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
 *   PROD_CORS_BUCKET=tsinglan-curriculum \
 *   PROD_CORS_ORIGIN=https://tsinglankindergarten.zeabur.app \
 *     node scripts/verify-prod-cors.mjs
 *
 * 为什么单独有这个脚本
 * --------------------
 * `verify-prod-browser-upload.mjs` 走的是完整直传闭环（建资源、取预签名、
 * 浏览器 PUT）。它很强，但**需要先能登录、先能建资源**，而且失败时只说
 * "PUT 没成功"。排查 CORS 本身时，我们要的是逐条看清预检的每一个响应头。
 *
 * 预检请求（OPTIONS）**不携带签名**（浏览器不可能签），所以本脚本可以直接
 * 对 bucket 发裸 OPTIONS，不需要任何凭据、不需要登录、不做任何写操作 ——
 * 这也是它可以在修 CORS 的过程中反复跑的原因。
 *
 * 逐条断言（对应用户列出的验收项）：
 *   1. 预检返回 **2xx**
 *   2. `Access-Control-Allow-Origin` **恰好**等于生产 origin
 *   3. `Access-Control-Allow-Methods` 含 **PUT**
 *   4. `Access-Control-Allow-Headers` 覆盖 `content-type`（浏览器直传唯一带的头）
 *   5. **其它 Origin 必须不被允许**（禁 wildcard：既不能返回 `*`，
 *      也不能对别的 origin 回显允许）
 *   6. 非白名单方法（如 DELETE）不应被允许
 */

const ENDPOINT = (process.env.PROD_CORS_ENDPOINT || '').replace(/\/$/, '');
const BUCKET = process.env.PROD_CORS_BUCKET || '';
const ORIGIN = process.env.PROD_CORS_ORIGIN || '';
const PROBE_KEY = process.env.PROD_CORS_PROBE_KEY || 'cors-probe/never-written';

if (!ENDPOINT || !BUCKET || !ORIGIN) {
  console.error('需要 PROD_CORS_ENDPOINT / PROD_CORS_BUCKET / PROD_CORS_ORIGIN');
  process.exit(2);
}

let PASSED = 0, FAILED = 0;
const ok = (l, d = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); PASSED++; };
const bad = (l, d = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); FAILED++; };

const url = `${ENDPOINT}/${BUCKET}/${PROBE_KEY}`;

/** 发一次预检。**不发签名**：真实预检也不带签名，所以这才是真实的被测对象。 */
async function preflight(origin, method = 'PUT', reqHeaders = 'content-type') {
  const r = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': reqHeaders,
    },
    redirect: 'manual',
  });
  const h = {};
  for (const [k, v] of r.headers.entries()) if (/^access-control-/i.test(k)) h[k.toLowerCase()] = v;
  return { status: r.status, headers: h };
}

console.log(`\n=== 生产 R2 CORS 预检验收（§5）===`);
console.log(`bucket : ${BUCKET}`);
console.log(`endpoint: ${ENDPOINT}`);
console.log(`origin : ${ORIGIN}`);
console.log(`预检目标: ${url}\n`);

// ---- 1) 允许的 origin -----------------------------------------------------
const allow = await preflight(ORIGIN);
console.log('1) 允许的生产 origin');
if (allow.status >= 200 && allow.status < 300) ok('预检返回 2xx', `HTTP ${allow.status}`);
else bad('预检返回 2xx', `HTTP ${allow.status}（CORS 未配置时 R2 返回 403）`);

const acao = allow.headers['access-control-allow-origin'];
if (acao === ORIGIN) ok('Access-Control-Allow-Origin 精确等于生产 origin', acao);
else if (acao === '*') bad('Access-Control-Allow-Origin 精确等于生产 origin', `返回了通配符 "*" —— 违反"禁止 wildcard origin"`);
else if (acao && acao.includes('*')) bad('Access-Control-Allow-Origin 精确等于生产 origin', `含通配符：${acao}`);
else bad('Access-Control-Allow-Origin 精确等于生产 origin', `得到 ${JSON.stringify(acao ?? null)}`);

const acam = allow.headers['access-control-allow-methods'] || '';
if (/(^|,)\s*PUT\s*(,|$)/i.test(acam)) ok('Access-Control-Allow-Methods 含 PUT', acam);
else bad('Access-Control-Allow-Methods 含 PUT', JSON.stringify(acam));

const acah = (allow.headers['access-control-allow-headers'] || '').toLowerCase();
if (acah.split(',').map((s) => s.trim()).includes('content-type')) {
  ok('Access-Control-Allow-Headers 覆盖 content-type', acah);
} else {
  bad('Access-Control-Allow-Headers 覆盖 content-type', JSON.stringify(acah));
}

// ---- 2) 其它 origin 必须被拒 ---------------------------------------------
console.log('\n2) 其它 Origin 必须不被允许（禁 wildcard 的真实含义）');
for (const other of ['https://evil.example.com', 'http://tsinglankindergarten.zeabur.app']) {
  const r = await preflight(other);
  const got = r.headers['access-control-allow-origin'];
  // 判定标准：**不能回显这个 origin，也不能回 *，也不能 2xx**。
  const echoes = got === other || got === '*';
  const accepted = r.status >= 200 && r.status < 300;
  if (!echoes && !accepted) {
    ok(`非白名单 origin 被拒：${other}`, `HTTP ${r.status}${got ? ` ACAO=${got}` : ' 无 CORS 头'}`);
  } else {
    bad(`非白名单 origin 被拒：${other}`,
      `HTTP ${r.status}${got ? ` ACAO=${got}` : ''}${accepted ? ' —— 预检竟然 2xx' : ''}`);
  }
}
// http→https 只是 scheme 不同，也要一并拒掉（避免"看起来像同站"的误配）

// ---- 3) 非白名单方法不该被允许 -------------------------------------------
console.log('\n3) 非白名单方法（DELETE）不应被允许');
const del = await preflight(ORIGIN, 'DELETE');
const delMethods = del.headers['access-control-allow-methods'] || '';
const deleteAllowed = /(^|,)\s*DELETE\s*(,|$)/i.test(delMethods);
if (!deleteAllowed) ok('预检不声明允许 DELETE', delMethods || '（无 Allow-Methods）');
else bad('预检不声明允许 DELETE', delMethods);

// ---- 4) 暴露的响应头（信息项，不参与通过判定）-----------------------------
const expose = allow.headers['access-control-expose-headers'];
console.log(`\n信息：Access-Control-Expose-Headers = ${JSON.stringify(expose ?? null)}（用于前端读 ETag；缺失不算失败）`);
const maxAge = allow.headers['access-control-max-age'];
console.log(`信息：Access-Control-Max-Age = ${JSON.stringify(maxAge ?? null)}`);

console.log(`\n=== RESULT ===\n  pass=${PASSED} fail=${FAILED}`);
if (FAILED > 0) {
  console.log('\n  未通过 —— 浏览器直传在这种情况下**一定**失败（PreflightMissingAllowOriginHeader）。');
}
process.exit(FAILED === 0 ? 0 : 1);
