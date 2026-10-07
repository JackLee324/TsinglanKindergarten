/**
 * 目录：V2 唯一的导航真相。
 *
 * 这里最重要的一条是**业主的核心验收**：
 *   管理员新增一级栏目「活动」→ 刷新 → 侧边栏出现「活动」——不需要改任何代码。
 */
import { test, describe, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  runProjectScript,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'

let admin
let prekVirtue

/** 在树里按 slug 路径找节点（拿 id + 名字）。 */
function findNode(roots, path) {
  const segments = path.split('/')
  let list = roots
  let found = null
  for (const segment of segments) {
    found = list.find((n) => n.slug === segment)
    if (!found) return null
    list = found.children
  }
  return found
}

before(async () => {
  await resetDatabase()
  await createAdmin('d_admin', 'DirAdminPass!1')
  prekVirtue = await directoryIdByPath('education/pre-k/virtue')
  await startServer()
  admin = client()
  await admin.login('d_admin', 'DirAdminPass!1')
})
after(async () => {
  await stopServer()
})

describe('PDF 初始目录', () => {
  test('两个一级栏目：教育教学 / 教师成长', async () => {
    const res = await admin.get('/api/directories/tree')
    assert.equal(res.status, 200)
    assert.deepEqual(
      res.data.roots.map((r) => r.slug),
      ['education', 'growth'],
    )
  })

  test('Pre-K 下四个科目齐全，含「英文」（业主明确要求保留）', async () => {
    const res = await admin.get('/api/directories/tree')
    const preK = findNode(res.data.roots, 'education/pre-k')
    assert.deepEqual(
      preK.children.map((c) => c.name),
      ['美德', '蒙特梭利', '体能', '英文'],
    )
  })

  test('K → 中文教学下四个子科目（含美育）', async () => {
    const res = await admin.get('/api/directories/tree')
    const chinese = findNode(res.data.roots, 'education/k/chinese')
    assert.deepEqual(
      chinese.children.map((c) => c.name),
      ['绘本阅读', '古诗', 'STEM', '美育'],
    )
  })

  test('每个末级科目下是四类资料夹', async () => {
    const res = await admin.get('/api/directories/tree')
    const virtue = findNode(res.data.roots, 'education/pre-k/virtue')
    assert.deepEqual(
      virtue.children.map((c) => c.name),
      ['课程大纲', '教学详案', '教学资源', '考核评估'],
    )
  })

  test('教师成长：师风师德建设与应急预案两级都在', async () => {
    const res = await admin.get('/api/directories/tree')
    const conduct = findNode(res.data.roots, 'growth/l1/ethics/conduct')
    assert.equal(conduct?.name, '师风师德建设')
    const plan = findNode(res.data.roots, 'growth/l1/safety/plan')
    assert.deepEqual(
      plan.children.map((c) => c.name),
      ['传染病识别与防治', '意外伤害预防与处置'],
    )
  })

  test('自建文件夹只在教学详案 / 教学资源开放（PDF 标注处）', async () => {
    const res = await admin.get('/api/directories/tree')
    const virtue = findNode(res.data.roots, 'education/pre-k/virtue')
    const flags = Object.fromEntries(virtue.children.map((c) => [c.name, c.allowCustomFolders]))
    assert.deepEqual(flags, {
      课程大纲: false,
      教学详案: true,
      教学资源: true,
      考核评估: false,
    })
  })

  test('只有资料夹允许放资源，班型/科目层不允许', async () => {
    const res = await admin.get('/api/directories/tree')
    assert.equal(findNode(res.data.roots, 'education/pre-k').allowFiles, false)
    assert.equal(findNode(res.data.roots, 'education/pre-k/virtue').allowFiles, false)
    assert.equal(findNode(res.data.roots, 'education/pre-k/virtue/resources').allowFiles, true)
  })
})

describe('新增一级栏目（业主的核心验收）', () => {
  test('新增「活动」后立刻出现在树里，且路径可解析', async () => {
    const created = await admin.post('/api/directories', {
      name: '活动',
      nameEn: 'Activities',
      slug: 'activities',
      type: 'ROOT',
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    assert.equal(created.data.slug, 'activities')
    assert.equal(created.data.parentId, null)

    const tree = await admin.get('/api/directories/tree')
    const node = findNode(tree.data.roots, 'activities')
    assert.ok(node, '刷新后必须出现在树里')
    assert.equal(node.name, '活动')

    const byPath = await admin.get('/api/directories/by-path?path=activities')
    assert.equal(byPath.data.node.slug, 'activities')
  })

  test('「活动」下可以继续建子目录（2027 春季活动 / 春游）', async () => {
    const tree = await admin.get('/api/directories/tree')
    const activities = findNode(tree.data.roots, 'activities')

    const spring = await admin.post('/api/directories', {
      parentId: activities.id,
      name: '2027 春季活动',
      slug: 'spring-2027',
    })
    assert.equal(spring.status, 201, JSON.stringify(spring.data))

    for (const [slug, name] of [
      ['spring-outing', '春游'],
      ['childrens-day', '六一'],
      ['graduation', '毕业典礼'],
    ]) {
      const res = await admin.post('/api/directories', {
        parentId: spring.data.id,
        name,
        slug,
      })
      assert.equal(res.status, 201, JSON.stringify(res.data))
    }

    const after = await admin.get('/api/directories/tree')
    const deep = findNode(after.data.roots, 'activities/spring-2027')
    assert.deepEqual(
      deep.children.map((c) => c.name),
      ['春游', '六一', '毕业典礼'],
    )
  })

  test('中文名生成不出 slug 时必须显式给，而不是编造一个', async () => {
    const res = await admin.post('/api/directories', { name: '校历', type: 'ROOT' })
    assert.equal(res.status, 403)
    assert.match(String(res.data.message), /slug/)
  })

  test('同级 slug 冲突时自动追加序号（不报错、不覆盖）', async () => {
    const res = await admin.post('/api/directories', {
      name: '另一个活动',
      slug: 'activities',
      type: 'ROOT',
    })
    assert.equal(res.status, 201)
    assert.equal(res.data.slug, 'activities-2')
  })
})

describe('改名：display 变，slug 与 URL 不变', () => {
  test('美德 → 美德课程，slug 仍是 virtue', async () => {
    const before = await admin.get(`/api/directories/${prekVirtue}`)
    assert.equal(before.data.name, '美德')
    assert.equal(before.data.path, 'education/pre-k/virtue')

    const res = await admin.patch(`/api/directories/${prekVirtue}`, { name: '美德课程' })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.name, '美德课程')
    assert.equal(res.data.slug, 'virtue', 'slug 必须不变')
    assert.equal(res.data.path, 'education/pre-k/virtue', 'URL 路径必须不变')

    const tree = await admin.get('/api/directories/tree')
    assert.equal(findNode(tree.data.roots, 'education/pre-k/virtue').name, '美德课程')
  })

  test('英文名与说明也可以改，且清空说明落成 null', async () => {
    const res = await admin.patch(`/api/directories/${prekVirtue}`, {
      nameEn: 'Virtue Course',
      description: '美德课程说明',
    })
    assert.equal(res.status, 200)
    assert.equal(res.data.nameEn, 'Virtue Course')
    assert.equal(res.data.description, '美德课程说明')

    const cleared = await admin.patch(`/api/directories/${prekVirtue}`, { description: null })
    assert.equal(cleared.data.description, null)
  })

  test('改名不会改动 slug / parentId / id', async () => {
    const res = await admin.patch(`/api/directories/${prekVirtue}`, { name: '美德' })
    assert.equal(res.data.id, prekVirtue)
    assert.equal(res.data.slug, 'virtue')
    assert.equal(res.data.parentId, await directoryIdByPath('education/pre-k'))
  })

  test('系统目录（PDF 初始目录）也能改名 —— 没有 isSystem 限制', async () => {
    const growthId = await directoryIdByPath('growth')
    const res = await admin.patch(`/api/directories/${growthId}`, { name: '教师成长（改名验证）' })
    assert.equal(res.status, 200)
    assert.equal(res.data.name, '教师成长（改名验证）')
    await admin.patch(`/api/directories/${growthId}`, { name: '教师成长' })
  })
})

describe('排序 / 启停', () => {
  test('↑ 交换相邻节点的顺序，刷新后保持', async () => {
    const tree = await admin.get('/api/directories/tree')
    const preK = findNode(tree.data.roots, 'education/pre-k')
    const second = preK.children[1]

    const res = await admin.post(`/api/directories/${second.id}/reorder`, { direction: 'up' })
    assert.equal(res.status, 201, JSON.stringify(res.data))

    const after = await admin.get('/api/directories/tree')
    assert.equal(findNode(after.data.roots, 'education/pre-k').children[0].id, second.id)
  })

  test('停用后教师看不到，管理员仍能看到', async () => {
    const tree = await admin.get('/api/directories/tree')
    const english = findNode(tree.data.roots, 'education/pre-k/english')
    await admin.patch(`/api/directories/${english.id}`, { enabled: false })

    // ⚠️ 这条测试曾经是**空过**的：教师的授权在「美德」上，而停用的是「英文」——
    // 他本来也看不到英文，所以"看不到"什么也证明不了。
    // 现在把授权放在**班型**上，让教师确实有权限看到英文，再看它是否被停用隐藏。
    await createTeacher('dir_teacher', 'DirTeacherPass!1', [
      { permission: 'resource.view', directoryId: await directoryIdByPath('education/pre-k') },
    ])
    const tc = client()
    await tc.login('dir_teacher', 'DirTeacherPass!1')
    const teacherTree = await tc.get('/api/directories/tree')
    assert.equal(findNode(teacherTree.data.roots, 'education/pre-k/english'), null, '教师不该看到停用节点')

    const adminTree = await admin.get('/api/directories/tree')
    assert.ok(findNode(adminTree.data.roots, 'education/pre-k/english'), '管理员应看到')

    await admin.patch(`/api/directories/${english.id}`, { enabled: true })
  })
})

describe('删除保护', () => {
  test('有子节点 → 409，且提示可读', async () => {
    const res = await admin.del(`/api/directories/${await directoryIdByPath('education/k')}`)
    assert.equal(res.status, 409)
    assert.equal(res.data.code, 'DIRECTORY_HAS_CHILDREN')
    assert.match(res.data.message, /先删除或移动/)
  })

  test('有资源（含回收站）→ 409，绝不级联删资源', async () => {
    const resourcesId = await directoryIdByPath('education/pre-k/virtue/resources')
    const created = await admin.post('/api/resources', {
      directoryId: resourcesId,
      title: '删除保护探针',
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))

    const res = await admin.del(`/api/directories/${resourcesId}`)
    assert.equal(res.status, 409)
    assert.equal(res.data.code, 'DIRECTORY_HAS_RESOURCES')

    // 资源还在（没有被级联删除）
    const still = await admin.get(`/api/resources/${created.data.id}`)
    assert.equal(still.status, 200)

    await admin.post(`/api/resources/${created.data.id}/purge`)
    const gone = await admin.get(`/api/resources/${created.data.id}`)
    assert.equal(gone.status, 404)

    // 清干净之后可以删（这里验证的是"空目录可删"这条路径本身是通的）
    const removable = await admin.post('/api/directories', {
      parentId: activitiesRootId(await admin.get('/api/directories/tree')),
      name: '待删空目录',
      slug: 'to-be-deleted',
    })
    assert.equal(removable.status, 201)
    const ok = await admin.del(`/api/directories/${removable.data.id}`)
    assert.equal(ok.status, 200, JSON.stringify(ok.data))
  })
})

function activitiesRootId(tree) {
  return findNode(tree.data.roots, 'activities').id
}

// ===========================================================================
// 阶段 3：`enabled` 的真实语义、删除保护、以及"改名不动 slug"的硬保证
// ===========================================================================
// 这一组全部来自实测发现的缺口（四个缺口都用探针脚本复现过）：
//   ① 停用父节点后，子节点会被**提升成顶层**（孤児挂到根上）
//   ② 停用（或上级停用）的目录仍可被**直接调接口**写入
//   ③ by-path 仍会解析进停用节点
//   ④ 删除仍有授权挂靠的目录会**静默级联删除授权**（2 行 → 1 行，无提示）
describe('阶段 3：停用的真实语义（整棵子树一起停用）', () => {
  // 每条测试结束后**无条件**把停用状态还原。
  // 放在 afterEach 而不是测试体末尾：断言失败会让测试体提前退出，
  // 写在末尾的清理就不会执行，接着把后面几条测试一起带红。
  afterEach(async () => {
    for (const id of [preKId, virtueId, virtueResourcesId]) {
      if (id) await admin.patch(`/api/directories/${id}`, { enabled: true })
    }
  })

  let scopeTeacher
  let preKId
  let virtueId
  let virtueResourcesId

  before(async () => {
    preKId = await directoryIdByPath('education/pre-k')
    virtueId = await directoryIdByPath('education/pre-k/virtue')
    virtueResourcesId = await directoryIdByPath('education/pre-k/virtue/resources')

    // 授权放在**整个「教育教学」**上：这样教师既有权限看到 Pre-K，也有权限看到 K。
    // 只有"本来看得见"的东西消失了，才证明得了"停用会隐藏"；
    // 同时能证明**同级节点不受影响**（K 必须还在）。
    const educationId = await directoryIdByPath('education')
    await createTeacher(
      'stage3_teacher',
      'Stage3TeacherPass!1',
      [
        { permission: 'resource.view', directoryId: educationId },
        { permission: 'resource.create', directoryId: educationId },
      ],
      '阶段三老师',
    )
    scopeTeacher = client()
    await scopeTeacher.login('stage3_teacher', 'Stage3TeacherPass!1')
  })

  test('停用父节点 → 整棵子树对教师消失，且不会有子节点被提升成顶层', async () => {
    const before = await scopeTeacher.get('/api/directories/tree')
    assert.ok(findNode(before.data.roots, 'education/pre-k/virtue'), '停用前应能看到美德')

    await admin.patch(`/api/directories/${preKId}`, { enabled: false })
    const after = await scopeTeacher.get('/api/directories/tree')

    const serialized = JSON.stringify(after.data)
    for (const leaked of ['"slug":"virtue"', '"slug":"montessori"', '"slug":"pre-k"']) {
      assert.ok(!serialized.includes(leaked), `${leaked} 泄漏到教师树里（孤児被提升为顶层）`)
    }
    assert.deepEqual(
      after.data.roots.map((r) => r.slug),
      ['education'],
      '美德 / 蒙台梭利 / 体能 / 英文 不能变成与「教育教学」并列的一级栏目',
    )
    assert.deepEqual(
      findNode(after.data.roots, 'education').children.map((c) => c.slug),
      ['k'],
      '同级的 K 仍然要在',
    )

    await admin.patch(`/api/directories/${preKId}`, { enabled: true })
  })

  test('停用节点对普通教师返回 404（不是 403，也不泄露存在）', async () => {
    await admin.patch(`/api/directories/${virtueId}`, { enabled: false })
    const res = await scopeTeacher.get(`/api/directories/${virtueId}`)
    assert.equal(res.status, 404, JSON.stringify(res.data))

    // 管理员仍然拿得到（要在管理界面里重新启用它）
    const adminRes = await admin.get(`/api/directories/${virtueId}`)
    assert.equal(adminRes.status, 200)
    assert.equal(adminRes.data.enabled, false)

    await admin.patch(`/api/directories/${virtueId}`, { enabled: true })
  })

  test('by-path 停在最近一个可用祖先，而不是解析进停用节点', async () => {
    await admin.patch(`/api/directories/${virtueId}`, { enabled: false })
    const res = await scopeTeacher.get('/api/directories/by-path?path=education/pre-k/virtue/resources')
    assert.equal(res.data.node.slug, 'pre-k', '应回退到 Pre-K')
    assert.equal(res.data.resolvedCount, 2)
    assert.deepEqual(res.data.restSegments, ['virtue', 'resources'])
    await admin.patch(`/api/directories/${virtueId}`, { enabled: true })
  })

  test('停用目录（或上级停用）不能建资源 —— 界面上藏按钮不算数', async () => {
    const baseline = await scopeTeacher.post('/api/resources', {
      directoryId: virtueResourcesId,
      title: '停用测试基线',
    })
    assert.equal(baseline.status, 201, JSON.stringify(baseline.data))

    // ① 自己停用
    await admin.patch(`/api/directories/${virtueResourcesId}`, { enabled: false })
    const self = await scopeTeacher.post('/api/resources', {
      directoryId: virtueResourcesId,
      title: '停用后建',
    })
    assert.equal(self.status, 409, JSON.stringify(self.data))
    await admin.patch(`/api/directories/${virtueResourcesId}`, { enabled: true })

    // ② 上级停用（自己仍然 enabled）—— 这条最容易漏
    await admin.patch(`/api/directories/${preKId}`, { enabled: false })
    const ancestor = await scopeTeacher.post('/api/resources', {
      directoryId: virtueResourcesId,
      title: '上级停用后建',
    })
    assert.equal(ancestor.status, 409, JSON.stringify(ancestor.data))
    await admin.patch(`/api/directories/${preKId}`, { enabled: true })
  })

  test('停用节点下不能新建子目录', async () => {
    await admin.patch(`/api/directories/${virtueResourcesId}`, { enabled: false })
    const res = await admin.post('/api/directories', {
      parentId: virtueResourcesId,
      name: '不该建出来',
      slug: 'should-not-exist',
    })
    assert.equal(res.status, 409, JSON.stringify(res.data))
    await admin.patch(`/api/directories/${virtueResourcesId}`, { enabled: true })
  })
})

describe('阶段 3：删除保护（三种保护，缺一不可）', () => {
  test('有子节点 → 409 DIRECTORY_HAS_CHILDREN', async () => {
    const parent = await admin.post('/api/directories', {
      name: '删除保护-父级',
      slug: 'del-protect-parent',
      type: 'ROOT',
    })
    assert.equal(parent.status, 201, JSON.stringify(parent.data))
    const child = await admin.post('/api/directories', {
      parentId: parent.data.id,
      name: '子目录',
      slug: 'child',
    })
    assert.equal(child.status, 201, JSON.stringify(child.data))

    const res = await admin.del(`/api/directories/${parent.data.id}`)
    assert.equal(res.status, 409, JSON.stringify(res.data))
    assert.equal(res.data.code, 'DIRECTORY_HAS_CHILDREN')

    await admin.del(`/api/directories/${child.data.id}`)
    const after = await admin.del(`/api/directories/${parent.data.id}`)
    assert.equal(after.status, 200, JSON.stringify(after.data))
  })

  test('有资源 → 409 DIRECTORY_HAS_RESOURCES', async () => {
    // 用一个**本测试自己建的**目录，而不是 PDF 里的小学节点 ——
    // 否则一旦断言失败，就会把一个种子节点删掉，污染后面的测试。
    const holder = await admin.post('/api/directories', {
      name: '删除保护-容器',
      slug: 'del-protect-holder',
      type: 'ROOT',
      allowFiles: true,
    })
    assert.equal(holder.status, 201, JSON.stringify(holder.data))

    const created = await admin.post('/api/resources', {
      directoryId: holder.data.id,
      title: '删除保护-资源',
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))

    const res = await admin.del(`/api/directories/${holder.data.id}`)
    assert.equal(res.status, 409, JSON.stringify(res.data))
    assert.equal(res.data.code, 'DIRECTORY_HAS_RESOURCES')

    // 清干净：先永久删资源，再删目录
    await admin.post(`/api/resources/${created.data.id}/purge`)
    const after = await admin.del(`/api/directories/${holder.data.id}`)
    assert.equal(after.status, 200, JSON.stringify(after.data))
  })

  test('仍有授权挂靠 → 409 DIRECTORY_HAS_PERMISSIONS（不静默级联删除授权）', async () => {
    const node = await admin.post('/api/directories', {
      name: '被授权的目录',
      slug: 'granted-node',
      type: 'ROOT',
    })
    const teacher = await createTeacher('grant_holder', 'GrantHolderPass!1', [
      { permission: 'resource.view', directoryId: node.data.id },
    ])
    const before = await withSql(
      (sql) => sql`SELECT count(*)::int AS n FROM user_permissions WHERE user_id = ${teacher.id}`,
    )
    assert.equal(before[0].n, 1)

    const res = await admin.del(`/api/directories/${node.data.id}`)
    assert.equal(res.status, 409, JSON.stringify(res.data))
    assert.equal(res.data.code, 'DIRECTORY_HAS_PERMISSIONS')

    // 授权还在（没有被动过）
    const after = await withSql(
      (sql) => sql`SELECT count(*)::int AS n FROM user_permissions WHERE user_id = ${teacher.id}`,
    )
    assert.equal(after[0].n, 1, '授权必须原样保留')

    // 解除授权之后就可以删
    await admin.put(`/api/users/${teacher.id}/permissions`, { permissions: [] })
    const ok = await admin.del(`/api/directories/${node.data.id}`)
    assert.equal(ok.status, 200, JSON.stringify(ok.data))
  })
})

describe('阶段 3：slug / id 的稳定性与不可变性', () => {
  test('PATCH 不接受 slug（改 slug 会让所有历史链接失效）', async () => {
    const res = await admin.patch(`/api/directories/${prekVirtue}`, {
      name: '改名可以',
      slug: 'hacked-slug',
    })
    assert.equal(res.status, 400, JSON.stringify(res.data))
    assert.equal(res.data.code, 'VALIDATION_FAILED')

    const node = await admin.get(`/api/directories/${prekVirtue}`)
    assert.equal(node.data.slug, 'virtue', 'slug 必须原样不动')
  })

  test('PATCH 不接受 parentId（移动是独立动作，要查环与同名冲突）', async () => {
    const res = await admin.patch(`/api/directories/${prekVirtue}`, { parentId: null })
    assert.equal(res.status, 400, JSON.stringify(res.data))
  })

  test('改名不改 id、不改 slug、不改 path，URL 继续有效', async () => {
    const before = await admin.get(`/api/directories/${prekVirtue}`)
    await admin.patch(`/api/directories/${prekVirtue}`, { name: '美德课程' })
    const after = await admin.get(`/api/directories/${prekVirtue}`)

    assert.equal(after.data.id, before.data.id)
    assert.equal(after.data.slug, 'virtue')
    assert.equal(after.data.path, before.data.path)
    assert.equal(after.data.name, '美德课程')

    // 老 URL 仍然解析得到同一个节点
    const byPath = await admin.get('/api/directories/by-path?path=education/pre-k/virtue')
    assert.equal(byPath.data.node.id, before.data.id)

    const list = await admin.get('/api/resources?q=virtue')
    assert.equal(list.data.total >= 0, true)
    await admin.patch(`/api/directories/${prekVirtue}`, { name: '美德' })
  })

  test('allowChildren=false 时不能建子目录', async () => {
    const node = await admin.post('/api/directories', {
      name: '不允许下级的目录',
      slug: 'leaf-only',
      type: 'ROOT',
      allowChildren: false,
    })
    assert.equal(node.status, 201, JSON.stringify(node.data))

    const res = await admin.post('/api/directories', {
      parentId: node.data.id,
      name: '子目录',
      slug: 'child',
    })
    assert.equal(res.status, 409, JSON.stringify(res.data))

    await admin.del(`/api/directories/${node.data.id}`)
  })
})

describe('阶段 3：seed 幂等且不覆盖管理员的修改', () => {
  test('重跑 seed：节点数不变，管理员改过的名字不被覆盖', async () => {
    const chosen = await directoryIdByPath('education/pre-k/virtue')
    await admin.patch(`/api/directories/${chosen}`, {
      name: '被管理员改过的名字',
      nameEn: 'Renamed By Admin',
    })
    await admin.patch(`/api/directories/${chosen}`, { allowFiles: true })

    const before = await withSql((sql) => sql`SELECT count(*)::int AS n FROM directories`)
    await runProjectScript('scripts/seed.mjs')
    const after = await withSql((sql) => sql`SELECT count(*)::int AS n FROM directories`)
    // 总数必须不变：seed 不得产生重复节点。
    // （它同时**会**补回被删掉的种子节点 —— 那是正确行为，不是重复；
    //   因此本测试之前的所有用例都必须自己清理干净，不能留下被删的种子节点。）
    assert.equal(after[0].n, before[0].n, '重跑 seed 不能产生重复节点')

    const node = await admin.get(`/api/directories/${chosen}`)
    assert.equal(node.data.name, '被管理员改过的名字', '重跑 seed 不能覆盖管理员改过的名字')
    assert.equal(node.data.nameEn, 'Renamed By Admin')
    assert.equal(node.data.allowFiles, true, '重跑 seed 不能覆盖管理员改过的能力开关')

    // 还原
    await admin.patch(`/api/directories/${chosen}`, {
      name: '美德',
      nameEn: 'Virtue',
      allowFiles: false,
    })
  })

  test('seed 之后 PDF 要求的两个节点仍然存在', async () => {
    const tree = await admin.get('/api/directories/tree')
    assert.ok(findNode(tree.data.roots, 'education/pre-k/english'), 'Pre-K → 英文 必须保留')
    assert.ok(findNode(tree.data.roots, 'growth/l1/ethics/conduct'), '职业道德规范 → 师风师德建设 必须保留')
    assert.ok(findNode(tree.data.roots, 'growth'), '教师成长是一等目录（parentId 为 null）')
    assert.equal(findNode(tree.data.roots, 'growth').parentId, null)
  })
})
