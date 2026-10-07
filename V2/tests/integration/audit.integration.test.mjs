/**
 * 审计：谁、什么时候、做了什么、结果如何。
 * 以及一条硬规则：**detail 里不得出现任何凭据**。
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

before(async () => {
  await resetDatabase()
  await createAdmin('a_admin', 'AuditAdminPass!1')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  await startServer()
  admin = client()
  await admin.login('a_admin', 'AuditAdminPass!1')
  await createTeacher(
    'a_teacher',
    'AuditTeacherPass!1',
    [{ permission: 'resource.view', directoryId: ids.virtue }],
    '审计老师',
  )
  teacher = client()
  await teacher.login('a_teacher', 'AuditTeacherPass!1')
})
after(async () => {
  await stopServer()
})

async function actionsOf(actorName) {
  return withSql(async (sql) => {
    const rows = await sql`
      SELECT action, result FROM audit_logs WHERE actor_name = ${actorName} ORDER BY id
    `
    return rows.map((r) => `${r.action}:${r.result}`)
  })
}

describe('审计查询', () => {
  test('需要 audit.view 权限', async () => {
    const res = await teacher.get('/api/audit/logs')
    assert.equal(res.status, 403)
  })

  test('管理员可以查，且返回总数', async () => {
    const res = await admin.get('/api/audit/logs?limit=5')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.data.items))
    // total 是**整张表**的条数，不是当前页长度 —— 这正是分页能成立的前提。
    assert.ok(res.data.total >= 1, `total 应为正数，实际 ${res.data.total}`)
    assert.ok(res.data.items.length <= 5)
    assert.ok(res.data.total >= res.data.items.length)
  })

  test('动作清单带中文标签（界面不需要手工同步）', async () => {
    const res = await admin.get('/api/audit/actions')
    assert.equal(res.status, 200)
    const byAction = Object.fromEntries(res.data.items.map((i) => [i.action, i.label]))
    // 阶段 7 起动作名与业主 §20 的清单逐字一致。
    assert.equal(byAction['resource.approve'], '审核通过并发布')
    assert.equal(byAction['resource.submit_review'], '提交审核')
    assert.equal(byAction['resource.reject'], '审核退回')
    assert.equal(byAction['resource.recall'], '资源撤回')
    assert.equal(byAction['user.permissions.update'], '权限修改')
  })

  test('可以按动作筛选', async () => {
    const res = await admin.get('/api/audit/logs?action=auth.login&limit=50')
    assert.equal(res.status, 200)
    assert.ok(res.data.items.every((i) => i.action === 'auth.login'))
  })
})

describe('写审计', () => {
  test('登录成功写一条', async () => {
    const actions = await actionsOf('审计老师')
    assert.ok(actions.includes('auth.login:success'), actions.join(','))
  })

  test('登录失败也写，但结果标 failed（且不带口令）', async () => {
    await client().login('a_teacher', 'wrong-password-here')
    const rows = await withSql(
      (sql) => sql`
        SELECT result, detail FROM audit_logs
        WHERE action = 'auth.login' AND result <> 'success' ORDER BY id DESC LIMIT 1
      `,
    )
    assert.equal(rows.length, 1)
    const serialized = JSON.stringify(rows[0].detail)
    assert.ok(!serialized.includes('wrong-password-here'), '审计里不能出现口令')
  })

  test('被拒绝的请求写 denied，并记录权限名与原因', async () => {
    await teacher.post('/api/resources', {
      directoryId: ids.resources,
      title: '越权尝试',
    })
    const rows = await withSql(
      (sql) => sql`
        SELECT detail FROM audit_logs WHERE action = 'authz.denied' ORDER BY id DESC LIMIT 1
      `,
    )
    assert.equal(rows.length, 1, '必须留下一条 denied')
    assert.ok(String(rows[0].detail.permission).length > 0)
  })

  test('管理动作成对留痕：建账号 / 改权限', async () => {
    const created = await admin.post('/api/users', {
      name: '被审计的老师',
      username: 'audited',
      password: 'AuditedPass!1',
      role: 'TEACHER',
    })
    await admin.put(`/api/users/${created.data.id}/permissions`, {
      permissions: [{ permission: 'resource.view', directoryId: ids.virtue }],
    })
    const actions = await actionsOf('系统管理员')
    assert.ok(actions.includes('user.create:success'))
    assert.ok(actions.includes('user.permissions.update:success'))
  })

  test('目录与资源动作都有审计', async () => {
    const dir = await admin.post('/api/directories', {
      name: '审计用栏目',
      slug: 'audit-branch',
      type: 'ROOT',
    })
    await admin.patch(`/api/directories/${dir.data.id}`, { name: '审计用栏目（改名）' })
    await admin.del(`/api/directories/${dir.data.id}`)

    const res = await admin.post('/api/resources', {
      directoryId: ids.resources,
      title: '审计用资源',
    })
    await admin.patch(`/api/resources/${res.data.id}`, { title: '审计用资源（改名）' })

    const actions = await actionsOf('系统管理员')
    for (const expected of [
      'directory.create:success',
      'directory.update:success',
      'directory.delete:success',
      'resource.create:success',
      'resource.update:success',
    ]) {
      assert.ok(actions.includes(expected), `缺少 ${expected}：${actions.join(',')}`)
    }
  })
})

describe('凭据绝不进审计', () => {
  test('全表扫描：detail 里没有口令 / token / 密钥 / 签名 URL', async () => {
    // 制造一批会带敏感数据的动作
    await admin.post('/api/users', {
      name: '带口令创建',
      username: 'pw_probe',
      password: 'SuperSecret!9999',
      role: 'TEACHER',
    })
    await client().login('pw_probe', 'SuperSecret!9999')

    const rows = await withSql((sql) => sql`SELECT detail FROM audit_logs`)
    const all = JSON.stringify(rows)
    for (const secret of ['SuperSecret!9999', 'AUDIT_PASSWORD_PLACEHOLDER']) {
      assert.ok(!all.includes(secret), `审计里出现了 ${secret}`)
    }
    for (const bannedKey of ['"password"', '"token"', '"secret"', '"storageKey"', '"signedUrl"']) {
      // 允许出现被剔除后的占位（[已剔除]），但不允许出现带真实值的 key
      const pattern = new RegExp(`${bannedKey}\\s*:\\s*"(?!\\[已剔除\\])`, 'i')
      assert.ok(!pattern.test(all), `审计 detail 里出现了 ${bannedKey} 的真实值`)
    }
  })

  test('登记文件时审计**不**记录 storageKey', async () => {
    const rows = await withSql(
      (sql) => sql`
        SELECT detail FROM audit_logs WHERE target_type = 'file' ORDER BY id DESC LIMIT 5
      `,
    )
    for (const row of rows) {
      assert.ok(!('storageKey' in row.detail), '文件审计里不该有 storageKey')
    }
  })
})
