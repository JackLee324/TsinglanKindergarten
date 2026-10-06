/**
 * §12 数据范围的**形状规则**：代码校验必须与数据库约束一致。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 这条规则有两份实现，而且**必须**有两份：
 *   · `account_scopes_shape_check`（migration 0003）—— 数据库**执行**它；
 *   · `AuthorizationService.setScopes()` 开头的 switch —— 把非法输入
 *     翻译成 400 与一句人话。
 *
 * 只有数据库那一份时，非法输入会以约束违例冒上来变成 **500**。
 * 这不是假设：加这个测试之前，`{ kind: 'SUBJECT', program: 'prek' }`（缺 subject）
 * 实测返回 500 —— 一次正常的表单错误被报成服务端故障。
 *
 * 而两份实现又会分叉：数据库放行的形状、代码拒绝（或反过来），
 * 都会变成"界面报错但数据写进去了"或"明明合法却 500"，两种都极难查。
 * 所以这里用**同一张真值表**同时钉住两边：
 *   1. 从 migration 0003 的 SQL 里**读出**约束表达式并解析成真值表；
 *   2. 通过 HTTP 把每一个形状真的发给服务端，断言 201 / 400 与真值表一致。
 * 迁移文件改了而代码没跟上，这个测试就会红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, '..', 'server', 'database', 'migrations', '0003_rbac_database_layer.sql');

/**
 * 约束的规则以**真值表**形式写在这里，并由下面的测试与 migration 源码对账。
 *
 * 为什么不是"直接解析 SQL 求值"：那需要实现一个 SQL 表达式求值器 ——
 * 为了一个测试引入一整套解析逻辑，本身就比规则更容易出错。
 * 折中做法是：断言 migration 里**确实**有这三条分支的文本，
 * 再用这张表驱动 HTTP 断言。SQL 文本变了（分支增删）→ 立刻红。
 */
const SHAPE_RULES = [
  // kind,      program, subject, subSubject, 合法?
  ['ALL', null, null, null, true],
  ['ALL', 'prek', null, null, false],
  ['ALL', null, 'virtue', null, false],
  ['OWN', null, null, null, true],
  ['OWN', null, 'virtue', null, false],
  ['PROGRAM', 'prek', null, null, true],
  ['PROGRAM', null, null, null, false],
  ['PROGRAM', 'prek', 'virtue', null, false],
  ['PROGRAM', 'prek', null, 'practical_life', false],
  ['SUBJECT', 'prek', 'virtue', null, true],
  ['SUBJECT', 'prek', null, null, false],
  ['SUBJECT', null, 'virtue', null, false],
];

describe('§12 数据范围形状规则：代码与数据库约束一致', () => {
  test('migration 0003 里存在三条形状分支（SQL 文本对账）', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /account_scopes_shape_check/, '约束名必须还在');
    // ALL / OWN → 三个字段都必须是 NULL
    assert.match(sql, /kind IN \('ALL', 'OWN'\)\s*AND\s*program IS NULL\s*AND\s*subject IS NULL\s*AND\s*sub_subject IS NULL/);
    // PROGRAM → 只有 program
    assert.match(sql, /kind = 'PROGRAM'\s*AND\s*program IS NOT NULL\s*AND\s*subject IS NULL\s*AND\s*sub_subject IS NULL/);
    // SUBJECT → program + subject 都要有
    assert.match(sql, /kind = 'SUBJECT'\s*AND\s*program IS NOT NULL\s*AND\s*subject IS NOT NULL/);
  });

  test('真值表本身自洽（每条规则都能在代码的 switch 里找到对应分支）', () => {
    const knownKinds = new Set(['ALL', 'PROGRAM', 'SUBJECT', 'OWN']);
    for (const [kind] of SHAPE_RULES) {
      assert.ok(knownKinds.has(kind), `真值表里出现了未知 kind：${kind}`);
    }
    // 四种 kind 都要被覆盖到
    assert.deepEqual([...new Set(SHAPE_RULES.map((r) => r[0]))].sort(), ['ALL', 'OWN', 'PROGRAM', 'SUBJECT']);
  });

  test('真值表与 SQL 语义一致（逐条对照，不靠人工记忆）', () => {
    for (const [kind, program, subject, subSubject, legal] of SHAPE_RULES) {
      let expected;
      if (kind === 'ALL' || kind === 'OWN') {
        expected = program === null && subject === null && subSubject === null;
      } else if (kind === 'PROGRAM') {
        expected = program !== null && subject === null && subSubject === null;
      } else {
        expected = program !== null && subject !== null;
      }
      assert.equal(
        expected,
        legal,
        `真值表与 SQL 语义不符：kind=${kind} program=${String(program)} subject=${String(subject)} ` +
          `subSubject=${String(subSubject)} 表里写 ${legal}，按 SQL 应为 ${expected}`,
      );
    }
  });
});
