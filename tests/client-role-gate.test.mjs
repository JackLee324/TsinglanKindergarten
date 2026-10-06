/**
 * tests/client-role-gate.test.mjs — 前端角色判定必须与后端同一套模型
 * =================================================================
 * Run with:  npm test   (or: node --test tests/client-role-gate.test.mjs)
 *
 * 背景（这是一个真实发生过、且**所有 HTTP 套件全绿**的线上故障）
 * ---------------------------------------------------------------------------
 * 部署完成后登录成功，页面显示「无权访问」；点「返回首页」又回到同一个页面，
 * 看起来像"首页坏了"。真实原因是一条纯前端的授权判定缺陷：
 *
 *   client/src/app.tsx            TEACHER_ROLES 是**白名单字面量**，不含 super_admin
 *   client/src/auth/ProtectedRoute.tsx
 *                                 「user.roles ∩ requiredRoles ≠ ∅」才放行
 *   server/.../authorization.service.ts
 *                                 对 super_admin 直接 `return true`（显式放行）
 *
 * 于是**只持 super_admin 的账号**在前端被每个受保护路由拒绝，而后端对同一个账号
 * 的实际请求返回 200。`/unauthorized` 的「返回首页」指向 `/`，而 `/` 也在同一个守卫
 * 里，所以那个链接点了等于没点 —— 这正是用户看到的那两个症状。
 *
 * 为什么不是"理论问题"
 *   `scripts/provision-super-admin.mjs --role` 的**默认值就是 super_admin**，
 *   `scripts/entrypoint.sh` 创建初始管理员时也正是走这条默认路径。也就是说：
 *   **每一次全新部署拿到的就是这样一个账号。**
 *
 * 这个文件断言什么
 *   1. 真实函数（`shared/…` 里那份，字节等同于线上跑的代码）在**只持
 *      super_admin** 时放行每一个前端角色白名单 —— 这条如果不过，线上就是白屏
 *      「无权访问」；
 *   2. 「放行」只针对 super_admin：**visitor / 空角色必须仍然被拒**。没有这一组，
 *      本文件只是在证明"把门开大了"，而那种"修复"能让任何人进去；
 *   3. 前端白名单是从 `client/src/app.tsx` **现场解析**出来的，不是抄进测试里的
 *      副本 —— 否则改了 app.tsx 而测试仍拿旧列表断言，就是假绿；
 *   4. 后端那份"super_admin 全放行"的规则仍然存在。前端镜像的是它；它一旦消失，
 *      前端的放宽就失去依据，本文件必须失败并把这件事说出来。
 *
 * ── 第 2 轮更新（信息架构收口 §13）───────────────────────────────────────
 * 上面那个故障的**机制**要说准：`TEACHER_ROLES` 里确实没有 super_admin，
 * 但 `hasAnyRole()` 把 super_admin 当**通配**（`held.includes(SUPER_ADMIN_ROLE)
 * → return true`），所以超管并没有被挡住 —— 挡住他的是**更早的版本**，
 * 而通配就是当时的修法。我一度只比较"权限集合 vs 角色数组"就断言
 * "超管被锁在门外"，**那个结论是错的**：漏掉了通配语义。
 *
 * 但同一份代码里还有第二个、**通配救不了**的分叉：
 *   · 侧边栏（Layout）用能力码 `account.view` 决定要不要显示「管理后台」；
 *   · 路由守卫却用 `ADMIN_ROLES = ['principal']`；
 *   · `curriculum_director` 持有 `account.view`，服务端 `GET /api/teachers`
 *     也只要求 `account.view`（`@RequirePermission('account.view')`）。
 * 于是教学主任**看得见菜单、点进去被弹回**，而服务端其实允许他读 ——
 * 客户端比服务端更严，正是这份测试一直在防的那类分叉。
 *
 * 所以本轮把 `app.tsx` 的守卫从**角色数组**改成**能力码**：
 *   · `<Layout>` → `curriculum.view`（服务端 `/api/directories/tree` 同一个码）
 *   · 上传 → `resource.create`、审核 → `review.view`
 *   · 管理后台各页 → `account.view` / `permission.view` / `audit.view` /
 *     `resource.restore` / `curriculum.manage`（逐一等于服务端各自 `@RequirePermission`）
 * 角色数组从此在客户端消失 —— 一个概念只有一个来源（§13）。
 *
 * 本文件随之**换了真相来源**（从 app.tsx 解析能力码，而不是角色数组），
 * 但**断言一条都没有减少**，反而多了两条：
 *   · 每一个守卫能力码都必须被 super_admin 持有（否则他又会进不去某个页面）；
 *   · 能力码必须与 `shared/rbac.ts` 的权限目录一致（不得出现拼错的码）。
 *
 * 关于第 4 条的诚实说明
 *   它是一条**源码断言**（读 authorization.service.ts 的文本），比行为断言弱。
 *   把它放在这里是因为这是一个"两侧必须一致"的不变量，而只有一侧能在 Node 里
 *   直接调用。真正的端到端证据在 scripts/verify-e2e-deploy.sh 第 6c 节：那里用真
 *   浏览器、真登录、真渲染，分别以 principal（阳性对照）、super_admin（故障复现）、
 *   visitor（阴性对照）跑三个账号。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/ts-alias-loader.mjs', import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 真实的实现，不是副本。乱码不会发生：这两个模块都只有类型级 import。
const rbac = await import(new URL('../shared/rbac.ts', import.meta.url).href);
const { hasAnyRole, SUPER_ADMIN_ROLE, ROLE_PERMISSIONS, isKnownPermission } = rbac;

/**
 * 从 client/src/app.tsx 里解析出真实的**路由守卫能力码**。
 *
 * 刻意不用正则把整个文件"猜"一遍：只认 `requiredPermission="…"` 这一种形态，
 * 并断言解析出来的数量不少于已知路由数 —— 解析出 0 个时必须失败，
 * 而不是让后面的断言在空集合上假绿（这一点是上一版用角色数组时踩过的教训，
 * 换真相来源之后同样适用）。
 */
