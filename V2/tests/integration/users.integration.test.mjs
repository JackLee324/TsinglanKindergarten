/** 账号创建与权限分配：管理员只填姓名/用户名/密码/勾选权限与目录。 */
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
import { permissions } from '../helpers/modules.mjs'
const { permissionChecklist } = permissions

let adminClient
let prekVirtue
let kChinese

before(async () => {
  await resetDatabase()
  await createAdmin('u_admin', 'UsersAdminPass!1')
  prekVirtue = await directoryIdByPath('education/pre-k/virtue')
  kChinese = await directoryIdByPath('education/k/chinese')
  await startServer()
  adminClient = client()
  await adminClient.login('u_admin', 'UsersAdminPass!1')
})
after(async () => {
  await stopServer()
})

describe('创建教师账号', () => {
  test('一次请求建出账号 + 权限 + 开放范围', async () => {
    const res = await adminClient.post('/api/users', {
      name: '张老师',
      username: 'zhang',
      password: 'ZhangPass!123',
      role: 'TEACHER',
      permissions: [
        { permission: 'resource.view', directoryId: prekVirtue },
        { permission: 'resource.create', directoryId: prekVirtue },
      ],
    })
    assert.equal(res.status, 201)
    assert.ok(res.data.id)

    const perms = await adminClient.get(`/api/users/${res.data.id}/permissions`)
    assert.equal(perms.status, 200)
    assert.equal(perms.data.items.length, 2)
    for (const item of perms.data.items) {
      assert.ok(permissionChecklist().includes(item.permission))
      assert.match(item.label, /[\u4e00-\u9fa5]/, '返回给界面的是中文标签，不是权限码')
    }
  })

  test('用户名冲突 → 409', async () => {
    const res = await adminClient.post('/api/users', {
      name: '另一个',
      username: 'zhang',
      password: 'ZhangPass!123',
      role: 'TEACHER',
    })
    assert.equal(res.status, 409)
  })

  test('未知权限码 → 400/403（拒绝幽灵权限）', async () => {
    const res = await adminClient.post('/api/users', {
      name: '幽灵',
      username: 'ghost',
      password: 'GhostPass!123',
      role: 'TEACHER',
      permissions: [{ permission: 'resource.fly', directoryId: prekVirtue }],
    })
    assert.ok([400, 403].includes(res.status), `实际 ${res.status}`)
  })

  test('全平台权限不能带目录范围（否则会出现一条永远不生效的授权）', async () => {
    const res = await adminClient.post('/api/users', {
      name: '范围错',
      username: 'scope_bad',
      password: 'ScopeBad!123',
      role: 'TEACHER',
      // 用 audit.view 而不是 user.manage：后者现在根本不可授予（见 Stage 13 §4），
      // 用它测"全平台权限不能带目录范围"就测不到原本要测的那条校验了。
      permissions: [{ permission: 'audit.view', directoryId: prekVirtue }],
    })
    assert.ok([400, 403].includes(res.status), `实际 ${res.status}`)
  })

  test('不存在的目录 → 400/403', async () => {
    const res = await adminClient.post('/api/users', {
      name: '目录错',
      username: 'dir_bad',
      password: 'DirBad!123',
      role: 'TEACHER',
      permissions: [{ permission: 'resource.view', directoryId: '00000000-0000-4000-8000-000000000000' }],
    })
    assert.ok([400, 403].includes(res.status), `实际 ${res.status}`)
  })

  test('普通教师不能建账号 → 403（门槛是超级管理员身份，不是 user.manage）', async () => {
    await createTeacher('plain_teacher', 'PlainPass!123', [
      { permission: 'resource.view', directoryId: prekVirtue },
    ])
    const c = client()
    await c.login('plain_teacher', 'PlainPass!123')
    const res = await c.post('/api/users', {
      name: '偷建的',
      username: 'smuggled',
      password: 'Smuggled!123',
      role: 'ADMIN',
    })
    assert.equal(res.status, 403)
  })
})

describe('整份替换权限', () => {
  test('取消勾选即真的失效（不是增量猜测）', async () => {
    const created = await adminClient.post('/api/users', {
      name: '李老师',
      username: 'li_teacher',
      password: 'LiPass!12345',
      role: 'TEACHER',
      permissions: [
        { permission: 'resource.view', directoryId: prekVirtue },
        { permission: 'resource.create', directoryId: prekVirtue },
      ],
    })
    // 先断言创建成功：否则 id 会是 undefined，后续 URL 变成 /api/users/undefined/...
    // 于是一个"创建失败"会伪装成"设权限失败"，排查方向完全错。这个坑我刚踩过。
    assert.equal(created.status, 201, `创建账号失败：${JSON.stringify(created.data)}`)
    const id = created.data.id
    assert.ok(id, '创建成功却没有返回 id')

    const res = await adminClient.put(`/api/users/${id}/permissions`, {
      permissions: [{ permission: 'resource.view', directoryId: prekVirtue }],
    })
    assert.equal(res.status, 200, `PUT 权限失败：${JSON.stringify(res.data)}`)
    assert.equal(res.data.grants, 1)

    const after = await adminClient.get(`/api/users/${id}/permissions`)
    assert.deepEqual(
      after.data.items.map((i) => i.permission),
      ['resource.view'],
    )
  })

  test('改权限会撤销该账号全部会话（即时生效）', async () => {
    const created = await adminClient.post('/api/users', {
      name: '王老师',
      username: 'wang',
      password: 'WangPass!1234',
      role: 'TEACHER',
      permissions: [{ permission: 'resource.view', directoryId: prekVirtue }],
    })
    const id = created.data.id

    const teacher = client()
    await teacher.login('wang', 'WangPass!1234')
    assert.equal((await teacher.get('/api/auth/me')).status, 200)

    const res = await adminClient.put(`/api/users/${id}/permissions`, {
      permissions: [{ permission: 'resource.view', directoryId: kChinese }],
    })
    assert.equal(res.status, 200, `PUT 权限失败：${JSON.stringify(res.data)}`)
    assert.ok(res.data.revokedSessions >= 1, '必须撤销了会话')

    assert.equal((await teacher.get('/api/auth/me')).status, 401, '旧会话必须立刻失效')
  })
})
