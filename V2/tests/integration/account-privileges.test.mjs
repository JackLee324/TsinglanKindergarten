/**
 * tests/integration/account-privileges.test.mjs —— 账号管理的**权限边界**（业主 Stage 13 §4）
 * ============================================================================
 * 这一份专门盯住一类很容易被"界面藏了按钮"掩盖的问题：
 *
 *   **账号管理（建账号 / 改身份 / 改权限 / 停用 / 改口令）只有超级管理员能做**
 *   —— 不是"有 `user.manage` 权限的人能做"。
 *
 * 为什么必须这样：`user.manage` 是**可授予**的权限。只要它还是门槛，
 * 一个被误配了它的老师就能直接调 API 建管理员、把别人（或自己）升级成管理员。
 * 前端把按钮藏起来挡不住 curl，也挡不住任何直接调用。
 *
 * 于是这里的核心用例是**主动制造误配置**：用 SQL 把 `user.manage` 直接塞给一个老师
 * （模拟"有人在界面上误勾了"，虽然现在界面已经不提供这个勾选框了），
 * 然后逐一调用账号管理接口 —— 全部必须 403。
 *
 * 覆盖：
 *   ① 误配 user.manage 的老师：账号管理接口全部 403（读 + 写）
 *   ② 老师不能建 ADMIN、不能改自己/别人的身份
 *   ③ 创建接口只建 TEACHER；建 ADMIN 被明确拒绝
 *   ④ 创建时 active 一次落库：停用的账号从第一秒就登不进去
 *   ⑤ 改用户名：大小写不敏感唯一、写审计、旧会话失效
 *   ⑥ 不能把 user.manage 授予出去（它是身份自带的）
 *   ⑦ 并发建同一个用户名只成功一个
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  runProjectScriptCaptured,
  runProjectScriptFailure,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'

let admin
let prekVirtue

before(async () => {
  await resetDatabase()
  await createAdmin('ap_admin', 'ApAdminPass!2026')
  prekVirtue = await directoryIdByPath('education/pre-k/virtue')
  await startServer()
  admin = client()
  await admin.login('ap_admin', 'ApAdminPass!2026')
})
after(async () => {
  await stopServer()
})

/** 建一个老师，并**直接把 `user.manage` 写进授权表**（模拟误配置）。 */
async function teacherWithManageMisconfigured(username, password) {
  await createTeacher(username, password, [
    { permission: 'resource.view', directoryId: prekVirtue },
    { permission: 'resource.create', directoryId: prekVirtue },
  ])
  const id = await withSql(async (sql) => {
    const rows = await sql`SELECT id::text FROM users WHERE username = ${username}`
    return rows[0].id
  })
  await withSql(async (sql) => {
    // 绕过接口直接写库 —— 这正是"误配置"的定义：授权表里有，但身份不是管理员。
    await sql`
      INSERT INTO user_permissions (user_id, permission, directory_id)
      VALUES (${id}, 'user.manage', NULL)
    `
  })
  const c = client()
  await c.login(username, password)
  return { id, client: c }
}

describe('① 误配 user.manage 的老师依然管不了账号（服务端身份门槛）', () => {
  test('读接口全部 403：列表 / 详情 / 权限', async () => {
    const { id, client: c } = await teacherWithManageMisconfigured('ap7_manage', 'Ap7Manage!2026')

    const list = await c.get('/api/users')
    assert.equal(list.status, 403, `列表必须拒绝：${JSON.stringify(list.data)}`)
    assert.match(JSON.stringify(list.data), /超级管理员/, '要说清是"只有超级管理员能管账号"')

    const one = await c.get(`/api/users/${id}`)
    assert.equal(one.status, 403)

    const perms = await c.get(`/api/users/${id}/permissions`)
    assert.equal(perms.status, 403)
  })

  test('写接口全部 403：建账号 / 改身份 / 改权限 / 停用', async () => {
    const { id, client: c } = await teacherWithManageMisconfigured('ap7_manage2', 'Ap7Manage2!2026')

    const created = await c.post('/api/users', {
      name: '偷建的管理员',
      username: 'ap7_smuggled',
      password: 'Smuggled!2026x',
      role: 'ADMIN',
    })
    assert.equal(created.status, 403, `不能建账号：${JSON.stringify(created.data)}`)

    const promoteOther = await c.patch(`/api/users/${id}`, { role: 'ADMIN' })
    assert.equal(promoteOther.status, 403)

    const grantSelf = await c.put(`/api/users/${id}/permissions`, {
      permissions: [{ permission: 'resource.delete.own', directoryId: prekVirtue }],
    })
    assert.equal(grantSelf.status, 403)

    const disable = await c.patch(`/api/users/${id}`, { active: false })
    assert.equal(disable.status, 403)

    // 身份确实没变，授权也没变（拒绝必须是"什么都没发生"，不是"做了但报错"）
    const after = await withSql(async (sql) => {
      const rows = await sql`SELECT role, status FROM users WHERE id = ${id}`
      const grants = await sql`SELECT permission FROM user_permissions WHERE user_id = ${id} ORDER BY permission`
      return { role: rows[0].role, status: rows[0].status, grants: grants.map((g) => g.permission) }
    })
    assert.equal(after.role, 'TEACHER')
    assert.equal(after.status, 'active')
    assert.deepEqual(after.grants, ['resource.create', 'resource.view', 'user.manage'])
  })

  test('老师也不能借权限编辑给自己加权限（接口先拒身份）', async () => {
    const { id, client: c } = await teacherWithManageMisconfigured('ap7_manage3', 'Ap7Manage3!2026')
    const res = await c.put(`/api/users/${id}/permissions`, {
      permissions: [{ permission: 'directory.manage', directoryId: null }],
    })
    assert.equal(res.status, 403)
  })
})

