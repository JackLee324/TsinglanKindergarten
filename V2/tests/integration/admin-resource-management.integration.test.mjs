/**
 * tests/integration/admin-resource-management.integration.test.mjs
 *   —— 超级管理员的资源管理：批量**软**删除 + 永久删除的权限与存储一致性
 * ============================================================================
 * 这份测试有两个来源：
 *
 * ① **2026-10-12 的代码审计发现的两个真实缺陷**（§5.1 / §5.2）：
 *    · `POST /api/resources/:id/purge` 只声明了 `resource.delete.own`，
 *      **没有** `@RequireSuperAdmin()` —— 任何持有该权限的老师都能永久删除；
 *    · `purge()` 里 `head()` / `delete()` 都没 `await`，且 `catch {}` 吞掉
 *      所有异常 —— 对象没删掉但数据库记录已经删了，留下永远无法回收的孤儿。
 *
 * ② 新增的批量软删除接口（§4）。
 *
 * ── 两条贯穿全篇的原则 ──────────────────────────────────────────────────
 * · **权限只看服务端**：所有"普通教师被拒"的用例都是直接构造 API 请求，
 *   不依赖界面上有没有按钮。界面上没有按钮从来不是安全证据。
 * · **失败必须无副作用**：被拒的请求不能删掉数据库记录，也不能删掉对象。
 *   所以每个拒绝用例后面都跟着一次"东西还在吗"的回查。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
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
import { makeResource } from '../helpers/resource-fixture.mjs'
import { S3_TEST_ACCESS_KEY, S3_TEST_SECRET_KEY, s3TestClient, startS3Backend } from '../helpers/s3-backend.mjs'

const BUCKET = `v2admin-${randomUUID().slice(0, 8)}`
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

let backend
let admin
let teacher
let ids = {}
/** 本文件造出来的资源，after 里统一清掉，不给后面的套件留残留。 */
const created = []

async function newDraft(title = '管理员批量探针', uploaderId) {
  if (uploaderId !== undefined) {
    // 直接造一条属于**别人**的资源（管理员要能管到它）。
    const id = await makeResource({ directoryId: ids.resources, uploaderId, title, status: 'DRAFT' })
    created.push(id)
    return id
  }
  const res = await admin.post('/api/resources', { directoryId: ids.resources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  created.push(res.data.id)
  return res.data.id
}

/** 走完整的三步上传（申请地址 → 浏览器直传 → 登记），返回 storageKey。 */
async function attachFile(resourceId, api = admin) {
  const ask = await api.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName: '批量探针.pdf',
    mimeType: 'application/pdf',
    size: PDF_BYTES.length,
    sha256: sha256(PDF_BYTES),
  })
  assert.equal(ask.status, 201, JSON.stringify(ask.data))
  const put = await fetch(ask.data.uploadUrl, {
    method: 'PUT',
    headers: ask.data.headers,
    body: PDF_BYTES,
  })
  assert.equal(put.status, 200, `PUT 应当成功：${await put.text()}`)
  const reg = await api.post(`/api/resources/${resourceId}/files/register`, {
    uploadId: ask.data.uploadId,
  })
  assert.equal(reg.status, 201, JSON.stringify(reg.data))
  return ask.data.storageKey
}

async function objectExists(storageKey) {
  try {
    await s3TestClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: storageKey }))
    return true
  } catch {
    return false
  }
}

async function resourceExists(id) {
  return withSql(async (sql) => {
    const rows = await sql`SELECT id FROM resources WHERE id = ${id}`
    return rows.length > 0
  })
}

async function auditActionsFor(targetId) {
  return withSql(async (sql) => {
    const rows = await sql`
      SELECT action, result, detail FROM audit_logs
      WHERE target_id = ${targetId} ORDER BY created_at
    `
    return rows
  })
}

