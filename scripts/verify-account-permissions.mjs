/**
 * scripts/verify-account-permissions.mjs —— §11 按账号授权 + `role.assign` 的真实行为。
 *
 *   DATABASE_URL=… node scripts/verify-account-permissions.mjs
 *
 * 为什么这条非有不可：
 *   上一轮我在提交信息里写了"role.assign 已真正接管角色变更"，但**那份代码里
 *   一个地方都没有读它** —— 只是 import 了常量、加了一个没人使用的参数。
 *   类型检查不会报（未使用参数只是 warning），幽灵权限审计当时也被
 *   "import 就算消费"的误报骗过去了。也就是说：**声称的强制根本没发生**。
 *   所以这里不检查"代码里有没有相关字样"，而是构造出一个"有 account.update、
 *   但没有 role.assign"的账号，然后**真的去改角色**，看它是否被挡住。
 *
 * 这个测试之所以现在才写得出，是因为它需要按账号的**追加/禁止**能力（§11）——
 * 而 §11 此前没有任何 API 可达。两件事是互相解锁的。
 */
const BASE = process.env.DIRECTORY_BASE || process.env.MFA_BASE || 'http://127.0.0.1:3200';
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;
const PRINCIPAL_PW = process.env.SEQ_PROBE_PASSWORD || 'SeqProbe!2026x';

let pass = 0, fail = 0; const failures = [];
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + '  ' +
    label.padEnd(62) + ' -> ' + JSON.stringify(actual) + (ok ? '' : '   expected ' + JSON.stringify(expected)));
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

function errText(r) {
  return String(r?.d?.error?.message ?? '') + JSON.stringify(r?.d?.error?.details ?? '') + String(r?.d?.message ?? '');
}

const stamp = Date.now().toString().slice(-6);
const TARGET = `perm_target_${stamp}`;
const ACTOR = `perm_actor_${stamp}`;
const ACTOR_PW = `PermActor!${stamp}aA`;

console.log(`\n§11 按账号授权 + role.assign 行为验证 @ ${BASE}\n${'='.repeat(78)}\n`);

const principal = makeClient();
await principal.req('GET', '/');
const login = await principal.req('POST', '/api/auth/login', { username: 'seq_principal', password: PRINCIPAL_PW });
if (login.s !== 201 && login.s !== 200) { console.error(`principal 登录失败：${login.s}`); process.exit(2); }

let targetId = null, actorId = null;

async function createAccount(username, roles = ['prek_head']) {
  const r = await principal.req('POST', '/api/teachers', {
    username, name: `授权探针 ${username.slice(-4)}`, roles, status: 'active',
  });
  if (r.s !== 201 && r.s !== 200) throw new Error(`创建 ${username} 失败：${r.s} ${JSON.stringify(r.d)}`);
  return { id: r.d?.id ?? r.d?.teacher?.id ?? null, temp: r.d?.temporaryPassword ?? r.d?.tempPassword ?? null };
}

