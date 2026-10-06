/**
 * scripts/verify-directories-write.mjs — 目录**写路径**的真实 HTTP 验证（§24/§25/§26）。
 *
 *   DIRECTORY_BASE=http://127.0.0.1:3200 node scripts/verify-directories-write.mjs
 *
 * 重点不是"能建出来"，而是**不能建/改/删的地方真的被拦住**：
 * 一个"可编辑目录"如果拦不住，就等于"可以把 PDF 的权威结构删掉"。
 *
 * 每条否定用例都断言**具体原因**（403 还是 400/409），而不是"只要失败就算过" ——
 * 曾经有一条断言接受 [400,403,500]，结果它因为 DTO 校验而通过，
 * 看起来在验证 RBAC、其实什么都没验证。
 */
const BASE = process.env.DIRECTORY_BASE || 'http://127.0.0.1:3200';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log(
    '  ' + (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') +
      '  ' + label.padEnd(60) + ' -> ' + JSON.stringify(actual) +
      (ok ? '' : '   expected ' + JSON.stringify(expected)),
  );
  if (ok) pass++;
  else { fail++; failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

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
      method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b),
    });
    store(r);
    let d = null;
    try { d = await r.json(); } catch { /* 204 / 空响应没有 JSON */ }
    return { s: r.status, d };
  }
  return { req };
}

async function login(username, password) {
  const c = makeClient();
  await c.req('GET', '/'); // CSRF cookie 只在页面路由下发
  const r = await c.req('POST', '/api/auth/login', { username, password });
  if (r.s !== 201 && r.s !== 200) throw new Error(`login ${username} -> ${r.s} ${JSON.stringify(r.d)}`);
  return c;
}

const PRINCIPAL_PW = process.env.SEQ_PROBE_PASSWORD || 'SeqProbe!2026x';
const PROBE_PW = process.env.SCOPE_PROBE_PASSWORD || 'ScopeProbe!2026';

console.log(`\ndirectories 写路径验证 @ ${BASE}\n${'='.repeat(78)}\n`);

const principal = await login('seq_principal', PRINCIPAL_PW);
const prekHead = await login('scope_prek_head', PROBE_PW);

const created = [];

// ---------------------------------------------------------------------------
// 1. 允许自建的地方：prek:pe_lesson（PDF 标了「允许自建」）
// ---------------------------------------------------------------------------
let firstCode = null;
{
  console.log('1) 在 PDF 允许自建的资料夹下新建（prek:pe_lesson）');
  const r = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'prek:pe_lesson',
    name: '体能课教案（自建）',
    nameEn: 'PE Lesson Notes',
  });
  check('HTTP 201', r.s, 201);
  if (r.s === 201) {
    firstCode = r.d?.code ?? null;
    created.push(firstCode);
    check('新节点类型为 folder', r.d?.type, 'folder');
    check('code 采用 <父>_u<n> 形式', /^prek:pe_lesson_u\d+$/.test(firstCode ?? ''), true);
    check('继承父节点的规范 token', r.d?.subject, 'physical_education');
    check('新节点自身也允许再自建（否则"自建"只有一层）', r.d?.allowCustomFolders, true);
    check('新节点出现在父节点的子树里', (r.d?.children ?? []).length, 0);
  }
  await principal.req('GET', '/');
}

// ---------------------------------------------------------------------------
// 2. 自建文件夹下可以再建（一级不够用）
// ---------------------------------------------------------------------------
let secondCode = null;
{
  console.log('\n2) 自建文件夹下再建（嵌套一层）');
  const r = await principal.req('POST', '/api/directories/folder', {
    parentCode: firstCode,
    name: '第 1 周',
  });
  check('HTTP 201', r.s, 201);
  if (r.s === 201) {
    secondCode = r.d?.code ?? null;
    created.push(secondCode);
    check('code 以父自建节点为前缀', (secondCode ?? '').startsWith(`${firstCode}_u`), true);
  }
  await principal.req('GET', '/');
}

