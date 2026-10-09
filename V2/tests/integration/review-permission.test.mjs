/**
 * tests/integration/review-permission.test.mjs —— 谁能在什么条件下审核（业主 §4/§8/§9/§26/§27）
 * ============================================================================
 * 这一份盯的是"审核权限本身"：
 *
 *   · 只有持有 `resource.review` / `resource.publish` 的人能裁决；
 *   · **不能审核自己上传的资源**（自审保护，业主 §8 / §26）；
 *   · 重复审核 / 非法状态下的裁决一律 409；
 *   · 跨目录：没有那个目录的审核权限就 403（不能因为"能提交"就能审）。
 *
 * 自审保护那一条特别容易被"顺手"做成权限配置问题：老师看到"没有权限"
 * 会去找管理员加权限，而加了也没用（系统就是不允许）。所以除了状态码，
 * 这里还断言**错误信息说清了原因**。
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
let teacher
let reviewer
let idOnlyReviewer
let ids = {}
const resources = []

async function newResource(as = teacher, title = '审核权限探针') {
  const res = await as.post('/api/resources', { directoryId: ids.resources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

/** 建资源 → 传文件 → 提交审核，返回资源 id（状态 PENDING_REVIEW）。 */
async function pendingResource(as = teacher, title = '待审探针') {
  const id = await newResource(as, title)
  await uploadFile(as, id, { bytes: pdfBytes(title), fileName: '教案.pdf', mimeType: 'application/pdf' })
  const submitted = await as.post(`/api/resources/${id}/submit`)
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data))
  assert.equal(submitted.data.status, 'PENDING_REVIEW')
  return id
}

before(async () => {
  await resetDatabase()
  await createAdmin('rp7_admin', 'Rp7AdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.kPe = await directoryIdByPath('education/k/pe')

  await startServer()

  await createTeacher('rp7_teacher', 'Rp7TeacherPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.create', directoryId: ids.virtue },
    { permission: 'resource.update.own', directoryId: ids.virtue },
    { permission: 'resource.download', directoryId: ids.virtue },
    { permission: 'resource.submit', directoryId: ids.virtue },
  ], '提交老师')
  teacher = client()
  await teacher.login('rp7_teacher', 'Rp7TeacherPass!1')

  // 审核员：有审核与发布权限，**但不是管理员**。
  await createTeacher('rp7_reviewer', 'Rp7ReviewerPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.download', directoryId: ids.virtue },
    { permission: 'resource.review', directoryId: ids.virtue },
    { permission: 'resource.publish', directoryId: ids.virtue },
  ], '审核员')
  reviewer = client()
  await reviewer.login('rp7_reviewer', 'Rp7ReviewerPass!1')

  // 只有 Pre-K 审核权的审核员：用来测跨目录。
  await createTeacher('rp7_konly', 'Rp7KonlyPass!1', [
    { permission: 'resource.view', directoryId: ids.kPe },
    { permission: 'resource.review', directoryId: ids.kPe },
    { permission: 'resource.publish', directoryId: ids.kPe },
  ], 'K 体能审核员')
  idOnlyReviewer = client()
  await idOnlyReviewer.login('rp7_konly', 'Rp7KonlyPass!1')

  admin = client()
  await admin.login('rp7_admin', 'Rp7AdminPass!1')
})

after(async () => {
  if (resources.length > 0) {
    await withSql(async (sql) => {
      // resource_reviews 是 ON DELETE CASCADE，跟着资源一起走。
      await sql`DELETE FROM resources WHERE id = ANY(${resources}::uuid[])`
    })
  }
  await stopServer()
})

describe('谁能审核', () => {
  test('没有审核权限的教师：看不了队列（403），也裁决不了（403）', async () => {
    const id = await pendingResource()
    const queue = await teacher.get('/api/reviews/pending')
    assert.equal(queue.status, 403, '队列本身就要 403')

    const approve = await teacher.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(approve.status, 403)
    const reject = await teacher.post(`/api/resources/${id}/review`, {
      action: 'reject',
      comment: '不行',
    })
    assert.equal(reject.status, 403)
  })

  test('审核员能通过并发布', async () => {
    const id = await pendingResource()
    const res = await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.status, 'PUBLISHED')
  })

  test('未登录 → 401', async () => {
    const id = await pendingResource()
    const anon = client()
    const res = await anon.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 401)
  })
})