describe('② 超级管理员：创建教师的实际行为', () => {
  test('创建并启用 → 立刻能登录', async () => {
    const res = await admin.post('/api/users', {
      name: '启用老师',
      username: 'ap7_active',
      password: 'Ap7Active!2026',
      role: 'TEACHER',
      active: true,
      permissions: [{ permission: 'resource.view', directoryId: prekVirtue }],
    })
    assert.equal(res.status, 201, JSON.stringify(res.data))

    const c = client()
    const login = await c.login('ap7_active', 'Ap7Active!2026')
    assert.ok([200, 201].includes(login.status), `应当能登录：${JSON.stringify(login.data)}`)
  })

  test('创建时选停用 → **一次落库**，账号从第一秒就登不进去', async () => {
    const res = await admin.post('/api/users', {
      name: '停用老师',
      username: 'ap7_inactive',
      password: 'Ap7Inactive!2026',
      role: 'TEACHER',
      active: false,
    })
    assert.equal(res.status, 201, JSON.stringify(res.data))

    // 数据库里从一开始就是 inactive（不是"先 active 再被第二个请求改掉"）
    const row = await withSql(async (sql) => {
      const rows = await sql`SELECT status FROM users WHERE username = 'ap7_inactive'`
      return rows[0]
    })
    assert.equal(row.status, 'inactive')

    const c = client()
    const login = await c.login('ap7_inactive', 'Ap7Inactive!2026')
    assert.equal(login.status, 401, `停用的账号不能登录：${JSON.stringify(login.data)}`)
  })

  test('创建接口只建教师：role=ADMIN 被明确拒绝（不悄悄降级）', async () => {
    const res = await admin.post('/api/users', {
      name: '想直接建管理员',
      username: 'ap7_want_admin',
      password: 'Ap7WantAdmin!2026',
      role: 'ADMIN',
    })
    assert.equal(res.status, 400, `应当 400：${JSON.stringify(res.data)}`)
    assert.match(JSON.stringify(res.data), /只能创建教师账号/)

    // 没有留下半成品账号
    const row = await withSql(async (sql) => {
      const rows = await sql`SELECT count(*)::int AS n FROM users WHERE username = 'ap7_want_admin'`
      return rows[0].n
    })
    assert.equal(row, 0, '被拒的创建不能留下账号')
  })

  test('用户名冲突 → 409（大小写不敏感）', async () => {
    const res = await admin.post('/api/users', {
      name: '大写重名',
      username: 'AP7_ACTIVE',
      password: 'Ap7Dup!2026xx',
      role: 'TEACHER',
    })
    assert.equal(res.status, 409, JSON.stringify(res.data))
  })

  test('并发建同一个用户名：只成功一个，另一个 409', async () => {
    const body = {
      name: '并发同名',
      username: 'ap7_race',
      password: 'Ap7Race!2026x',
      role: 'TEACHER',
    }
    const [a, b] = await Promise.all([
      admin.post('/api/users', body),
      admin.post('/api/users', body),
    ])
    const codes = [a.status, b.status].sort()
    assert.deepEqual(codes, [201, 409], `实际：${codes.join(',')} / ${JSON.stringify([a.data, b.data])}`)

    const n = await withSql(async (sql) => {
      const rows = await sql`SELECT count(*)::int AS n FROM users WHERE lower(username) = 'ap7_race'`
      return rows[0].n
    })
    assert.equal(n, 1, '数据库唯一索引保证只有一个账号')
  })
})