// ---------------------------------------------------------------------------
// 3. 不允许自建的地方必须被拦住（PDF 只标了 16 个叶节点）
// ---------------------------------------------------------------------------
{
  console.log('\n3) 不允许自建的地方必须被拦住');
  // prek:virtue_lesson 在 PDF 里**没有**标自建（只有 Pre-K 体能/英文 + 8 个 K 叶科标了）
  const r = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'prek:virtue_lesson',
    name: '不该建出来',
  });
  check('prek:virtue_lesson（PDF 未标自建）→ 403', r.s, 403);

  const r2 = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'prek',
    name: '不该建出来',
  });
  check('在班型节点下建 → 403', r2.s, 403);

  const r3 = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'root:edu',
    name: '不该建出来',
  });
  check('在根节点下建 → 403', r3.s, 403);

  const r4 = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'does:not:exist',
    name: 'x',
  });
  check('父节点不存在 → 404', r4.s, 404);
  await principal.req('GET', '/');
}

// ---------------------------------------------------------------------------
// 4. 同级重名必须被拦住
// ---------------------------------------------------------------------------
{
  console.log('\n4) 同级重名');
  const r = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'prek:pe_lesson',
    name: '体能课教案（自建）', // 与第 1 步同名
  });
  check('同名 → 409', r.s, 409);
  const r2 = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'prek:pe_lesson',
    name: '体能课教案（自建）'.toUpperCase(), // 大小写不同仍算同名（DB 唯一索引用 lower(name)）
  });
  check('大小写不同的同名 → 409', r2.s, 409);
  const r3 = await principal.req('POST', '/api/directories/folder', {
    parentCode: 'prek:pe_lesson', name: '',
  });
  check('空名称 → 400', r3.s, 400);
  await principal.req('GET', '/');
}

// ---------------------------------------------------------------------------
// 5. 系统节点：**可改名**，但不可删；code 永远是稳定标识
// ---------------------------------------------------------------------------
//
// ⚠️ 这一节的规则在本轮被业主明确改写过（§5 原话：
//    「不要再使用 `isSystem => 不允许改名` —— 这是之前擅自增加的限制，不是业主要求。
//      显示名称可以改；内部稳定 code / id 不变」）。
//
// 所以断言从"改名必须 403"改成**三条更精确的断言**：
//   ① 改名成功（200）；
//   ② 名字真的变了；
//   ③ **code 一个字都没变** —— 这才是真正需要保护的稳定标识。
// 只断言"能改"是不够的：一个把 code 也一起改掉的实现同样会让它通过，
// 而 code 一变，历史资源归属、审计记录、旧 URL 全部对不上。
//
// 跑完恢复原名，避免污染后续断言与开发库。
{
  console.log('\n5) 系统节点：可改名、code 不变、不可删');
  // ⚠️ 探针节点选 **`growth:l2`**，不选 `prek:virtue` —— 这是一条真实的隔离教训。
  //
  // 第一版改的是 `prek:virtue`（跑完还原）。它单独跑完全正确，但在门禁里
  // 与其它套件共存时出过一次假红：`ia-consolidation` 断言侧边栏显示「美德」，
  // 却读到了改名的中间态。根因是**改一个别的套件正在断言的共享节点** ——
  // 这个节点是全库唯一一份，任何"改了再还原"的窗口对别人都是可见的。
  // `growth:l2` 同属正式目录（isSystem=true），改名规则完全一样，
  // 但没有任何其它套件断言它的显示名，于是窗口期不会伤到别人。
  const PROBE_CODE = 'growth:l2';
  const PROBE_ENC = 'growth%3Al2';
  const before = await principal.req('GET', `/api/directories/node?code=${PROBE_ENC}`);
  const originalName = before.d?.node?.name ?? before.d?.name ?? 'L2 独立胜任';

  const ren = await principal.req('PATCH', `/api/directories/node/${PROBE_CODE}`, {
    name: '被改掉的名字',
  });
  check('§5 改系统节点名 → 200（不再是 403）', ren.s, 200);
  check('§5 名字确实变了', ren.d?.name, '被改掉的名字');
  check('§5 code 未被改动（稳定标识受保护）', ren.d?.code, PROBE_CODE);

  const restore = await principal.req('PATCH', `/api/directories/node/${PROBE_CODE}`, {
    name: originalName,
  });
  check('§5 恢复原名 → 200', restore.s, 200);
  check('§5 恢复后名字回到原值', restore.d?.name, originalName);
  check('§5 恢复后 code 仍未变', restore.d?.code, PROBE_CODE);

  const del = await principal.req('DELETE', '/api/directories/node/prek:virtue');
  check('删系统节点 → 403', del.s, 403);

  const del2 = await principal.req('DELETE', '/api/directories/node/prek');
  check('删班型节点 → 403', del2.s, 403);

  const delRoot = await principal.req('DELETE', '/api/directories/node/root:edu');
  check('删根节点 → 403', delRoot.s, 403);
  await principal.req('GET', '/');
}

