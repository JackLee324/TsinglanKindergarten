/**
 * tests/integration/admin-security.test.mjs —— 管理员自己的边界（业主 §5–§7 / §17 / §18 / §19 / §27）
 * ============================================================================
 * 管理员权力最大，所以**关于管理员自己的规则更要紧**。这一份测的全是
 * "万一做错了会把人锁在系统外面"的那几件事：
 *
 *   · 最后一个管理员不能被停用 / 降级（业主 §7 / §18）→ 明确提示；
 *   · 不能改自己的身份（业主 §27）—— 自己降级是最常见的误操作；
 *   · 权限 / 状态 / 口令任一变化 → **立刻**撤销该账号全部会话（业主 §5 / §17）；
 *   · 停用一个人不删他的历史（业主 §19：审计 / 审核 / 上传者都不能断链）。
 *
 * 提示语是逐字断言的：业主指定的那句是「系统至少需要一名管理员。」
 * —— 界面要原样显示它，所以它必须真的从服务端来。
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

let rootAdmin
let secondAdmin
let teacher
let ids = {}
const probeUsernames = []

/**
 * 重新登录。
 *
 * ⚠️ 每次"启用 / 停用账号"都会**撤销该账号的全部会话**（这是设计要求）。
 * 所以测试里只要动过某个账号的状态，就必须重新登录它 ——
 * 第一版忘了这件事，后面的用例拿到的是 401，看起来像"功能坏了"，
 * 其实是"会话真的被踢掉了"。这个 helper 让这件事在代码里看得见。
 */
async function relogin(username, password) {
  const c = client()
  const res = await c.login(username, password)
  assert.equal(res.status, 201, `重新登录 ${username} 失败：${JSON.stringify(res.data)}`)
  return c
}

async function cleanupProbes() {
  if (probeUsernames.length === 0) return 0
  return withSql(async (sql) => {
    const rows = await sql`
      DELETE FROM users WHERE username = ANY(${probeUsernames}::text[]) RETURNING id::text
    `
    return rows.length
  })
}

before(async () => {
  await resetDatabase()
  // 主管理员由夹具创建；第二个管理员用**接口**创建（走真实的建号路径）。
  await createAdmin('sec_root', 'SecRootPass!1')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')

  await startServer()
  rootAdmin = client()
  await rootAdmin.login('sec_root', 'SecRootPass!1')

  probeUsernames.push('sec_admin2')
  /*
    第二位管理员：**接口新增管理员的路已经封掉了**（业主 Stage 13B §2：
    超级管理员只能有一名，`PATCH /api/users/:id` 想把教师升成 ADMIN 会 400
    `SUPERADMIN_TRANSFER_REQUIRED`；换人只能走 `scripts/transfer-superadmin.mjs`）。

    但"系统里同时存在两个管理员"这件事仍然真的会发生 —— 生产上就是历史遗留
    （迁过来时一共有三名，收敛之后只剩 `TsinglanAdmin` 一名）。
    「最后一名管理员」这道护栏要管的正是这种状态，所以这里**用夹具直接写入一行
    ADMIN**（`createAdmin`，模拟历史数据），而不是走已经封掉的接口。
    "接口不能新增管理员"这件事由下面 `超级管理员唯一化` 那组用例单独钉住。
  */
  await createAdmin('sec_admin2', 'SecAdmin2Pass!1')
  secondAdmin = client()
  await secondAdmin.login('sec_admin2', 'SecAdmin2Pass!1')

  await createTeacher('sec_teacher', 'SecTeacherPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
  ], '安全探针老师')
  teacher = client()
  await teacher.login('sec_teacher', 'SecTeacherPass!1')
})

after(async () => {
  const removed = await cleanupProbes()
  assert.equal(removed, probeUsernames.length, '探针账号必须全部清掉（残留核对）')
  await stopServer()
})

