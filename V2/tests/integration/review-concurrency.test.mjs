/**
 * tests/integration/review-concurrency.test.mjs —— 并发审核只有一个能成（业主 §10 / §28）
 * ============================================================================
 * 场景：两位管理员**同时**点「通过并发布」。
 *
 * 必须的结果：
 *   · 一个 201（真的转换了）；
 *   · 另一个 409（状态已经被别人改过）；
 *   · 数据库里**只有一条** review 记录；
 *   · 没有"后写覆盖前写"。
 *
 * 靠的不是"先查后写"（那之间有窗口），而是**条件更新**：
 *
 * ```sql
 * UPDATE resources SET status = $to WHERE id = $id AND status = $from
 * ```
 *
 * 然后检查受影响行数 —— 为 0 说明别人先动了手。
 * 这里用真的并发请求去打，而不是顺序调用：顺序调用测不出竞态。
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

let adminA
let adminB
let teacher
let reviewer
let ids = {}
const resources = []

async function newResource(as = teacher, title = '并发探针') {
  const res = await as.post('/api/resources', { directoryId: ids.resources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

async function pendingResource(title = '并发待审探针') {
  const id = await newResource(teacher, title)
  await uploadFile(teacher, id, {
    bytes: pdfBytes(title),
    fileName: '教案.pdf',
    mimeType: 'application/pdf',
  })
  const submitted = await teacher.post(`/api/resources/${id}/submit`)
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data))
  return id
}

/**
 * 数一数这条资源上有多少条**指定动作**的流水。
 *
 * 为什么要指定动作：一条资源上本来就有一条 `submit` 记录，
 * 如果笼统地"数所有记录"，断言 1 就会被那条 submit 顶成 2，
 * 于是测试要么写错数字、要么变得看不懂（第一版就是这么错的）。
 */
async function recordCount(id, action) {
  return withSql(async (sql) => {
    const rows = await sql`
      SELECT count(*)::int AS n FROM resource_reviews
      WHERE resource_id = ${id} AND action = ${action}
    `
    return rows[0].n
  })
}

before(async () => {
  await resetDatabase()
  await createAdmin('cc_admin_a', 'CcAdminAPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  await startServer()

  // 两个**独立会话**的管理员：并发审核最常见的真实形态。
  await createAdmin('cc_admin_b', 'CcAdminBPass!1')
  adminA = client()
  await adminA.login('cc_admin_a', 'CcAdminAPass!1')
  adminB = client()
  await adminB.login('cc_admin_b', 'CcAdminBPass!1')

  await createTeacher('cc_teacher', 'CcTeacherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.submit', directoryId: virtue },
  ], '并发老师')
  teacher = client()
  await teacher.login('cc_teacher', 'CcTeacherPass!1')

  await createTeacher('cc_reviewer', 'CcReviewerPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.review', directoryId: virtue },
    { permission: 'resource.publish', directoryId: virtue },
  ], '并发审核员')
  reviewer = client()
  await reviewer.login('cc_reviewer', 'CcReviewerPass!1')
})

