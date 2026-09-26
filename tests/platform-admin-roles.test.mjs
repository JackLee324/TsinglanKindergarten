/**
 * tests/platform-admin-roles.test.mjs — 「谁是全平台课程管理员」只能有一个答案
 * ==========================================================================
 * Run with:  npm test   (or: node --test tests/platform-admin-roles.test.mjs)
 *
 * 这是**第三次**出现同一个缺陷形态了，所以这条测试是泛化的。
 *
 * 三次实例
 *   1. `client/src/auth/ProtectedRoute.tsx` + `app.tsx` 的 TEACHER_ROLES 白名单
 *      不含 super_admin → 登录成功后每个受保护页面都是「无权访问」。
 *   2. `client/src/pages/Home/HomePage.tsx` 手写 `roles?.includes('principal')`
 *      → super_admin 首页少三张平台统计卡。
 *   3. `server/modules/resources/resources.service.ts` 自带一份
 *      `ADMIN_ROLES = ['principal','curriculum_director']`，漏掉 super_admin
 *      → **每一个**科目页返回 `403 无该科目查看权限`；前端把 403 当成功响应读
 *      `resp.items` → undefined → `SubjectPage.tsx:252` 的 `resources.length`
 *      抛 TypeError → 整页「页面出现错误」。
 *
 * 第 3 条是线上故障的直接原因，也是本文件存在的原因：它不在前端，不在
 * authorization.service.ts，而在一个**谁都想不到的第三个地方**。
 *
 * 本文件断言什么
 *   1. `shared/rbac.ts` 的 `isPlatformAdmin()` 对 super_admin 恒为 true，对
 *      principal / curriculum_director 为 true；
 *   2. **阴性对照**：教学角色与 visitor 必须为 false —— 没有这一组，本文件只是
 *      在证明"把门开大了"；
 *   3. resources.service.ts **不再自带**一份窄名单，而是用 shared 的判定；
 *   4. 它镜像的 `authorization.service.ts` 仍然对 super_admin 无条件放行。
 *      那条规则一旦改变语义，第 1 条的依据就消失了，本文件必须失败并说明。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rbac = await import(new URL('../shared/rbac.ts', import.meta.url).href);
const { isPlatformAdmin, PLATFORM_ADMIN_ROLES, SUPER_ADMIN_ROLE, ROLE_CODES } = rbac;

const SERVICE = join(ROOT, 'server', 'modules', 'resources', 'resources.service.ts');
const AUTHZ = join(ROOT, 'server', 'modules', 'authz', 'authorization.service.ts');

describe('isPlatformAdmin：super_admin 必须是全平台课程管理员', () => {
  test('只持 super_admin 时为 true（这正是全新部署拿到的账号形态）', () => {
    assert.equal(
      isPlatformAdmin([SUPER_ADMIN_ROLE]),
      true,
      'super_admin 不是全平台课程管理员 —— 这正是线上「每个科目页 403 无该科目查看权限」' +
        '的根因。shared/rbac.ts 声明它持有 scope ALL 的全部权限，authorization.service.ts ' +
        '也据此放行，resources.service.ts 不得更严。',
    );
  });

  test('super_admin 与其它角色混持、顺序不同，结论都不变', () => {
    assert.equal(isPlatformAdmin([SUPER_ADMIN_ROLE, 'visitor']), true);
    assert.equal(isPlatformAdmin(['visitor', SUPER_ADMIN_ROLE]), true);
    assert.equal(isPlatformAdmin([SUPER_ADMIN_ROLE, 'principal']), true);
  });

  test('principal / curriculum_director 仍是全平台课程管理员（原有行为未被削弱）', () => {
    assert.equal(isPlatformAdmin(['principal']), true);
    assert.equal(isPlatformAdmin(['curriculum_director']), true);
  });
});

describe('阴性对照：不能把门开大', () => {
  test('每个非管理角色都不是全平台课程管理员', () => {
    const mustBeFalse = ROLE_CODES.filter(
      (r) => !PLATFORM_ADMIN_ROLES.includes(r) && r !== SUPER_ADMIN_ROLE,
    );
    assert.ok(mustBeFalse.length > 0, 'ROLE_CODES 里没有非管理角色？解析失效了');
    for (const role of mustBeFalse) {
      assert.equal(
        isPlatformAdmin([role]),
        false,
        `${role} 被当成了全平台课程管理员 —— 权限被放大了`,
      );
    }
  });

  test('空角色集不是管理员', () => {
    assert.equal(isPlatformAdmin([]), false);
  });

  test('PLATFORM_ADMIN_ROLES 只含已知角色，且不含 super_admin（它是单独一条通配）', () => {
    for (const r of PLATFORM_ADMIN_ROLES) {
      assert.ok(ROLE_CODES.includes(r), `PLATFORM_ADMIN_ROLES 含未知角色 ${r}`);
    }
    assert.equal(
      PLATFORM_ADMIN_ROLES.includes(SUPER_ADMIN_ROLE),
      false,
      'super_admin 应通过 isPlatformAdmin 的通配分支命中，而不是被塞进这份名单；' +
        '两者的区别是"名单可扩展、通配不可关闭"。',
    );
  });
});

describe('resources.service.ts 不得再自带窄名单', () => {
  const src = readFileSync(SERVICE, 'utf8');

  test('文件里不再有本地 ADMIN_ROLES 常量', () => {
    assert.doesNotMatch(
      src,
      /const ADMIN_ROLES\s*:/,
      'resources.service.ts 又定义了自己的管理员名单。这份名单漏掉 super_admin 造成过' +
        '线上故障（每个科目页 403）；请改用 shared/rbac.ts 的 isPlatformAdmin。',
    );
  });

  test('文件里不再手写 roles 与角色字面量的包含判断', () => {
    const offenders = [...src.matchAll(/(?:ADMIN_ROLES|PLATFORM_ADMIN_ROLES)\.some\(/g)];
    assert.equal(
      offenders.length,
      0,
      'resources.service.ts 又在调用点手写角色包含判断。这类判断在本仓库已经各自演化出' +
        '三次故障；一律改为 isPlatformAdmin(...)。',
    );
  });

  test('它从 shared/rbac 导入 isPlatformAdmin', () => {
    assert.match(
      src,
      /import\s*\{[^}]*\bisPlatformAdmin\b[^}]*\}\s*from\s*'@shared\/rbac'/,
      'resources.service.ts 没有使用共享的 isPlatformAdmin —— 它一旦又自己决定"谁是管理员"，' +
        '就会再次与 shared/rbac.ts 和 authorization.service.ts 不一致。',
    );
  });
});

describe('这条判定镜像的后端规则必须仍然存在', () => {
  const authz = readFileSync(AUTHZ, 'utf8');

  test('authorization.service.ts 仍然对 super_admin 无条件放行', () => {
    assert.match(
      authz,
      /includes\(\s*SUPER_ADMIN_ROLE\s*\)[\s\S]{0,40}?return\s+true/,
      '后端不再对 super_admin 无条件放行了 —— isPlatformAdmin 里的 super_admin 通配就是' +
        '照它写的。请先确认后端语义，再决定这里该怎么改，然后同步更新本文件。',
    );
  });
});