function extractGuardPermissions(source) {
  const codes = [...source.matchAll(/requiredPermission="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    codes.length >= 8,
    `client/src/app.tsx 里只解析出 ${codes.length} 个 requiredPermission。` +
      '守卫的形态变了，或者解析逻辑失效了 —— 绝不能当作"通过"。' +
      '请更新本测试以指向新的真相来源，不要删掉断言。',
  );
  return [...new Set(codes)];
}

/**
 * 角色数组不得回归。
 *
 * 这是本文件守护的**形式**：一旦有人在客户端重新写一张角色白名单，
 * 它就又是一份与服务端 `@RequirePermission` 各自演化的真相。
 */
function assertNoRoleArrays(source) {
  const hits = [...source.matchAll(/requiredRoles\s*=/g)].map((m) => m[0]);
  assert.deepEqual(
    hits,
    [],
    'client/src/app.tsx 里又出现了 requiredRoles —— 角色数组不得回归。' +
      '它会与服务端的 @RequirePermission（以及侧边栏用的能力码）分叉，' +
      '而分叉时不报错：教学主任"看得见菜单、点进去被弹回"就是这么来的。',
  );
}

const appSource = readFileSync(join(ROOT, 'client', 'src', 'app.tsx'), 'utf8');
assertNoRoleArrays(appSource);
const GUARD_PERMISSIONS = extractGuardPermissions(appSource);

/**
 * "这个角色集合是否能通过这条守卫" —— 镜像服务端 `AuthorizationService.can()`
 * 的**能力**判定，并且同样把 super_admin 当通配。
 *
 * 为什么不直接 import 服务端：那需要 Nest 运行时。这里的镜像很薄，
 * 而且下面有一条源码断言盯着"后端仍然对 super_admin 无条件放行"，
 * 两者不会各走各的。角色 → 权限的映射**直接取自 shared/rbac.ts**，
 * 不在测试里重抄一遍。
 */
function can(roles, permission) {
  if (roles.includes(SUPER_ADMIN_ROLE)) return true;
  return roles.some((r) => (ROLE_PERMISSIONS[r] ?? []).includes(permission));
}

const ALL_GATES = GUARD_PERMISSIONS.map((code) => [code, code]);

describe('前端路由守卫的能力码确实被解析出来了（防止后面的断言在空集合上假绿）', () => {
  test('解析出至少 8 条守卫，且每一条都是 shared/rbac.ts 里真实存在的权限码', () => {
    assert.ok(GUARD_PERMISSIONS.length >= 8, `只解析出 ${GUARD_PERMISSIONS.length} 条守卫`);
    for (const code of GUARD_PERMISSIONS) {
      assert.ok(
        isKnownPermission(code),
        `${code} 不在权限目录里 —— 拼错的码永远不会被命中，是个静默失效的守卫`,
      );
    }
  });

  test('关键路由的守卫都在（逐一列出，少一条就红）', () => {
    for (const must of [
      'curriculum.view',      // <Layout>：整个应用的入口
      'resource.create',      // 上传
      'review.view',          // 审核工作台
      'account.view',         // 教师管理
      'permission.view',      // 权限管理
      'audit.view',           // 审计日志
      'resource.restore',     // 回收站
      'curriculum.manage',    // 目录管理 / 待补齐目录归属
    ]) {
      assert.ok(GUARD_PERMISSIONS.includes(must), `app.tsx 少了 ${must} 这条守卫`);
    }
  });

  test('守卫必须与服务端同一份：这些码在服务端确实被 @RequirePermission 用过', () => {
    // 静态对照：每一条守卫码都要能在 server/ 里找到对应的 @RequirePermission 声明。
    // 这条断言的价值在于它把"客户端自己发明的码"挡住 —— 那种码服务端根本不认，
    // 于是客户端放行的页面会在一进去就 403，看起来像"页面坏了"。
    const walk = (dir) => {
      let acc = '';
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { acc += walk(full); continue; }
        if (/\.ts$/.test(entry.name)) acc += readFileSync(full, 'utf8');
      }
      return acc;
    };
    const serverSource = walk(join(ROOT, 'server'));
    for (const code of GUARD_PERMISSIONS) {
      assert.match(
        serverSource,
        new RegExp(`RequirePermission\\(\\s*'${code.replace(/\./g, '\\.')}'`),
        `服务端没有任何 @RequirePermission('${code}') —— 客户端用了一个服务端不认的守卫码`,
      );
    }
  });
});