before(async () => {
  await resetDatabase()
  await createAdmin('adm', 'AdminPass!2026')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  // 先起真后端，再让被测服务连它 —— 否则启动即连不上。
  backend = await startS3Backend({ bucket: BUCKET })
  await startServer({
    env: {
      STORAGE_PROVIDER: 's3',
      STORAGE_ENDPOINT: backend.endpoint,
      STORAGE_REGION: 'us-east-1',
      STORAGE_BUCKET: BUCKET,
      STORAGE_ACCESS_KEY: S3_TEST_ACCESS_KEY,
      STORAGE_SECRET_KEY: S3_TEST_SECRET_KEY,
      STORAGE_FORCE_PATH_STYLE: '1',
    },
  })

  admin = client()
  await admin.login('adm', 'AdminPass!2026')

  /*
    关键：这个老师**持有 `resource.delete.own`**。
    修复前他能直接 purge 自己的资源；修复后必须被 403 拦住。
    如果用一个没有该权限的老师去测，"被拒"可能只是因为他连删除权限都没有 ——
    那样测出来的是别的东西，证明不了这次修复。
  */
  const t = await createTeacher(
    'bulk_teacher',
    'TeacherPass!2026',
    [
      { permission: 'resource.view', directoryId: virtue },
      { permission: 'resource.create', directoryId: virtue },
      { permission: 'resource.update.own', directoryId: virtue },
      { permission: 'resource.delete.own', directoryId: virtue },
      { permission: 'resource.download', directoryId: virtue },
    ],
    '持有删除权限的老师',
  )
  teacher = client()
  await teacher.login('bulk_teacher', 'TeacherPass!2026')
  ids.teacherId = t.id
})

after(async () => {
  // 先清数据再停服务：清不掉的话至少服务还在，报错更有用。
  try {
    await withSql(async (sql) => {
      for (const id of created) {
        await sql`DELETE FROM resource_files WHERE resource_id = ${id}`
        await sql`DELETE FROM resources WHERE id = ${id}`
      }
    })
  } catch {
    /* 清理是尽力而为 */
  }
  await stopServer()
  await backend?.stop()
})