try {
  // ---- 1. 建两个探针账号 ----
  console.log('1) 准备两个探针账号');
  // 被改对象刻意用**更低等级**的角色：`updateTeacher` 除了 role.assign 之外
  // 还会跑 `assertCanManageAccount`（不能动同级/更高级）。第一版两边都是 prek_head，
  // 于是即使 role.assign 已经授予，也仍然被等级规则挡住 ——
  // 那条 403 是对的，是我的用例设计错了。
  const t = await createAccount(TARGET, ['prek_assistant']);
  targetId = t.id;
  const a = await createAccount(ACTOR);
  actorId = a.id;
  check('被改对象账号已创建', !!targetId, true);
  check('操作者账号已创建', !!actorId, true);

  // ---- 2. §11 追加/禁止：让操作者能改账号，但**不能**分配角色 ----
  console.log('\n2) 用 §11 的接口给操作者配置权限（追加 account.update、禁止 role.assign）');
  const g1 = await principal.req('POST', `/api/teachers/${actorId}/permission-overrides/grant`, {
    permission: 'account.update', reason: '授权探针：允许改账号',
  });
  check('追加授权 account.update → 201', g1.s, 201);

  const g2 = await principal.req('POST', `/api/teachers/${actorId}/permission-overrides/grant`, {
    permission: 'account.view',
  });
  check('追加授权 account.view → 201', g2.s, 201);

  const d1 = await principal.req('POST', `/api/teachers/${actorId}/permission-overrides/deny`, {
    permission: 'role.assign', reason: '授权探针：禁止分配角色',
  });
  check('显式禁止 role.assign → 201', d1.s, 201);
  check('  → 返回的 effective permissions 里 account.update 已生效',
    (d1.d?.permissions ?? []).includes('account.update'), true);
  check('  → role.assign 不在生效权限里', (d1.d?.permissions ?? []).includes('role.assign'), false);
  check('  → role.assign 出现在 denied 来源里', (d1.d?.sources?.denied ?? []).includes('role.assign'), true);

  const eff = await principal.req('GET', `/api/teachers/${actorId}/effective-permissions`);
  check('读取生效权限 → 200', eff.s, 200);
  check('  → fromRoles 里有 prek_head 的默认权限', (eff.d?.sources?.fromRoles ?? []).length > 0, true);
  check('  → granted 里有我们追加的那条', (eff.d?.sources?.granted ?? []).includes('account.update'), true);

  // ---- 3. 操作者登录（临时密码 → 必须改密，§13）----
  console.log('\n3) 操作者登录并被强制改密（§13 与 §11 一起工作）');
  const actor = makeClient();
  await actor.req('GET', '/');
  const al = await actor.req('POST', '/api/auth/login', { username: ACTOR, password: a.temp });
  check('用临时密码登录 → 201', al.s, 201);
  check('  → 账号被标记必须改密', al.d?.teacher?.mustChangePassword, true);

  const blocked = await actor.req('GET', '/api/teachers');
  check('  改密前受保护接口被服务端拒绝（403）', blocked.s, 403);

  // 服务端返回 201（创建了新的凭据），不是 200 —— 我第一版期望写成 200，
  // 而且这条失败会把后面"403 到底来自 role.assign 还是来自没改密"的判断搅浑。
  const chg = await actor.req('POST', '/api/auth/change-password', { currentPassword: a.temp, newPassword: ACTOR_PW });
  check('改密 → 201', chg.s, 201);

  // ---- 4. 决定性断言：有 account.update 但无 role.assign，改角色必须被挡 ----
  console.log('\n4) 决定性断言：改角色必须被 `role.assign` 挡住（而不只是"失败")');
  const withRoles = await actor.req('PATCH', `/api/teachers/${targetId}`, { roles: ['prek_assistant'] });
  check('改角色 → 403', withRoles.s, 403);
  const roleMsg = errText(withRoles);
  check('  → 拒绝原因**明确指向** role.assign（不是笼统的"无权限"）',
    /role\.assign/.test(roleMsg), true);
  console.log('       服务端原文：' + roleMsg.slice(0, 140));

  // 同一账号、同一个接口，只改名字（不涉及角色）**必须成功** ——
  // 否则上面的 403 可能只是"这个账号本来就什么都做不了"。
  const withoutRoles = await actor.req('PATCH', `/api/teachers/${targetId}`, { name: '授权探针（已改名）' });
  check('只改名字 → 200（证明 403 确实来自 role.assign，而不是账号没权限）', withoutRoles.s, 200);

  // ---- 5. 清除禁止后应当放行（清除覆盖也是 §11 的一部分）----
  console.log('\n5) 清除禁止 → 同一个操作应当放行');
  const clr = await principal.req('DELETE', `/api/teachers/${actorId}/permission-overrides/role.assign`);
  check('清除覆盖项 → 200', clr.s, 200);
  check('  → role.assign 依据角色默认回来了（prek_head 默认不含，故仍不在）或仍在 denied 之外',
    (clr.d?.sources?.denied ?? []).includes('role.assign'), false);

  // 直接给这个账号追加 role.assign，再试一次 —— 这次应当通过
  const g3 = await principal.req('POST', `/api/teachers/${actorId}/permission-overrides/grant`, {
    permission: 'role.assign', reason: '授权探针：放行',
  });
  check('追加 role.assign → 201', g3.s, 201);
  // 注意：**必须重新登录**。给操作者本人改权限会触发
  // `trg_apo_bump_permissions_version`，把该账号的 `permissions_version` 自增，
  // AuthGuard 随即判定"权限已变更"并作废旧会话 —— 这正是 design 上的即时撤销。
  // 第一版没重登，于是拿到 401 而误报成"权限没生效"。
  const actor2 = makeClient();
  await actor2.req('GET', '/');
  const relogin = await actor2.req('POST', '/api/auth/login', { username: ACTOR, password: ACTOR_PW });
  check('改权限后旧会话被作废、重新登录成功（即时撤销生效）', relogin.s, 201);

  const stale = await actor.req('PATCH', `/api/teachers/${targetId}`, { roles: ['prek_assistant'] });
  check('  → 旧会话确实不能再用了（401）', stale.s, 401);

  const afterGrant = await actor2.req('PATCH', `/api/teachers/${targetId}`, { roles: ['prek_assistant'] });
  check('追加 role.assign 并重登后，同样的改角色请求 → 200（证明这条权限真的在起作用）',
    afterGrant.s, 200);

  // ---- 6. 审计：每次授权变更都留痕 ----
  if (DB_URL) {
    console.log('\n6) 授权变更必须留审计');
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1 });
    const rows = await sql`
      select detail from audit_logs
       where action = 'permission_change' and teacher_id = ${actorId}
       order by _created_at desc limit 5`;
    check('有 permission_change 审计行', rows.length >= 3, true);
    const joined = rows.map((r) => String(r.detail)).join(' | ');
    check('  → 审计里记录了权限码', /role\.assign/.test(joined), true);
    check('  → 审计里记录了生效方向（追加/禁止/清除）', /(追加授权|显式禁止|清除覆盖项)/.test(joined), true);
    await sql.end();
  } else {
    console.log('\n6) 跳过审计检查（未设置 DATABASE_URL）');
  }
} finally {
  if (DB_URL) {
    try {
      const postgres = (await import('postgres')).default;
      const sql = postgres(DB_URL, { max: 1 });
      for (const u of [TARGET, ACTOR]) {
        await sql`DELETE FROM teachers WHERE username = ${u}`;
      }
      await sql.end();
      console.log(`\n清理：已删除 ${TARGET} / ${ACTOR}`);
    } catch (e) { console.error(`清理失败：${e?.message}`); }
  } else {
    console.error('\n未能清理探针账号（未设置 DATABASE_URL）');
  }
}

console.log('\n' + '='.repeat(78));
console.log(`§11 按账号授权验证：${pass} 通过 / ${fail} 失败   pass=${pass} fail=${fail}`);
if (fail > 0) { console.log('\n失败明细：'); for (const f of failures) console.log('  * ' + f); process.exit(1); }