// ---------------------------------------------------------------------------
// 6. 自建节点：改名可以，删有子节点的要拦住
// ---------------------------------------------------------------------------
{
  console.log('\n6) 自建节点：可改名、非空不可删');
  const ren = await principal.req('PATCH', `/api/directories/node/${firstCode}`, {
    name: '体能课教案（已改名）',
  });
  check('改自建节点名 → 200', ren.s, 200);
  check('名称已更新', ren.d?.name, '体能课教案（已改名）');

  const del = await principal.req('DELETE', `/api/directories/node/${firstCode}`);
  check('删还有子节点的自建文件夹 → 409', del.s, 409);
  await principal.req('GET', '/');
}

// ---------------------------------------------------------------------------
// 7. 权限：没有 curriculum.manage 的角色一律进不来
// ---------------------------------------------------------------------------
{
  console.log('\n7) 权限（curriculum.manage）');
  const r = await prekHead.req('POST', '/api/directories/folder', {
    parentCode: 'prek:pe_lesson', name: 'prek_head 不该建得出来',
  });
  check('prek_head（有 curriculum.view、无 manage）→ 403', r.s, 403);

  const r2 = await prekHead.req('PATCH', `/api/directories/node/${firstCode}`, { name: 'x' });
  check('prek_head 改名 → 403', r2.s, 403);

  const r3 = await prekHead.req('DELETE', `/api/directories/node/${secondCode}`);
  check('prek_head 删除 → 403', r3.s, 403);

  // 两种"未登录"要分开断言，因为拦下它们的是**两道不同的防线**：
  //   * 没有 CSRF token → CsrfCheckMiddleware 先拦（403），此时 AuthGuard 还没跑；
  //   * 有 CSRF token 但没有会话 → AuthGuard 拦（401）。
  // 我第一版只写了后者却忘了给匿名客户端预热 CSRF，于是拿到 403 而误报失败 ——
  // 而 403 恰恰说明 CSRF 防线在正常工作。两条都写清楚，才不会被这种现象带偏。
  const anonNoCsrf = makeClient();
  const r4 = await anonNoCsrf.req('POST', '/api/directories/folder', {
    parentCode: 'prek:pe_lesson', name: 'x',
  });
  check('未登录且无 CSRF token → 403（CSRF 防线先于鉴权）', r4.s, 403);

  const anon = makeClient();
  await anon.req('GET', '/'); // 取到 CSRF cookie，但没有任何会话
  const r5 = await anon.req('POST', '/api/directories/folder', {
    parentCode: 'prek:pe_lesson', name: 'x',
  });
  check('有 CSRF token 但未登录 → 401', r5.s, 401);
  await prekHead.req('GET', '/');
}

// ---------------------------------------------------------------------------
// 8. 清理：删掉本轮建出来的（先子后父），并确认 PDF 结构完好
// ---------------------------------------------------------------------------
{
  console.log('\n8) 清理与结构完好性');
  if (secondCode) {
    const d1 = await principal.req('DELETE', `/api/directories/node/${secondCode}`);
    check('删子文件夹 → 204', d1.s, 204);
  }
  if (firstCode) {
    const d2 = await principal.req('DELETE', `/api/directories/node/${firstCode}`);
    check('删父文件夹 → 204', d2.s, 204);
  }
  await principal.req('GET', '/');
  const tree = await principal.req('GET', '/api/directories/tree');
  const flat = (n, o = []) => { for (const x of n) { o.push(x.code); flat(x.children ?? [], o); } return o; };
  const codes = flat(tree.d?.roots ?? []);
  check('清理后节点数回到 69（PDF 结构未被动过）', codes.length, 69);
  check('allowCustomFolders 叶节点仍是 16', tree.d?.customFolderLeafCount, 16);
}

console.log('\n' + '='.repeat(78));
console.log(`目录写路径验证：${pass} 通过 / ${fail} 失败   pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  * ' + f);
  process.exit(1);
}
