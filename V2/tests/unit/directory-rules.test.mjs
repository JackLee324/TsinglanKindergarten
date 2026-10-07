/**
 * 目录的 slug 规则与深度上限。
 *
 * 关键一条：**中文名生成不出可读 slug 时必须报错，而不是编造一个 node-1。**
 * 业主的要求是 URL 可读（`/directory/pre-k/virtue`），编造的值会让它永远读不懂。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { directoryRules } from '../helpers/modules.mjs'
const { slugifyCandidate, slugWithSuffix, isValidSlug, MAX_DIRECTORY_DEPTH, DIRECTORY_TYPES } =
  directoryRules

describe('目录 slug 规则', () => {
  test('英文名可以规范化', () => {
    assert.equal(slugifyCandidate('Teaching Resources'), 'teaching-resources')
    assert.equal(slugifyCandidate('  Pre-K  '), 'pre-k')
    assert.equal(slugifyCandidate('STEM!!'), 'stem')
  })

  test('中文名得不到 slug（而不是硬凑一个）', () => {
    assert.equal(slugifyCandidate('美德'), '')
    assert.equal(slugifyCandidate('师风师德建设'), '')
  })

  test('同级冲突时追加序号', () => {
    assert.equal(slugWithSuffix('virtue', 1), 'virtue')
    assert.equal(slugWithSuffix('virtue', 2), 'virtue-2')
    assert.equal(slugWithSuffix('virtue', 3), 'virtue-3')
  })

  test('序号后长度仍然合法（不超过 64）', () => {
    const long = 'a'.repeat(64)
    const candidate = slugWithSuffix(long, 12)
    assert.ok(candidate.length <= 64)
    assert.ok(isValidSlug(candidate))
  })

  test('非法 slug 被拒：大写、下划线、空格、前导连字符', () => {
    for (const bad of ['Virtue', 'tea_ching', 'tea ching', '-virtue', 'virtue-', '虚拟']) {
      assert.equal(isValidSlug(bad), false, `${bad} 不应通过`)
    }
    for (const good of ['virtue', 'pre-k', 'stem', 'a', 'l1', 'picture-books']) {
      assert.equal(isValidSlug(good), true, `${good} 应通过`)
    }
  })

  test('深度上限是一个明确的数字', () => {
    assert.equal(MAX_DIRECTORY_DEPTH, 12)
  })

  test('目录类型只有四个，且**没有任何业务规则按它分支**（此测试只固定枚举）', () => {
    assert.deepEqual([...DIRECTORY_TYPES], ['ROOT', 'CATEGORY', 'SECTION', 'FOLDER'])
  })
})
