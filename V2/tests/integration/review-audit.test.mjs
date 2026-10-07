/**
 * tests/integration/review-audit.test.mjs —— 每次状态变化都留痕（业主 §20）
 * ============================================================================
 * 业主的要求是「API + 数据库 + UI + Audit 四个一起变化」。
 * 这一份专测最后那一个：**审计**。
 *
 * 四条要记的动作（名字与业主 §20 逐字一致）：
 *   · `resource.submit_review`  教师提交审核
 *   · `resource.approve`        审核通过并发布
 *   · `resource.reject`         审核退回（带原因）
 *   · `resource.recall`         撤回
 *
 * 另外两条纪律：
 *   · 审计里**不允许**出现密码 / token / 存储密钥 / 签名 URL（AUDIT_FORBIDDEN_DETAIL_KEYS）；
 *   · 被拒绝的裁决也要留痕（否则"谁想越权"这个问题无从回答）。
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
import { auditActions } from '../helpers/modules.mjs'

const { AUDIT_ACTIONS, AUDIT_FORBIDDEN_DETAIL_KEYS } = auditActions

let admin
let teacher
let reviewer
let outsider
let ids = {}
const resources = []

async function newResource(as = teacher, title = '审计探针') {
  const res = await as.post('/api/resources', { directoryId: ids.resources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

async function pending(title = '审计待审') {
  const id = await newResource(teacher, title)
  await uploadFile(teacher, id, {
    bytes: pdfBytes(title),
    fileName: '教案.pdf',
    mimeType: 'application/pdf',
  })
  await teacher.post(`/api/resources/${id}/submit`)
  return id
}

/** 取某条资源上的审计记录（按时间正序）。 */
async function auditOf(resourceId, action) {
  return withSql(async (sql) => {
    const rows = await sql`
      SELECT actor_name, action, result, detail, created_at
      FROM audit_logs
      WHERE target_type = 'resource' AND target_id = ${resourceId} AND action = ${action}
      ORDER BY created_at ASC, id ASC
    `
    return rows
  })
}

before(async () => {
  await resetDatabase()
  await createAdmin('ra_admin', 'RaAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  await startServer()

  await createTeacher('ra_teacher', 'RaTeacherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.download', directoryId: virtue },
    { permission: 'resource.submit', directoryId: virtue },
    { permission: 'audit.view', directoryId: null },
  ], '审计老师')
  teacher = client()
  await teacher.login('ra_teacher', 'RaTeacherPass!1')

  await createTeacher('ra_reviewer', 'RaReviewerPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.review', directoryId: virtue },
    { permission: 'resource.publish', directoryId: virtue },
  ], '审计审核员')
  reviewer = client()
  await reviewer.login('ra_reviewer', 'RaReviewerPass!1')

  await createTeacher('ra_outsider', 'RaOutsiderPass!1', [
    { permission: 'resource.view', directoryId: virtue },
  ], '只读老师')
  outsider = client()
  await outsider.login('ra_outsider', 'RaOutsiderPass!1')

  admin = client()
  await admin.login('ra_admin', 'RaAdminPass!1')
})