describe('自审保护（业主 §8 / §26；管理员例外见 Stage 13 §3）', () => {
  test('自己上传、自己审核 → 403，并且说清楚是"不能自审"', async () => {
    // 这位老师**同时**持有审核与发布权限 —— 也就是业主说的
    // "如果以后某个 TEACHER 具有 review permission"那种情况。
    await createTeacher('rp7_self', 'Rp7SelfPass!1', [
      { permission: 'resource.view', directoryId: ids.virtue },
      { permission: 'resource.create', directoryId: ids.virtue },
      { permission: 'resource.update.own', directoryId: ids.virtue },
      { permission: 'resource.download', directoryId: ids.virtue },
      { permission: 'resource.submit', directoryId: ids.virtue },
      { permission: 'resource.review', directoryId: ids.virtue },
      { permission: 'resource.publish', directoryId: ids.virtue },
    ], '有审核权的老师')
    const both = client()
    await both.login('rp7_self', 'Rp7SelfPass!1')

    const id = await pendingResource(both, '自审探针')

    const approve = await both.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(approve.status, 403, JSON.stringify(approve.data))
    assert.match(JSON.stringify(approve.data), /自己上传/, '要说清是"不能自审"，不是"没有权限"')

    const reject = await both.post(`/api/resources/${id}/review`, {
      action: 'reject',
      comment: '退回自己的',
    })
    assert.equal(reject.status, 403)
    assert.match(JSON.stringify(reject.data), /自己上传/)

    // 状态没被改动 —— 被拒之后**不能**留下任何转换痕迹
    const detail = await both.get(`/api/resources/${id}`)
    assert.equal(detail.data.status, 'PENDING_REVIEW')
  })

  test('管理员**可以**审自己上传的资源（业主 Stage 13 §3：规则变更）', async () => {
    /*
      规则变更：Stage 7 §8 / §26 当时要求"管理员也不能自审"。
      业主复核后改为：**超级管理员必须能审核并发布自己上传的待审资源** ——
      否则单管理员站点会出现"资源永远卡在待审"的死角，而那条旧规则并不增加安全性
      （管理员本来就有全平台权限，放行的唯一入口仍是 can()）。
      普通教师的自审保护**没有**被取消，上面的用例仍然断言 403。
    */
    const created = await admin.post('/api/resources', {
      directoryId: ids.resources,
      title: '管理员自己的资源',
    })
    resources.push(created.data.id)
    await uploadFile(admin, created.data.id, {
      bytes: pdfBytes('admin'),
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
    })
    const submitted = await admin.post(`/api/resources/${created.data.id}/submit`)
    assert.equal(submitted.status, 201, JSON.stringify(submitted.data))

    // 审核前：能力位必须已经告诉界面"这条我能审"（前端据此显示按钮）
    const before = await admin.get(`/api/resources/${created.data.id}`)
    assert.equal(before.data.capabilities.canApprove, true, '管理员自审的能力位应当是 true')
    assert.equal(before.data.capabilities.canReject, true)
    assert.equal(before.data.capabilities.reviewDeniedReason ?? null, null)

    const res = await admin.post(`/api/resources/${created.data.id}/review`, { action: 'approve' })
    assert.equal(res.status, 201, `管理员自审应当成功：${JSON.stringify(res.data)}`)

    // 状态真的走到 PUBLISHED，且时间线/审计都留下了这条记录
    const after = await admin.get(`/api/resources/${created.data.id}`)
    assert.equal(after.data.status, 'PUBLISHED')
    const history = await admin.get(`/api/resources/${created.data.id}/review-history`)
    const events = history.data.items ?? []
    assert.ok(
      events.some((r) => r.action === 'review.approve'),
      `审核时间线里应当有 approve：${JSON.stringify(history.data).slice(0, 240)}`,
    )
    // 操作者必须是**自己**（自审也要如实记账，不能因为"是管理员"就省略）
    const approved = events.find((r) => r.action === 'review.approve')
    assert.equal(approved.actorId, before.data.uploaderId, '审核人就是上传者本人（这就是自审）')
  })

  test('管理员自审也走状态机：重复审核不能产生第二次成功转换', async () => {
    const created = await admin.post('/api/resources', {
      directoryId: ids.resources,
      title: '管理员自审幂等探针',
    })
    resources.push(created.data.id)
    await uploadFile(admin, created.data.id, {
      bytes: pdfBytes('admin2'),
      fileName: 'b.pdf',
      mimeType: 'application/pdf',
    })
    await admin.post(`/api/resources/${created.data.id}/submit`)

    const first = await admin.post(`/api/resources/${created.data.id}/review`, { action: 'approve' })
    assert.equal(first.status, 201, JSON.stringify(first.data))
    // 已经是 PUBLISHED，再审一次必须被状态机拒绝（不是"再来一次也成功"）
    const second = await admin.post(`/api/resources/${created.data.id}/review`, { action: 'approve' })
    assert.ok(second.status >= 400, `重复审核应当被拒，实际 ${second.status}`)
  })

  test('别人的资源，同一个审核员审得了（自审保护没有过度扩大）', async () => {
    const id = await pendingResource()
    const res = await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 201, JSON.stringify(res.data))
  })

  test('能力位也如实告诉界面"为什么不能审"（前端不用猜）', async () => {
    await createTeacher('rp7_self2', 'Rp7Self2Pass!1', [
      { permission: 'resource.view', directoryId: ids.virtue },
      { permission: 'resource.create', directoryId: ids.virtue },
      { permission: 'resource.update.own', directoryId: ids.virtue },
      { permission: 'resource.submit', directoryId: ids.virtue },
      { permission: 'resource.review', directoryId: ids.virtue },
      { permission: 'resource.publish', directoryId: ids.virtue },
    ], '有审核权的老师2')
    const both = client()
    await both.login('rp7_self2', 'Rp7Self2Pass!1')
    const id = await pendingResource(both, '自审能力位探针')

    const detail = await both.get(`/api/resources/${id}`)
    assert.equal(detail.data.capabilities.canApprove, false)
    assert.equal(detail.data.capabilities.canReject, false)
    assert.equal(detail.data.capabilities.reviewDeniedReason, 'self-review')

    // 审核员看同一条资源：能力位是 true（证明前面那个 false 来自自审，不是别的原因）
    const asReviewer = await reviewer.get(`/api/resources/${id}`)
    assert.equal(asReviewer.data.capabilities.canApprove, true)
    assert.equal(asReviewer.data.capabilities.canReject, true)
  })
})

