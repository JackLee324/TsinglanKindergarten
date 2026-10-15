/**
 * 「我的资源」：分栏、分页、以及**只看得到自己的**。
 *
 * 业主的规则（§4/§6）：草稿、待审核、已退回、已撤回只在上传者自己的
 * 「我的资源」里出现 —— 别的老师在同一目录里看不到它们。
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
let teacherA
let teacherB
let ids = {}
const probes = []

before(async () => {
  await resetDatabase()
  const adminUser = await createAdmin('mr_admin', 'MrAdminPass!1')
  ids.adminId = adminUser.id
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  // 两位老师都只有 education 这一支的 resource.view —— growth 这一支他们看不到
  ids.growth = await directoryIdByPath('growth/l1')
  const education = await directoryIdByPath('education')

  await startServer()
  admin = client()
  await admin.login('mr_admin', 'MrAdminPass!1')

  const a = await createTeacher('mr_a', 'MrAPass!12345', [
    { permission: 'resource.view', directoryId: education },
  ], 'A 老师')
  const b = await createTeacher('mr_b', 'MrBPass!12345', [
    { permission: 'resource.view', directoryId: education },
  ], 'B 老师')

  teacherA = client(); await teacherA.login('mr_a', 'MrAPass!12345')
  teacherB = client(); await teacherB.login('mr_b', 'MrBPass!12345')
  ids.teacherAId = a.id
  ids.teacherBId = b.id

  // A 的四种未发布状态各一条 + 一条已发布
  for (const status of ['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'RECALLED', 'PUBLISHED']) {
    probes.push(await makeResource({
      directoryId: ids.resources,
      uploaderId: a.id,
      title: `A 的${status}`,
      status,
    }))
  }
  // B 的一条草稿（用来验证"看不到别人的"）
  probes.push(await makeResource({
    directoryId: ids.resources,
    uploaderId: b.id,
    title: 'B 的草稿',
    status: 'DRAFT',
  }))
})
after(async () => {
  const removed = await purgeResources(probes)
  assert.equal(removed, probes.length, '探针必须全部清掉（残留核对）')
  await stopServer()
})

describe('「我的资源」只看得到自己的', () => {
  test('A 看到自己 5 条（含全部未发布状态）', async () => {
    const res = await teacherA.get('/api/resources/mine?pageSize=50')
    assert.equal(res.status, 200)
    assert.equal(res.data.total, 5, JSON.stringify(res.data.items.map((i) => i.title)))
    assert.equal(res.data.items.every((i) => i.title.startsWith('A 的')), true)
  })

  test('A **看不到** B 的草稿', async () => {
    const res = await teacherA.get('/api/resources/mine?pageSize=50')
    assert.ok(!res.data.items.some((i) => i.title === 'B 的草稿'), '别人的草稿不该出现在我的资源里')
  })

  test('管理员看「我的资源」只看到自己上传的（这里是 0 条）', async () => {
    const res = await admin.get('/api/resources/mine?pageSize=50')
    assert.equal(res.status, 200)
    assert.equal(res.data.total, 0, '管理员没有上传过任何东西')
    // 但他在目录列表里能看到全部（管理员不受状态限制）
    const all = await admin.get(`/api/resources?directoryId=${ids.resources}&pageSize=50`)
    assert.equal(all.data.total, 6)
  })
})

/**
 * 回收站的范围隔离。
 *
 * 这一组是 2026-10-15 补的，补的原因是一个**线上已经存在的越权**：
 * `queryResources()` 的 WHERE 里"回收站分支"是一个**裸的 OR 析取项** ——
 *
 *   WHERE (recycled = true AND deleted_at IS NOT NULL)
 *      OR (recycled = false AND deleted_at IS NULL
 *          AND ...目录范围... AND ...上传者... AND ...可见性...)
 *
 * SQL 里 `AND` 比 `OR` 结合得紧，于是这句实际等价于
 * 「回收站那一条 **绕过后面所有过滤条件**」。结果：
 *   · 老师在自己的「我的资源 → 回收站」里看得到**全平台**所有被删的资源
 *     （别人的草稿、别的目录、管理员的东西），带标题、目录路径、上传者姓名；
 *   · 目录范围、上传者过滤、可见性判定**一条都没生效**。
 *
 * 为什么一直没被发现：普通列表走的是 `recycled = false` 那一支
 * （第一个析取项恒为假），所以只有回收站这一条路是坏的 ——
 * 而回收站此前只测过"管理员看得到别人的"，**从没测过"老师看不到别人的"**。
 */
