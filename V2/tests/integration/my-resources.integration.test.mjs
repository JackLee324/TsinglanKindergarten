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
  await createAdmin('mr_admin', 'MrAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
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