describe('只持 super_admin 的账号必须能进入每一个前端受保护页面', () => {
  // 这一组是那起线上故障的直接复现。当时超管被前端挡住，
  // 而后端对同一账号是放行的（authorization.service.ts 显式 return true）。
  // 换成能力码之后，超管通配由"持有全部权限"保证 —— 断言仍然是每一条守卫都要过。
  for (const [name, code] of ALL_GATES) {
    test(`super_admin 通过守卫 ${name}`, () => {
      assert.equal(
        can([SUPER_ADMIN_ROLE], code),
        true,
        `只持 super_admin 的账号被 ${name} 拒绝了 —— 这就是"登录成功但每个页面都` +
          '显示无权访问"的线上故障。后端对同一账号是放行的，前端不得更严。',
      );
    });
  }

  test('super_admin 单独持有（不带任何附加角色）时全部放行 —— bootstrap 创建的就是这个形态', () => {
    for (const [, code] of ALL_GATES) {
      assert.equal(can([SUPER_ADMIN_ROLE], code), true, `super_admin 被 ${code} 拒绝`);
    }
  });

  test('super_admin 与其它角色混持时同样放行', () => {
    assert.equal(can([SUPER_ADMIN_ROLE, 'visitor'], 'audit.view'), true);
  });
});

