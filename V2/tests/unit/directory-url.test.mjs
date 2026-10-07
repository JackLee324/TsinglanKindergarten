/**
 * tests/unit/directory-url.test.mjs —— `path.ts` 是"改名不让链接失效"的可测部分
 * ============================================================================
 * 服务端保证「改 name 不动 slug」；前端保证「URL 只由 slug 生成」。
 * 这两条合起来才等于"改中文名不会让任何链接失效"。前者在集成测试里验，
 * 后者是纯函数，在这里验。
 *
 * 它是 `client/src/directory/path.ts` 的**唯一**实现 —— 页面、侧边栏、
 * 面包屑、卡片全部调它，任何组件都不允许自己拼 `/directory/...`。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// 直接用 Node 的类型剥离加载 .ts（`path.ts` 只有 `import type`，会被擦除，
// 因此不需要 Vite 的别名解析）。测的是**将要打进包里的那份源码**。
const { directoryUrl, isWithinPath, resolveInTree, segmentsToPath, DIRECTORY_BASE } = await import(
  '../../client/src/directory/path.ts'
)

/** 造一个最小可用的节点，只保留解析需要的字段。 */
function node(slug, children = [], extra = {}) {
  return {
    id: `id-${slug}`,
    parentId: null,
    slug,
    name: slug,
    nameEn: null,
    description: null,
    type: 'SECTION',
    sortOrder: 0,
    enabled: true,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
    icon: null,
    path: slug,
    capabilities: {
      canManage: false,
      canCreateChild: false,
      canUpload: false,
      canCreateFolder: false,
    },
    resourceCount: 0,
    children,
    ...extra,
  }
}

const education = node('education', [
  node('pre-k', [node('virtue', [node('resources')]), node('english')]),
  node('k'),
])
const growth = node('growth', [node('l1', [node('safety')])])
const TREE = [education, growth]

describe('目录 URL 只由 slug 生成', () => {
  test('根层与深层', () => {
    assert.equal(directoryUrl(''), DIRECTORY_BASE)
    assert.equal(directoryUrl('education'), '/directory/education')
    assert.equal(directoryUrl('education/pre-k/virtue'), '/directory/education/pre-k/virtue')
  })

  test('结尾斜杠与空段被规范化', () => {
    assert.equal(directoryUrl('education//pre-k/'), '/directory/education/pre-k')
    assert.equal(segmentsToPath(['education', '', 'pre-k']), 'education/pre-k')
  })

  test('**没有任何**写死的名字参与生成（改中文名不影响 URL）', () => {
    // 把节点的 name 改成中文，URL 完全不变 —— 这正是业主的验收点。
    const renamed = { ...education, name: '教育教学（改名）' }
    assert.equal(directoryUrl(renamed.path), directoryUrl(education.path))
  })
})

describe('路径归属判断（侧边栏高亮与面包屑用）', () => {
  test('自身、子路径都算"在内"，兄弟不算', () => {
    assert.equal(isWithinPath('education/pre-k', 'education'), true)
    assert.equal(isWithinPath('education/pre-k', 'education/pre-k'), true)
    assert.equal(isWithinPath('education', 'education/pre-k'), false)
    assert.equal(isWithinPath('growth/l1', 'education'), false)
  })

  test('前缀相同但不是路径段的边界不算在内', () => {
    // `education-extra` 不该被当成 `education` 的子路径
    assert.equal(isWithinPath('education-extra', 'education'), false)
  })

  test('空路径代表根，任何路径都在根之下', () => {
    assert.equal(isWithinPath('anything/at/all', ''), true)
  })
})

describe('在已加载的树里按 slug 解析', () => {
  test('逐级解析并给出完整祖先链', () => {
    const target = resolveInTree(TREE, ['education', 'pre-k', 'virtue'])
    assert.equal(target.node.slug, 'virtue')
    assert.deepEqual(
      target.chain.map((n) => n.slug),
      ['education', 'pre-k', 'virtue'],
    )
    assert.equal(target.resolvedCount, 3)
    assert.deepEqual(target.restSegments, [])
  })

  test('空路径 → 根列表（node 为 null，chain 为空）', () => {
    const target = resolveInTree(TREE, [])
    assert.equal(target.node, null)
    assert.deepEqual(target.chain, [])
    assert.equal(target.resolvedCount, 0)
  })

  test('解析失败时退到**最近一个可解析的祖先**，并如实报告剩余段', () => {
    const target = resolveInTree(TREE, ['education', 'pre-k', 'not-here', 'deeper'])
    assert.equal(target.node.slug, 'pre-k')
    assert.equal(target.resolvedCount, 2)
    assert.deepEqual(target.restSegments, ['not-here', 'deeper'])
  })

  test('第一段就不存在 → 一段都没解析到（由界面显示"找不到这个目录"）', () => {
    const target = resolveInTree(TREE, ['nope'])
    assert.equal(target.node, null)
    assert.equal(target.resolvedCount, 0)
    assert.deepEqual(target.restSegments, ['nope'])
  })

  test('教师成长与教育教学是**同级**：都在根列表里，路径等深', () => {
    const a = resolveInTree(TREE, ['education', 'pre-k'])
    const b = resolveInTree(TREE, ['growth', 'l1', 'safety'])
    assert.equal(a.resolvedCount, 2)
    assert.equal(b.resolvedCount, 3)
    assert.deepEqual(b.chain.map((n) => n.slug), ['growth', 'l1', 'safety'])
  })

  test('解析结果只依赖 slug —— 改名之后同一个 URL 仍然解析到同一个节点', () => {
    const before = resolveInTree(TREE, ['education', 'pre-k', 'virtue'])
    const renamedTree = [
      node('education', [node('pre-k', [node('virtue', [], { name: '美德课程' })])]),
      growth,
    ]
    const after = resolveInTree(renamedTree, ['education', 'pre-k', 'virtue'])
    assert.equal(after.node.id, before.node.id)
    assert.equal(after.node.name, '美德课程', '名字变了')
    assert.equal(after.resolvedCount, 3, '地址没变')
  })
})
