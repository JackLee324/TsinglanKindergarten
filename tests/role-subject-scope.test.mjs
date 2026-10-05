/**
 * tests/role-subject-scope.test.mjs — 「角色 → 数据范围」这条规则只能有一份
 * ====================================================================
 * Run with:  npm test
 *
 * 背景：同一条规则以前在**三个服务**里各写了一遍：
 *   resources.service.ts:407-409,589,594,599
 *   dashboard.service.ts:150-152
 *   curriculum.service.ts:57-61
 * 而"同一条规则被抄 N 遍"正是本仓库 ADMIN_ROLES 那个缺陷连出三次的成因。
 * 现在规则收敛到 shared/rbac.ts 的 roleSubjectScope()；本文件把它的语义钉死。
 *
 * 注意：**这是规则本身的测试**。三个消费者改用它的重构是后续步骤 ——
 * 截至目前只有 curriculum.service.ts 已切换。不要读成本文件已经证明了三个服务已收口。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const rbac = await import(new URL('../shared/rbac.ts', import.meta.url).href);
const { roleSubjectScope, roleScopeCovers } = rbac;

const P = (r) => roleSubjectScope(r);

describe('roleSubjectScope：逐角色语义', () => {
  test('平台管理员 = 全部（含 super_admin）', () => {
    for (const role of ['principal', 'curriculum_director', 'super_admin']) {
      assert.equal(P([role]).all, true, `${role} 应当是全平台`);
    }
  });

  test('prek_head → Pre-K 全部科目；k_head → K 全部科目', () => {
    assert.deepEqual(P(['prek_head']).wholePrograms, ['prek']);
    assert.deepEqual(P(['k_head']).wholePrograms, ['k']);
    assert.equal(roleScopeCovers(P(['prek_head']), 'prek', 'virtue'), true);
    assert.equal(roleScopeCovers(P(['prek_head']), 'k', 'chinese'), false);
  });

  test('pe_specialist → 两个班型的 physical_education，仅此', () => {
    const s = P(['pe_specialist']);
    assert.deepEqual(s.wholePrograms, []);
    assert.equal(roleScopeCovers(s, 'prek', 'physical_education'), true);
    assert.equal(roleScopeCovers(s, 'k', 'physical_education'), true);
    assert.equal(roleScopeCovers(s, 'prek', 'virtue'), false);
    assert.equal(roleScopeCovers(s, 'k', 'chinese'), false);
  });

  test('配班 / visitor → 角色本身不授予任何科目范围（必须查 subject_permissions）', () => {
    for (const role of ['prek_assistant', 'k_assistant', 'visitor']) {
      const s = P([role]);
      assert.equal(s.all, false);
      assert.deepEqual(s.wholePrograms, []);
      assert.deepEqual(s.explicitPairs, []);
      assert.equal(
        s.requiresSubjectPermissions,
        true,
        `${role} 应当标记为"需要查 subject_permissions"，否则会被误判成 403`,
      );
    }
  });

  test('多角色叠加取并集', () => {
    const s = P(['prek_head', 'pe_specialist']);
    assert.deepEqual(s.wholePrograms, ['prek']);
    assert.equal(roleScopeCovers(s, 'k', 'physical_education'), true, 'k 的体能来自 pe_specialist');
    assert.equal(roleScopeCovers(s, 'k', 'chinese'), false);
  });
});

describe('阴性对照：不能把门开大', () => {
  test('空角色集不授予任何范围', () => {
    const s = P([]);
    assert.equal(s.all, false);
    assert.equal(s.requiresSubjectPermissions, true);
  });

  test('任何非管理角色都不得 all=true', () => {
    const nonAdmin = rbac.ROLE_CODES.filter((r) => !rbac.PLATFORM_ADMIN_ROLES.includes(r) && r !== rbac.SUPER_ADMIN_ROLE);
    assert.ok(nonAdmin.length > 0);
    for (const role of nonAdmin) {
      assert.equal(P([role]).all, false, `${role} 被误判成全平台`);
    }
  });

  test('wholePrograms 只可能含已知 program', () => {
    for (const role of rbac.ROLE_CODES) {
      for (const p of P([role]).wholePrograms) {
        assert.ok(['prek', 'k'].includes(p), `${role} 产出了未知 program ${p}`);
      }
    }
  });
});

describe('与三个服务里原实现的语义一致性（逐条对照源码读出的事实）', () => {
  test('resources.service 的两处判定都能用本规则表达', () => {
    // `if (hasPrekHead && program === 'prek') return sql\`true\``
    assert.equal(roleScopeCovers(P(['prek_head']), 'prek', 'anything'), true);
    // `if (hasKHead && program === 'k') return sql\`true\``
    assert.equal(roleScopeCovers(P(['k_head']), 'k', 'anything'), true);
    // `if (hasPeSpecialist && subject === 'physical_education') return sql\`true\``
    assert.equal(roleScopeCovers(P(['pe_specialist']), 'prek', 'physical_education'), true);
    assert.equal(roleScopeCovers(P(['pe_specialist']), 'k', 'physical_education'), true);
  });

  test('dashboard.service 的 roleSubjects 集合与 explicitPairs 一致', () => {
    const pairs = P(['pe_specialist']).explicitPairs.map((p) => `${p.program}:${p.subject}`).sort();
    assert.deepEqual(pairs, ['k:physical_education', 'prek:physical_education']);
  });
});
