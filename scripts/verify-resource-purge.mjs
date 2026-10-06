import { folderIdFor } from '../tests/helpers/directory-fixture.mjs';
/**
 * scripts/verify-resource-purge.mjs —— 按需永久删除（`resource.purge`）的**行为**验证。
 *
 *   DATABASE_URL=… node scripts/verify-resource-purge.mjs
 *
 * ===========================================================================
 * 这个套件守护的是"清理"不可能变成"误删业务数据"
 * ===========================================================================
 * `POST /api/resources/:id/purge` 是本轮新加的**不可逆**写接口。它存在的理由
 * 很具体：`resource.purge` 原先只声明、从未被检查（幽灵权限），于是误传的文件
 * 只能等 30 天保留期。但这个理由**不能**成为"随便就能永久删"的借口，
 * 所以三条闸都必须被证明是活的：
 *
 *   1. `reason` 必填且够长 —— 没有理由的永久删除事后无法复核；
 *   2. **只接受已在回收站中的行** —— 正常资源必须先"删除 → 回收站"，
 *      这条路径绝不能变成绕过回收站的近道；
 *   3. 审计里必须留下"谁、何时、为什么、原 purge_after"。
 *
 * 另外还要证明**权限**这一层是真的：只有 `super_admin` 持有 `resource.purge`，
 * 所以 `curriculum_director`（有审核权、但没有 purge 权）必须被 403 挡住 ——
 * 否则"只有超管能永久删"就只是一句描述。
 */

