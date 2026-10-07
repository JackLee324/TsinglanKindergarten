/**
 * 搜索：标题 / 英文标题 / 描述，并且**结果必须仍然受目录权限限制**。
 *
 * 最危险的一类缺陷是"加了搜索之后越权"：搜索很容易被实现成一个绕过范围过滤的
 * 独立查询路径。这里专门用一条"用搜索去够没权限的资源"来钉住它。
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
import { makeResource, purgeResources } from '../helpers/resource-fixture.mjs'

let admin
let teacher
let t              // 搜索老师本体：它的 id 用作 uploader_id
let other          // 另一位老师：验证"别人的草稿看不见"
let ids = {}
const probes = []

before(async () => {
  await resetDatabase()
  await createAdmin('rs_admin', 'RsAdminPass!1')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.montessoriResources = await directoryIdByPath('education/pre-k/montessori/resources')
  ids.kPeResources = await directoryIdByPath('education/k/pe/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  await startServer()
  admin = client()
  await admin.login('rs_admin', 'RsAdminPass!1')
  t = await createTeacher('rs_t', 'RsTeacherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
  ], '搜索老师')
  // 另一个真实存在的用户：用来验证"别人的草稿我看不到"。
  // 不能编一个假 uuid —— uploader_id 有外键，会被数据库直接拒掉。
  other = await createTeacher('rs_other', 'RsOtherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
  ], '另一位老师')
  teacher = client()
  await teacher.login('rs_t', 'RsTeacherPass!1')

  // 有权限的目录里放三条，字段各不相同
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: t.id,
    title: '春天主题活动', titleEn: 'Spring Theme', description: '关于春天的主题教学',
  }))
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: t.id,
    title: '秋季主题', titleEn: 'Autumn Unit', description: '秋天的自然观察',
  }))
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: t.id,
    title: '无关内容', titleEn: 'Unrelated', description: '这段描述里藏着关键词 winter',
  }))
  // 无权限的目录里放一条，标题故意用同样的关键词 —— 搜索不该够到它
  probes.push(await makeResource({
    directoryId: ids.kPeResources, uploaderId: t.id,
    title: '春天主题活动（K 体能）', titleEn: 'Spring Theme K',
  }))
  probes.push(await makeResource({
    directoryId: ids.montessoriResources, uploaderId: t.id,
    title: '蒙氏春天',
  }))
})
after(async () => {
  const removed = await purgeResources(probes)
  assert.equal(removed, probes.length, '探针必须全部清掉（残留核对）')
  await stopServer()
})

describe('搜索覆盖三类字段', () => {
  test('中文标题', async () => {
    const res = await teacher.get('/api/resources?q=春天主题&pageSize=50')
    assert.equal(res.status, 200)
    assert.ok(res.data.items.some((i) => i.title === '春天主题活动'))
  })

  test('英文标题', async () => {
    const res = await teacher.get('/api/resources?q=Autumn&pageSize=50')
    assert.equal(res.status, 200)
    assert.deepEqual(res.data.items.map((i) => i.title), ['秋季主题'])
  })

  test('描述', async () => {
    const res = await teacher.get('/api/resources?q=winter&pageSize=50')
    assert.equal(res.status, 200)
    assert.deepEqual(res.data.items.map((i) => i.title), ['无关内容'])
  })

  test('匹配不到 → 空列表且 total=0', async () => {
    const res = await teacher.get('/api/resources?q=绝对不存在的关键词&pageSize=50')
    assert.equal(res.status, 200)
    assert.equal(res.data.total, 0)
    assert.deepEqual(res.data.items, [])
  })
})

describe('搜索不能越权', () => {
  test('同样的关键词搜不到无权目录里的资源', async () => {
    const res = await teacher.get('/api/resources?q=春天&pageSize=50')
    assert.equal(res.status, 200)
    const titles = res.data.items.map((i) => i.title)
    assert.ok(
      !titles.includes('春天主题活动（K 体能）'),
      `搜索够到了无权目录里的资源：${JSON.stringify(titles)}`,
    )
    assert.ok(!titles.includes('蒙氏春天'), `搜索够到了无权目录里的资源：${JSON.stringify(titles)}`)
    assert.deepEqual(titles.sort(), ['春天主题活动'].sort())
  })

  test('管理员用同样的关键词能看到全部（证明不是"搜不到"而是"按权限过滤"）', async () => {
    const res = await admin.get('/api/resources?q=春天&pageSize=50')
    assert.equal(res.status, 200)
    const titles = res.data.items.map((i) => i.title).sort()
    assert.deepEqual(titles, ['春天主题活动', '春天主题活动（K 体能）', '蒙氏春天'].sort())
  })

  test('指定无权目录 + 搜索 → 403（不是空列表）', async () => {
    const res = await teacher.get(`/api/resources?directoryId=${ids.kPeResources}&q=春天`)
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })
})

describe('搜索与其它条件叠加', () => {
  test('搜索 + 状态筛选', async () => {
    const othersDraft = await makeResource({
      directoryId: ids.virtueResources, uploaderId: other.id,
      title: '春天草稿（别人的）', status: 'DRAFT',
    })
    const mine = await makeResource({
      directoryId: ids.virtueResources, uploaderId: t.id,
      title: '春天草稿（我的）', status: 'DRAFT',
    })
    probes.push(othersDraft, mine)

    const res = await teacher.get('/api/resources?q=春天草稿&status=DRAFT&pageSize=50')
    assert.equal(res.status, 200)
    assert.deepEqual(
      res.data.items.map((i) => i.title),
      ['春天草稿（我的）'],
      '搜索 + 状态筛选时也必须只返回自己的草稿',
    )
    // 管理员看得到两条
    const asAdmin = await admin.get('/api/resources?q=春天草稿&status=DRAFT&pageSize=50')
    assert.equal(asAdmin.data.total, 2)
  })

  test('搜索词里的 % 与 _ 不会变成通配符（LIKE 注入）', async () => {
    const res = await teacher.get('/api/resources?q=%25&pageSize=50')
    assert.equal(res.status, 200)
    // 如果 % 被当成通配符，就会返回全部资源
    assert.equal(res.data.total, 0, '% 必须被当作普通字符')
  })
})
