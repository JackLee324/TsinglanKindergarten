/**
 * 资源：状态机 / 搜索 / 分页 / 回收站。
 *
 * 最关键的一组是「不允许假成功」——
 * 每条状态变更都从**服务端再读一次**确认它真的变了，而不是看响应里那句"成功"。
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
  await createAdmin('r_admin', 'ResAdminPass!1')
  ids = {
    virtueResources: await directoryIdByPath('education/pre-k/virtue/resources'),
    virtueLesson: await directoryIdByPath('education/pre-k/virtue/lesson'),
    virtue: await directoryIdByPath('education/pre-k/virtue'),
    kResources: await directoryIdByPath('education/k/pe/resources'),
  }

  await startServer()
  admin = client()
  await admin.login('r_admin', 'ResAdminPass!1')

  await createTeacher(
    'res_teacher',
    'ResTeacherPass!1',
    [
      { permission: 'resource.view', directoryId: ids.virtue },
      { permission: 'resource.create', directoryId: ids.virtue },
      { permission: 'resource.update.own', directoryId: ids.virtue },
      { permission: 'resource.delete.own', directoryId: ids.virtue },
      { permission: 'resource.submit', directoryId: ids.virtue },
      { permission: 'resource.download', directoryId: ids.virtue },
    ],
    '王老师',
  )
  teacher = client()
  await teacher.login('res_teacher', 'ResTeacherPass!1')
})
after(async () => {
  await stopServer()
})

/** 建一条资源并（可选）挂一个文件，返回 id。 */
async function makeResource(title, withFile = false) {
  const created = await teacher.post('/api/resources', {
    directoryId: ids.virtueResources,
    title,
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  if (withFile) await attachFile(created.data.id, `${title}.txt`, 'text/plain', Buffer.from(`内容：${title}`))
  return created.data.id
}

/** 完整走一遍 申请地址 → PUT → 登记，返回登记结果。 */
async function attachFile(resourceId, fileName, mimeType, content) {
  const url = await teacher.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName,
    mimeType,
    size: content.byteLength,
  })
  assert.equal(url.status, 201, JSON.stringify(url.data))

  const put = await fetch(`http://127.0.0.1:3311${url.data.uploadUrl}`, {
    method: 'PUT',
    headers: { 'content-type': mimeType },
    body: content,
  })
  assert.equal(put.status, 200, `PUT 失败：${put.status}`)

  const sha256 = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
  const reg = await teacher.post(`/api/resources/${resourceId}/files/register`, {
    storageKey: url.data.storageKey,
    fileName,
    mimeType,
    size: content.byteLength,
    sha256,
  })
  return reg
}

describe('创建资源', () => {
  test('必须指定目录（界面上它来自"当前所在目录"）', async () => {
    const res = await teacher.post('/api/resources', { title: '没有目录的资源' })
    assert.equal(res.status, 400)
  })

  test('不能建在只做导航的目录上（科目层 allowFiles=false）', async () => {
    const res = await teacher.post('/api/resources', {
      directoryId: ids.virtue,
      title: '挂在科目上',
    })
    assert.equal(res.status, 409)
    assert.match(res.data.message, /只做导航|不是可以放资源/)
  })

  test('V2 的资源里**没有** legacy folderType / 班型 / 科目字段', async () => {
    const id = await makeResource('字段检查')
    const res = await teacher.get(`/api/resources/${id}`)
    const keys = Object.keys(res.data)
    for (const banned of ['folderType', 'program', 'subject', 'subSubject']) {
      assert.ok(!keys.includes(banned), `V2 不应有 ${banned} 字段`)
    }
    assert.equal(res.data.directoryPath, 'education/pre-k/virtue/resources')
  })
})

