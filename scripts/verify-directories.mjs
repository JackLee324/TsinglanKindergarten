/**
 * scripts/verify-directories.mjs — 目录树接口的真实 HTTP 验证（§1/§2/§20 的一部分）。
 *
 *   DIRECTORY_BASE=http://127.0.0.1:3200 node scripts/verify-directories.mjs
 *
 * 需要：
 *   * 一个已启动、已 build 的服务端（`npm run build:server && npm run start`）；
 *   * 数据库里已跑过 migration 0009，并且 `directories` 表非空。
 *
 * 这个脚本刻意**断言精确数字**而不是「大于 0」：
 * 「接口返回了 200」和「接口返回了正确的那棵树」是两件事，
 * 而"看起来成功了"正是这个项目反复出现的失败形态。
 *
 * FIXTURES
 *   使用 tests/helpers 里既有的探针账号（scope_* 系列，密码 ScopeProbe!2026）
 *   与 seq_principal（SeqProbe!2026x）。另外临时建一个 visitor 账号来验证
 *   「没有 curriculum.view 的角色被挡住」——因为现有账号里没有任何一个 visitor，
 *   不建就只能凭空声称这条规则成立。用完即删。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = process.env.DIRECTORY_BASE || 'http://127.0.0.1:3200';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  // 数组按内容比较。第一版写成 `expected.includes(actual)`，两个内容相同的数组
  // 因为引用不同而被判成 FAIL —— 测试自己的 bug，会让真正的失败淹没在噪声里。
  const ok = Array.isArray(expected)
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  console.log(
    '  ' + (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') +
      '  ' + label.padEnd(62) + ' -> ' + JSON.stringify(actual) +
      (ok ? '' : '   expected ' + JSON.stringify(expected)),
  );
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

/** 一个独立的 cookie jar —— 每个账号一份，绝不共用。 */
function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  function store(r) {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }
  async function req(m, p, b) {
    const h = { 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = cookie();
    if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
    const r = await fetch(BASE + p, {
      method: m,
      headers: h,
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    store(r);
    let d = null;
    try { d = await r.json(); } catch { /* 空响应/HTML 没有 JSON */ }
    return { s: r.status, d };
  }
  return { req, jar };
}

async function login(username, password) {
  const c = makeClient();
  // CsrfCheckMiddleware 对非安全方法要求 cookie 与 header 里都有 `suda-csrf-token`。
  // 该 cookie **只在页面路由上**下发（server/common/http/request-paths.ts 的
  // isCsrfTokenPath），GET /api/health 不会带上它 —— 我第一次就是拿 /api/health
  // 去预热，于是所有登录都拿到 403「csrf token not found in cookie」，
  // 看起来像密码错。必须 GET /。
  await c.req('GET', '/');
  const r = await c.req('POST', '/api/auth/login', { username, password });
  if (r.s !== 201 && r.s !== 200) {
    throw new Error(`login failed for ${username}: HTTP ${r.s} ${JSON.stringify(r.d)}`);
  }
  return c;
}

/** 把树拍平成 code 列表，便于精确比对。 */
function flatten(nodes, out = []) {
  for (const n of nodes) {
    out.push(n.code);
    flatten(n.children ?? [], out);
  }
  return out;
}

function findByCode(nodes, code) {
  for (const n of nodes) {
    if (n.code === code) return n;
    const hit = findByCode(n.children ?? [], code);
    if (hit) return hit;
  }
  return null;
}

// 门禁（scripts/verify-all.sh）用的是 AUTHZ_TEST_DB，单独跑时习惯用 DATABASE_URL，
// 两个都接受，避免「在门禁里能过、单独跑却因为拿不到库而清理失败」这种不一致。
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;

const PROBE_PW = process.env.SCOPE_PROBE_PASSWORD || 'ScopeProbe!2026';
const PRINCIPAL_PW = process.env.SEQ_PROBE_PASSWORD || 'SeqProbe!2026x';

console.log(`\ndirectories 接口验证 @ ${BASE}\n${'='.repeat(78)}\n`);

// ---------------------------------------------------------------------------
// 0. 未登录
// ---------------------------------------------------------------------------
{
  console.log('0) 未登录的调用');
  const anon = makeClient();
  const r = await anon.req('GET', '/api/directories/tree');
  check('未登录 → 401', r.s, 401);
}

// ---------------------------------------------------------------------------
// 1. 平台管理员：整棵树
// ---------------------------------------------------------------------------
const principal = await login('seq_principal', PRINCIPAL_PW);
let adminTree = null;
{
  console.log('\n1) principal（平台管理员）看到完整目录');
  const r = await principal.req('GET', '/api/directories/tree');
  check('HTTP 200', r.s, 200);
  adminTree = r.d;
  check('两个根（教育教学 + 教师成长）', (r.d?.roots ?? []).length, 2);
  check('根 code 依次为 root:edu / root:growth',
    (r.d?.roots ?? []).map((x) => x.code), ['root:edu', 'root:growth']);

  const codes = flatten(r.d?.roots ?? []);
  check('节点总数 = 69', codes.length, 69);
  check('含教师成长 L1/L2/L3',
    ['growth:l1', 'growth:l2', 'growth:l3'].every((c) => codes.includes(c)), true);
  check('allowCustomFolders 叶节点 = 16', r.d?.customFolderLeafCount, 16);
  check('管理员没有任何被隐藏的科目', (r.d?.hiddenSubjectCodes ?? []).length, 0);

  // PDF 要求的科目全部在树里
  for (const code of [
    'prek:virtue', 'prek:montessori', 'prek:pe', 'prek:english',
    'k:chinese', 'k:english', 'k:pe',
    'k:chinese:reading', 'k:chinese:poetry', 'k:chinese:stem', 'k:chinese:arts',
  ]) {
    check(`PDF 科目在树里：${code}`, codes.includes(code), true);
  }

  // 资源数量必须是真数字（不是 0 —— 0 会被渲染成「暂无资源」）
  const virtue = findByCode(r.d?.roots ?? [], 'prek:virtue');
  check('prek:virtue 有 resourceCount 字段', typeof virtue?.resourceCount, 'number');
  const chinese = findByCode(r.d?.roots ?? [], 'k:chinese');
  console.log(`       （参考：prek:virtue=${virtue?.resourceCount}  k:chinese=${chinese?.resourceCount}）`);

  // 规范 token 映射：prek:pe 必须是 physical_education，而不是 code 本身
  const pe = findByCode(r.d?.roots ?? [], 'prek:pe');
  check('prek:pe 的规范 token = physical_education', pe?.subject, 'physical_education');
  const arts = findByCode(r.d?.roots ?? [], 'k:chinese:arts');
  check('PDF 新增的 k:chinese:arts 规范 token = null（如实反映缺口）', arts?.subject, null);
  const reading = findByCode(r.d?.roots ?? [], 'k:chinese:reading');
  check('k:chinese:reading 规范 token = picture_books', reading?.subject, 'picture_books');
}

// ---------------------------------------------------------------------------
// 2. prek_head：只看得到 Pre-K
// ---------------------------------------------------------------------------
{
  console.log('\n2) prek_head 只看得到 Pre-K 那一支');
  const c = await login('scope_prek_head', PROBE_PW);
  const r = await c.req('GET', '/api/directories/tree');
  check('HTTP 200', r.s, 200);
  const codes = flatten(r.d?.roots ?? []);
  check('只有教育教学生效（教师成长仍可见）',
    (r.d?.roots ?? []).map((x) => x.code), ['root:edu', 'root:growth']);
  check('有 prek:montessori', codes.includes('prek:montessori'), true);
  check('有 PDF 新增的 prek:english（整班型可见即可见）', codes.includes('prek:english'), true);
  check('没有 k:chinese', codes.includes('k:chinese'), false);
  check('没有 k:english', codes.includes('k:english'), false);
  check('K 的科目被记录为隐藏', (r.d?.hiddenSubjectCodes ?? []).some((x) => x.startsWith('k:')), true);
}

// ---------------------------------------------------------------------------
// 3. k_head：只看得到 K
// ---------------------------------------------------------------------------
{
  console.log('\n3) k_head 只看得到 K 那一支');
  const c = await login('scope_k_head', PROBE_PW);
  const r = await c.req('GET', '/api/directories/tree');
  check('HTTP 200', r.s, 200);
  const codes = flatten(r.d?.roots ?? []);
  check('有 k:chinese:arts', codes.includes('k:chinese:arts'), true);
  check('有 k:chinese:reading', codes.includes('k:chinese:reading'), true);
  check('没有 prek:montessori', codes.includes('prek:montessori'), false);
  check('没有 prek:english', codes.includes('prek:english'), false);
}

// ---------------------------------------------------------------------------
// 4. pe_specialist：只有体能，两个班型各一个
// ---------------------------------------------------------------------------
{
  console.log('\n4) pe_specialist 只看到体能（跨班型的单科目授权）');
  const c = await login('scope_pe_specialist', PROBE_PW);
  const r = await c.req('GET', '/api/directories/tree');
  check('HTTP 200', r.s, 200);
  const codes = flatten(r.d?.roots ?? []);
  check('有 prek:pe', codes.includes('prek:pe'), true);
  check('有 k:pe', codes.includes('k:pe'), true);
  check('没有 prek:virtue', codes.includes('prek:virtue'), false);
  check('没有 k:chinese', codes.includes('k:chinese'), false);
  check('两个根都还在（各有可见子节点）',
    (r.d?.roots ?? []).map((x) => x.code), ['root:edu', 'root:growth']);
  // 体能科目下的 4 个资料夹必须跟着出来
  const peFolders = findByCode(r.d?.roots ?? [], 'prek:pe');
  check('prek:pe 下 4 个资料夹', (peFolders?.children ?? []).length, 4);
  check('prek:pe_lesson 允许自建文件夹',
    findByCode(r.d?.roots ?? [], 'prek:pe_lesson')?.allowCustomFolders, true);
  check('prek:pe_outline 不允许自建文件夹',
    findByCode(r.d?.roots ?? [], 'prek:pe_outline')?.allowCustomFolders, false);
}

// ---------------------------------------------------------------------------
// 5. prek_assistant：看得到结构（与 CurriculumService 同一语义）
// ---------------------------------------------------------------------------
{
  console.log('\n5) prek_assistant 看得到 Pre-K 结构');
  const c = await login('scope_prek_assistant', PROBE_PW);
  const r = await c.req('GET', '/api/directories/tree');
  check('HTTP 200', r.s, 200);
  const codes = flatten(r.d?.roots ?? []);
  check('有 prek 的科目', codes.includes('prek:virtue'), true);
  check('没有 K 的科目', codes.includes('k:chinese'), false);
}

// ---------------------------------------------------------------------------
// 6. visitor：没有 curriculum.view，必须被挡在接口之外
// ---------------------------------------------------------------------------
let visitorId = null;
{
  console.log('\n6) visitor 被 curriculum.view 挡住（临时建号，用完即删）');
  // 幂等：上一次运行如果因为清理失败留下了同名账号，这里先清掉，
  // 否则会拿到 409「用户名已存在」，然后被误报成「创建失败」。
  if (DB_URL) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1 });
    const stale = await sql`DELETE FROM teachers WHERE username = 'dirprobe_visitor'`;
    await sql.end();
    if (stale.count > 0) console.log(`      （清理了上次遗留的同名账号 ${stale.count} 个）`);
  }
  const created = await principal.req('POST', '/api/teachers', {
    username: 'dirprobe_visitor',
    name: '目录探针访客',
    roles: ['visitor'],
    status: 'active',
  });
  if (created.s === 201 || created.s === 200) {
    visitorId = created.d?.id ?? created.d?.teacher?.id ?? null;
    const tempPw = created.d?.temporaryPassword ?? created.d?.tempPassword ?? null;
    check('visitor 账号创建成功', true, true);
    if (tempPw) {
      const vc = await login('dirprobe_visitor', tempPw);
      const r = await vc.req('GET', '/api/directories/tree');
      check('visitor GET /api/directories/tree → 403', r.s, 403);
    } else {
      console.log('      \x1b[33mSKIP\x1b[0m  创建接口未返回临时密码，无法登录 visitor 断言 403');
    }
  } else {
    check('visitor 账号创建成功', `HTTP ${created.s} ${JSON.stringify(created.d)}`, '201');
  }
}