describe('③ 修改教师账号：用户名、审计与会话', () => {
  test('改用户名成功：写审计、旧会话失效、新用户名能登录', async () => {
    const created = await admin.post('/api/users', {
      name: '改名老师',
      username: 'ap7_rename_old',
      password: 'Ap7Rename!2026',
      role: 'TEACHER',
      permissions: [{ permission: 'resource.view', directoryId: prekVirtue }],
    })
    const id = created.data.id

    const teacher = client()
    await teacher.login('ap7_rename_old', 'Ap7Rename!2026')
    const before = await teacher.get('/api/auth/me')
    assert.equal(before.status, 200, '改名之前会话可用')

    const renamed = await admin.patch(`/api/users/${id}`, { username: 'ap7_rename_new' })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data))
    assert.ok(renamed.data.revokedSessions >= 1, `应当撤销旧会话：${JSON.stringify(renamed.data)}`)

    // 旧会话立刻失效
    const afterRename = await teacher.get('/api/auth/me')
    assert.equal(afterRename.status, 401, '改用户名后旧会话必须失效')

    // 审计里有一条单独的 username_change（不混在笼统的 user.update 里）
    const audited = await withSql(async (sql) => {
      const rows = await sql`
        SELECT action, detail FROM audit_logs
        WHERE target_type = 'user' AND target_id = ${id} AND action = 'user.username_change'
      `
      return rows
    })
    assert.equal(audited.length, 1, '必须有一条 user.username_change 审计')
    assert.equal(audited[0].detail.username, 'ap7_rename_new')
    assert.equal(audited[0].detail.before.username, 'ap7_rename_old')
    assert.equal(JSON.stringify(audited[0].detail).includes('Ap7Rename!2026'), false, '审计里绝不能有口令')

    // 新用户名能登录，旧用户名不能
    const fresh = client()
    assert.ok([200, 201].includes((await fresh.login('ap7_rename_new', 'Ap7Rename!2026')).status))
    const stale = client()
    assert.equal((await stale.login('ap7_rename_old', 'Ap7Rename!2026')).status, 401)
  })

  test('改用户名撞已有账号 → 409，且不产生任何改动', async () => {
    // 用**确实还被占用**的名字：把 ap7_active 改成 ap7_rename_new（后者此刻存在）
    const target = await withSql(async (sql) => {
      const rows = await sql`SELECT id::text FROM users WHERE username = 'ap7_active'`
      return rows[0].id
    })
    const res = await admin.patch(`/api/users/${target}`, { username: 'AP7_Rename_New' })
    assert.equal(res.status, 409, `大写也算重名：${JSON.stringify(res.data)}`)

    // 被拒之后账号名没变
    const still = await withSql(async (sql) => {
      const rows = await sql`SELECT username FROM users WHERE id = ${target}`
      return rows[0].username
    })
    assert.equal(still, 'ap7_active', '被拒的改名不能留下任何改动')
  })

  test('不能把「管理教师」授予出去（它是身份自带的）', async () => {
    const target = await admin.post('/api/users', {
      name: '不该拿到管理权',
      username: 'ap7_grant_target',
      password: 'Ap7Grant!2026x',
      role: 'TEACHER',
    })
    const res = await admin.put(`/api/users/${target.data.id}/permissions`, {
      permissions: [{ permission: 'user.manage', directoryId: null }],
    })
    assert.equal(res.status, 400, `应当明确拒绝：${JSON.stringify(res.data)}`)
    assert.match(JSON.stringify(res.data), /超级管理员/)
  })

  test('不能修改自己的身份（仍然保留的护栏）', async () => {
    const me = await admin.get('/api/auth/me')
    const res = await admin.patch(`/api/users/${me.data.user.id}`, { role: 'TEACHER' })
    assert.equal(res.status, 400, JSON.stringify(res.data))
  })
})