describe('跨目录审核（业主 §27）', () => {
  test('只有 K 体能审核权的人：审 Pre-K 的资源 → 403', async () => {
    const id = await pendingResource()
    const res = await idOnlyReviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })

  test('他的待审队列里看不到 Pre-K 的资源（不是只有动作被拦）', async () => {
    await pendingResource()
    const queue = await idOnlyReviewer.get('/api/reviews/pending?pageSize=100')
    assert.equal(queue.status, 200, JSON.stringify(queue.data))
    for (const item of queue.data.items) {
      assert.equal(
        item.directoryPath.startsWith('education/k/'),
        true,
        `K 审核员不该看到 ${item.directoryPath}`,
      )
    }
  })

  test('提交审核也不能跨目录：改 directoryId 到 K → 403', async () => {
    // 教师只有 Pre-K 的权限；资源本身在 Pre-K，但要把它"挪"到 K 需要目标目录的权限。
    const id = await newResource(teacher, '跨目录提交探针')
    // 先直接用一个不属于自己的目录建资源
    const created = await teacher.post('/api/resources', {
      directoryId: ids.kPe,
      title: '跨目录创建',
    })
    assert.equal(created.status, 403, JSON.stringify(created.data))
    void id
  })
})

describe('非法与重复（业主 §9）', () => {
  test('已经通过之后再通过 → 409（不能重复成功）', async () => {
    const id = await pendingResource()
    assert.equal((await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })).status, 201)
    const again = await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(again.status, 409, JSON.stringify(again.data))
    assert.equal(again.data.code, 'ILLEGAL_TRANSITION')
  })

  test('已经退回之后再退回 → 409', async () => {
    const id = await pendingResource()
    assert.equal(
      (await reviewer.post(`/api/resources/${id}/review`, { action: 'reject', comment: '第一次' }))
        .status,
      201,
    )
    const again = await reviewer.post(`/api/resources/${id}/review`, {
      action: 'reject',
      comment: '第二次',
    })
    assert.equal(again.status, 409)
  })

  test('草稿不能直接被裁决（必须先在待审核）', async () => {
    const id = await newResource()
    const res = await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 409, JSON.stringify(res.data))
  })

  test('行动列表里没有的动作 → 400（不是悄悄当成 approve）', async () => {
    const id = await pendingResource()
    for (const action of ['publish', 'APPROVE', '', 'recall']) {
      const res = await reviewer.post(`/api/resources/${id}/review`, { action })
      assert.equal(res.status, 400, `action=${action} 应当 400，实际 ${res.status}`)
    }
    // 上面几次都没能改动状态
    const detail = await reviewer.get(`/api/resources/${id}`)
    assert.equal(detail.data.status, 'PENDING_REVIEW')
  })

  test('退回不写原因 → 400（业主 §6）', async () => {
    const id = await pendingResource()
    for (const comment of ['', '   ', null, undefined]) {
      const res = await reviewer.post(`/api/resources/${id}/review`, { action: 'reject', comment })
      assert.equal(res.status, 400, `comment=${String(comment)} 应当 400`)
      assert.equal(res.data.code, 'COMMENT_REQUIRED')
    }
    const detail = await reviewer.get(`/api/resources/${id}`)
    assert.equal(detail.data.status, 'PENDING_REVIEW', '被拒的退回不该改动状态')
  })
})