// ══════════════════════════════════════════════════════════════════════════
// §5.1 永久删除的权限
// ══════════════════════════════════════════════════════════════════════════
describe('§5.1 永久删除只有超级管理员可以做', () => {
  test('持有 resource.delete.own 的普通教师 purge **自己的**资源 → 403，且什么都没删', async () => {
    // 造一条属于该老师的资源，并附上一个真实对象。
    const id = await newDraft('老师的资源', ids.teacherId)
    const key = await attachFile(id, teacher)
    await teacher.del(`/api/resources/${id}`) // 先软删除（这一步他有权限）

    const res = await teacher.post(`/api/resources/${id}/purge`)
    assert.equal(res.status, 403, `应当 403，实际 ${res.status}：${JSON.stringify(res.data)}`)
    assert.match(JSON.stringify(res.data), /SUPERADMIN_REQUIRED|超级管理员/)

    // 失败必须**无副作用**：记录还在、对象还在。
    assert.equal(await resourceExists(id), true, '被拒的 purge 不能删掉数据库记录')
    assert.equal(await objectExists(key), true, '被拒的 purge 不能删掉存储对象')
  })

  test('未登录 purge → 401', async () => {
    const id = await newDraft('未登录探针')
    await admin.del(`/api/resources/${id}`)
    const anon = client()
    const res = await anon.post(`/api/resources/${id}/purge`)
    assert.equal(res.status, 401, `应当 401，实际 ${res.status}`)
    assert.equal(await resourceExists(id), true)
  })

  test('超级管理员可以 purge 回收站里的资源 → 数据库行与对象都真的没了', async () => {
    const id = await newDraft('待永久删除')
    const key = await attachFile(id)
    await admin.del(`/api/resources/${id}`)
    assert.equal(await admin.get(`/api/resources/${id}`).then((r) => r.status), 404, '软删除后详情应当 404')

    const res = await admin.post(`/api/resources/${id}/purge`)
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(await resourceExists(id), false, '数据库行应当被删除')
    assert.equal(await objectExists(key), false, '对象存储里的文件也应当被删除')
  })

  test('**没有软删除**的资源不能被直接永久删除 → 409（生命周期表第 11 行只允许"软删除 → 永久删除"）', async () => {
    const id = await newDraft('未进回收站')
    const key = await attachFile(id)

    const res = await admin.post(`/api/resources/${id}/purge`)
    assert.equal(res.status, 409, `应当 409，实际 ${res.status}：${JSON.stringify(res.data)}`)
    assert.match(JSON.stringify(res.data), /回收站|RESOURCE_NOT_IN_RECYCLE_BIN/)
    assert.equal(await resourceExists(id), true)
    assert.equal(await objectExists(key), true, '被拒的 purge 不能顺手把对象删了')
  })

  test('成功的永久删除留下 resource.purge 审计，且**没有**失败记录', async () => {
    const id = await newDraft('审计探针')
    await attachFile(id)
    await admin.del(`/api/resources/${id}`)
    await admin.post(`/api/resources/${id}/purge`)

    const rows = await auditActionsFor(id)
    const purge = rows.filter((r) => r.action === 'resource.purge')
    assert.equal(purge.length, 1, '应当正好写一条 purge 审计')
    assert.equal(purge[0].result, 'success')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// §4 批量软删除
// ══════════════════════════════════════════════════════════════════════════
describe('§4 批量软删除（可恢复，不是永久删除）', () => {
  test('管理员批量删除多条合法资源 → 逐条成功', async () => {
    const a = await newDraft('批量A')
    const b = await newDraft('批量B')
    const c = await newDraft('批量C')

    const res = await admin.post('/api/resources/bulk-delete', { ids: [a, b, c] })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.deleted, 3)
    assert.equal(res.data.skipped, 0)
    assert.equal(res.data.failed, 0)
    assert.equal(res.data.items.length, 3)
    assert.deepEqual([...res.data.items].every((i) => i.outcome === 'deleted'), true)
  })

  test('软删除后资源出现在回收站，恢复后回到原列表', async () => {
    const id = await newDraft('回收站往返')
    const before = await admin.get('/api/resources?page=1&pageSize=100')
    assert.equal(before.data.items.some((i) => i.id === id), true, '删除前应在列表里')

    await admin.post('/api/resources/bulk-delete', { ids: [id] })
    const bin = await admin.get('/api/resources/recycle-bin')
    assert.equal(bin.data.items.some((i) => i.id === id), true, '软删除后应在回收站')

    const back = await admin.post(`/api/resources/${id}/restore`)
    assert.equal(back.status, 201, JSON.stringify(back.data))
    const after = await admin.get('/api/resources?page=1&pageSize=100')
    assert.equal(after.data.items.some((i) => i.id === id), true, '恢复后应回到列表')
  })

  test('软删除**不碰对象存储**：文件与对象都还在', async () => {
    const id = await newDraft('软删除保留文件')
    const key = await attachFile(id)

    await admin.post('/api/resources/bulk-delete', { ids: [id] })
    assert.equal(await objectExists(key), true, '软删除不能删对象 —— 那是永久删除才做的事')

    // 文件记录也要还在（恢复之后还得能下载）。
    const files = await withSql(async (sql) => {
      const rows = await sql`SELECT id FROM resource_files WHERE resource_id = ${id}`
      return rows.length
    })
    assert.equal(files, 1, '软删除不能清 resource_files')
  })

  test('管理员可以删除**别人**上传的资源', async () => {
    const id = await newDraft('别人的草稿', ids.teacherId)
    const res = await admin.post('/api/resources/bulk-delete', { ids: [id] })
    assert.equal(res.data.deleted, 1)
  })

  test('混合状态：成功的成功、该跳过的跳过，并给出原因', async () => {
    const draft = await newDraft('混合-草稿')
    const published = await newDraft('混合-已发布')
    await withSql(async (sql) => {
      await sql`UPDATE resources SET status = 'PUBLISHED', published_at = now() WHERE id = ${published}`
    })
    const missing = randomUUID()

    const res = await admin.post('/api/resources/bulk-delete', { ids: [draft, published, missing] })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.deleted, 1)
    assert.equal(res.data.skipped, 2)
    assert.equal(res.data.failed, 0)

    const byId = Object.fromEntries(res.data.items.map((i) => [i.id, i]))
    assert.equal(byId[draft].outcome, 'deleted')
    assert.equal(byId[published].outcome, 'skipped')
    assert.equal(byId[published].reason, 'ILLEGAL_TRANSITION')
    assert.match(byId[published].message, /撤回/, '应当告诉用户"已发布要先撤回"')
    assert.equal(byId[missing].outcome, 'skipped')
    assert.equal(byId[missing].reason, 'NOT_FOUND')
  })

  test('已在回收站里的资源 → 跳过而不是报错，也不会重复计数', async () => {
    const id = await newDraft('重复删除')
    await admin.post('/api/resources/bulk-delete', { ids: [id] })
    const again = await admin.post('/api/resources/bulk-delete', { ids: [id] })
    assert.equal(again.data.deleted, 0)
    assert.equal(again.data.skipped, 1)
    assert.equal(again.data.items[0].reason, 'ALREADY_DELETED')
  })

  test('重复 ID 被去重，并在结果里如实说明', async () => {
    const id = await newDraft('重复ID')
    const res = await admin.post('/api/resources/bulk-delete', { ids: [id, id, id] })
    assert.equal(res.status, 201)
    assert.equal(res.data.requested, 3)
    assert.equal(res.data.unique, 1)
    assert.equal(res.data.duplicated, 2)
    assert.equal(res.data.deleted, 1, '同一资源只能成功一次')
  })

  test('输入校验：空数组 / 非 UUID / 超上限都被拒（fail closed）', async () => {
    const empty = await admin.post('/api/resources/bulk-delete', { ids: [] })
    assert.equal(empty.status, 400, `空数组应当 400，实际 ${empty.status}`)

    const bad = await admin.post('/api/resources/bulk-delete', { ids: ['not-a-uuid'] })
    assert.equal(bad.status, 400, `非 UUID 应当 400，实际 ${bad.status}`)

    const tooMany = await admin.post('/api/resources/bulk-delete', {
      ids: Array.from({ length: 101 }, () => randomUUID()),
    })
    assert.equal(tooMany.status, 400, `超过 100 条应当 400（不截断），实际 ${tooMany.status}`)

    const notArray = await admin.post('/api/resources/bulk-delete', { ids: 'abc' })
    assert.equal(notArray.status, 400)
  })

  test('普通教师调批量删除 → 403（即使他有 resource.delete.own）', async () => {
    const id = await newDraft('老师想批量删', ids.teacherId)
    const res = await teacher.post('/api/resources/bulk-delete', { ids: [id] })
    assert.equal(res.status, 403, `应当 403，实际 ${res.status}：${JSON.stringify(res.data)}`)
    assert.equal(await resourceExists(id), true, '被拒的批量删除不能真的删掉东西')
  })

  test('未登录调批量删除 → 401', async () => {
    const anon = client()
    const res = await anon.post('/api/resources/bulk-delete', { ids: [randomUUID()] })
    assert.equal(res.status, 401, `应当 401，实际 ${res.status}`)
  })

  test('每条成功删除都写下审计（resource.delete，带 via=bulk）', async () => {
    const a = await newDraft('审计批量A')
    const b = await newDraft('审计批量B')
    await admin.post('/api/resources/bulk-delete', { ids: [a, b] })

    for (const id of [a, b]) {
      const rows = await auditActionsFor(id)
      const del = rows.filter((r) => r.action === 'resource.delete')
      assert.equal(del.length, 1, `资源 ${id} 应当有一条删除审计`)
      assert.equal(del[0].result, 'success')
      assert.equal(del[0].detail?.via, 'bulk', '应当标明来自批量操作')
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
// §5.2 存储一致性 —— 放在最后：它会停掉测试用的 S3 后端来模拟"存储不可用"
// ══════════════════════════════════════════════════════════════════════════
describe('§5.2 永久删除的存储一致性', () => {
  test('对象已经不存在时 → 幂等成功（这是唯一允许"继续"的异常情形）', async () => {
    const id = await newDraft('对象已被手工清掉')
    const key = await attachFile(id)
    await admin.del(`/api/resources/${id}`)

    // 直接把对象删掉，模拟"上一次删到一半 / 人工清理过"。
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await s3TestClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
    assert.equal(await objectExists(key), false)

    const res = await admin.post(`/api/resources/${id}/purge`)
    assert.equal(res.status, 201, `对象本就不在应当幂等成功：${JSON.stringify(res.data)}`)
    assert.equal(await resourceExists(id), false)
  })

  test('存储不可用时 purge 必须失败，且**数据库记录不能被删掉**', async () => {
    const id = await newDraft('存储故障探针')
    const key = await attachFile(id)
    await admin.del(`/api/resources/${id}`)
    assert.equal(await objectExists(key), true)

    // 停掉对象存储：之后 head()/delete() 会抛 StorageUnavailableError，
    // 而不是返回 null。"抛异常"与"对象不存在"必须被区分对待。
    await backend.stop()
    backend = null

    const res = await admin.post(`/api/resources/${id}/purge`)
    assert.notEqual(res.status, 201, `存储不可用时不能报成功，实际 ${res.status}`)
    assert.equal(res.status, 503, `应当是 503 STORAGE_UNAVAILABLE，实际 ${res.status}：${JSON.stringify(res.data)}`)

    // 最关键的一条：数据库记录必须还在（否则对象就成了无人认领的孤儿）。
    assert.equal(await resourceExists(id), true, '存储失败时绝不能把数据库记录删掉')

    const rows = await auditActionsFor(id)
    assert.equal(
      rows.some((r) => r.action === 'resource.purge' && r.result === 'success'),
      false,
      '失败的永久删除不能留下"成功"审计',
    )
  })
})
