/**
 * tests/integration/review-visibility.test.mjs —— 审核工作流的**可见性**（业主 §17 / §18 / §30）
 * ============================================================================
 * 三条规则，每一条都曾经是（或差点是）一个泄漏：
 *
 * 1. **目录浏览只显示已发布**（§17）。
 *    别人看不到你的草稿 —— 这条从阶段 6 起由可见性策略保证；
 *    阶段 7 又进一步把"目录页"本身限定成只看已发布，
 *    于是"这条资源上线了吗"在界面上只有一个不会误解的答案。
 *
 * 2. **搜索不能绕过权限**（§18）。
 *    搜索曾经是最容易长出第二条查询路径的地方。这里用同样的关键词
 *    在"有权 / 无权 / 管理员"三种身份下各搜一次，证明过滤发生在**授权**里，
 *    而不是在某个接口自己的 if 里。
 *
 * 3. **回收站里的资源**（§30）不能被提交、审核、发布、下载 —— 除非先恢复。
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
  withSql,
} from '../helpers/harness.mjs'
import { pdfBytes, uploadFile } from '../helpers/upload.mjs'

let admin
let teacherA
let teacherB
let reviewer
let ids = {}
const resources = []
/** 只在"搜索"用例里用的关键词，避免和别的用例互相干扰。 */
const KEYWORD = `可见性探针${Date.now().toString().slice(-6)}`

async function newResource(as, title, directoryId = null) {
  const res = await as.post('/api/resources', {
    directoryId: directoryId ?? ids.resources,
    title,
  })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

async function withFile(as, id, tag = 'v') {
  await uploadFile(as, id, {
    bytes: pdfBytes(tag),
    fileName: '教案.pdf',
    mimeType: 'application/pdf',
  })
  return id
}

before(async () => {
  await resetDatabase()
  await createAdmin('rv_admin', 'RvAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.kResources = await directoryIdByPath('education/k/pe/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')
  const kPe = await directoryIdByPath('education/k/pe')

  await startServer()

  await createTeacher('rv_a', 'RvAPass!1234', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.download', directoryId: virtue },
    { permission: 'resource.submit', directoryId: virtue },
    { permission: 'resource.delete.own', directoryId: virtue },
  ], 'A 老师')
  teacherA = client()
  await teacherA.login('rv_a', 'RvAPass!1234')

  await createTeacher('rv_b', 'RvBPass!1234', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.download', directoryId: virtue },
    { permission: 'resource.submit', directoryId: virtue },
  ], 'B 老师')
  teacherB = client()
  await teacherB.login('rv_b', 'RvBPass!1234')

  await createTeacher('rv_k', 'RvKPass!1234', [
    { permission: 'resource.view', directoryId: kPe },
    { permission: 'resource.create', directoryId: kPe },
    { permission: 'resource.download', directoryId: kPe },
  ], 'K 老师')
  void (await createTeacher('rv_reviewer', 'RvReviewerPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.download', directoryId: virtue },
    { permission: 'resource.review', directoryId: virtue },
    { permission: 'resource.publish', directoryId: virtue },
  ], '审核员'))
  reviewer = client()
  await reviewer.login('rv_reviewer', 'RvReviewerPass!1')

  admin = client()
  await admin.login('rv_admin', 'RvAdminPass!1')
})