const BASE = process.env.DIRECTORY_BASE || process.env.MFA_BASE || 'http://127.0.0.1:3200';
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;
const PW = process.env.SEQ_PROBE_PASSWORD || 'SeqProbe!2026x';

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (l, d = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); PASSED++; };
const bad = (l, d = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? '  -> ' + d : ''}`); FAILED++; };
const skip = (l, r) => { console.log(`  \x1b[33mSKIP\x1b[0m  ${l}  -> ${r}`); SKIPPED++; };

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
const TITLE = `purge 探针 ${stamp}`;
let run = null;
let resourceId = null;
let hardDeleted = false;

try {
  const { startVerificationRun } = await import('../tests/helpers/reset-fixtures.mjs');
  // 需要一个**有审核权但没有 purge 权**的账号做对照：curriculum_director。
  run = await startVerificationRun(DB_URL, { suite: 'purge', accounts: ['director'] });

  const principal = makeClient();
  const director = makeClient();
  const lp = await principal.login('seq_principal', PW);
  if (lp.s !== 201 && lp.s !== 200) { bad('principal 登录', `HTTP ${lp.s}`); throw new Error('login'); }
  const ld = await director.login(run.account('director').username, run.account('director').password);
  if (ld.s !== 201) { bad('curriculum_director 登录', `HTTP ${ld.s}`); throw new Error('login'); }
  ok('principal 与 curriculum_director 登录成功');

  console.log(`\n=== 按需永久删除（resource.purge）行为验证（${BASE}）===\n`);

  const dirAcct = run.account('director');
  const inBinList = async () => {
    const b = await principal.req('GET', '/api/resources/recycle-bin?pageSize=100');
    return ((b.d?.items ?? [])).some((r) => r.id === resourceId);
  };

  // ---- 1) 权限层：purge 只属于 super_admin，director 拿不到 ----------------
  // 先在没有权限的状态下验一次：**必须是 403**。否则"只有超管能永久删"
  // 就只是一句描述 —— 而这一层必须先被证明是活的，
  // 后面三条闸才有意义（否则它们可能只是被 403 顺带"通过"）。
  console.log('1) 权限层：purge 不是"有审核权就能做"');
  const dirEff = await director.req('GET', '/api/auth/me/permissions');
  const dirPerms = dirEff.d?.permissions ?? [];
  if (!dirPerms.includes('resource.purge')) ok('curriculum_director 默认不持有 resource.purge', `${dirPerms.length} 项`);
  else bad('curriculum_director 默认不持有 resource.purge', '它竟然持有');

  // ---- 2) 建一条草稿资源 --------------------------------------------------
  // §8：必须带 directoryId。这条探针原本用 legacy folderType 'materials'，
  // 新契约下 folderType 由服务端按目录推导 —— 目标取「教学资源」，
  // 与原来的 'materials' 属于同一类（courseware/materials → 教学资源）。
  const purgeProbeDir = await folderIdFor(principal, {
    program: 'prek', subject: 'virtue', suffix: 'resource',
  });
  const created = await principal.req('POST', '/api/resources', {
    title: TITLE, program: 'prek', subject: 'virtue', directoryId: purgeProbeDir,
    semester: 'S1', week: 1, status: 'draft',
  });
  resourceId = created.d?.id ?? created.d?.resource?.id ?? null;
  if (resourceId) ok('建探针资源（草稿，**正常状态**）', `id=${resourceId}`);
  else { bad('建探针资源', `HTTP ${created.s} ${JSON.stringify(created.d).slice(0, 160)}`); throw new Error('create'); }

  const noPerm = await director.req('POST', `/api/resources/${resourceId}/purge`, { reason: `越权尝试 ${stamp}` });
  if (noPerm.s === 403) ok('无 purge 权的账号被 403 拒绝（且此时资源连回收站都没进）', `HTTP ${noPerm.s}`);
  else bad('无 purge 权的账号被 403 拒绝', `HTTP ${noPerm.s}（期望 403）`);
  if (await principal.req('GET', `/api/resources/${resourceId}`).then((r) => r.s === 200)) {
    ok('那次 403 没有产生任何副作用（资源仍是正常状态）');
  } else {
    bad('那次 403 没有产生任何副作用', '资源状态被改了');
  }

  // ---- 3) 按账号授权：把 resource.purge 授予 director（§11）---------------
  // 接下来三条闸必须在**确实持有权限**的操作者身上验 ——
  // 否则"拒绝"可能只是权限不足，而不是闸门在起作用。
  console.log('\n2) 按账号授权 resource.purge 给 director（让下面的闸门可以被真正检验）');
  const grant = await principal.req('POST', `/api/teachers/${dirAcct.id}/permission-overrides/grant`, {
    permission: 'resource.purge',
  });
  if (grant.s === 200 || grant.s === 201) ok('principal 授予 director resource.purge', `HTTP ${grant.s}`);
  else { bad('principal 授予 director resource.purge', `HTTP ${grant.s} ${JSON.stringify(grant.d).slice(0, 140)}`); }

  // 权限变更会作废旧会话，必须重新登录（permissions_version 的作用）。
  const relogin = await director.login(dirAcct.username, dirAcct.password);
  if (relogin.s === 201) ok('director 重新登录（权限变更作废旧会话）', `HTTP ${relogin.s}`);
  else bad('director 重新登录', `HTTP ${relogin.s}`);
  const dirEff2 = await director.req('GET', '/api/auth/me/permissions');
  if ((dirEff2.d?.permissions ?? []).includes('resource.purge')) ok('director 现在持有 resource.purge');
  else bad('director 现在持有 resource.purge', JSON.stringify((dirEff2.d?.permissions ?? []).slice(0, 5)));

  // ---- 4) 闸 2：正常资源不能直接被 purge ---------------------------------
  console.log('\n3) 闸：不允许绕过回收站直接永久删除正常资源');
  const direct = await director.req('POST', `/api/resources/${resourceId}/purge`, { reason: `试图绕过回收站 ${stamp}` });
  if (direct.s === 400) {
    ok('对**未删除**的资源 purge 被 400 拒绝（权限足够，是闸门挡住的）',
      String(direct.d?.error?.message ?? '').slice(0, 44));
  } else if (direct.s === 403) {
    bad('对**未删除**的资源 purge 被 400 拒绝', 'HTTP 403 —— 这说明权限没授上，闸门其实没被验到');
  } else {
    bad('对**未删除**的资源 purge 被 400 拒绝', `HTTP ${direct.s} —— 竟然允许绕过回收站`);
  }
  if (await principal.req('GET', `/api/resources/${resourceId}`).then((r) => r.s === 200)) {
    ok('被拒之后资源仍是正常状态（拒绝是真的拒绝）');
  } else {
    bad('被拒之后资源仍是正常状态', '资源状态被改了');
  }

  // ---- 5) 闸 1：reason 必填且够长 ----------------------------------------
  console.log('\n4) 闸：reason 必填（没有理由的永久删除事后无法复核）');
  const noReason = await director.req('POST', `/api/resources/${resourceId}/purge`, {});
  if (noReason.s === 400) ok('不带 reason 被 400 拒绝', `HTTP ${noReason.s}`);
  else bad('不带 reason 被 400 拒绝', `HTTP ${noReason.s}（期望 400；403 说明权限没生效）`);
  const shortReason = await director.req('POST', `/api/resources/${resourceId}/purge`, { reason: 'x' });
  if (shortReason.s === 400) ok('reason 过短被 400 拒绝', `HTTP ${shortReason.s}`);
  else bad('reason 过短被 400 拒绝', `HTTP ${shortReason.s}（期望 400）`);

  // ---- 6) 正路：已进回收站的资源可以被 purge ------------------------------
  console.log('\n5) 正路：回收站里的资源可以被永久删除，且留下审计');
  const del = await principal.req('DELETE', `/api/resources/${resourceId}`);
  if (del.s === 200 || del.s === 204) ok('先移入回收站（软删除）', `HTTP ${del.s}`);
  else bad('先移入回收站', `HTTP ${del.s}`);

  if (await inBinList()) ok('此刻它确实在回收站里（满足 purge 的前置条件）');
  else bad('此刻它确实在回收站里', '回收站里找不到它 —— 前置条件不成立');

  const purged = await director.req('POST', `/api/resources/${resourceId}/purge`, {
    reason: `生产探针清理（${stamp}）—— 本套件自建的测试资源`,
  });
  if (purged.s === 200 || purged.s === 201) ok('purge 成功', `HTTP ${purged.s}`);
  else bad('purge 成功', `HTTP ${purged.s} ${JSON.stringify(purged.d).slice(0, 160)}`);

  // 注意：软删除之后 `GET /api/resources/:id` 本来就会 404（读取一律 activeOnly），
  // 所以"查不到"**不能**用来证明"行被永久删了"。真正的判据是：
  // ① 回收站里没有它；② 数据库里那一行确实不存在。两个都要查。
  const bin = await principal.req('GET', '/api/resources/recycle-bin?pageSize=100');
  if (!((bin.d?.items ?? [])).some((r) => r.id === resourceId)) ok('回收站里不再有它');
  else bad('回收站里不再有它', '仍在回收站');

  if (DB_URL) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1 });
    const row = await sql`SELECT id FROM resources WHERE id = ${resourceId}`;
    if (row.length === 0) ok('数据库里那一行确实不存在了（永久删除）');
    else bad('数据库里那一行确实不存在了', '行还在 —— 只从回收站列表里消失了而已');
    await sql.end();
  } else {
    skip('数据库里那一行确实不存在了', '未设置 DATABASE_URL');
  }

  // ---- 7) 闸 3：审计记录必须留下"谁/何时/为什么" -------------------------
  console.log('\n6) 闸：审计证据');
  if (!DB_URL) {
    skip('审计记录内容', '未设置 DATABASE_URL，无法直接读审计表');
  } else {
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1 });
    const rows = await sql`
      SELECT action, teacher_id, resource_id, detail, success
      FROM audit_logs
      WHERE action = 'resource_purge' AND resource_id = ${resourceId}
      ORDER BY id DESC LIMIT 5
    `;
    if (rows.length > 0) ok('写入了 resource_purge 审计记录', `${rows.length} 条`);
    else bad('写入了 resource_purge 审计记录', '一条都没有 —— 永久删除没有留痕');

    const d = String(rows[0]?.detail ?? '');
    if (d.includes('原因=') && d.includes(String(stamp))) ok('审计里带原因', d.slice(0, 72));
    else bad('审计里带原因', d.slice(0, 120));
    if (d.includes('purge_after=')) ok('审计里带原 purge_after（可复核"本可等到哪天"）', '有');
    else bad('审计里带原 purge_after', d.slice(0, 120));
    if (rows[0]?.teacher_id) ok('审计里带操作者 id', String(rows[0].teacher_id));
    else bad('审计里带操作者 id', 'null');

    // 越权那次**不应**留下 resource_purge 成功记录
    const forbidden = rows.filter((r) => r.success === true && String(r.detail ?? '').includes('越权尝试'));
    if (forbidden.length === 0) ok('越权尝试没有产生成功的 purge 审计');
    else bad('越权尝试没有产生成功的 purge 审计', JSON.stringify(forbidden).slice(0, 120));

    await sql.end();
  }

  hardDeleted = true;
} catch (error) {
  console.error('\n  ABORTED — ' + (error?.stack || String(error)));
  FAILED += 1;
} finally {
  // 兜底：只要行还在，就硬删掉（探针不该留在库里 —— 这条路径本身就是本套件在测的能力）。
  try {
    if (!hardDeleted && resourceId && DB_URL) {
      console.log('（走兜底清理路径：正向 purge 未成功，说明本套件自身有问题）');
      const postgres = (await import('postgres')).default;
      const sql = postgres(DB_URL, { max: 1 });
      const n = await sql`DELETE FROM resources WHERE id = ${resourceId}`;
      console.log(`清理（兜底）：硬删除探针资源 ${resourceId} → ${n.count} 行`);
      await sql.end();
    }
    if (run && DB_URL) {
      const postgres = (await import('postgres')).default;
      const sql = postgres(DB_URL, { max: 1 });
      const left = await sql`SELECT count(*)::int AS n FROM resources WHERE title LIKE ${'%purge 探针 ' + stamp + '%'}`;
      console.log(`清理：关键字复查残留 ${left[0].n} 条`);
      if (left[0].n > 0) FAILED += 1;
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
