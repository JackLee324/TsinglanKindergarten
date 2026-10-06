import { folderIdFor } from '../tests/helpers/directory-fixture.mjs';
/**
 * scripts/verify-curriculum-scope.mjs —— §2 与 §3 的**行为**验证（不是结构断言）。
 *
 *   DATABASE_URL=… node scripts/verify-curriculum-scope.mjs
 *
 * ===========================================================================
 * 为什么需要这个套件（前一版的证据不够）
 * ===========================================================================
 * §2 要求「Pre-K English → prek_head、K Chinese Arts → k_head」。
 * 此前对这条的证据只有两类：
 *   1. **结构**：目录树里确实有 `prek:english` / `k:chinese:arts` 两个节点，
 *      且 `subject` token 正确（`verify-directories.mjs`）；
 *   2. **推断**：`prek_head` 的角色 scope 是**整个 prek 班型**，
 *      而 `k_head` 是整个 k 班型，所以新科目"自动被覆盖"。
 *
 * 第 2 条是**推理**，不是测量。推理错在权限系统里是灾难性的：
 * 一旦某个 head 的范围其实被写成了"逐个科目的白名单"，新科目就落到**无人可见**，
 * 而结构断言照样全绿 —— 节点在树里、token 也对，只是**没有任何角色能动它**。
 *
 * 所以这里改成让两个 head 账号**真的去动那两个科目**：
 *   能建资源、能取直传地址、能按目录查到 → 算归属正确；
 *   并且必须**越不过去**（prek_head 动不了 k，k_head 动不了 prek），
 *   否则"归属"就退化成"所有人都有权"，那同样不是要求的意思。
 *
 * §3 的「resource.view/create、storage.upload 受 directory/program/subject scope 约束」
 * 也在这里用**同一个账号**的行为来验：不再是"权限目录里标了 dataScoped"。
 *
 * 前提：服务进程**不配对象存储**（`upload-url` 会 503 fail closed）。
 * 那不影响本套件 —— 它要证明的是"能不能拿到直传地址"这件事上的**授权判定**，
 * 503（未配置）与 403（无权限）是两条不同的路径：前者说明**授权已通过**、
 * 只是后端没配；后者才是被 scope 挡住。断言里把两者分开，不混为一谈。
 */

const BASE = process.env.DIRECTORY_BASE || process.env.MFA_BASE || 'http://127.0.0.1:3200';
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
const skip = (label, reason) => { console.log(`  \x1b[33mSKIP\x1b[0m  ${label}  -> ${reason}`); SKIPPED++; };

function makeClient() {
  const jar = {};
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
  const login = async (u, p) => { await req('GET', '/'); return req('POST', '/api/auth/login', { username: u, password: p }); };
  return { req, login };
}

const stamp = Date.now().toString().slice(-6);
/** 本套件建的所有资源，跑完硬删。 */
const createdResourceIds = [];
let run = null;

const flatten = (nodes) => {
  const out = [];
  const walk = (ns) => { for (const n of ns ?? []) { out.push(n); walk(n.children); } };
  walk(nodes);
  return out;
};

