#!/usr/bin/env node
/**
 * scripts/purge-prod-probes.mjs —— 清理生产回收站里的**探针**资源（§12 收口）。
 *
 *   PROD_BASE_URL=… PROD_ADMIN_CREDENTIALS=… ALLOW_PROD_PURGE=1 \
 *     node scripts/purge-prod-probes.mjs
 *
 * 用户要求：清理本轮留在生产回收站中的测试探针、**不要为此删除真实业务资源**、
 * 清理动作必须保留审计证据。
 *
 * 这个脚本把"不要误删真实资源"做成**代码里的硬约束**，而不是靠操作者小心：
 *
 *   1. 只处理**回收站里**的资源（`purge` 接口本身就只接受已软删除的行）；
 *   2. 只处理标题命中**白名单正则**的（探针命名的固定前缀），
 *      任何一条不匹配就跳过并打印，绝不"顺手一起删"；
 *   3. 每条 purge 都带 `reason`（含本次运行标记），服务端会把它写进
 *      `resource_purge` 审计 —— 谁、何时、为什么、原 purge_after 全部可复核；
 *   4. **默认 dry-run**：不加 `ALLOW_PROD_PURGE=1` 只列出将要删除什么。
 *
 * 它**不会**去猜"哪些像测试数据"：标题正则写在下面，改它必须是一次显式改动。
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.PROD_BASE_URL || '').replace(/\/$/, '');
const CRED = process.env.PROD_ADMIN_CREDENTIALS || '';
const APPLY = process.env.ALLOW_PROD_PURGE === '1';

/**
 * 只删**这些**标题。它们全部来自本工程的验证脚本（`verify-prod-*.mjs`），
 * 命名是这些脚本自己拼的，不会与老师的真实资源撞名。
 */
const PROBE_TITLE_PATTERNS = [
  /^R2 往返探针 \d+$/,
  /^存储往返探针 \d+$/,
  /^浏览器直传探针 \d+$/,
  /^CORS 探针 \d+$/,
  /^RLS 删除探针$/,
  /^到期清理探针$/,
];

if (!BASE || !CRED) { console.error('需要 PROD_BASE_URL / PROD_ADMIN_CREDENTIALS'); process.exit(2); }
const cred = JSON.parse(readFileSync(resolve(CRED), 'utf8'));

const require = createRequire(resolve(process.cwd()) + '/');
const mfa = require(resolve(process.cwd(), 'dist/server/common/crypto/mfa-crypto.js'));

const jar = {};
const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const store = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } };
async function req(m, p, b) {
  const h = { 'content-type': 'application/json' };
  if (Object.keys(jar).length) h.cookie = cookie();
  if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b), redirect: 'manual' });
  store(r); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 200); }
  return { s: r.status, d };
}

const RUN_ID = `probe-cleanup-${new Date().toISOString()}`;

await req('GET', '/');
const l = await req('POST', '/api/auth/login', { username: cred.username, password: cred.password });
if (l.s !== 201) { console.error(`登录失败：HTTP ${l.s}`); process.exit(1); }
await req('POST', '/api/auth/mfa/verify', { challengeToken: l.d?.challengeToken, code: mfa.generateTotp(cred.totpSecret) });

const bin = await req('GET', '/api/resources/recycle-bin?pageSize=100');
const items = bin.d?.items ?? [];
console.log(`\n=== 生产回收站探针清理（${BASE}）===`);
console.log(`模式：${APPLY ? '**APPLY（会永久删除）**' : 'dry-run（只列出）'}`);
console.log(`回收站 total=${bin.d?.total}，本页 ${items.length}\n`);

const targets = [];
const skipped = [];
for (const r of items) {
  const title = String(r.title ?? '');
  if (PROBE_TITLE_PATTERNS.some((p) => p.test(title))) targets.push(r);
  else skipped.push(r);
}

console.log(`命中白名单（将被永久删除）：${targets.length} 条`);
for (const t of targets) {
  console.log(`  · ${t.id}  「${t.title}」  deleted_at=${t.deletedAt}  purge_after=${t.purgeAfter}`);
}
console.log(`\n**不匹配白名单（保持不动）**：${skipped.length} 条`);
for (const s of skipped) {
  console.log(`  · ${s.id}  「${String(s.title).slice(0, 40)}」  ← 非探针，不动`);
}

if (!APPLY) {
  console.log('\n（dry-run 结束，未删除任何东西。要执行请设 ALLOW_PROD_PURGE=1）');
  process.exit(0);
}

console.log('\n--- 执行 ---');
let purged = 0, failed = 0;
for (const t of targets) {
  const res = await req('POST', `/api/resources/${t.id}/purge`, {
    reason: `生产探针清理（${RUN_ID}）—— 由 scripts/verify-prod-*.mjs 创建的测试资源`,
  });
  if (res.s === 200 || res.s === 201) {
    purged += 1;
    console.log(`  ✅ ${t.id} 「${String(t.title).slice(0, 28)}」 → HTTP ${res.s}  hadFile=${res.d?.hadFile}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${t.id} → HTTP ${res.s} ${JSON.stringify(res.d).slice(0, 140)}`);
  }
}

console.log('\n--- 复查 ---');
const after = await req('GET', '/api/resources/recycle-bin?pageSize=100');
const stillThere = ((after.d?.items ?? [])).filter((r) => PROBE_TITLE_PATTERNS.some((p) => p.test(String(r.title ?? ''))));
console.log(`回收站 total=${after.d?.total}；仍匹配白名单的探针：${stillThere.length}`);
for (const s of stillThere) console.log(`  · 仍在：${s.id} 「${s.title}」`);

console.log(`\n=== RESULT ===  永久删除 ${purged} / 失败 ${failed} / 未动 ${skipped.length}`);
console.log(`本次运行的审计标记（可在审计日志里搜）：${RUN_ID}`);
process.exit(failed === 0 && stillThere.length === 0 ? 0 : 1);
