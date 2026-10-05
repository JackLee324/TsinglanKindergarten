/**
 * tests/curriculum-structure-isolation.test.mjs — 课程结构不得被"用户 A 改掉给用户 B 看"
 * =================================================================================
 * Run with:  npm test
 *
 * 已证实的缺陷（不是预防性测试）
 * ------------------------------
 * `CurriculumService.getStructure()` 以前：
 *   1. 管理员路径 `return PROGRAM_STRUCTURES;` —— 返回**模块级数组本身**；
 *   2. 非管理员路径 `result.push(prekProgram)` —— push 的是**同一个对象**，不是拷贝；
 *   3. `hasPeSpecialist` 分支随后 `existing.subjects.push(peSubject)` —— 原地追加。
 *
 * 合并后果：一个同时持有 prek_head + pe_specialist 的账号发一次请求，就会把「体能」
 * 永久追加进全局 Pre-K 科目表；此后所有账号（含只有 prek_assistant 的配班老师、乃至
 * visitor）看到的都是被改过的结构。数组在模块作用域里，不随请求结束恢复。
 *
 * 为什么这里测的是**数据模块**而不是 service
 * ----------------------------------------
 * `CurriculumService` 带 `@Injectable()` 装饰器，而 Node 的原生类型擦除
 * （本仓库测试用的别名 loader）**不支持装饰器**，直接 import 会抛
 * `SyntaxError: Invalid or unexpected token`。这是本仓库既有的测试边界：
 * Nest 服务一律通过 HTTP 套件（scripts/verify-*.mjs）验证。
 * 所以本文件守住**机制**那一半（共享数据不可被就地修改）；
 * HTTP 那一半（同一角色反复请求结果稳定）由 scripts/verify-authz-http.mjs 覆盖。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// curriculum.data.ts 通过 `@shared/...` 别名导入，必须注册别名 loader（同其它 TS 测试）
register('./helpers/ts-alias-loader.mjs', import.meta.url);

const data = await import(
  new URL('../server/modules/curriculum/curriculum.data.ts', import.meta.url).href
);
const { PROGRAM_STRUCTURES, FOLDER_DEFINITIONS } = data;

const PREK = (rows) => rows.find((p) => p.program === 'prek');
const keys = (program) => program.subjects.map((s) => s.key).sort();

describe('共享课程数据必须被深冻结（结构性防线）', () => {
  test('PROGRAM_STRUCTURES 及其嵌套数组/对象全部 frozen', () => {
    assert.equal(Object.isFrozen(PROGRAM_STRUCTURES), true, '顶层数组可被 push');
    for (const program of PROGRAM_STRUCTURES) {
      assert.equal(Object.isFrozen(program), true, program.program + ' 对象可被改');
      assert.equal(Object.isFrozen(program.subjects), true, program.program + '.subjects 可被 push');
      for (const subject of program.subjects) {
        assert.equal(Object.isFrozen(subject), true, program.program + '/' + subject.key + ' 可被改');
      }
    }
  });

  test('FOLDER_DEFINITIONS 同样被冻结', () => {
    assert.equal(Object.isFrozen(FOLDER_DEFINITIONS), true);
  });

  test('**旧缺陷的写法现在会立刻抛错**，而不是悄悄污染全局', () => {
    // 这正是 getStructure() 的 hasPeSpecialist 分支当年做的事
    const prek = PREK(PROGRAM_STRUCTURES);
    const peSubject = prek.subjects.find((s) => s.key === 'physical_education');
    assert.throws(
      () => { prek.subjects.push(peSubject); },
      TypeError,
      '对共享 subjects 的 push 竟然成功了 —— 深冻结失效，全局污染又可能发生',
    );
  });

  test('冻结不改变内容：深拷贝与原件逐字相同（服务层 clone 的忠实性）', () => {
    const copy = structuredClone(PROGRAM_STRUCTURES);
    assert.deepEqual(copy, PROGRAM_STRUCTURES);
    copy[0].subjects.push({ key: 'forged', name: 'x', nameEn: 'x' });
    assert.equal(Object.isFrozen(PROGRAM_STRUCTURES[0].subjects), true);
    assert.notEqual(copy[0].subjects.length, PROGRAM_STRUCTURES[0].subjects.length);
  });
});

describe('阴性对照：数据本身必须仍是完整课程结构', () => {
  test('两个班型都在，且 Pre-K 含体能（供 pe_specialist 过滤）', () => {
    assert.deepEqual(PROGRAM_STRUCTURES.map((p) => p.program).sort(), ['k', 'prek']);
    assert.equal(keys(PREK(PROGRAM_STRUCTURES)).includes('physical_education'), true);
  });

  test('每个科目都有 key/name/nameEn', () => {
    for (const program of PROGRAM_STRUCTURES) {
      for (const subject of program.subjects) {
        for (const field of ['key', 'name', 'nameEn']) {
          assert.equal(typeof subject[field], 'string', program.program + '/' + subject.key + ' 缺 ' + field);
        }
      }
    }
  });
});