describe('审核历史是完整流水（业主 §7）', () => {
  test('退回 → 编辑 → 再提交 → 通过：四条记录全都在', async () => {
    const id = await newResource()
    await uploadFile(teacher, id, { bytes: pdfBytes('history'), fileName: 'a.pdf', mimeType: 'application/pdf' })
    await teacher.post(`/api/resources/${id}/submit`)
    await reviewer.post(`/api/resources/${id}/review`, { action: 'reject', comment: '请补充课程目标。' })
    await teacher.patch(`/api/resources/${id}`, { description: '已补充课程目标' })
    await teacher.post(`/api/resources/${id}/submit`)
    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })

    const history = await reviewer.get(`/api/resources/${id}/review-history`)
    assert.equal(history.status, 200)
    const actions = history.data.items.map((i) => i.action)
    // `resource_reviews` 是**审核流水**：只记四种审核动作
    // （数据库约束就是这么定的）。教师的编辑不在这里，见下面审计那条断言。
    assert.deepEqual(actions, ['submit', 'review.reject', 'submit', 'review.approve'])

    // 退回原因**仍然在**（没有被后来的通过覆盖）—— 这正是业主 §7 要的"全部保留"。
    const reject = history.data.items.find((i) => i.action === 'review.reject')
    assert.equal(reject.comment, '请补充课程目标。')
    assert.equal(reject.actorName, '审核员')

    // 列表上的"最新退回意见"也仍然能看到
    const list = await teacher.get(`/api/resources/mine?pageSize=100`)
    const item = list.data.items.find((i) => i.id === id)
    assert.equal(item.latestReviewComment, '请补充课程目标。')

    // 教师那次"编辑把状态变回草稿"记在**审计日志**里（带 statusFrom / statusTo）。
    // 这样状态变化一件事也没丢，只是分工不同：
    //   审核流水（resource_reviews）= 谁在什么时候裁决了什么；
    //   审计日志（audit_logs）      = 谁在什么时候改了什么字段、状态怎么走的。
    const audit = await withSql(async (sql) => {
      return sql`
        SELECT detail FROM audit_logs
        WHERE target_type = 'resource' AND target_id = ${id} AND action = 'resource.update'
        ORDER BY created_at DESC LIMIT 1
      `
    })
    assert.equal(audit.length, 1)
    assert.equal(audit[0].detail.statusFrom, 'REJECTED')
    assert.equal(audit[0].detail.statusTo, 'DRAFT')
  })
})