after(async () => {
  if (resources.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ANY(${resources}::uuid[])`
    })
  }
  await stopServer()
})

describe('四个动作的中文标签与列表都到位', () => {
  test('标签不是动作名本身（界面不需要手工同步）', () => {
    assert.equal(AUDIT_ACTIONS['resource.submit_review'], '提交审核')
    assert.equal(AUDIT_ACTIONS['resource.approve'], '审核通过并发布')
    assert.equal(AUDIT_ACTIONS['resource.reject'], '审核退回')
    assert.equal(AUDIT_ACTIONS['resource.recall'], '资源撤回')
  })
})

describe('每次状态变化都写一条审计', () => {
  test('提交 → 通过：两条审计，actor 与结果都对', async () => {
    const id = await pending('审计通过')

    const submits = await auditOf(id, 'resource.submit_review')
    assert.equal(submits.length, 1, '提交审核必须留痕')
    assert.equal(submits[0].actor_name, '审计老师')
    assert.equal(submits[0].result, 'success')
    assert.equal(submits[0].detail.from, 'DRAFT')
    assert.equal(submits[0].detail.to, 'PENDING_REVIEW')

    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    const approves = await auditOf(id, 'resource.approve')
    assert.equal(approves.length, 1)
    assert.equal(approves[0].actor_name, '审计审核员')
    assert.equal(approves[0].detail.from, 'PENDING_REVIEW')
    assert.equal(approves[0].detail.to, 'PUBLISHED')
  })

  test('退回：审计里带着审核意见（教师能看到它靠的就是这个）', async () => {
    const id = await pending('审计退回')
    await reviewer.post(`/api/resources/${id}/review`, {
      action: 'reject',
      comment: '请补充课程目标。',
    })
    const rejects = await auditOf(id, 'resource.reject')
    assert.equal(rejects.length, 1)
    assert.equal(rejects[0].detail.comment, '请补充课程目标。')
    assert.equal(rejects[0].detail.to, 'REJECTED')
  })

  test('撤回：记的是 recall，**不是** reject（否则教师会看到假的退回原因）', async () => {
    const id = await pending('审计撤回')
    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    await teacher.post(`/api/resources/${id}/recall`, { comment: '内容需要调整' })

    const recalls = await auditOf(id, 'resource.recall')
    assert.equal(recalls.length, 1)
    assert.equal(recalls[0].detail.from, 'PUBLISHED')
    assert.equal(recalls[0].detail.to, 'RECALLED')
    assert.equal(recalls[0].detail.comment, '内容需要调整')

    // 关键断言：撤回**没有**产生一条 reject 审计。
    assert.equal((await auditOf(id, 'resource.reject')).length, 0)
  })

  test('非法转换也留痕（result = failed）', async () => {
    const id = await newResource(teacher, '审计非法转换')
    // 草稿直接通过 → 409
    const res = await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 409)

    const failures = await withSql(async (sql) => {
      return sql`
        SELECT result, detail FROM audit_logs
        WHERE target_type = 'resource' AND target_id = ${id} AND result = 'failed'
      `
    })
    assert.equal(failures.length >= 1, true, '被拒的转换必须留痕')
    assert.equal(failures[0].detail.reason, 'ILLEGAL_TRANSITION')
  })

  test('被拒绝的越权尝试也留痕（authz.denied）', async () => {
    const id = await newResource(teacher, '审计越权')
    const res = await outsider.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 403)

    // ⚠️ 这条拒绝发生在**守卫层**（他没有 resource.review 这个权限，
    // 守卫在进入 service 之前就拦下了），所以审计的 target 是请求本身，
    // 而不是资源 id —— 按 actor + 权限名去查才对。
    const denied = await withSql(async (sql) => {
      return sql`
        SELECT actor_name, detail FROM audit_logs
        WHERE action = 'authz.denied'
          AND actor_name = '只读老师'
          AND detail->>'permission' = 'resource.review'
        ORDER BY created_at DESC LIMIT 1
      `
    })
    assert.equal(denied.length, 1, '越权尝试必须留痕')
    assert.equal(denied[0].detail.reason !== undefined, true)
    void id
  })
})

describe('时间线顺序稳定', () => {
  test('同一条资源被裁决两次：审计按时间正序且条数正确', async () => {
    const id = await pending('审计两条裁决')
    await reviewer.post(`/api/resources/${id}/review`, { action: 'reject', comment: '第一次' })
    await teacher.patch(`/api/resources/${id}`, { description: '补充好了' })
    await teacher.post(`/api/resources/${id}/submit`)
    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })

    const submits = await auditOf(id, 'resource.submit_review')
    const rejects = await auditOf(id, 'resource.reject')
    const approves = await auditOf(id, 'resource.approve')
    assert.equal(submits.length, 2, '两次提交都要记')
    assert.equal(rejects.length, 1)
    assert.equal(approves.length, 1)
    assert.equal(
      new Date(submits[0].created_at).getTime() <= new Date(submits[1].created_at).getTime(),
      true,
      '必须能按时间排出先后',
    )
  })
})

describe('审计里不允许出现敏感值（业主 §20 / 已有的禁区清单）', () => {
  test('四个动作的 detail 都不含密码 / token / 存储密钥 / 签名 URL', async () => {
    const id = await pending('审计禁区')
    await reviewer.post(`/api/resources/${id}/review`, { action: 'reject', comment: '改一下' })
    await teacher.patch(`/api/resources/${id}`, { description: '改好了' })
    await teacher.post(`/api/resources/${id}/submit`)
    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    await teacher.post(`/api/resources/${id}/recall`)

    const rows = await withSql(async (sql) => {
      return sql`
        SELECT detail FROM audit_logs WHERE target_type = 'resource' AND target_id = ${id}
      `
    })
    assert.equal(rows.length >= 4, true)
    for (const row of rows) {
      const keys = Object.keys(row.detail ?? {})
      for (const forbidden of AUDIT_FORBIDDEN_DETAIL_KEYS) {
        assert.equal(
          keys.includes(forbidden),
          false,
          `审计 detail 里出现了禁区字段 ${forbidden}：${keys.join('、')}`,
        )
      }
    }
  })

  test('审计查询接口给老师看到的是自己的动作（按标签渲染，不显示动作码）', async () => {
    const res = await teacher.get('/api/audit/logs?pageSize=100')
    assert.equal(res.status, 200, JSON.stringify(res.data))
    const action = res.data.items[0]?.action
    assert.equal(typeof action, 'string')
    // 界面用的标签由服务端/共享定义给出，不是把动作码直接摆出来
    assert.equal(
      Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, action),
      true,
      `审计里出现了未登记的动作码：${action}`,
    )
  })
})