describe('回收站也只看得到自己的（越权回归）', () => {
  let aDeleted
  let bDeleted
  let outsideDeleted

  test('为这一组单独造三条并删掉（不复用别的分栏依赖的探针）', async () => {
    /*
      ⚠️ 这里必须造**自己的**探针。
      第一版复用了 `probes[0]`（= A 的草稿），结果把后面
      「分栏 status=DRAFT → 1 条」和分页总数一起弄红了 ——
      两条看起来毫不相干的用例失败，而真实原因是这一组把它们的素材删了。
      用例之间共享可变素材，失败信息就会指向错误的地方。
    */
    const aOwn = await makeResource({
      directoryId: ids.resources,
      uploaderId: ids.teacherAId,
      title: '回收站隔离·A 自己的',
      status: 'DRAFT',
    })
    const bOwn = await makeResource({
      directoryId: ids.resources,
      uploaderId: ids.teacherBId,
      title: '回收站隔离·B 自己的',
      status: 'DRAFT',
    })
    // 别人上传的，而且放在 A **完全看不到**的目录里（growth 那一支）
    const outside = await makeResource({
      directoryId: ids.growth,
      uploaderId: ids.adminId,
      title: '回收站隔离·A 看不到的目录里的',
      status: 'DRAFT',
    })
    probes.push(aOwn, bOwn, outside)
    aDeleted = aOwn
    bDeleted = bOwn
    outsideDeleted = outside

    // A、B 都没有 resource.delete.own，所以由管理员执行软删除
    for (const id of [aDeleted, bDeleted, outsideDeleted]) {
      const res = await admin.del(`/api/resources/${id}`)
      assert.equal(res.status, 200, JSON.stringify(res.data))
    }
  })

  test('A 的回收站里有自己的、**没有 B 的**', async () => {
    const res = await teacherA.get('/api/resources/mine/recycle-bin?pageSize=50')
    assert.equal(res.status, 200)
    const idsSeen = res.data.items.map((i) => i.id)
    assert.equal(idsSeen.includes(aDeleted), true, '自己删的必须在回收站里')
    assert.equal(
      idsSeen.includes(bDeleted),
      false,
      `A 不该看到 B 删掉的资源，实际看到：${JSON.stringify(res.data.items.map((i) => i.title))}`,
    )
  })

  test('别人的东西不该出现 —— 哪怕在 A 完全看不到的目录里', async () => {
    const res = await teacherA.get('/api/resources/mine/recycle-bin?pageSize=50')
    const idsSeen = res.data.items.map((i) => i.id)
    assert.equal(
      idsSeen.includes(outsideDeleted),
      false,
      'A 对 growth 那一支没有 resource.view，回收站里也不该看到那边管理员上传的东西',
    )
    // 顺带钉住：泄漏不是"只在同一个目录里" —— 跨目录一样漏（修复前就是这样）
    assert.equal(idsSeen.includes(bDeleted), false)
  })

  test('全站回收站（/recycle-bin）对老师同样只给自己的', async () => {
    const res = await teacherA.get('/api/resources/recycle-bin?pageSize=50')
    assert.equal(res.status, 200)
    const idsSeen = res.data.items.map((i) => i.id)
    assert.equal(idsSeen.includes(aDeleted), true)
    assert.equal(idsSeen.includes(bDeleted), false, 'B 的不该出现')
    assert.equal(idsSeen.includes(outsideDeleted), false, '越出目录范围的也不该出现')
  })

  test('B 的回收站同样只看得到自己的（不是只有 A 特殊）', async () => {
    const res = await teacherB.get('/api/resources/mine/recycle-bin?pageSize=50')
    const idsSeen = res.data.items.map((i) => i.id)
    assert.equal(idsSeen.includes(bDeleted), true)
    assert.equal(idsSeen.includes(aDeleted), false)
    assert.equal(idsSeen.includes(outsideDeleted), false)
  })

  test('管理员仍然看得到全部人的（这条能力不能被修坏）', async () => {
    const res = await admin.get('/api/resources/recycle-bin?pageSize=50')
    assert.equal(res.status, 200)
    const idsSeen = res.data.items.map((i) => i.id)
    for (const id of [aDeleted, bDeleted, outsideDeleted]) {
      assert.equal(idsSeen.includes(id), true, `管理员应当看到 ${id}`)
    }
  })

  test('未登录：401（回收站不是公开接口）', async () => {
    const anon = client()
    for (const path of ['/api/resources/recycle-bin', '/api/resources/mine/recycle-bin']) {
      const res = await anon.get(path)
      assert.equal(res.status, 401, `${path} 应当 401`)
    }
  })
})

describe('分栏（全部 / 草稿 / 待审核 / 已发布 / 已退回 / 已撤回）', () => {
  for (const [status, expected] of [
    ['DRAFT', 1],
    ['PENDING_REVIEW', 1],
    ['PUBLISHED', 1],
    ['REJECTED', 1],
    ['RECALLED', 1],
  ]) {
    test(`status=${status} → ${expected} 条，且状态都对`, async () => {
      const res = await teacherA.get(`/api/resources/mine?status=${status}&pageSize=50`)
      assert.equal(res.status, 200)
      assert.equal(res.data.total, expected)
      assert.equal(res.data.items.every((i) => i.status === status), true)
    })
  }

  test('不同分栏的数字之和 = 全部', async () => {
    const all = await teacherA.get('/api/resources/mine?pageSize=50')
    let sum = 0
    for (const status of ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'RECALLED']) {
      const res = await teacherA.get(`/api/resources/mine?status=${status}&pageSize=50`)
      sum += res.data.total
    }
    assert.equal(sum, all.data.total)
  })
})

describe('分页', () => {
  test('分页字段齐全，totalPages 由服务端算', async () => {
    const res = await teacherA.get('/api/resources/mine?page=1&pageSize=2')
    assert.deepEqual(Object.keys(res.data).sort(), ['items', 'page', 'pageSize', 'total', 'totalPages'])
    assert.equal(res.data.pageSize, 2)
    assert.equal(res.data.total, 5)
    assert.equal(res.data.totalPages, 3)
    assert.equal(res.data.items.length, 2)
  })

  test('第二页是不同的行', async () => {
    const p1 = await teacherA.get('/api/resources/mine?page=1&pageSize=2')
    const p2 = await teacherA.get('/api/resources/mine?page=2&pageSize=2')
    const ids1 = p1.data.items.map((i) => i.id)
    const ids2 = p2.data.items.map((i) => i.id)
    assert.equal(ids1.some((id) => ids2.includes(id)), false, '两页不能有重复行')
  })
})

describe('资源条目带「所在位置」', () => {
  test('每条都带 directoryPath（业主特别要求：资源去哪了一眼可见）', async () => {
    const res = await teacherA.get('/api/resources/mine?pageSize=50')
    for (const item of res.data.items) {
      assert.equal(item.directoryPath, 'education/pre-k/virtue/resources')
    }
  })
})