describe('状态机（不允许假成功）', () => {
  test('没有文件不能提交审核', async () => {
    const id = await makeResource('空资源')
    const res = await teacher.post(`/api/resources/${id}/submit`)
    assert.equal(res.status, 409)
    assert.match(res.data.message, /文件/)
  })

  test('有文件 → 提交 → 状态真的变成 PENDING_REVIEW，且刷新后仍是', async () => {
    const id = await makeResource('待审资源', true)
    const res = await teacher.post(`/api/resources/${id}/submit`)
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.status, 'PENDING_REVIEW')

    const reread = await teacher.get(`/api/resources/${id}`)
    assert.equal(reread.data.status, 'PENDING_REVIEW', '必须从服务端再读一次确认')
  })

  test('跳过审核直接发布 → 409（表里没有这条转换）', async () => {
    const id = await makeResource('跳过审核', true)
    // 用审核接口在草稿上"通过"
    const res = await admin.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 409)
    assert.equal(res.data.code, 'ILLEGAL_TRANSITION')
  })

  test('两个审核员同时通过 → 一个成功、一个 409（条件更新）', async () => {
    const id = await makeResource('并发审核', true)
    await teacher.post(`/api/resources/${id}/submit`)

    const [a, b] = await Promise.all([
      admin.post(`/api/resources/${id}/review`, { action: 'approve' }),
      admin.post(`/api/resources/${id}/review`, { action: 'approve' }),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [201, 409], `实际 ${statuses.join(',')}`)

    const reread = await admin.get(`/api/resources/${id}`)
    assert.equal(reread.data.status, 'PUBLISHED')
  })

  test('已发布资源被编辑 → version+1 并回到草稿（不原地覆盖）', async () => {
    const id = await makeResource('已发布再编辑', true)
    await teacher.post(`/api/resources/${id}/submit`)
    await admin.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal((await admin.get(`/api/resources/${id}`)).data.status, 'PUBLISHED')

    const edit = await admin.patch(`/api/resources/${id}`, { title: '改过标题' })
    assert.equal(edit.status, 200)
    assert.equal(edit.data.status, 'DRAFT')
    assert.equal(edit.data.version, 2)
  })

  test('已发布资源不能直接删除，必须先撤回', async () => {
    const id = await makeResource('发布后删除', true)
    await teacher.post(`/api/resources/${id}/submit`)
    await admin.post(`/api/resources/${id}/review`, { action: 'approve' })

    const del = await teacher.del(`/api/resources/${id}`)
    assert.equal(del.status, 409)
    assert.match(del.data.message, /先撤回/)
  })
})

describe('退回与撤回（两种操作不能混用）', () => {
  test('退回不写原因 → 400/403', async () => {
    const id = await makeResource('退回无原因', true)
    await teacher.post(`/api/resources/${id}/submit`)
    const res = await admin.post(`/api/resources/${id}/review`, { action: 'reject' })
    assert.ok([400, 403].includes(res.status), `实际 ${res.status}`)
  })

  test('退回带原因 → REJECTED，且教师能看到原因', async () => {
    const id = await makeResource('会被退回', true)
    await teacher.post(`/api/resources/${id}/submit`)
    const res = await admin.post(`/api/resources/${id}/review`, {
      action: 'reject',
      comment: '请补充教学目标',
    })
    assert.equal(res.status, 201, JSON.stringify(res.data))

    const asTeacher = await teacher.get(`/api/resources/${id}`)
    assert.equal(asTeacher.data.status, 'REJECTED')
    assert.equal(asTeacher.data.reviewComment, '请补充教学目标')
  })

  test('被退回后可以重新提交（REJECTED → PENDING_REVIEW）', async () => {
    const id = await makeResource('重新提交', true)
    await teacher.post(`/api/resources/${id}/submit`)
    await admin.post(`/api/resources/${id}/review`, { action: 'reject', comment: '再来一次' })
    const res = await teacher.post(`/api/resources/${id}/submit`)
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.status, 'PENDING_REVIEW')
  })

  test('撤回是独立动作，**不产生**假的退回原因', async () => {
    const id = await makeResource('撤回验证', true)
    await teacher.post(`/api/resources/${id}/submit`)
    await admin.post(`/api/resources/${id}/review`, { action: 'approve' })

    const recall = await teacher.post(`/api/resources/${id}/recall`)
    assert.equal(recall.status, 201, JSON.stringify(recall.data))
    assert.equal(recall.data.status, 'RECALLED')

    const reread = await teacher.get(`/api/resources/${id}`)
    assert.equal(reread.data.status, 'RECALLED')
    assert.equal(reread.data.reviewComment, null, '撤回绝不能留下退回原因')

    const history = await teacher.get(`/api/resources/${id}/review-history`)
    const actions = history.data.items.map((i) => i.action)
    assert.ok(actions.includes('review.recall'))
    assert.ok(!actions.includes('review.reject'), '不能有 reject 记录')
  })
})

