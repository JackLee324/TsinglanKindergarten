/**
 * tests/integration/admin-users.integration.test.mjs —— 教师账号管理（业主 §2 / §28 / §29）
 * ============================================================================
 * 这一份测"管理员能不能把老师这件事管好"：
 *
 *   · 列表要能**服务端搜索 + 分页**（业主 §28：不要一次读取所有教师）；
 *   · 列表要给出**最后登录时间**与**权限摘要**（业主 §2 / §29），
 *     而且摘要里**不能出现权限码** —— 那是给开发看的，不是给园长看的；
 *   · 新增教师的字段就是业主 §3 那些，不多一个不少一个；
 *   · 停用而不是删除（业主 §2）—— 历史审计与审核记录不能因为账号消失而断链。
 *
 * 每个用例自己造账号、自己清掉，跑完 0 残留（业主 §36）。
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

let admin
let teacher
let ids = {}
/** 本套件创建的账号 —— after 里按用户名清掉。 */
const probeUsernames = []

async function cleanupProbes() {
  if (probeUsernames.length === 0) return 0
  return withSql(async (sql) => {
    const rows = await sql`
      DELETE FROM users WHERE username = ANY(${probeUsernames}::text[]) RETURNING id::text
    `
    return rows.length
  })
}

/** 用管理员身份建一个老师（走接口，不直接写库）。 */
async function createTeacherViaApi(over = {}) {
  const username = over.username ?? `probe_${Math.random().toString(36).slice(2, 10)}`
  probeUsernames.push(username)
  const res = await admin.post('/api/users', {
    name: over.name ?? '探针老师',
    username,
    password: over.password ?? 'ProbePass!2026',
    role: 'TEACHER',
    permissions: over.permissions ?? [],
  })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  return { ...res.data, username }
}

before(async () => {
  await resetDatabase()
  await createAdmin('au_admin', 'AuAdminPass!1')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')

  await startServer()
  admin = client()
  await admin.login('au_admin', 'AuAdminPass!1')

  await createTeacher('au_teacher', 'AuTeacherPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
  ], '现有老师')
  teacher = client()
  await teacher.login('au_teacher', 'AuTeacherPass!1')
})

after(async () => {
  const removed = await cleanupProbes()
  assert.equal(removed, probeUsernames.length, '探针账号必须全部清掉（残留核对）')
  await stopServer()
})