describe('放行**仅限**该能力真正授予的角色 —— 阴性对照，防止把门开大', () => {
  test('visitor 被每一条守卫拒绝（它不持有任何权限，也不该看到课程内容）', () => {
    for (const [name, code] of ALL_GATES) {
      assert.equal(can(['visitor'], code), false, `visitor 通过了 ${name} —— 权限被放大了。`);
    }
  });

  test('空角色被拒绝', () => {
    for (const [, code] of ALL_GATES) {
      assert.equal(can([], code), false, `空角色通过了 ${code}`);
    }
  });

  test('教学助理不得进管理后台，也不得进审核台', () => {
    assert.equal(can(['prek_assistant'], 'account.view'), false);
    assert.equal(can(['k_assistant'], 'audit.view'), false);
    assert.equal(can(['prek_assistant'], 'review.view'), false);
    assert.equal(can(['prek_assistant'], 'resource.create'), false);
  });
});

describe('普通角色仍然按能力正常放行（换真相来源没有影响正常路径）', () => {
  test('principal 通过全部守卫', () => {
    for (const [name, code] of ALL_GATES) {
      assert.equal(can(['principal'], code), true, `principal 被 ${name} 拒绝`);
    }
  });

  test('教学角色按各自能力放行', () => {
    assert.equal(can(['prek_head'], 'curriculum.view'), true);
    assert.equal(can(['prek_head'], 'resource.create'), true);
    assert.equal(can(['pe_specialist'], 'resource.create'), true);
    assert.equal(can(['curriculum_director'], 'review.view'), true);
  });

  test('§13 教学主任的管理后台：客户端不得比服务端更严', () => {
    // 这曾是一处分叉：侧边栏按 `account.view` 显示，路由却按
    // `ADMIN_ROLES = ['principal']` 拦人，而服务端 `GET /api/teachers`
    // 只要求 `account.view`。教学主任于是"看得见菜单、点进去被弹回"。
    assert.equal(can(['curriculum_director'], 'account.view'), true, '服务端允许、客户端也必须允许');
    assert.equal(can(['curriculum_director'], 'permission.view'), true);
    // 但超管专属的能力仍然不给他 —— 这次改动是"对齐"，不是"放宽"。
    assert.equal(can(['curriculum_director'], 'audit.export'), false);
    assert.equal(can(['curriculum_director'], 'role.assign'), false);
  });

  test('hasAnyRole 的通配语义没有被改坏（super_admin 仍是无条件放行）', () => {
    assert.equal(hasAnyRole([SUPER_ADMIN_ROLE], []), true);
    assert.equal(hasAnyRole([], []), true, '空 required 表示"只要登录即可"');
    assert.equal(hasAnyRole(['visitor'], []), true);
    assert.equal(hasAnyRole(['visitor'], ['principal']), false);
  });
});

