/**
 * 目录：V2 唯一的导航真相。
 *
 * 这里最重要的一条是**业主的核心验收**：
 *   管理员新增一级栏目「活动」→ 刷新 → 侧边栏出现「活动」——不需要改任何代码。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
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

    await createTeacher('dir_teacher', 'DirTeacherPass!1', [
      { permission: 'resource.view', directoryId: prekVirtue },
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