after(async () => {
  if (resources.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ANY(${resources}::uuid[])`
    })
  }
  await stopServer()
})

describe('非发布状态不会出现在别人的视野里（§17）', () => {
  test('A 的草稿：B 在列表里搜不到、按 id 取也 403', async () => {
    const id = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} A的草稿`))

    const listForB = await teacherB.get(
      `/api/resources?directoryId=${ids.resources}&q=${encodeURIComponent(KEYWORD)}&pageSize=100`,
    )
    assert.equal(listForB.status, 200)
    assert.equal(
      listForB.data.items.some((i) => i.id === id),
      false,
      '别人的草稿不该出现在列表里',
    )

    const direct = await teacherB.get(`/api/resources/${id}`)
    assert.equal(direct.status, 403, '知道 id 也不行')
    const files = await teacherB.get(`/api/resources/${id}/files`)
    assert.equal(files.status, 403)
  })

  test('待审核 / 已退回 / 已撤回状态同样对别人不可见', async () => {
    // 待审核
    const pending = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} 待审`))
    await teacherA.post(`/api/resources/${pending}/submit`)
    assert.equal((await teacherB.get(`/api/resources/${pending}`)).status, 403, '待审核对别人不可见')

    // 已退回
    await reviewer.post(`/api/resources/${pending}/review`, { action: 'reject', comment: '补充' })
    assert.equal((await teacherB.get(`/api/resources/${pending}`)).status, 403, '已退回对别人不可见')

    // 已撤回：先发布再撤回
    const recalled = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} 撤回`))
    await teacherA.post(`/api/resources/${recalled}/submit`)
    await reviewer.post(`/api/resources/${recalled}/review`, { action: 'approve' })
    // 发布之后 B 是看得到的
    assert.equal((await teacherB.get(`/api/resources/${recalled}`)).status, 200)
    await teacherA.post(`/api/resources/${recalled}/recall`)
    assert.equal((await teacherB.get(`/api/resources/${recalled}`)).status, 403, '已撤回对别人不可见')
  })

  test('已发布对同目录的老师可见', async () => {
    const id = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} 已发布`))
    await teacherA.post(`/api/resources/${id}/submit`)
    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })

    const detail = await teacherB.get(`/api/resources/${id}`)
    assert.equal(detail.status, 200, JSON.stringify(detail.data))
    assert.equal(detail.data.status, 'PUBLISHED')
    // 文件也要能拿到下载地址（发布 = 共享）
    const dl = await teacherB.get(`/api/resources/${id}/files`)
    assert.equal(dl.status, 200)
  })

  test('审核员能看到别人**已提交**的内容（否则审核台是空的）', async () => {
    const id = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} 待审核员`))
    await teacherA.post(`/api/resources/${id}/submit`)
    const detail = await reviewer.get(`/api/resources/${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.data.status, 'PENDING_REVIEW')
    assert.equal(detail.data.capabilities.canApprove, true)
  })

  test('管理员能看到任何状态', async () => {
    const id = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} 草稿给管理员`))
    const detail = await admin.get(`/api/resources/${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.data.status, 'DRAFT')
  })
})

describe('搜索不能绕过权限（§18）', () => {
  test('同一个关键词：有权的人搜得到，无权的人一条都搜不到', async () => {
    const mine = await newResource(teacherA, `${KEYWORD} 搜索命中`)
    await withFile(teacherA, mine)
    await teacherA.post(`/api/resources/${mine}/submit`)
    await reviewer.post(`/api/resources/${mine}/review`, { action: 'approve' })

    const kTeacher = client()
    await kTeacher.login('rv_k', 'RvKPass!1234')

    const forA = await teacherA.get(`/api/resources?q=${encodeURIComponent(KEYWORD)}&pageSize=100`)
    assert.equal(forA.data.items.some((i) => i.id === mine), true, 'A 应当搜得到')

    const forK = await kTeacher.get(`/api/resources?q=${encodeURIComponent(KEYWORD)}&pageSize=100`)
    assert.equal(
      forK.data.items.some((i) => i.id === mine),
      false,
      'K 老师没有 Pre-K 的权限，搜索也不能够到',
    )

    const forAdmin = await admin.get(`/api/resources?q=${encodeURIComponent(KEYWORD)}&pageSize=100`)
    assert.equal(forAdmin.data.items.some((i) => i.id === mine), true)
  })

  test('搜索 + 目录过滤 + 状态过滤叠加时，可见性仍然生效', async () => {
    const id = await newResource(teacherA, `${KEYWORD} 叠加过滤`)
    await withFile(teacherA, id)
    const res = await teacherB.get(
      `/api/resources?directoryId=${ids.resources}&status=DRAFT&q=${encodeURIComponent(KEYWORD)}&pageSize=100`,
    )
    assert.equal(res.status, 200)
    assert.equal(
      res.data.items.some((i) => i.id === id),
      false,
      '状态过滤不能把别人的草稿"筛"出来',
    )
  })

  test('我的资源里只有自己的东西（搜索/分页都不例外）', async () => {
    const mine = await newResource(teacherA, `${KEYWORD} 我的`)
    await withFile(teacherA, mine)
    const theirs = await newResource(teacherB, `${KEYWORD} 他的`)
    await withFile(teacherB, theirs)

    const res = await teacherA.get('/api/resources/mine?pageSize=100')
    const ids_ = res.data.items.map((i) => i.id)
    assert.equal(ids_.includes(mine), true)
    assert.equal(ids_.includes(theirs), false)
  })
})

describe('回收站里的资源（§30）', () => {
  test('已删除的资源：不能提交、不能审核、不能下载', async () => {
    const id = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} 待删除`))
    const files = await teacherA.get(`/api/resources/${id}/files`)
    const fileId = files.data.items[0].id

    const del = await teacherA.del(`/api/resources/${id}`)
    assert.equal(del.status, 200, JSON.stringify(del.data))

    const submit = await teacherA.post(`/api/resources/${id}/submit`)
    assert.equal(submit.status, 404, `回收站里的资源不能提交：${JSON.stringify(submit.data)}`)

    const review = await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal([403, 404].includes(review.status), true, `不能审核：${review.status}`)

    const download = await teacherA.get(`/api/resources/${id}/files/${fileId}/download`)
    assert.equal([403, 404].includes(download.status), true, `不能下载：${download.status}`)

    // 恢复之后一切照旧
    const restore = await teacherA.post(`/api/resources/${id}/restore`)
    assert.equal(restore.status, 201, JSON.stringify(restore.data))
    assert.equal((await teacherA.get(`/api/resources/${id}/files/${fileId}/download`)).status, 200)
  })

  test('回收站里的资源不在审核队列里', async () => {
    // 造一条待审 → 撤回不了（待审不能删），所以用草稿走一遍：
    // 关键断言是"删除之后队列里查不到"。
    const id = await withFile(teacherA, await newResource(teacherA, `${KEYWORD} 队列删除探针`))
    await teacherA.post(`/api/resources/${id}/submit`)
    const before = await reviewer.get('/api/reviews/pending?pageSize=100')
    assert.equal(before.data.items.some((i) => i.id === id), true)

    await teacherA.del(`/api/resources/${id}`)
    const after = await reviewer.get('/api/reviews/pending?pageSize=100')
    assert.equal(
      after.data.items.some((i) => i.id === id),
      false,
      '进了回收站就不该再出现在待审队列里',
    )
  })
})