describe('最后一个管理员（§7 / §18 / §27）', () => {
  test('有两位管理员时，停用其中一位是允许的', async () => {
    const list = await rootAdmin.get('/api/users?q=sec_admin2')
    const id = list.data.items[0].id
    const res = await rootAdmin.patch(`/api/users/${id}`, { active: false })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    // 复原，后面的用例还要用
    await rootAdmin.patch(`/api/users/${id}`, { active: true })
  })

  test('把**另一位**降级到最后一个管理员时被拒绝，并给出业主指定的那句话', async () => {
    // 先停用第二位管理员 → root 成为唯一 active ADMIN
    const list = await rootAdmin.get('/api/users?q=sec_admin2')
    const secondId = list.data.items[0].id
    await rootAdmin.patch(`/api/users/${secondId}`, { active: false })

    // 现在停用 root（最后一个）必须被拒
    const me = await rootAdmin.get('/api/auth/me')
    const rootId = me.data.user.id
    const res = await rootAdmin.patch(`/api/users/${rootId}`, { active: false })
    assert.equal(res.status, 400, JSON.stringify(res.data))
    assert.equal(res.data.message, '系统至少需要一名管理员。')
    assert.equal(res.data.code, 'LAST_ADMIN')

    // 降级同样被拒（而且这里先撞上"不能改自己的身份"，两条护栏都在）
    const demote = await rootAdmin.patch(`/api/users/${rootId}`, { role: 'TEACHER' })
    assert.equal(demote.status, 400, JSON.stringify(demote.data))

    await rootAdmin.patch(`/api/users/${secondId}`, { active: true })
    // 启用动作撤销了 second 的全部会话 —— 后面还要用它，所以重新登录。
    secondAdmin = await relogin('sec_admin2', 'SecAdmin2Pass!1')
  })

  test('降级**另一位**管理员到最后一位时同样被拒绝', async () => {
    const list = await rootAdmin.get('/api/users?q=sec_admin2')
    const secondId = list.data.items[0].id

    // 先把 root 自己降级？不行（不能改自己）。所以换个方向：
    // 停用 root 需要"还有第二个管理员"，所以先停 root 是允许的。
    const me = await rootAdmin.get('/api/auth/me')
    const rootId = me.data.user.id
    assert.equal((await secondAdmin.patch(`/api/users/${rootId}`, { active: false })).status, 200)

    // 现在 second 是最后一个管理员：他不能把自己降级
    const res = await secondAdmin.patch(`/api/users/${secondId}`, { role: 'TEACHER' })
    assert.equal(res.status, 400, JSON.stringify(res.data))
    assert.match(res.data.message, /自己的身份|至少需要一名管理员/)

    // 也不能把自己停用
    const disable = await secondAdmin.patch(`/api/users/${secondId}`, { active: false })
    assert.equal(disable.status, 400)

    // 复原
    await secondAdmin.patch(`/api/users/${rootId}`, { active: true })
    // 同理：root 的会话也被撤销了，后面的用例还要用它。
    rootAdmin = await relogin('sec_root', 'SecRootPass!1')
  })

  test('管理员不能修改自己的身份（业主 §27）', async () => {
    const me = await secondAdmin.get('/api/auth/me')
    const res = await secondAdmin.patch(`/api/users/${me.data.user.id}`, { role: 'TEACHER' })
    assert.equal(res.status, 400, JSON.stringify(res.data))
    assert.equal(res.data.code, 'SELF_ROLE_CHANGE')
    assert.match(res.data.message, /自己的身份/)
  })

  test('管理员可以改自己的名字（允许的那一半）', async () => {
    const me = await secondAdmin.get('/api/auth/me')
    const res = await secondAdmin.patch(`/api/users/${me.data.user.id}`, { name: '第二位管理员（改名）' })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    await secondAdmin.patch(`/api/users/${me.data.user.id}`, { name: '第二位管理员' })
  })
})