describe('列表：搜索、分页、最后登录、权限摘要（§2 / §28 / §29）', () => {
  test('默认分页有 total / totalPages，不是一次给全部', async () => {
    const res = await admin.get('/api/users?pageSize=1')
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.items.length, 1)
    assert.equal(res.data.pageSize, 1)
    assert.equal(res.data.totalPages >= 2, true, '库里不止一个人')
    assert.equal(res.data.total >= 2, true)
  })

  test('列表每一行都带业主列的那几项：姓名 / 用户名 / 状态 / 创建时间 / 最后登录 / 权限摘要', async () => {
    const created = await createTeacherViaApi({ name: '字段探针李老师', username: 'fieldprobe01' })
    const res = await admin.get('/api/users?q=fieldprobe01')
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.total, 1)
    const row = res.data.items[0]

    assert.equal(row.id, created.id)
    assert.equal(row.name, '字段探针李老师')
    assert.equal(row.username, 'fieldprobe01')
    assert.equal(row.status, 'active')
    // 创建时间必须是**可解析的时间**，不是空串、也不是 undefined —— 界面上直接显示它的前 10 位。
    assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T/, `创建时间应当是 ISO 时间：${row.createdAt}`)
    assert.equal(Number.isNaN(Date.parse(row.createdAt)), false)
    assert.equal(row.lastLoginAt, null, '还没登录过就是 null（界面显示"从未登录"）')
    assert.deepEqual(row.permissionSummary, [], '这位老师没有授权')
    assert.equal(row.permissionCount, 0)
    assert.equal(row.isAdmin, false, '普通教师不是管理员')
  })

  test('搜索按姓名，也按用户名（服务端过滤）', async () => {
    const created = await createTeacherViaApi({ name: '搜索探针王老师', username: 'searchprobe01' })

    const byName = await admin.get(`/api/users?q=${encodeURIComponent('搜索探针王')}`)
    assert.equal(byName.data.total, 1)
    assert.equal(byName.data.items[0].id, created.id)

    const byUsername = await admin.get('/api/users?q=searchprobe01')
    assert.equal(byUsername.data.total, 1)
    assert.equal(byUsername.data.items[0].username, 'searchprobe01')
  })

  test('搜索里的 % 与 _ 不会变成通配符', async () => {
    await createTeacherViaApi({ name: '通配符探针', username: 'wildprobe01' })
    const res = await admin.get('/api/users?q=%25')
    assert.equal(res.status, 200)
    assert.equal(res.data.total, 0, '% 应当被当成普通字符')
  })

  test('状态筛选', async () => {
    const created = await createTeacherViaApi({ name: '停用探针', username: 'inactiveprobe' })
    await admin.patch(`/api/users/${created.id}`, { active: false })

    const active = await admin.get('/api/users?status=active&pageSize=100')
    assert.equal(active.data.items.some((i) => i.id === created.id), false)
    const inactive = await admin.get('/api/users?status=inactive&pageSize=100')
    assert.equal(inactive.data.items.some((i) => i.id === created.id), true)
  })

  test('最后登录时间来自会话表：登录过就有，没登录过是 null', async () => {
    await createTeacherViaApi({ name: '登录时间探针', username: 'lastloginprobe' })

    const beforeLogin = await admin.get('/api/users?q=lastloginprobe')
    assert.equal(beforeLogin.data.items[0].lastLoginAt, null, '没登录过就是 null，不能编一个时间')

    const c = client()
    await c.login('lastloginprobe', 'ProbePass!2026')
    const afterLogin = await admin.get('/api/users?q=lastloginprobe')
    assert.equal(typeof afterLogin.data.items[0].lastLoginAt, 'string')
  })

  test('权限摘要是人事化说法，不含权限码', async () => {
    const created = await createTeacherViaApi({
      name: '摘要探针',
      username: 'summaryprobe',
      permissions: [
        { permission: 'resource.view', directoryId: ids.virtue },
        { permission: 'resource.view', directoryId: ids.resources },
        { permission: 'resource.create', directoryId: ids.virtue },
      ],
    })

    const res = await admin.get('/api/users?q=summaryprobe')
    const row = res.data.items[0]
    assert.equal(row.id, created.id)
    assert.equal(row.permissionCount, 3)
    assert.equal(row.directoryCount, 2)

    const summary = row.permissionSummary
    assert.equal(summary.length, 2)
    const view = summary.find((s) => s.label === '查看资源')
    assert.equal(view.directoryCount, 2, '查看资源开放了 2 个目录')
    assert.equal(view.global, false)

    // 摘要里**不允许**出现权限码 —— 业主 §29："不要显示内部 permission code"
    const asText = JSON.stringify(summary.map((s) => s.label))
    assert.equal(/resource\.|user\.manage|audit\.view/.test(asText), false, asText)
  })

  test('权限摘要里的标签来自共享定义（不是界面自己编的）', async () => {
    await createTeacherViaApi({
      name: '标签探针',
      username: 'labelprobe',
      permissions: [{ permission: 'resource.submit', directoryId: ids.virtue }],
    })
    const res = await admin.get('/api/users?q=labelprobe')
    assert.equal(res.data.items[0].permissionSummary[0].label, '提交审核')
  })
})