describe('搜索与分页', () => {
  test('按标题搜索', async () => {
    await makeResource('春天主题教案')
    const res = await teacher.get('/api/resources?q=春天主题')
    assert.equal(res.status, 200)
    assert.ok(res.data.items.length >= 1)
    assert.ok(res.data.items.every((i) => i.title.includes('春天主题')))
  })

  test('按目录名搜索（美术 → 命中目录路径）', async () => {
    const res = await teacher.get('/api/resources?q=virtue')
    assert.equal(res.status, 200)
    assert.ok(res.data.total >= 1, '目录路径可被搜索到')
  })

  test('分页：total 是真实总数，不是当前页长度', async () => {
    for (let i = 0; i < 5; i += 1) await makeResource(`分页资源 ${i}`)

    const page1 = await teacher.get('/api/resources?page=1&pageSize=2')
    assert.equal(page1.data.items.length, 2)
    assert.ok(page1.data.total >= 7, `总数应 >= 7，实际 ${page1.data.total}`)

    const page2 = await teacher.get('/api/resources?page=2&pageSize=2')
    assert.notEqual(page1.data.items[0].id, page2.data.items[0].id, '第二页必须是不同的行')
  })

  test('pageSize 有上限（防止一次拉全库）', async () => {
    const res = await teacher.get('/api/resources?pageSize=100000')
    assert.equal(res.status, 400)
  })
})

describe('回收站', () => {
  test('删除 → 进回收站 → 恢复 → 回到原目录', async () => {
    const id = await makeResource('会被删除')
    const del = await teacher.del(`/api/resources/${id}`)
    assert.equal(del.status, 200, JSON.stringify(del.data))

    // 常规查询看不到
    assert.equal((await teacher.get(`/api/resources/${id}`)).status, 404)

    const bin = await teacher.get('/api/resources/recycle-bin')
    assert.ok(bin.data.items.some((i) => i.id === id), '回收站里要有它')

    const restore = await teacher.post(`/api/resources/${id}/restore`)
    assert.equal(restore.status, 201, JSON.stringify(restore.data))

    const after = await teacher.get(`/api/resources/${id}`)
    assert.equal(after.status, 200)
    assert.equal(after.data.directoryId, ids.virtueResources, '要回到原目录')
  })

  test('教师看不到别人的回收站条目，管理员看得到', async () => {
    // 先真的删一条，否则回收站是空的 —— 上一条测试把它恢复回去了。
    const victim = await makeResource('回收站可见性探针')
    await teacher.del(`/api/resources/${victim}`)

    await createTeacher(
      'bin_other',
      'BinOtherPass!1',
      [{ permission: 'resource.delete.own', directoryId: ids.virtue }],
    )
    const other = client()
    await other.login('bin_other', 'BinOtherPass!1')

    const mine = await teacher.get('/api/resources/recycle-bin')
    const others = await other.get('/api/resources/recycle-bin')
    assert.notEqual(mine.status, 403, '有 delete.own 权限就能看自己的回收站')
    if (others.status === 200) {
      assert.equal(others.data.items.length, 0, '别人看不到我的删除项')
    }
    const asAdmin = await admin.get('/api/resources/recycle-bin')
    assert.ok(asAdmin.data.total >= 1, '管理员能看到全部')
  })

  test('永久删除 → 数据库行消失 + 对象文件消失', async () => {
    const id = await makeResource('会被永久删除', true)
    const keys = await withSql(async (sql) => {
      const rows = await sql`SELECT storage_key FROM resource_files WHERE resource_id = ${id}`
      return rows.map((r) => r.storage_key)
    })
    assert.equal(keys.length, 1)

    await teacher.del(`/api/resources/${id}`)
    const purge = await admin.post(`/api/resources/${id}/purge`)
    assert.equal(purge.status, 201, JSON.stringify(purge.data))
    assert.equal(purge.data.removedObjects, 1, '对象存储里的文件必须真的被删掉')

    const gone = await admin.get(`/api/resources/${id}`)
    assert.equal(gone.status, 404)
    const fileRows = await withSql(
      (sql) => sql`SELECT count(*)::int AS n FROM resource_files WHERE resource_id = ${id}`,
    )
    assert.equal(fileRows[0].n, 0)
  })
})
