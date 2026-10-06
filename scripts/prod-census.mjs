#!/usr/bin/env node
/**
 * scripts/prod-census.mjs —— **生产数据的 API 级普查**（上线前基线快照）。
 *
 *   PROD_BASE_URL=… PROD_ADMIN_CREDENTIALS=… \
 *     node scripts/prod-census.mjs --out backups/prod-census.json
 *
 * ===========================================================================
 * ⚠️ 这不是数据库备份。它**不能**用来恢复数据库。
 * ===========================================================================
 * 要说清楚它是什么、不是什么，否则"我们做了备份"这句话会骗到人：
 *
 *   它**是**：把应用对外暴露的每一张业务表**通过 API 读一遍**，
 *           记录行数与逐表内容校验和（sha256），作为上线前的数据基线。
 *           用途是"上线后对比有没有丢/少/变"，以及给运维一份可核对的数据存量清单。
 *
 *   它**不是**：`pg_dump` 的逻辑备份。恢复不了外键、序列、RLS 策略、
 *           角色/授权、索引、触发器；也不含表里应用接口不暴露的列。
 *
 *   为什么不做真正的备份：本机**没有** `pg_dump` / `pg_restore` / `psql`
 *   （嵌入式 PostgreSQL 只带 `initdb` / `pg_ctl` / `postgres`），
 *   而生产库跑在 Zeabur 内网（`service-…` 主机名在本机 NXDOMAIN）。
 *   真正的备份必须在**能连到该集群的环境**里用 `pg_dump` 做 ——
 *   脚本结束时会打印那几条命令，不会假装自己跑过了。
 *
 * 只读：全程只用 GET，不做任何写操作。
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const BASE = (process.env.PROD_BASE_URL || '').replace(/\/$/, '');
const CRED = process.env.PROD_ADMIN_CREDENTIALS || '';
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : 'backups/prod-census.json';

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
  // ⚠️ 必须转发 body。第一版漏了 `b`，于是登录被 POST 成**空 body**，
  // 服务端在读 username 时抛错 → HTTP 500。我当时把它当成了"生产重启中的偶发"，
  // 那是错的归因：500 是我自己造成的，与生产无关。
  const r = await fetch(BASE + p, {
    method: m,
    headers: h,
    body: b === undefined ? undefined : JSON.stringify(b),
    redirect: 'manual',
  });
  store(r);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 400); }
  return { s: r.status, d };
}

/** 逐表：稳定排序后再算校验和 —— 否则同一份数据两次读出来顺序不同就不是"基线"了。 */
function checksum(rows) {
  const canon = rows
    .map((r) => JSON.stringify(r, Object.keys(r).sort()))
    .sort()
    .join('\n');
  return { sha256: createHash('sha256').update(canon).digest('hex'), bytes: Buffer.byteLength(canon) };
}

await req('GET', '/');
const l = await req('POST', '/api/auth/login', { username: cred.username, password: cred.password });
if (l.s !== 201) { console.error(`登录失败 HTTP ${l.s}`); process.exit(1); }
if (l.d?.mfaRequired) {
  const v = await req('POST', '/api/auth/mfa/verify', {
    challengeToken: l.d?.challengeToken, code: mfa.generateTotp(cred.totpSecret),
  });
  if (v.s !== 200 && v.s !== 201) { console.error(`第二因子失败 HTTP ${v.s}`); process.exit(1); }
}

const census = {
  kind: 'api-level-census',
  note: '这不是数据库备份，不能用于恢复。真正的备份见 scripts/prod-census.mjs 头部与 DISASTER_RECOVERY.md §3。',
  base: BASE,
  capturedAt: new Date().toISOString(),
  tables: {},
  endpoints: [],
};

/** 分页拉全量：`pageSize` 上限 100（写死过 200 会 400）。 */
async function paginate(path, { maxPages = 20 } = {}) {
  const items = [];
  let total = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await req('GET', `${path}${sep}page=${page}&pageSize=100`);
    census.endpoints.push({ path, page, status: r.s });
    if (r.s !== 200) return { items, total, failedAt: page, status: r.s };
    const batch = r.d?.items ?? [];
    if (typeof r.d?.total === 'number') total = r.d.total;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return { items, total };
}

