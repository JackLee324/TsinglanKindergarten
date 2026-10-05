/**
 * scripts/verify-resource-versions.mjs —— 资源版本生命周期（§15）。
 *
 *   DATABASE_URL=… node scripts/verify-resource-versions.mjs
 *
 * 为什么这条要单独测：`resources.version` 这一列**一直存在、界面也一直显示
 * "版本 v1"，但迁移前 348 行全部等于 1** —— 也就是说那个数字此前是装饰。
 * 「看起来有版本」和「真的有版本」之间的差别，只能靠"改一次、看它动没动"来判定。
 */
const BASE = process.env.DIRECTORY_BASE || process.env.MFA_BASE || 'http://127.0.0.1:3200';
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;

let pass = 0, fail = 0; const failures = [];
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + '  ' +
    label.padEnd(60) + ' -> ' + JSON.stringify(actual) + (ok ? '' : '   expected ' + JSON.stringify(expected)));
  if (ok) pass++; else { fail++; failures.push(`${label}: got ${JSON.stringify(actual)}`); }
}

function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } };
  async function req(m, p, b) {
    const h = { 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = cookie();
    if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
    const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    store(r);
    let d = null; try { d = await r.json(); } catch { /* 204/空 */ }
    return { s: r.status, d };
  }
  return { req };
}

const PW = process.env.SEQ_PROBE_PASSWORD || 'SeqProbe!2026x';
console.log(`\n资源版本生命周期验证 @ ${BASE}\n${'='.repeat(78)}\n`);

const c = makeClient();
await c.req('GET', '/');
const login = await c.req('POST', '/api/auth/login', { username: 'seq_principal', password: PW });
if (login.s !== 201 && login.s !== 200) {
  console.error(`登录失败：HTTP ${login.s} ${JSON.stringify(login.d)}`);
  process.exit(2);
}
const me = login.d?.teacher;
console.log(`  登录为 ${me?.username}（${(me?.roles ?? []).join(',')}）\n`);

let resourceId = null;
try {
  // ---- 1. 新建 → 第 1 版 ----
  console.log('1) 新建资源应当产生第 1 版');
  const created = await c.req('POST', '/api/resources', {
    title: `版本探针 ${Date.now().toString().slice(-6)}`,
    program: 'prek',
    subject: 'virtue',
    folderType: 'curriculum_outline',
    description: '初始说明',
  });
  check('创建资源 → 201', created.s, 201);
  resourceId = created.d?.id ?? null;
  if (!resourceId) throw new Error('创建响应没有 id：' + JSON.stringify(created.d));
  check('新资源 version = 1', created.d?.version, 1);

  let v = await c.req('GET', `/api/resources/${resourceId}/versions`);
  check('GET :id/versions → 200', v.s, 200);
  check('历史里有 1 条', (v.d ?? []).length, 1);
  check('  该条 version = 1', v.d?.[0]?.version, 1);
  check('  该条 changeKind = created', v.d?.[0]?.changeKind, 'created');
  check('  该条记录了操作人', v.d?.[0]?.changedBy, me?.id);

  // ---- 2. 编辑说明 → 第 2 版 ----
  console.log('\n2) 修改内容应当产生新版本');
  const edited = await c.req('PATCH', `/api/resources/${resourceId}`, { description: '改过一次' });
  check('编辑 → 200', edited.s, 200);
  check('version 变成 2', edited.d?.version, 2);

  v = await c.req('GET', `/api/resources/${resourceId}/versions`);
  check('历史里有 2 条', (v.d ?? []).length, 2);
  check('最新的一条是 v2（新的在前）', v.d?.[0]?.version, 2);
  check('  v2 的 changeKind = metadata_edited', v.d?.[0]?.changeKind, 'metadata_edited');
  check('  v2 的说明是改后的值', v.d?.[0]?.description, '改过一次');
  check('  v1 的说明仍是初始值（历史不可变）', v.d?.[1]?.description, '初始说明');

  // ---- 3. 无实质变化的保存**不应**产生版本 ----
  console.log('\n3) 没有实质变化的保存不应产生版本（否则历史会被噪声淹没）');
  const same = await c.req('PATCH', `/api/resources/${resourceId}`, { description: '改过一次' });
  check('重复提交同样的值 → 200', same.s, 200);
  check('version 仍为 2（未自增）', same.d?.version, 2);
  v = await c.req('GET', `/api/resources/${resourceId}/versions`);
  check('历史仍是 2 条', (v.d ?? []).length, 2);

  // ---- 4. 再改一次 → 第 3 版 ----
  console.log('\n4) 再次修改 → 第 3 版');
  const edited2 = await c.req('PATCH', `/api/resources/${resourceId}`, { title: '版本探针（改名）' });
  check('version 变成 3', edited2.d?.version, 3);
  v = await c.req('GET', `/api/resources/${resourceId}/versions`);
  check('历史里有 3 条', (v.d ?? []).length, 3);
  check('v3 的标题是新标题', v.d?.[0]?.title, '版本探针（改名）');

  // ---- 5. 回填的快照：既有资源也应当有第 1 版 ----
  if (DB_URL) {
    console.log('\n5) 迁移回填：既有资源都有第 1 版快照');
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1 });
    const [{ missing }] = await sql`
      SELECT count(*)::int AS missing FROM resources r
       WHERE NOT EXISTS (SELECT 1 FROM resource_versions v WHERE v.resource_id = r.id)`;
    check('没有任何资源缺少版本快照', missing, 0);
    const [{ bad }] = await sql`
      SELECT count(*)::int AS bad FROM resources r
       JOIN (SELECT resource_id, max(version) AS latest FROM resource_versions GROUP BY resource_id) m
         ON m.resource_id = r.id
       WHERE m.latest <> r.version`;
    check('resources.version 与最新快照版本号一致', bad, 0);
    const [{ backfilled }] = await sql`
      SELECT count(*)::int AS backfilled FROM resource_versions WHERE change_kind = 'backfilled'`;
    console.log(`        （回填快照 ${backfilled} 条）`);
    await sql.end();
  } else {
    console.log('\n5) 跳过回填检查（未设置 DATABASE_URL / AUTHZ_TEST_DB）');
  }
} finally {
  if (resourceId) {
    const del = await c.req('DELETE', `/api/resources/${resourceId}`);
    console.log(`\n清理：删除探针资源 → HTTP ${del.s}`);
  }
}

console.log('\n' + '='.repeat(78));
console.log(`资源版本验证：${pass} 通过 / ${fail} 失败   pass=${pass} fail=${fail}`);
if (fail > 0) { console.log('\n失败明细：'); for (const f of failures) console.log('  * ' + f); process.exit(1); }