try {
  const { startVerificationRun } = await import('../tests/helpers/reset-fixtures.mjs');
  run = await startVerificationRun(DB_URL, { suite: 'curscope', accounts: ['head', 'khead', 'readonly'] });
  const prek = run.account('head');
  const kHead = run.account('khead');
  const ro = run.account('readonly');

  console.log(`\n=== §2/§3 科目归属与范围：行为验证（${BASE}）===\n`);

  const prekC = makeClient();
  const kC = makeClient();
  const roC = makeClient();

  const lp = await prekC.login(prek.username, prek.password);
  if (lp.s !== 201) { bad('prek_head 登录', `HTTP ${lp.s}`); process.exit(1); }
  const lk = await kC.login(kHead.username, kHead.password);
  if (lk.s !== 201) { bad('k_head 登录', `HTTP ${lk.s}`); process.exit(1); }
  const lro = await roC.login(ro.username, ro.password);
  if (lro.s !== 201) { bad('prek_assistant 登录', `HTTP ${lro.s}`); process.exit(1); }
  ok('三个角色账号登录成功（探针账号，跑完删除）',
    `prek_head / k_head / prek_assistant`);

  // ---- 1) 权限本身：两个 head 都该有 create + upload ----------------------
  console.log('\n1) 角色默认权限（生效权限，不是角色字面量）');
  for (const [name, c, want] of [
    ['prek_head', prekC, ['resource.create', 'storage.upload', 'resource.view']],
    ['k_head', kC, ['resource.create', 'storage.upload', 'resource.view']],
  ]) {
    const eff = await c.req('GET', '/api/auth/me/permissions');
    const perms = eff.d?.permissions ?? [];
    const missing = want.filter((w) => !perms.includes(w));
    if (eff.s === 200 && missing.length === 0) ok(`${name} 持有 ${want.join(' / ')}`, `${perms.length} 项`);
    else bad(`${name} 持有 ${want.join(' / ')}`, `HTTP ${eff.s} 缺 ${JSON.stringify(missing)}`);
  }

  // 只读配班：有 resource.view、**没有** resource.create。它是下面"拒绝"分支的对照 ——
  // 没有它，"403" 可能只是因为这个账号什么都干不了，而不是 scope 在起作用。
  const roEff = await roC.req('GET', '/api/auth/me/permissions');
  const roPerms = roEff.d?.permissions ?? [];
  if (roPerms.includes('resource.view') && !roPerms.includes('resource.create')) {
    ok('对照账号 prek_assistant：有 view、无 create（拒绝分支的对照）');
  } else {
    bad('对照账号 prek_assistant：有 view、无 create',
      `view=${roPerms.includes('resource.view')} create=${roPerms.includes('resource.create')}`);
  }

  // ---- 2) 目录树可见性：新科目必须在**对应 head** 的树里 ------------------
  console.log('\n2) 新科目出现在对应 head 的目录树里（否则他连选都选不到）');
  const treeOf = async (c) => {
    const r = await c.req('GET', '/api/directories/tree');
    return { status: r.s, codes: flatten(r.d?.roots ?? []).map((n) => n.code) };
  };
  const prekTree = await treeOf(prekC);
  const kTree = await treeOf(kC);
  if (prekTree.codes.includes('prek:english')) ok('prek_head 的树里有 prek:english');
  else bad('prek_head 的树里有 prek:english', `HTTP ${prekTree.status}，共 ${prekTree.codes.length} 个节点`);
  if (kTree.codes.includes('k:chinese:arts')) ok('k_head 的树里有 k:chinese:arts');
  else bad('k_head 的树里有 k:chinese:arts', `HTTP ${kTree.status}，共 ${kTree.codes.length} 个节点`);

  // ---- 3) 真的能建：§2 的核心断言 ----------------------------------------
  console.log('\n3) 真的能在这两个科目上建资源');
  const mkRes = async (c, body) => {
    const r = await c.req('POST', '/api/resources', {
      status: 'draft', semester: 'S1', week: 1, ...body,
    });
    const id = r.d?.id ?? r.d?.resource?.id ?? null;
    if (id) createdResourceIds.push(id);
    return { s: r.s, id, err: String(r.d?.error?.message ?? '').slice(0, 60) };
  };
  // §8：必须带 directoryId，且资料夹要与资源自身科目一致 —— 用 english 的资料夹。
  // 这一条本身就在验证「归属正确」：目录选错会被服务端 400 拒绝。
  const pDir = await folderIdFor(prekC, { program: 'prek', subject: 'english', suffix: 'resource' });
  const pRes = await mkRes(prekC, {
    title: `范围探针 prek-english ${stamp}`, program: 'prek', subject: 'english',
    directoryId: pDir,
  });
  if (pRes.s === 201 && pRes.id) ok('prek_head 在 prek/english 建资源 → 201（§2 归属成立）');
  else bad('prek_head 在 prek/english 建资源', `HTTP ${pRes.s} ${pRes.err}`);

  const kDir = await folderIdFor(kC, { program: 'k', subject: 'chinese:arts', suffix: 'resource' });
  const kRes = await mkRes(kC, {
    title: `范围探针 k-arts ${stamp}`, program: 'k', subject: 'chinese', subSubject: 'arts',
    directoryId: kDir,
  });
  if (kRes.s === 201 && kRes.id) ok('k_head 在 k/chinese/arts 建资源 → 201（§2 归属成立）');
  else bad('k_head 在 k/chinese/arts 建资源', `HTTP ${kRes.s} ${kRes.err}`);

  // ---- 4) 越不过去：归属 ≠ 所有人都有权 -----------------------------------
  console.log('\n4) 越界必须被拒（否则"归属"退化成"所有人都有权"）');
  // 越界探针也必须带一个**合法**的 directoryId —— 否则它会被"缺 directoryId"的
  // 400 拦下，于是"越界被拒"这条断言会**因为错误的理由通过**（400 而非 403）。
  // 这正是"断言通过但没验证到目标行为"的典型，必须避免。
  const cross1 = await mkRes(prekC, {
    title: `越界探针 prek→k ${stamp}`, program: 'k', subject: 'chinese', subSubject: 'arts',
    directoryId: kDir,
  });
  if (cross1.s === 403) ok('prek_head 在 k/chinese/arts 建资源被拒 → 403');
  else bad('prek_head 在 k/chinese/arts 建资源被拒', `HTTP ${cross1.s}（期望 403）`);

  const cross2 = await mkRes(kC, {
    title: `越界探针 k→prek ${stamp}`, program: 'prek', subject: 'english',
    directoryId: pDir,
  });
  if (cross2.s === 403) ok('k_head 在 prek/english 建资源被拒 → 403');
  else bad('k_head 在 prek/english 建资源被拒', `HTTP ${cross2.s}（期望 403）`);

  const roDir = await folderIdFor(roC, { program: 'prek', subject: 'virtue', suffix: 'resource' });
  const roCreate = await mkRes(roC, {
    title: `对照探针 readonly ${stamp}`, program: 'prek', subject: 'virtue',
    directoryId: roDir,
  });
  if (roCreate.s === 403) ok('prek_assistant 建资源被拒 → 403（对照：拒绝来自权限，不是 scope 巧合）');
  else bad('prek_assistant 建资源被拒', `HTTP ${roCreate.s}（期望 403）`);

  // ---- 5) storage.upload 也受 scope 约束 ---------------------------------
  // 关键区分：**403 = 被授权挡住**（scope 生效）；**503 = 授权已通过、只是没配存储**。
  // 两者混为一谈的话，"未配置存储"会把一条越权也变成"看起来通过"。
  console.log('\n5) storage.upload 同时受 scope 约束（403 与 503 必须分开看）');
  if (pRes.id) {
    const own = await prekC.req('POST', `/api/resources/${pRes.id}/upload-url`, { fileName: 'scope-probe.pdf' });
    if (own.s === 201 || own.s === 200) ok('prek_head 对自己的资源取直传地址 → 2xx（配了存储）');
    else if (own.s === 503) ok('prek_head 对自己的资源取直传地址 → 503（授权已通过，仅未配存储）');
    else bad('prek_head 对自己的资源取直传地址', `HTTP ${own.s} ${String(own.d?.error?.message ?? '').slice(0, 70)}`);
  } else {
    skip('prek_head 取直传地址', '前置的建资源未通过');
  }

  if (kRes.id) {
    const foreign = await prekC.req('POST', `/api/resources/${kRes.id}/upload-url`, { fileName: 'scope-probe.pdf' });
    // 越界资源对 prek_head 应当**不可见**，所以这里期望 404（不区分"不存在"与"无权限"）
    // 或 403；两者都表明拿不到直传地址。**唯独 2xx 不可接受**。
    if (foreign.s === 403 || foreign.s === 404) ok('prek_head 对 k 科目资源取直传地址被拒（403/404）', `HTTP ${foreign.s}`);
    else bad('prek_head 对 k 科目资源取直传地址被拒', `HTTP ${foreign.s} —— 越权拿到了直传地址`);
  } else {
    skip('prek_head 越界取直传地址', '前置的 k 资源未建成');
  }

  // ---- 6) 目录维度的 scope：?directory= 不能成为越权入口 -------------------
  console.log('\n6) 按目录查询也受 scope 约束（?directory= 不是越权入口）');
  const prekByDir = await prekC.req('GET', '/api/resources?directory=prek%3Aenglish&pageSize=20');
  if (prekByDir.s === 200) ok('prek_head 按 prek:english 查资源 → 200', `total=${prekByDir.d?.total}`);
  else bad('prek_head 按 prek:english 查资源', `HTTP ${prekByDir.s}`);

  const kByDirForPrek = await kC.req('GET', '/api/resources?directory=prek%3Aenglish&pageSize=20');
  const leaked = ((kByDirForPrek.d ?? {}).items ?? []).filter((r) => r.program === 'prek');
  if (kByDirForPrek.s === 200 && leaked.length === 0) {
    ok('k_head 用 prek:english 作为目录过滤拿不到任何 prek 资源', `total=${kByDirForPrek.d?.total ?? 0}`);
  } else {
    bad('k_head 用 prek:english 作为目录过滤拿不到任何 prek 资源',
      `HTTP ${kByDirForPrek.s} 泄漏 ${leaked.length} 条`);
  }

  // ---- 7) §2 的"不新增 Specialist 角色" ----------------------------------
  console.log('\n7) 没有为了新科目录新增 Specialist 角色');
  // 角色目录是编译期常量，读**构建产物**（dist/shared/rbac.js），
  // 不去 import TS 源码 —— 那样要 Node 直接解析 .ts，会带上无关的告警噪音。
  const { createRequire } = await import('node:module');
  const req2 = createRequire(process.cwd() + '/');
  const rbac = req2(process.cwd() + '/dist/shared/rbac.js');
  const roleCodes = rbac.ROLE_CODES;
  if (!Array.isArray(roleCodes) || roleCodes.length === 0) {
    throw new Error('读不到 ROLE_CODES —— 先确认 dist/shared/rbac.js 已构建（npm run build）');
  }
  const specialists = roleCodes.filter((c) => String(c).includes('specialist'));
  if (specialists.length === 1 && specialists[0] === 'pe_specialist') {
    ok('角色目录里唯一的 specialist 仍是 pe_specialist（未新增 Specialist 角色）', roleCodes.join(','));
  } else {
    bad('角色目录里唯一的 specialist 仍是 pe_specialist', JSON.stringify(roleCodes));
  }
  const allRoles = JSON.stringify(roleCodes);
  if (!/english_specialist|arts_specialist|chinese_arts/.test(allRoles)) {
    ok('没有为 prek:english / k:chinese:arts 引入任何专属角色');
  } else {
    bad('没有为 prek:english / k:chinese:arts 引入任何专属角色', allRoles);
  }
} catch (error) {
  console.error('\n  ABORTED — ' + (error?.stack || String(error)));
  FAILED += 1;
} finally {
  // 清理：先硬删资源，再删账号（账号由 reset-fixtures 负责，但它不认 resources）。
  try {
    if (run && createdResourceIds.length > 0) {
      const postgres = (await import('postgres')).default;
      const sql = postgres(DB_URL, { max: 1 });
      for (const id of createdResourceIds) {
        const n = await sql`DELETE FROM resources WHERE id = ${id}`;
        console.log(`清理：硬删除探针资源 ${id} → ${n.count} 行`);
      }
      const left = await sql`SELECT count(*)::int AS n FROM resources WHERE title LIKE ${'%范围探针%' + stamp} OR title LIKE ${'%越界探针%' + stamp} OR title LIKE ${'%对照探针%' + stamp}`;
      console.log(`清理：关键字复查残留 ${left[0].n} 条`);
      await sql.end();
    }
    if (run) await run.cleanup();
  } catch (e) {
    console.error(`清理失败：${e?.message}`);
    FAILED += 1;
  }
  console.log('\n=== RESULT ===');
  console.log(`  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
  if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
  process.exit(FAILED ? 1 : 0);
}