describe('前端镜像的后端规则必须仍然存在', () => {
  const authzSource = readFileSync(
    join(ROOT, 'server', 'modules', 'authz', 'authorization.service.ts'),
    'utf8',
  );

  test('authorization.service.ts 仍然对 super_admin 无条件放行', () => {
    assert.match(
      authzSource,
      /includes\(\s*SUPER_ADMIN_ROLE\s*\)[\s\S]{0,40}?return\s+true/,
      '后端不再对 super_admin 无条件放行了 —— 前端 hasAnyRole 里的 super_admin 通配' +
        '就是照它写的。请先确认后端语义（是收紧了？还是换了写法？），再决定前端该' +
        '怎么改，然后同步更新本测试。不要让两者各自演化。',
    );
  });

  test('两个前端判定点都委派给共享规则，而不是各写一遍交集', () => {
    const protectedRoute = readFileSync(
      join(ROOT, 'client', 'src', 'auth', 'ProtectedRoute.tsx'),
      'utf8',
    );
    const authContext = readFileSync(
      join(ROOT, 'client', 'src', 'auth', 'auth-context.tsx'),
      'utf8',
    );

    for (const [name, src] of [
      ['ProtectedRoute.tsx', protectedRoute],
      ['auth-context.tsx', authContext],
    ]) {
      assert.match(src, /hasAnyRole\s*\(/, `${name} 不再使用共享的 hasAnyRole`);
      assert.doesNotMatch(
        src,
        /roles\.some\([\s\S]{0,60}?\.includes\(/,
        `${name} 又出现了手写的"取交集"判定。这正是本文件记录的缺陷形态：它与 ` +
          'shared/rbac.ts 的 hasAnyRole 会各自演化，然后再次不一致。',
      );
    }
  });
});

describe('整个 client 里不得再出现任何"手写的当前用户角色判定"', () => {
  /**
   * 这一条是**泛化**的守卫，而不是又一个点状断言。
   *
   * 原因：写本文件时，同一个缺陷形态在客户端被找到了**两次**。
   *   1. `auth/ProtectedRoute.tsx` + `auth/auth-context.tsx` —— 手写交集，导致
   *      super_admin 在**每个**受保护路由上看到「无权访问」（用户报告的故障）；
   *   2. `pages/Home/HomePage.tsx:128` —— `user?.roles?.includes('principal')`，
   *      导致同一个 super_admin 的首页**少显示三张平台统计卡片**。
   *
   * 第 2 处之所以在第一次排查里被漏掉，是因为当时搜的是 `roles.includes`，
   * 而它写的是 `roles?.includes`（中间有可选链）。**"靠一次 grep 记住还有没有别的
   * 地方"是不可靠的**，所以让测试每次都做这件事：
   *
   *   任何形如 `user.roles.includes(...)` / `user?.roles?.some(...)` 的表达式，
   *   都是"某个组件自己发明了一套角色判定"。一律必须改为 `shared/rbac.ts` 的
   *   `hasAnyRole`，或其包装 `useAuth().hasRole`。
   */
  const ALLOWED = [
    // 表单里对"被编辑账号的角色集合"做包含判断，与当前登录者是谁无关。
    'pages/TeacherAdmin/TeacherFormDialog.tsx',
  ];

  /**
   * 去掉注释后再匹配。
   *
   * 必须有这一步，而且**它是被自己的失败逼出来的**：本测试第一版直接扫原始文本，
   * 结果 `HomePage.tsx` 里那段解释这条缺陷的注释（里面引用了被禁的写法）被判成违规 ——
   * 一个只会在文档写得越清楚时越容易误报的守卫是不可接受的。
   *
   * 实现上跳过字符串/模板串，避免把 `'https://…'` 里的 `//` 当成注释开头而把
   * 后面真正的代码一起吃掉（那会造成**漏报**，比误报更危险）。
   */
  function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (c === '/' && next === '/') {
        while (i < n && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        out += c;
        i += 1;
        while (i < n) {
          if (src[i] === '\\') {
            out += src[i] + (src[i + 1] ?? '');
            i += 2;
            continue;
          }
          out += src[i];
          if (src[i] === quote) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      out += c;
      i += 1;
    }
    return out;
  }

  test('没有任何组件手写当前用户的角色判定', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const rel = relative(join(ROOT, 'client', 'src'), full);
        if (ALLOWED.includes(rel)) continue;
        // 行号要基于**原始**源码报，否则报了注释里的位置，等于没报。
        const raw = readFileSync(full, 'utf8');
        const code = stripComments(raw);
        const re = /\buser\??\.roles\??\.(includes|some|indexOf)\s*\(/g;
        for (const m of code.matchAll(re)) {
          const line = code.slice(0, m.index).split('\n').length;
          offenders.push(`${rel}:${line}  ${m[0].replace(/\s+/g, '')}`);
        }
      }
    };
    walk(join(ROOT, 'client', 'src'));

    assert.deepEqual(
      offenders,
      [],
      '以下位置自己写了一套"当前用户有没有某个角色"的判定。\n' +
        '这类判定已经造成过两次真实故障（super_admin 进不去任何页面、首页少三张卡片），' +
        '根因都是它与后端 authorization.service.ts 以及 shared/rbac.ts 各自演化。\n' +
        '请改为 `const { hasRole } = useAuth(); hasRole([...])`（内部是 hasAnyRole，' +
        'super_admin 作为通配）。若某处确实不是权限判定，把它加入本测试的 ALLOWED ' +
        '并写明理由 —— 不要放宽正则：\n  ' +
        offenders.join('\n  '),
    );
  });
});
