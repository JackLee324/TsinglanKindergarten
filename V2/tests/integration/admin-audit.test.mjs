/**
 * tests/integration/admin-audit.test.mjs —— 审计的筛选与覆盖（业主 §14 / §15 / §35）
 * ============================================================================
 * 审计的价值全在"能不能查得到"。这一份逐条验证业主 §14 要求的四种筛选：
 *
 *   按时间 / 按用户 / 按动作 / 按资源
 *
 * 并且逐条验证 §15 要求的动作都真的会被记下来 —— 包括这一阶段新加的
 * `user.password_change`、`directory.enable`、`directory.disable`。
 *
 * 一条纪律贯穿全篇：**筛选后的 total 必须与筛选后的条数一致**。
 * 如果总数用的是不带筛选的计数，界面会显示"共 500 条"，而列表里只有 3 条 ——
 * 那是分页最让人不信任的一种坏法。
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

const { AUDIT_ACTIONS } = auditActions

let admin
let teacher
let ids = {}
const probeUsernames = []
const probeDirectories = []
const probeResources = []

before(async () => {
  await resetDatabase()
  await createAdmin('ad_admin', 'AdAdminPass!1')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')

  await startServer()
  admin = client()
  await admin.login('ad_admin', 'AdAdminPass!1')

  await createTeacher('ad_teacher', 'AdTeacherPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.create', directoryId: ids.virtue },
    { permission: 'resource.update.own', directoryId: ids.virtue },
    { permission: 'resource.submit', directoryId: ids.virtue },
  ], '审计被操作者')
  teacher = client()
  await teacher.login('ad_teacher', 'AdTeacherPass!1')
})

after(async () => {
  if (probeResources.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ANY(${probeResources}::uuid[])`
    })
  }
  if (probeDirectories.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM directories WHERE id = ANY(${probeDirectories}::uuid[])`
    })
  }
  if (probeUsernames.length > 0) {
    const removed = await withSql(async (sql) => {
      const rows = await sql`
        DELETE FROM users WHERE username = ANY(${probeUsernames}::text[]) RETURNING id::text
      `
      return rows.length
    })
    assert.equal(removed, probeUsernames.length, '探针账号必须全部清掉（残留核对）')
  }
  await stopServer()
})

/** 取一条最近的动作记录。 */
async function latestOf(action) {
  const res = await admin.get(`/api/audit/logs?action=${encodeURIComponent(action)}&limit=1`)
  return res.data.items[0] ?? null
}

