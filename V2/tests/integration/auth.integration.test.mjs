/** 认证：登录 / 会话 / CSRF / 停用 / 改密。
 *
 * 每条都在真实 HTTP 上跑（服务是 `npm run build` 的产物）。 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEST_BASE,
  client,
  createAdmin,
  createTeacher,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'

before(async () => {
  await resetDatabase()
  await createAdmin('auth_admin', 'AuthAdminPass!1')
  await startServer()
})
after(async () => {
  await stopServer()
})

describe('登录', () => {
  test('正确口令 → 200，下发会话与 CSRF cookie', async () => {
    const c = client()
    const res = await c.login('auth_admin', 'AuthAdminPass!1')
    assert.equal(res.status, 201)
    assert.equal(res.data.user.username, 'auth_admin')
    assert.equal(res.data.user.role, 'ADMIN')
    assert.ok(c.cookie('v2_session'), '必须有会话 cookie')
    assert.ok(c.cookie('v2_csrf'), '必须有 CSRF cookie')
  })

  test('口令错误 → 401，且提示不区分"用户不存在"与"密码不对"', async () => {
    const wrongPass = await client().login('auth_admin', 'nope-nope-nope')
    const noUser = await client().login('does_not_exist', 'nope-nope-nope')
    assert.equal(wrongPass.status, 401)
    assert.equal(noUser.status, 401)
    assert.equal(wrongPass.data.message, noUser.data.message, '两种情况必须给同一句话（防账号枚举）')
  })

  test('停用账号不能登录', async () => {
    const teacher = await createTeacher('auth_disabled', 'DisabledPass!1', [])
    await withSql(
      (sql) => sql`UPDATE users SET status = 'inactive' WHERE id = ${teacher.id}`,
    )
    const res = await client().login('auth_disabled', 'DisabledPass!1')
    assert.equal(res.status, 401)
    assert.equal(res.data.code, 'ACCOUNT_DISABLED')
  })
})

describe('会话与 CSRF', () => {
  test('/auth/me 返回自己的身份与权限', async () => {
    const c = client()
    await c.login('auth_admin', 'AuthAdminPass!1')
    const res = await c.get('/api/auth/me')
    assert.equal(res.status, 200)
    assert.equal(res.data.user.username, 'auth_admin')
  })

  test('未登录访问受保护接口 → 401', async () => {
    const res = await client().get('/api/users')
    assert.equal(res.status, 401)
    assert.equal(res.data.code, 'UNAUTHENTICATED')
  })

  test('缺少 CSRF 头 → 403（双提交 cookie）', async () => {
    const c = client()
    await c.login('auth_admin', 'AuthAdminPass!1')
    // 手工构造一个"带着会话 cookie 但没有 CSRF 头"的请求
    const res = await fetch(`${TEST_BASE}/api/users`, {
      method: 'POST',
      headers: {
        cookie: `v2_session=${c.cookie('v2_session')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'x', username: 'xxxx', password: 'password123', role: 'TEACHER' }),
    })
    assert.equal(res.status, 403)
  })

  test('退出后会话立即失效', async () => {
    const c = client()
    await c.login('auth_admin', 'AuthAdminPass!1')
    assert.equal((await c.get('/api/auth/me')).status, 200)
    await c.post('/api/auth/logout')
    assert.equal((await c.get('/api/auth/me')).status, 401)
  })
})

describe('修改密码', () => {
  test('改密后全部会话被撤销，旧会话立刻 401', async () => {
    const c = client()
    await c.login('auth_admin', 'AuthAdminPass!1')
    const other = client()
    await other.login('auth_admin', 'AuthAdminPass!1')

    const res = await c.post('/api/auth/change-password', {
      currentPassword: 'AuthAdminPass!1',
      newPassword: 'AuthAdminPass!2',
    })
    assert.equal(res.status, 201)
    assert.ok(res.data.revokedSessions >= 2, '两个会话都要被撤销')

    assert.equal((await c.get('/api/auth/me')).status, 401)
    assert.equal((await other.get('/api/auth/me')).status, 401)

    // 新口令可用
    assert.equal((await client().login('auth_admin', 'AuthAdminPass!2')).status, 201)
    // 还原，避免影响后续断言
    const back = client()
    await back.login('auth_admin', 'AuthAdminPass!2')
    await back.post('/api/auth/change-password', {
      currentPassword: 'AuthAdminPass!2',
      newPassword: 'AuthAdminPass!1',
    })
  })

  test('当前口令不对 → 401，且不改', async () => {
    const c = client()
    await c.login('auth_admin', 'AuthAdminPass!1')
    const res = await c.post('/api/auth/change-password', {
      currentPassword: 'wrong-current',
      newPassword: 'SomethingNew!123',
    })
    assert.equal(res.status, 401)
    assert.equal(res.data.code, 'WRONG_PASSWORD')
    assert.equal((await client().login('auth_admin', 'AuthAdminPass!1')).status, 201)
  })
})