describe('④ 超级管理员唯一化（业主 Stage 13B §2）', () => {
  test('编辑接口**不能**把别人升成管理员（不留第二条超管通道）', async () => {
    const target = await admin.post('/api/users', {
      name: '想升管理员',
      username: 'ap7_promote_me',
      password: 'Ap7Promote!2026',
      role: 'TEACHER',
    })
    assert.equal(target.status, 201, JSON.stringify(target.data))

    const promoted = await admin.patch(`/api/users/${target.data.id}`, { role: 'ADMIN' })
    assert.equal(promoted.status, 400, `应当明确拒绝：${JSON.stringify(promoted.data)}`)
    assert.match(JSON.stringify(promoted.data), /超级管理员只能有一名|交接/)

    // 身份没变，而且系统里仍然**恰好一名**管理员
    const state = await withSql(async (sql) => {
      const rows = await sql`SELECT role FROM users WHERE id = ${target.data.id}`
      const admins = await sql`SELECT username FROM users WHERE role = 'ADMIN' ORDER BY username`
      return { role: rows[0].role, admins: admins.map((a) => a.username) }
    })
    assert.equal(state.role, 'TEACHER', '被拒的升级不能留下任何变化')
    assert.deepEqual(state.admins, ['ap_admin'], `只能有一名管理员：${JSON.stringify(state.admins)}`)
  })

  test('交接脚本：缺确认字符串时拒绝执行（防止手误换人）', async () => {
    const { code, out } = await runProjectScriptFailure('scripts/transfer-superadmin.mjs', {
      TRANSFER_FROM_USERNAME: 'ap_admin',
      TRANSFER_TO_USERNAME: 'ap7_promote_me',
    })
    assert.notEqual(code, 0, '缺确认必须失败')
    assert.match(out, /TRANSFER-CONFIRM|确认/, `要说清缺什么：${out.slice(0, 200)}`)

    // 而且**真的没换人**：拒绝执行不能留下半截状态
    const admins = await withSql(async (sql) => {
      const rows = await sql`SELECT username FROM users WHERE role = 'ADMIN' ORDER BY username`
      return rows.map((r) => r.username)
    })
    assert.deepEqual(admins, ['ap_admin'], `被拒的交接不能动数据：${JSON.stringify(admins)}`)
  })

  test('交接脚本：一降一升在同一事务，交接后仍**恰好一名**有效管理员，并写两条审计', async () => {
    const before = await withSql(async (sql) => {
      const rows = await sql`SELECT username FROM users WHERE role = 'ADMIN' AND status = 'active'`
      return rows.map((r) => r.username)
    })
    assert.deepEqual(before, ['ap_admin'], '前置：只有一名有效管理员')

    const out = await runProjectScriptCaptured('scripts/transfer-superadmin.mjs', {
      TRANSFER_FROM_USERNAME: 'ap_admin',
      TRANSFER_TO_USERNAME: 'ap7_promote_me',
      TRANSFER_CONFIRM: 'TRANSFER-SUPERADMIN',
    })
    assert.match(out, /超级管理员交接完成/, `脚本应当报成功：${out.slice(0, 300)}`)
    assert.match(out, /当前唯一有效管理员：ap7_promote_me/)

    const after = await withSql(async (sql) => {
      const admins = await sql`SELECT username FROM users WHERE role = 'ADMIN' ORDER BY username`
      const activeAdmins = await sql`SELECT username FROM users WHERE role = 'ADMIN' AND status = 'active'`
      const audits = await sql`
        SELECT action FROM audit_logs
        WHERE action IN ('user.role_transfer_out', 'user.role_transfer_in') ORDER BY action`
      const outgoing = await sql`SELECT role FROM users WHERE username = 'ap_admin'`
      return {
        admins: admins.map((a) => a.username),
        activeAdmins: activeAdmins.map((a) => a.username),
        audits: audits.map((a) => a.action),
        outgoingRole: outgoing[0].role,
      }
    })
    assert.deepEqual(after.activeAdmins, ['ap7_promote_me'], `接手人必须是唯一有效管理员：${JSON.stringify(after)}`)
    assert.equal(after.admins.length, 1, '系统里只能有一个 ADMIN 行')
    assert.equal(after.outgoingRole, 'TEACHER', '交出的那一方必须降级')
    assert.deepEqual(after.audits, ['user.role_transfer_in', 'user.role_transfer_out'], '两条审计都要有')
  })

  test('交接之后：新超级管理员能管账号，旧的不能', async () => {
    const newAdmin = client()
    const loginNew = await newAdmin.login('ap7_promote_me', 'Ap7Promote!2026')
    assert.ok([200, 201].includes(loginNew.status), `新管理员应当能登录：${JSON.stringify(loginNew.data)}`)
    const list = await newAdmin.get('/api/users')
    assert.equal(list.status, 200, '新超级管理员能列账号')

    const oldAdmin = client()
    await oldAdmin.login('ap_admin', 'ApAdminPass!2026')
    const denied = await oldAdmin.get('/api/users')
    assert.equal(denied.status, 403, '交出身份之后不能再管账号')

    // 把身份还回去，避免影响同文件后面的用例（走同一个交接流程）
    const back = await runProjectScriptCaptured('scripts/transfer-superadmin.mjs', {
      TRANSFER_FROM_USERNAME: 'ap7_promote_me',
      TRANSFER_TO_USERNAME: 'ap_admin',
      TRANSFER_CONFIRM: 'TRANSFER-SUPERADMIN',
    })
    assert.match(back, /当前唯一有效管理员：ap_admin/, `还回去也要成功：${back.slice(0, 200)}`)
  })
})