describe('§15 要求的动作都真的会被记录', () => {
  test('user.create / user.update / user.disable / user.password_change', async () => {
    probeUsernames.push('ad_probe_user')
    const created = await admin.post('/api/users', {
      name: '审计探针老师',
      username: 'ad_probe_user',
      password: 'AdProbePass!1',
      role: 'TEACHER',
    })
    const id = created.data.id

    const create = await latestOf('user.create')
    assert.equal(create.actorName, '系统管理员')
    assert.equal(create.result, 'success')
    assert.equal(create.targetId, id)

    await admin.patch(`/api/users/${id}`, { name: '审计探针老师（改名）' })
    assert.equal((await latestOf('user.update')).targetId, id)

    // 口令与停用是**两个独立动作**（业主 §15 点名要 user.password_change）
    await admin.patch(`/api/users/${id}`, { password: 'AdProbePass!2' })
    const pw = await latestOf('user.password_change')
    assert.equal(pw.targetId, id)
    assert.equal(JSON.stringify(pw.detail).includes('AdProbePass!2'), false, '审计里绝不能出现口令本身')

    await admin.patch(`/api/users/${id}`, { active: false })
    assert.equal((await latestOf('user.disable')).targetId, id)
  })

  test('permission.update（改权限）与 directory.create / enable / disable', async () => {
    const list = await admin.get('/api/users?q=ad_teacher')
    const teacherId = list.data.items[0].id
    await admin.put(`/api/users/${teacherId}/permissions`, {
      permissions: [
        { permission: 'resource.view', directoryId: ids.virtue },
        { permission: 'resource.create', directoryId: ids.virtue },
        { permission: 'resource.update.own', directoryId: ids.virtue },
        { permission: 'resource.submit', directoryId: ids.virtue },
      ],
    })
    const perm = await latestOf('user.permissions.update')
    assert.equal(perm.targetId, teacherId)
    assert.equal(perm.result, 'success')

    // ⚠️ 改权限会**撤销该老师的全部会话**（设计要求）。
    // 后面的用例还要用他的账号上传资源，所以必须重新登录 ——
    // 忘了这一步的表现是"上传 401"，看起来像接口坏了。
    await teacher.login('ad_teacher', 'AdTeacherPass!1')

    // 新建一个目录 → directory.create
    const created = await admin.post('/api/directories', {
      parentId: null,
      name: `审计目录${Date.now().toString().slice(-6)}`,
      slug: `audit-probe-${Date.now().toString().slice(-6)}`,
      // `type` 的合法值是 ROOT / CATEGORY / SECTION / FOLDER（枚举，不是自由字符串）。
      // 一级栏目通常就是 CATEGORY。
      type: 'CATEGORY',
      allowFiles: true,
      allowChildren: true,
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    probeDirectories.push(created.data.id)
    assert.equal((await latestOf('directory.create')).targetId, created.data.id)

    // 停用 / 启用 → 各自独立的动作
    await admin.patch(`/api/directories/${created.data.id}`, { enabled: false })
    assert.equal((await latestOf('directory.disable')).targetId, created.data.id)
    await admin.patch(`/api/directories/${created.data.id}`, { enabled: true })
    assert.equal((await latestOf('directory.enable')).targetId, created.data.id)
  })

  test('resource.submit_review / approve / reject / recall 也都在（阶段 7 的四个）', async () => {
    const reviewers = await admin.get('/api/users?q=ad_teacher')
    void reviewers

    const resource = await teacher.post('/api/resources', {
      directoryId: ids.resources,
      title: `审计资源${Date.now().toString().slice(-6)}`,
    })
    assert.equal(resource.status, 201)
    probeResources.push(resource.data.id)
    await uploadFile(teacher, resource.data.id, {
      bytes: pdfBytes('audit'),
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
    })

    await teacher.post(`/api/resources/${resource.data.id}/submit`)
    const submit = await latestOf('resource.submit_review')
    assert.equal(submit.targetId, resource.data.id)

    await admin.post(`/api/resources/${resource.data.id}/review`, { action: 'reject', comment: '补充课程目标' })
    assert.equal((await latestOf('resource.reject')).targetId, resource.data.id)

    await teacher.patch(`/api/resources/${resource.data.id}`, { description: '补充好了' })
    await teacher.post(`/api/resources/${resource.data.id}/submit`)
    await admin.post(`/api/resources/${resource.data.id}/review`, { action: 'approve' })
    assert.equal((await latestOf('resource.approve')).targetId, resource.data.id)

    await teacher.post(`/api/resources/${resource.data.id}/recall`)
    assert.equal((await latestOf('resource.recall')).targetId, resource.data.id)
  })

  test('动作清单里的每一项都有中文标签（界面不手工同步）', async () => {
    const res = await admin.get('/api/audit/actions')
    assert.equal(res.status, 200)
    assert.equal(res.data.items.length, Object.keys(AUDIT_ACTIONS).length)
    for (const item of res.data.items) {
      assert.equal(typeof item.label, 'string')
      assert.notEqual(item.label, item.action, `「${item.action}」没有中文标签`)
    }
  })
})

describe('§14 的四种筛选', () => {
  test('按动作筛：结果里只有那个动作', async () => {
    const res = await admin.get('/api/audit/logs?action=user.create&limit=50')
    assert.equal(res.status, 200)
    assert.equal(res.data.items.length > 0, true)
    for (const item of res.data.items) assert.equal(item.action, 'user.create')
  })

  test('按用户筛：只返回这个人做的事', async () => {
    const me = await admin.get('/api/auth/me')
    const actorId = me.data.user.id
    const res = await admin.get(`/api/audit/logs?actorId=${actorId}&limit=50`)
    assert.equal(res.data.items.length > 0, true)
    for (const item of res.data.items) assert.equal(item.actorId, actorId)

    // 换一个不存在的人 → 0 条
    const none = await admin.get('/api/audit/logs?actorId=11111111-1111-4111-8111-111111111111')
    assert.equal(none.data.total, 0)
  })

  test('按资源筛：这条资源经历过什么', async () => {
    const resourceId = probeResources[probeResources.length - 1]
    const res = await admin.get(`/api/audit/logs?targetId=${resourceId}&limit=100`)
    assert.equal(res.data.items.length > 0, true)
    for (const item of res.data.items) assert.equal(item.targetId, resourceId)
    const actions = res.data.items.map((i) => i.action)
    assert.equal(actions.includes('resource.submit_review'), true)
    assert.equal(actions.includes('resource.approve'), true)
    assert.equal(actions.includes('resource.recall'), true)
  })

  test('按时间区间筛：未来的区间 → 0 条', async () => {
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    const res = await admin.get(`/api/audit/logs?from=${encodeURIComponent(future)}&limit=10`)
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.total, 0)
    assert.deepEqual(res.data.items, [])
  })

  test('按结果筛：只看被拒绝的', async () => {
    const res = await admin.get('/api/audit/logs?result=denied&limit=50')
    for (const item of res.data.items) assert.equal(item.result, 'denied')
  })

  test('**筛选后的 total 与筛选后的条数一致**（否则分页会撒谎）', async () => {
    const res = await admin.get('/api/audit/logs?action=user.create&limit=1')
    assert.equal(res.data.items.length, 1)

    const all = await admin.get('/api/audit/logs?action=user.create&limit=200')
    assert.equal(
      res.data.total,
      all.data.items.length,
      'total 必须是"符合筛选条件的总数"，不是整张表的行数',
    )
  })

  test('空字符串筛选参数按"没有这个筛选"处理', async () => {
    // 界面上清空输入框会送出 `?action=`。如果把它当成"筛 action = ''"，
    // 结果会永远是 0 条，而用户以为自己只是清空了搜索框。
    const empty = await admin.get('/api/audit/logs?action=&result=&limit=5')
    const none = await admin.get('/api/audit/logs?limit=5')
    assert.equal(empty.data.total, none.data.total)
  })

  test('分页：offset 能翻到不同的记录', async () => {
    const first = await admin.get('/api/audit/logs?limit=2&offset=0')
    const second = await admin.get('/api/audit/logs?limit=2&offset=2')
    assert.equal(first.data.items.length, 2)
    assert.equal(second.data.items.length, 2)
    assert.notDeepEqual(
      first.data.items.map((i) => i.id),
      second.data.items.map((i) => i.id),
    )
  })
})

describe('审计的边界', () => {
  test('普通教师看不到审计（403）', async () => {
    const res = await teacher.get('/api/audit/logs')
    assert.equal(res.status, 403)
  })

  test('未登录 → 401', async () => {
    const anon = client()
    assert.equal((await anon.get('/api/audit/logs')).status, 401)
  })

  test('审计里不出现密码 / 令牌 / 存储密钥 / 签名 URL', async () => {
    const res = await admin.get('/api/audit/logs?limit=200')
    const body = JSON.stringify(res.data.items)
    for (const forbidden of ['password_hash', 'passwordHash', 'csrfToken', 'sessionToken', 'X-Amz-Signature']) {
      assert.equal(body.includes(forbidden), false, `审计里出现了 ${forbidden}`)
    }
  })
})
