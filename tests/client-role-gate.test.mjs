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
const { hasAnyRole, SUPER_ADMIN_ROLE, ROLE_CODES } = rbac;

/**
 * 从 client/src/app.tsx 里解析出真实的角色白名单。
 *
 * 刻意不用正则去"猜"整个数组：这里先把 `const NAME: RoleCode[] = [` 到配套的 `];`
 * 之间的片段切出来，再从片段里取单引号字符串。切不出片段就直接失败（而不是返回空
 * 数组让断言静默通过）——空数组会让"必须放行"的断言全部假绿。
 */
function extractRoleList(source, constName) {
  const start = source.indexOf(`const ${constName}: RoleCode[] = [`);
  assert.notEqual(
    start,
    -1,
    `client/src/app.tsx 里找不到 ${constName} —— 前端角色白名单的形态变了，` +
      '本测试无法再核对它。请更新本测试以指向新的真相来源，不要删掉断言。',
  );
  const end = source.indexOf('];', start);
  assert.notEqual(end, -1, `${constName} 的数组没有正常结束`);
  const body = source.slice(start, end);
  const roles = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(
    roles.length > 0,
    `${constName} 解析出 0 个角色 —— 解析逻辑失效了，绝不能当作"通过"`,
  );
  return roles;
}

const appSource = readFileSync(join(ROOT, 'client', 'src', 'app.tsx'), 'utf8');
const TEACHER_ROLES = extractRoleList(appSource, 'TEACHER_ROLES');
const UPLOAD_ROLES = extractRoleList(appSource, 'UPLOAD_ROLES');
const REVIEW_ROLES = extractRoleList(appSource, 'REVIEW_ROLES');
const ADMIN_ROLES = extractRoleList(appSource, 'ADMIN_ROLES');

const ALL_GATES = [
  ['TEACHER_ROLES', TEACHER_ROLES],
  ['UPLOAD_ROLES', UPLOAD_ROLES],
  ['REVIEW_ROLES', REVIEW_ROLES],
  ['ADMIN_ROLES', ADMIN_ROLES],
];

describe('前端角色白名单确实被解析出来了（防止后面的断言在空列表上假绿）', () => {
  test('四个白名单都非空，且都是已知角色', () => {
    for (const [name, roles] of ALL_GATES) {
      assert.ok(roles.length > 0, `${name} 为空`);
      for (const r of roles) {
        assert.ok(
          ROLE_CODES.includes(r),
          `${name} 含未知角色 ${r} —— 它永远不可能被命中，是个静默失效的权限项`,
        );
      }
    }
  });

  test('解析出来的内容与 app.tsx 的实际文本一致（抽查 principal）', () => {
    for (const [name, roles] of ALL_GATES) {
      assert.ok(roles.includes('principal'), `${name} 竟然不含 principal：${roles}`);
    }
  });
});

describe('只持 super_admin 的账号必须能进入每一个前端受保护页面', () => {
  // 这一组就是线上故障的直接复现。修复前，全部 4 条为 false。
  for (const [name, required] of ALL_GATES) {
    test(`super_admin 通过 ${name}`, () => {
      assert.equal(
        hasAnyRole([SUPER_ADMIN_ROLE], required),
        true,
        `只持 super_admin 的账号被 ${name} 拒绝了 —— 这就是"登录成功但每个页面都` +
          '显示无权访问"的线上故障。后端对同一账号是放行的' +
          '（authorization.service.ts 显式 return true），前端不得更严。',
      );
    });
  }

  test('super_admin 即使没有任何附加角色也放行（这正是 bootstrap 创建的形态）', () => {
    assert.equal(hasAnyRole([SUPER_ADMIN_ROLE], []), true);
  });

  test('super_admin 与其它角色混持时同样放行', () => {
    assert.equal(hasAnyRole([SUPER_ADMIN_ROLE, 'visitor'], ADMIN_ROLES), true);
  });
});

describe('放行**仅限** super_admin —— 阴性对照，防止把门开大', () => {
  test('visitor 被每一个白名单拒绝', () => {
    for (const [name, required] of ALL_GATES) {
      assert.equal(
        hasAnyRole(['visitor'], required),
        false,
        `visitor 通过了 ${name} —— 权限被放大了。`,
      );
    }
  });

  test('空角色被拒绝', () => {
    for (const [name, required] of ALL_GATES) {
      assert.equal(hasAnyRole([], required), false, `空角色通过了 ${name}`);
    }
  });

  test('不在白名单里的教学角色仍然被拒（prek_assistant 不得进管理后台）', () => {
    assert.equal(hasAnyRole(['prek_assistant'], ADMIN_ROLES), false);
    assert.equal(hasAnyRole(['k_assistant'], REVIEW_ROLES), false);
  });
});

describe('普通角色仍然按白名单正常放行（修复没有影响正常路径）', () => {
  test('principal 通过全部四个白名单', () => {
    for (const [name, required] of ALL_GATES) {
      assert.equal(hasAnyRole(['principal'], required), true, `principal 被 ${name} 拒绝`);
    }
  });

  test('白名单内的教学角色按原样放行', () => {
    assert.equal(hasAnyRole(['prek_head'], TEACHER_ROLES), true);
    assert.equal(hasAnyRole(['pe_specialist'], UPLOAD_ROLES), true);
    assert.equal(hasAnyRole(['curriculum_director'], REVIEW_ROLES), true);
  });

  test('空 requiredRoles 表示"只要登录即可"', () => {
    assert.equal(hasAnyRole([], []), true);
    assert.equal(hasAnyRole(['visitor'], []), true);
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