async function table(name, path, opts) {
  const { items, total, failedAt, status } = await paginate(path, opts);
  // 只保留业务字段，剔除纯粹的时间戳噪声（updatedAt 之类仍保留，便于发现"上线后被动过"）。
  const cs = checksum(items);
  census.tables[name] = {
    endpoint: path,
    totalReported: total ?? null,
    rowsFetched: items.length,
    ...(failedAt ? { failedAtPage: failedAt, status } : {}),
    ...cs,
    rows: items,
  };
  const flag = failedAt ? `  ⚠️ 第 ${failedAt} 页 HTTP ${status}` : '';
  console.log(`  ${name.padEnd(22)} total=${String(total ?? '?').padStart(5)}  fetched=${String(items.length).padStart(5)}  sha256=${cs.sha256.slice(0, 16)}…${flag}`);
  return census.tables[name];
}

console.log(`\n=== 生产数据普查（API 级）${BASE} ===\n`);
console.log('  表                     报告总数   实际取到   内容校验和');
await table('resources', '/api/resources?status=published');
await table('resources_draft', '/api/resources?status=draft');
await table('resources_pending', '/api/resources?status=pending_review');
await table('resources_all', '/api/resources');
await table('recycle_bin', '/api/resources/recycle-bin');
await table('teachers', '/api/teachers');
await table('review_pending', '/api/review/pending');
await table('audit_logs', '/api/audit/logs', { maxPages: 30 });

// 树/结构类：不是分页列表，单独取
for (const [name, path] of [
  ['directories_tree', '/api/directories/tree'],
  ['curriculum_structure', '/api/curriculum/structure'],
  ['curriculum_folders', '/api/curriculum/folders'],
  ['curriculum_roles', '/api/curriculum/roles'],
]) {
  const r = await req('GET', path);
  census.endpoints.push({ path, status: r.s });
  const body = JSON.stringify(r.d ?? null);
  census.tables[name] = { endpoint: path, status: r.s, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), payload: r.d ?? null };
  console.log(`  ${name.padEnd(22)} HTTP ${r.s}  sha256=${census.tables[name].sha256.slice(0, 16)}…`);
}

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), JSON.stringify(census, null, 2), { mode: 0o600 });
console.log(`\n已写出：${OUT}（mode 600，gitignored：${existsSync('.gitignore') ? '见 .gitignore 的 backups/' : '?'}）`);

console.log(`
────────────────────────────────────────────────────────────────────────────
⚠️  这是 **API 级普查**，不是数据库备份。它**不能**用于恢复数据库。
    真正要做的是下面这些命令，必须在**能连到生产集群**的环境里执行
    （Zeabur：进入 postgres 服务的终端/命令入口，或用平台的备份功能）：

  # ① 业务库逻辑备份（结构 + 数据）
  pg_dump --format=custom --no-owner --no-privileges \\
          "$DATABASE_URL" > qls_prod_$(date +%Y%m%d_%H%M).dump

  # ② 集群级角色与授权 —— pg_dump **不含**它们
  #    恢复到新集群时，缺了它们所有引用 anon_/authenticated_ 的策略与 GRANT 都会失败
  pg_dumpall --roles-only "$DATABASE_URL" > qls_roles_$(date +%Y%m%d).sql

  # ③ 校验备份可读（不是"看起来有文件"）
  pg_restore --list qls_prod_*.dump | head

  # ④ 把备份放到**与数据库不同**的故障域，并记录"最后一次成功备份时间"
  #    参见 DISASTER_RECOVERY.md §3、§2（RPO/RTO 至今未定义）

  本机为什么做不了：没有 pg_dump / pg_restore / psql（嵌入式 PostgreSQL
  只带 initdb / pg_ctl / postgres），且生产库在 Zeabur 内网（主机名在本机 NXDOMAIN）。
────────────────────────────────────────────────────────────────────────────`);
