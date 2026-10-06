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

  // ---- 5b. §12 数据范围（ALL / PROGRAM / SUBJECT / OWN）可查看、可编辑 ----
  //
  // WHY 这一段在这里：`AuthorizationService.setScopes()` 与 `account_scopes` 表
  // 早就存在，但**长期没有任何 API 或界面能调用它们** —— 于是"把某位主任的数据范围
  // 限制到只有 Pre-K"这件事，在库里定义完整、在界面上完全不可达。
  // 本轮补了 `GET/POST /api/teachers/:id/scopes` 与权限面板里的编辑区；
  // 这一段就是它的自动化回归 —— 没有它，将来一次改动可以静默把这条能力改坏。
  console.log('\n5b) §12 数据范围：查看与编辑');
  {
    const before = await principal.req('GET', `/api/teachers/${targetId}/scopes`);
    check('GET scopes → 200 且形如 { scopes: [...] }', before.s === 200 && Array.isArray(before.d?.scopes), true);
    check('  → 新账号默认没有任何显式绑定（空数组 = 按角色默认）', before.d?.scopes?.length, 0);

    const set1 = await principal.req('POST', `/api/teachers/${targetId}/scopes`, {
      scopes: [{ permission: null, kind: 'PROGRAM', program: 'prek' }],
    });
    check('POST scopes（PROGRAM / prek）→ 201', set1.s, 201);
    check('  → 返回值就是新的绑定集合', JSON.stringify(set1.d?.scopes), JSON.stringify([
      { permission: null, kind: 'PROGRAM', program: 'prek', subSubject: null },
    ]));

    // 必须**从生效权限快照里也读得到** —— 只回显写入内容不算数。
    const eff = await principal.req('GET', `/api/teachers/${targetId}/effective-permissions`);
    const effScopes = eff.d?.scopes ?? [];
    check('  → 生效权限快照里也带上了这条绑定（不是只回显）',
      effScopes.some((x) => x.kind === 'PROGRAM' && x.program === 'prek'), true);

    // 换成 SUBJECT，并把 permission 绑定到具体权限码上 —— 整表替换语义。
    const set2 = await principal.req('POST', `/api/teachers/${targetId}/scopes`, {
      scopes: [{ permission: 'resource.view', kind: 'SUBJECT', program: 'prek', subject: 'virtue' }],
    });
    check('POST scopes（SUBJECT / prek:virtue，绑定到 resource.view）→ 201', set2.s, 201);
    check('  → 旧绑定被替换掉（整表替换，不是追加）', JSON.stringify(set2.d?.scopes), JSON.stringify([
      { permission: 'resource.view', kind: 'SUBJECT', program: 'prek', subject: 'virtue', subSubject: null },
    ]));

    /**
     * 形状真值表 —— 逐个形状真的发给服务端。
     *
     * 这张表与 `tests/data-scope-shape.test.mjs` 里那张、以及数据库约束
     * `account_scopes_shape_check` 是同一条规则的三处表述。
     * 之所以用 12 个请求把它全跑一遍，而不是只测"四种 kind 都能用"：
     * 加这一段之前，`kind=SUBJECT` 缺 `subject` **返回 500** ——
     * 数据库约束把它拦下了，但客户端拿到的是服务端故障而不是"你少填了 subject"。
     * 只测合法形状的用例**永远发现不了这个**。
     */
    const SHAPES = [
      ['ALL',     null,   null,     null,   true,  '全部'],
      ['ALL',     'prek', null,     null,   false, 'ALL 不能带 program'],
      ['ALL',     null,   'virtue', null,   false, 'ALL 不能带 subject'],
      ['OWN',     null,   null,     null,   true,  '仅自己创建'],
      ['OWN',     null,   'virtue', null,   false, 'OWN 不能带 subject'],
      ['PROGRAM', 'prek', null,     null,   true,  '按班型'],
      ['PROGRAM', null,   null,     null,   false, 'PROGRAM 缺 program'],
      ['PROGRAM', 'prek', 'virtue', null,   false, 'PROGRAM 不能带 subject'],
      ['PROGRAM', 'prek', null, 'practical_life', false, 'PROGRAM 不能带 subSubject'],
      ['SUBJECT', 'prek', 'virtue', null,   true,  '按科目'],
      ['SUBJECT', 'prek', null,     null,   false, 'SUBJECT 缺 subject'],
      ['SUBJECT', null,   'virtue', null,   false, 'SUBJECT 缺 program'],
    ];
    for (const [kind, program, subject, subSubject, legal, label] of SHAPES) {
      const r = await principal.req('POST', `/api/teachers/${targetId}/scopes`, {
        scopes: [{ permission: null, kind, program, subject, subSubject }],
      });
      if (legal) {
        check(`形状 ${label}（${kind}）→ 201`, r.s, 201);
      } else {
        // 非法形状必须是 **400**，而不是 500。
        // 500 意味着"约束在数据库层才被拦下"，客户端拿不到可读原因 ——
        // 这正是这一段要防的回归。
        check(`形状 ${label}（${kind}）→ 400（不是 500）`, r.s, 400);
        check(`  → ${label} 给出了可读原因`,
          typeof r.d?.error?.message === 'string' && r.d.error.message.length > 0, true);
      }
    }

    // 拒绝路径。这三条都要**具体**断言，不能只看"失败了"。
    const unknownPerm = await principal.req('POST', `/api/teachers/${targetId}/scopes`, {
      scopes: [{ permission: 'not.a.permission', kind: 'ALL' }],
    });
    check('未知权限码 → 400', unknownPerm.s, 400);
    check('  → 报的是"未知权限"而不是笼统的 400',
      /未知权限/.test(String(unknownPerm.d?.error?.message ?? '')), true);

    const badKind = await principal.req('POST', `/api/teachers/${targetId}/scopes`, {
      scopes: [{ kind: 'NOWHERE' }],
    });
    check('非法 kind → 400', badKind.s, 400);

    // `scopes` 必传：省略与"清空"必须能区分，否则一次漏传字段的请求会静默
    // 把人的数据范围放大到角色默认 —— 那是**扩大**权限的方向。
    const omitted = await principal.req('POST', `/api/teachers/${targetId}/scopes`, {});
    check('省略 scopes 字段 → 400（省略 ≠ 清空）', omitted.s, 400);

    // 清空：显式空数组 = 回到角色默认。
    const cleared = await principal.req('POST', `/api/teachers/${targetId}/scopes`, { scopes: [] });
    check('POST scopes（空数组）→ 201', cleared.s, 201);
    check('  → 显式清空后绑定为空（回到角色默认）', cleared.d?.scopes?.length, 0);

    // 权限闸：`permission.grant` 是写路径的门槛。操作者此时已被追加 role.assign，
    // 但**没有** permission.grant —— 它必须被挡住。
    const actorWrite = await actor2.req('POST', `/api/teachers/${targetId}/scopes`, {
      scopes: [{ permission: null, kind: 'ALL' }],
    });
    check('无 permission.grant 的账号写 scope → 403', actorWrite.s, 403);
    // 读路径的门槛是 `permission.view`，与"登录了"无关。
    //
    // ⚠️ 第一版这里断言的是 200，**是我写错了**：这个操作者默认角色是 prek_head，
    // 而 `permission.view` 只在 principal / curriculum_director / super_admin 手上。
    // 403 才是对的 —— 而且它恰好是更有价值的一条断言：证明这条路由是
    // "按能力"而不是"按是否登录"守的。（前面 `principal` 读成功那条已覆盖 200 分支。）
    const actorRead = await actor2.req('GET', `/api/teachers/${targetId}/scopes`);
    check('无 permission.view 的账号读 scope → 403（按能力守，不是按登录守）', actorRead.s, 403);
  }

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

    // §12：数据范围变更与覆盖项变更是**同一类事**（都改了某个账号的授权），
    // 所以复用同一个动作码 `permission_change`。这里验证它真的被记下来了 ——
    // 否则"谁把谁的数据范围缩小到了哪个班型"事后查不到。
    const scopeRows = await sql`
      select detail from audit_logs
       where action = 'permission_change' and teacher_id = ${targetId}
       order by _created_at desc limit 20`;
    const scopeJoined = scopeRows.map((r) => String(r.detail)).join(' | ');
    check('数据范围变更也进了 permission_change 审计', scopeJoined.includes('设置数据范围'), true);
    check('  → 审计里写出了范围与目标（kind / program）',
      /PROGRAM\/prek|SUBJECT\/prek\/virtue|ALL|OWN/.test(scopeJoined), true);
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