describe('超级管理员唯一化（业主 Stage 13B §2）', () => {
  test('账号编辑**不能**把教师升成管理员：换人只能走交接流程', async () => {
    const created = await rootAdmin.post('/api/users', {
      name: '想升管理员的人',
      username: 'sec_want_admin',
      password: 'SecWantAdmin!1',
      role: 'TEACHER',
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    probeUsernames.push('sec_want_admin')

    const promoted = await rootAdmin.patch(`/api/users/${created.data.id}`, { role: 'ADMIN' })
    assert.equal(promoted.status, 400, `必须明确拒绝：${JSON.stringify(promoted.data)}`)
    assert.equal(promoted.data.code, 'SUPERADMIN_TRANSFER_REQUIRED')
    assert.match(promoted.data.message, /超级管理员只能有一名/)

    // 被拒之后不能留下任何改变
    const list = await rootAdmin.get('/api/users?q=sec_want_admin')
    assert.equal(list.data.items[0].role, 'TEACHER', '被拒的升级不能留下任何变化')
  })
})

describe('权限 / 状态 / 口令改动 → 会话立刻失效（§5 / §17）', () => {
  test('改权限之后旧会话不能再用，重新登录才生效', async () => {
    const list = await rootAdmin.get('/api/users?q=sec_teacher')
    const id = list.data.items[0].id

    // 改之前：这位老师的会话是好的
    assert.equal((await teacher.get('/api/auth/me')).status, 200)

    const res = await rootAdmin.put(`/api/users/${id}/permissions`, {
      permissions: [
        { permission: 'resource.view', directoryId: ids.virtue },
        { permission: 'resource.create', directoryId: ids.virtue },
      ],
    })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.revokedSessions >= 1, true, '改权限必须撤销旧会话')

    // 旧会话已经无效
    const stale = await teacher.get('/api/auth/me')
    assert.equal(stale.status, 401, '旧会话必须立刻失效')

    // 重新登录后新权限生效
    const fresh = client()
    await fresh.login('sec_teacher', 'SecTeacherPass!1')
    const caps = await fresh.get('/api/auth/capabilities')
    assert.equal(caps.data.canUpload, true, '重新登录后应当拿到上传能力')
    teacher = fresh
  })

  test('停用之后旧会话立刻失效（不是"等它自然过期"）', async () => {
    const list = await rootAdmin.get('/api/users?q=sec_teacher')
    const id = list.data.items[0].id

    assert.equal((await teacher.get('/api/auth/me')).status, 200)
    const res = await rootAdmin.patch(`/api/users/${id}`, { active: false })
    assert.equal(res.data.revokedSessions >= 1, true)
    assert.equal((await teacher.get('/api/auth/me')).status, 401)

    await rootAdmin.patch(`/api/users/${id}`, { active: true })
    const fresh = client()
    assert.equal((await fresh.login('sec_teacher', 'SecTeacherPass!1')).status, 201)
    teacher = fresh
  })

  test('管理员重置口令之后旧会话立刻失效，且新口令可用', async () => {
    const list = await rootAdmin.get('/api/users?q=sec_teacher')
    const id = list.data.items[0].id

    assert.equal((await teacher.get('/api/auth/me')).status, 200)
    const res = await rootAdmin.patch(`/api/users/${id}`, { password: 'BrandNewPass!2026' })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal((await teacher.get('/api/auth/me')).status, 401, '改口令必须踢掉旧会话')

    const stale = client()
    assert.equal((await stale.login('sec_teacher', 'SecTeacherPass!1')).status, 401, '旧口令不能再用')
    const fresh = client()
    assert.equal((await fresh.login('sec_teacher', 'BrandNewPass!2026')).status, 201)
    teacher = fresh
  })

  test('管理员看不到任何人的口令，也不能取回旧口令（§16）', async () => {
    const list = await rootAdmin.get('/api/users?q=sec_teacher')
    const detail = await rootAdmin.get(`/api/users/${list.data.items[0].id}`)
    const body = JSON.stringify(detail.data)
    for (const forbidden of ['password', 'passwordHash', 'password_hash']) {
      assert.equal(body.includes(forbidden), false, `响应里不该出现 ${forbidden}`)
    }
    // 数据库里存的必须是哈希
    const rows = await withSql(async (sql) => {
      return sql`SELECT password_hash FROM users WHERE username = 'sec_teacher'`
    })
    assert.match(rows[0].password_hash, /^scrypt\$/, '口令必须以 scrypt 哈希存储')
  })
})

describe('历史不断链（§19）', () => {
  test('停用账号之后：审计还在、上传者名字还在', async () => {
    const created = await rootAdmin.post('/api/users', {
      name: '历史探针老师',
      username: 'sec_history',
      password: 'SecHistoryPass!1',
      role: 'TEACHER',
      permissions: [
        { permission: 'resource.view', directoryId: ids.virtue },
        { permission: 'resource.create', directoryId: ids.virtue },
        { permission: 'resource.update.own', directoryId: ids.virtue },
      ],
    })
    probeUsernames.push('sec_history')
    const id = created.data.id

    // 用这位老师的账号上传一条资源（产生"上传者"这条链）
    const author = client()
    await author.login('sec_history', 'SecHistoryPass!1')
    const resource = await author.post('/api/resources', {
      directoryId: await directoryIdByPath('education/pre-k/virtue/resources'),
      title: '历史探针资源',
    })
    assert.equal(resource.status, 201)

    const auditBefore = await withSql(async (sql) => {
      return sql`SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = ${id}`
    })

    await rootAdmin.patch(`/api/users/${id}`, { active: false })

    // 审计一条不少
    const auditAfter = await withSql(async (sql) => {
      return sql`SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = ${id}`
    })
    assert.equal(auditAfter[0].n, auditBefore[0].n, '停用不该删掉这个人的历史审计')

    // 资源的上传者仍然指向他，而且界面上还能显示出名字
    const detail = await rootAdmin.get(`/api/resources/${resource.data.id}`)
    assert.equal(detail.data.uploaderId, id)
    assert.equal(detail.data.uploaderName, '历史探针老师')

    // 清理这条资源
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ${resource.data.id}`
    })
  })

  test('停用账号之后它仍然出现在列表里（可以再启用）', async () => {
    const res = await rootAdmin.get('/api/users?q=sec_history')
    assert.equal(res.data.items.length, 1)
    assert.equal(res.data.items[0].status, 'inactive')
  })
})

describe('普通教师不能碰管理接口（§6）', () => {
  test('改自己的权限 / 改别人的权限 / 建账号 / 升管理员 —— 一律 403', async () => {
    const list = await rootAdmin.get('/api/users?q=sec_teacher')
    const teacherId = list.data.items[0].id
    const me = await teacher.get('/api/auth/me')
    const myId = me.data.user.id

    for (const res of [
      await teacher.put(`/api/users/${myId}/permissions`, { permissions: [] }),
      await teacher.put(`/api/users/${teacherId}/permissions`, { permissions: [] }),
      await teacher.patch(`/api/users/${myId}`, { role: 'ADMIN' }),
      await teacher.patch(`/api/users/${teacherId}`, { role: 'ADMIN' }),
      await teacher.post('/api/users', {
        name: 'x',
        username: 'x123456',
        password: 'ProbePass!2026',
        role: 'ADMIN',
      }),
      await teacher.get('/api/users'),
    ]) {
      assert.equal(res.status, 403, JSON.stringify(res.data))
    }

    // 自己的身份没有被改动
    const after = await teacher.get('/api/auth/me')
    assert.equal(after.data.user.role, 'TEACHER')
  })
})