// ---------------------------------------------------------------------------
// 7. 单节点接口 + 失败关闭
// ---------------------------------------------------------------------------
{
  console.log('\n7) 单节点接口 /api/directories/node');
  const ok = await principal.req('GET', '/api/directories/node?code=prek:virtue');
  check('principal 取 prek:virtue → 200', ok.s, 200);
  check('prek:virtue 下 4 个资料夹', (ok.d?.children ?? []).length, 4);

  const missing = await principal.req('GET', '/api/directories/node?code=does:not:exist');
  check('不存在的 code → 404', missing.s, 404);

  const peClient = await login('scope_pe_specialist', PROBE_PW);
  const forbidden = await peClient.req('GET', '/api/directories/node?code=prek:virtue');
  check('pe_specialist 取 prek:virtue → 404（与不存在同一个响应，不泄露结构）',
    forbidden.s, 404);
  const allowed = await peClient.req('GET', '/api/directories/node?code=prek:pe');
  check('pe_specialist 取 prek:pe → 200', allowed.s, 200);
  check('prek:pe 的 subject = physical_education', allowed.d?.subject, 'physical_education');
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------
if (visitorId) {
  const del = await principal.req('DELETE', `/api/teachers/${visitorId}`);
  if (del.s === 200 || del.s === 204) {
    console.log(`\n清理：删除临时 visitor 账号 → HTTP ${del.s}`);
  } else {
    // 这条路径在本机测试库上会 500（42501 insufficient_privilege，见服务端日志），
    // 与本次改动无关，但也不能因为清理失败就留着脏账号 —— 所以回退到直接 SQL。
    console.log(`\n\x1b[33m注意\x1b[0m  DELETE /api/teachers/:id 返回 HTTP ${del.s}；改用 SQL 清理`);
    if (DB_URL) {
      const postgres = (await import('postgres')).default;
      const sql = postgres(DB_URL, { max: 1 });
      const n = await sql`DELETE FROM teachers WHERE username = 'dirprobe_visitor'`;
      await sql.end();
      console.log(`      SQL 清理完成（影响 ${n.count} 行）`);
    } else {
      console.log('      \x1b[31m未能清理 dirprobe_visitor —— 请手动删除\x1b[0m（未设置 DATABASE_URL / AUTHZ_TEST_DB）');
    }
  }
}

console.log('\n' + '='.repeat(78));
console.log(`目录树接口验证：${pass} 通过 / ${fail} 失败   pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  * ' + f);
  process.exit(1);
}