describe('新增教师（§3）', () => {
  test('字段就是业主列的那些，建完就能登录', async () => {
    const created = await createTeacherViaApi({
      name: '新来的老师',
      username: 'newteacher01',
      permissions: [{ permission: 'resource.view', directoryId: ids.virtue }],
    })
    // ⚠️ `POST /api/users` 只返回 `{ id }`（不返回整行）—— 断言要走 detail 接口，
    // 顺带也验证了"建完之后立刻能查到"。
    const detail = await admin.get(`/api/users/${created.id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.data.name, '新来的老师')
    assert.equal(detail.data.role, 'TEACHER', '新建的账号永远是教师')
    assert.equal(detail.data.status, 'active')

    const c = client()
    const login = await c.login('newteacher01', 'ProbePass!2026')
    assert.equal(login.status, 201, JSON.stringify(login.data))
    // `/api/auth/me` 返回的是 `{ user, permissions }`
    assert.equal((await c.get('/api/auth/me')).data.user.name, '新来的老师')
  })

  test('用户名重复 → 409（不是静默建出两个同名账号）', async () => {
    await createTeacherViaApi({ username: 'dupprobe' })
    const again = await admin.post('/api/users', {
      name: '重复',
      username: 'dupprobe',
      password: 'ProbePass!2026',
      role: 'TEACHER',
    })
    assert.equal(again.status, 409, JSON.stringify(again.data))
  })

  test('密码太短 / 用户名太短 → 400', async () => {
    for (const body of [
      { name: 'x', username: 'okname01', password: 'short', role: 'TEACHER' },
      { name: 'x', username: 'ab', password: 'ProbePass!2026', role: 'TEACHER' },
      { name: '', username: 'okname02', password: 'ProbePass!2026', role: 'TEACHER' },
    ]) {
      const res = await admin.post('/api/users', body)
      assert.equal(res.status, 400, JSON.stringify(res.data))
    }
  })

  test('未知权限码 → 400/403（拒绝幽灵权限）', async () => {
    const res = await admin.post('/api/users', {
      name: '幽灵权限',
      username: 'ghostprobe',
      password: 'ProbePass!2026',
      role: 'TEACHER',
      permissions: [{ permission: 'resource.hack', directoryId: null }],
    })
    assert.equal([400, 403].includes(res.status), true, JSON.stringify(res.data))
  })

  test('只有**超级管理员**能建账号：普通教师 403（即使被误配了 user.manage 也一样）', async () => {
    /*
      规则变更（业主 Stage 13 §4）：门槛从"持有 user.manage 权限"改成"是超级管理员身份"。
      被误配 user.manage 的老师同样要被拒 —— 那正是提权通道（详见
      tests/integration/account-privileges.test.mjs 里主动制造误配的用例）。
    */
    const res = await teacher.post('/api/users', {
      name: '越权',
      username: 'nope01',
      password: 'ProbePass!2026',
      role: 'TEACHER',
    })
    assert.equal(res.status, 403)
  })
})

describe('停用而不是删除（§2 / §19）', () => {
  test('停用后不能登录；账号本身还在（历史不断链）', async () => {
    const created = await createTeacherViaApi({ name: '要被停用的', username: 'todisable01' })

    const c = client()
    assert.equal((await c.login('todisable01', 'ProbePass!2026')).status, 201)
    // 停用前有历史：一条登录审计
    const before = await withSql(async (sql) => {
      const rows = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = ${created.id}`
      return rows[0].n
    })
    assert.equal(before >= 1, true, '停用之前应当已经有审计记录')

    const disabled = await admin.patch(`/api/users/${created.id}`, { active: false })
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data))
    assert.equal(disabled.data.revokedSessions >= 1, true, '停用必须撤销已有会话')

    const again = client()
    const login = await again.login('todisable01', 'ProbePass!2026')
    assert.equal(login.status, 401, '停用之后不能登录')

    // 用户行还在（停用不是删除）
    const rows = await withSql(async (sql) => {
      const rows = await sql`SELECT status FROM users WHERE id = ${created.id}`
      return rows
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'inactive')

    // 停用前的历史审计一条不少
    const after = await withSql(async (sql) => {
      const rows = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = ${created.id}`
      return rows[0].n
    })
    assert.equal(after >= before, true, '审计不能因为账号停用而消失')
  })

  test('没有"删除账号"的接口（只能停用）', async () => {
    const created = await createTeacherViaApi({ username: 'nodelete01' })
    const res = await admin.del(`/api/users/${created.id}`)
    // 没有这个路由 → Nest 返回 404（不是 200）。这条断言的意义是：
    // 将来有人顺手加一个 DELETE，它会立刻红，从而被迫先回答"审计怎么办"。
    assert.equal(res.status, 404, `不该存在删除账号的接口，实际 ${res.status}`)
  })
})