after(async () => {
  if (resources.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ANY(${resources}::uuid[])`
    })
  }
  await stopServer()
})

describe('同时通过', () => {
  test('两个管理员同时 approve：一个 201、一个 409，只有一条审核记录', async () => {
    const id = await pendingResource('同时通过')

    const [a, b] = await Promise.all([
      adminA.post(`/api/resources/${id}/review`, { action: 'approve' }),
      adminB.post(`/api/resources/${id}/review`, { action: 'approve' }),
    ])

    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [201, 409], `实际 ${a.status} / ${b.status}：${JSON.stringify([a.data, b.data])}`)

    const loser = a.status === 409 ? a : b
    assert.equal(loser.data.code, 'ILLEGAL_TRANSITION', '要能区分"非法转换/被别人抢先"')

    const detail = await adminA.get(`/api/resources/${id}`)
    assert.equal(detail.data.status, 'PUBLISHED', '最终状态只能是已发布一次')

    assert.equal(await recordCount(id, 'review.approve'), 1, '并发下不能写出两条审核记录')
  })

  test('同时一个通过、一个退回：只能有一个生效', async () => {
    const id = await pendingResource('通过对退回')

    const [approve, reject] = await Promise.all([
      adminA.post(`/api/resources/${id}/review`, { action: 'approve' }),
      adminB.post(`/api/resources/${id}/review`, { action: 'reject', comment: '我这边觉得不行' }),
    ])

    const okCount = [approve, reject].filter((r) => r.status === 201).length
    assert.equal(okCount, 1, `只能有一个成功：${approve.status} / ${reject.status}`)

    const detail = await adminA.get(`/api/resources/${id}`)
    assert.equal(
      ['PUBLISHED', 'REJECTED'].includes(detail.data.status),
      true,
      `最终状态应当是其中之一，实际 ${detail.data.status}`,
    )

    // 状态与审核记录必须**互相一致** —— 不能出现"状态是已发布、记录却是退回"。
    const expectedAction = detail.data.status === 'PUBLISHED' ? 'review.approve' : 'review.reject'
    const rows = await withSql(async (sql) => {
      return sql`
        SELECT action FROM resource_reviews
        WHERE resource_id = ${id} AND action IN ('review.approve', 'review.reject')
      `
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, expectedAction)
  })

  test('三个人同时 approve 也一样：一个成功，其余 409', async () => {
    const id = await pendingResource('三并发')
    const third = client()
    // 第三个人用审核员的会话（他有 review/publish 权限）
    await third.login('cc_reviewer', 'CcReviewerPass!1')

    const results = await Promise.all([
      adminA.post(`/api/resources/${id}/review`, { action: 'approve' }),
      adminB.post(`/api/resources/${id}/review`, { action: 'approve' }),
      third.post(`/api/resources/${id}/review`, { action: 'approve' }),
    ])

    assert.equal(results.filter((r) => r.status === 201).length, 1)
    assert.equal(results.filter((r) => r.status === 409).length, 2)
    assert.equal(await recordCount(id, 'review.approve'), 1)
  })
})

describe('同时提交 / 同时撤回', () => {
  test('同一份草稿被提交两次：只有一次真的转换', async () => {
    const id = await newResource(teacher, '同时提交')
    await uploadFile(teacher, id, {
      bytes: pdfBytes('double-submit'),
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
    })
    const other = client()
    await other.login('cc_teacher', 'CcTeacherPass!1')

    const [a, b] = await Promise.all([
      teacher.post(`/api/resources/${id}/submit`),
      other.post(`/api/resources/${id}/submit`),
    ])
    assert.deepEqual([a.status, b.status].sort(), [201, 409], `${a.status} / ${b.status}`)
    assert.equal(await recordCount(id, 'submit'), 1, '提交也只能记一条')
  })

  test('同一份已发布资源被撤回两次：只有一次成功', async () => {
    const id = await pendingResource('同时撤回')
    await adminA.post(`/api/resources/${id}/review`, { action: 'approve' })

    const other = client()
    await other.login('cc_teacher', 'CcTeacherPass!1')
    const [a, b] = await Promise.all([
      teacher.post(`/api/resources/${id}/recall`),
      other.post(`/api/resources/${id}/recall`),
    ])
    assert.deepEqual([a.status, b.status].sort(), [201, 409], `${a.status} / ${b.status}`)

    const detail = await adminA.get(`/api/resources/${id}`)
    assert.equal(detail.data.status, 'RECALLED')
    assert.equal(await recordCount(id, 'review.approve'), 1)
    assert.equal(await recordCount(id, 'review.recall'), 1)
  })
})

describe('条件更新是真的（不是"先查后写"）', () => {
  test('绕过接口直接把状态改掉，接口就再也转换不了', async () => {
    const id = await pendingResource('条件更新探针')

    // 模拟"别人先动手"：直接改库，把状态从待审核挪走。
    await withSql(async (sql) => {
      await sql`UPDATE resources SET status = 'DRAFT' WHERE id = ${id}`
    })

    const res = await adminA.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 409, `状态已经是 DRAFT，approve 必须被拒：${JSON.stringify(res.data)}`)
    assert.equal(await recordCount(id, 'review.approve'), 0, '被拒的裁决不能留下记录')
  })
})
