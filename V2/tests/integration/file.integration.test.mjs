/**
 * tests/integration/file.integration.test.mjs —— 文件接口的**访问控制**
 * ============================================================================
 * 这一份只问一件事：**谁能够到文件**。
 *
 * 文件不是独立资源，它的可见性完全由所属资源的目录授权决定
 * （AuthorizationService 的唯一判定入口）。所以这里的每一条用例，
 * 本质都是在验证"文件没有长出第二套权限口径"：
 *
 *   · 看不到资源的老师，拿不到文件列表、下载地址、预览地址；
 *   · 换个资源的 id 去拼文件 id，够不到别人的文件（横向越权）；
 *   · 上传/删除文件必须是自己上传的资源（所有权）；
 *   · 响应里不出现 bucket / storage key / 令牌（§11：界面只看到「下载」）。
 *
 * 完整的上传链路（申请地址 → PUT → 登记）在 `upload.integration.test.mjs`，
 * 预览与下载的语义在 `download-preview.integration.test.mjs`。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  TEST_BASE,
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
let outsider
let ids = {}
const resources = []

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n'.repeat(10)),
  Buffer.from('%%EOF\n'),
])
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png payload\n'.repeat(10)),
])
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function newResource(as = teacher, title = '文件权限探针') {
  const res = await as.post('/api/resources', { directoryId: ids.resources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

/** 完整上传一个文件，返回登记结果。 */
async function upload(
  resourceId,
  { bytes = PDF_BYTES, fileName = '教案.pdf', mimeType = 'application/pdf', as = teacher } = {},
) {
  const ask = await as.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName,
    mimeType,
    size: bytes.length,
    sha256: sha256(bytes),
  })
  assert.equal(ask.status, 201, JSON.stringify(ask.data))
  const put = await fetch(`${TEST_BASE}${ask.data.uploadUrl}`, {
    method: 'PUT',
    headers: ask.data.headers,
    body: bytes,
  })
  assert.equal(put.status, 200, await put.text())
  const reg = await as.post(`/api/resources/${resourceId}/files/register`, { uploadId: ask.data.uploadId })
  assert.equal(reg.status, 201, JSON.stringify(reg.data))
  return { ...reg.data, storageKey: ask.data.storageKey }
}

before(async () => {
  await resetDatabase()
  await createAdmin('f_admin', 'FileAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.kPeResources = await directoryIdByPath('education/k/pe/resources')

  await startServer()
  admin = client()
  await admin.login('f_admin', 'FileAdminPass!1')

  await createTeacher('file_teacher', 'FileTeacherPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.create', directoryId: ids.virtue },
    { permission: 'resource.update.own', directoryId: ids.virtue },
    { permission: 'resource.delete.own', directoryId: ids.virtue },
    { permission: 'resource.submit', directoryId: ids.virtue },
    { permission: 'resource.download', directoryId: ids.virtue },
  ], '陈老师')
  teacher = client()
  await teacher.login('file_teacher', 'FileTeacherPass!1')

  // 另一位老师：**同目录、不同人** —— 用来验证"所有权"这一条。
  await createTeacher('file_other', 'FileOtherPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.create', directoryId: ids.virtue },
    { permission: 'resource.update.own', directoryId: ids.virtue },
    { permission: 'resource.download', directoryId: ids.virtue },
  ], '李老师')
  outsider = client()
  await outsider.login('file_other', 'FileOtherPass!1')
})

after(async () => {
  if (resources.length > 0) {
    const removed = await withSql(async (sql) => {
      const rows = await sql`
        DELETE FROM resources WHERE id = ANY(${resources}::uuid[]) RETURNING id::text
      `
      return rows.length
    })
    assert.equal(removed, resources.length, '探针资源必须全部清掉（残留核对）')
  }
  await stopServer()
})

describe('文件挂在资源的目录授权之下', () => {
  test('看得到资源 → 看得到它的文件列表', async () => {
    const id = await newResource()
    await upload(id)
    const res = await teacher.get(`/api/resources/${id}/files`)
    assert.equal(res.status, 200)
    assert.equal(res.data.items.length, 1)
  })

  test('**别人**看得到已发布资源里的文件列表，但删除不了', async () => {
    const id = await newResource()
    const file = await upload(id)
    await teacher.post(`/api/resources/${id}/submit`)
    await admin.post(`/api/resources/${id}/review`, { action: 'approve' })

    const list = await outsider.get(`/api/resources/${id}/files`)
    assert.equal(list.status, 200, '已发布资源的文件列表，有 view 权限的人都看得到')
    const dl = await outsider.get(`/api/resources/${id}/files/${file.id}/download`)
    assert.equal(dl.status, 200, '已发布资源谁都能下载（这是"共享"的意思）')
    const del = await outsider.del(`/api/resources/${id}/files/${file.id}`)
    // 已发布状态下删除本来就会先撞上状态锁；这里要的是"所有权也不成立"，
    // 所以下面用**草稿**资源再测一次真正的所有权分支。
    assert.equal([403, 409].includes(del.status), true, `实际 ${del.status}`)
  })

  test('别人的**草稿**资源：连文件列表都够不到', async () => {
    const id = await newResource()
    await upload(id)
    const res = await outsider.get(`/api/resources/${id}/files`)
    // 未发布且不是自己的 → 资源本身不可见，守卫层直接 403
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })

  test('草稿资源：别人删不掉（所有权分支）', async () => {
    // 不走捷径，直接测所有者判定：由 outsider 上传到**自己的**资源后，
    // teacher 去删 —— 即使两人在同一个目录、都有 update.own 授权，
    // 所有权这一条仍然把它挡住。
    const own = await newResource(outsider, '别人的资源')
    const file = await upload(own, { as: outsider })
    const del = await teacher.del(`/api/resources/${own}/files/${file.id}`)
    assert.equal(del.status, 403, `不是自己上传的 → 403，实际 ${del.status} ${JSON.stringify(del.data)}`)
  })

  test('没有该目录权限的老师 → 403（不是空列表）', async () => {
    const kResource = await admin.post('/api/resources', { directoryId: ids.kPeResources, title: 'K 体能探针' })
    assert.equal(kResource.status, 201)
    resources.push(kResource.data.id)
    const res = await teacher.get(`/api/resources/${kResource.data.id}/files`)
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })

  test('换资源的 id 去够别人的文件（横向越权）→ 404', async () => {
    const mine = await newResource()
    const theirs = await newResource(outsider, '别人的资源')
    const theirFile = await upload(theirs, { as: outsider })
    // 文件 id 是真的，但挂在**别人的**资源下：路径里的 :id 对不上
    const res = await teacher.get(`/api/resources/${mine}/files/${theirFile.id}/download`)
    assert.equal(res.status, 404, `应当 404（这个文件不属于这个资源），实际 ${res.status}`)
  })

  test('不存在的文件 id → 404，不是 500', async () => {
    const id = await newResource()
    const res = await teacher.get(`/api/resources/${id}/files/11111111-1111-4111-8111-111111111111/download`)
    assert.equal(res.status, 404)
  })
})

describe('上传与删除的所有权', () => {
  test('别人的资源不能上传文件 → 403（守卫层就会拦）', async () => {
    const id = await newResource()
    const res = await outsider.post(`/api/resources/${id}/files/upload-url`, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.length,
      sha256: sha256(PDF_BYTES),
    })
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })

  test('文件列表对未登录用户是 401', async () => {
    const id = await newResource()
    await upload(id)
    const anon = client()
    const res = await anon.get(`/api/resources/${id}/files`)
    assert.equal(res.status, 401)
  })
})

describe('响应里不出现存储细节（§11）', () => {
  test('文件列表只有业务字段，没有 storage key / bucket / 令牌', async () => {
    const id = await newResource()
    const file = await upload(id, { bytes: PNG_BYTES, fileName: '照片.png', mimeType: 'image/png' })
    const list = await teacher.get(`/api/resources/${id}/files`)
    const body = JSON.stringify(list.data)
    assert.equal(body.includes(file.storageKey), false, '不该把 storage key 交给前端')
    assert.equal(body.includes('bucket'), false)
    assert.equal(body.includes('token'), false)
    assert.deepEqual(Object.keys(list.data.items[0]).sort(), [
      'createdAt',
      'fileName',
      'id',
      'mimeType',
      'previewMessage',
      'previewable',
      'sha256',
      'size',
      'sizeLabel',
      'viewer',
    ])
  })

  test('预览/下载接口返回的是签名地址，且不含凭据', async () => {
    const id = await newResource()
    const file = await upload(id)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const body = JSON.stringify(dl.data)
    assert.equal(body.includes('accessKey'), false)
    assert.equal(body.includes('secret'), false)
    // 本地驱动是短命 HMAC 令牌；S3 驱动是 SigV4 签名。两者都不能泄漏凭据。
    assert.match(dl.data.url, /token=|X-Amz-Signature=/, '地址必须是带签名的短命 URL')
  })
})

describe('删除的语义', () => {
  test('删掉自己的文件 → 200；重复删 → 404（不是 500）', async () => {
    const id = await newResource()
    const file = await upload(id)
    const res = await teacher.del(`/api/resources/${id}/files/${file.id}`)
    assert.equal(res.status, 200, JSON.stringify(res.data))
    const again = await teacher.del(`/api/resources/${id}/files/${file.id}`)
    assert.equal(again.status, 404)
  })

  test('删掉文件之后资源本身还在（只是文件没了）', async () => {
    const id = await newResource()
    const file = await upload(id)
    await teacher.del(`/api/resources/${id}/files/${file.id}`)
    const detail = await teacher.get(`/api/resources/${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.data.files.length, 0)
    assert.equal(detail.data.hasFile, false)
  })

  test('删除写审计（谁删了什么）', async () => {
    const id = await newResource()
    const file = await upload(id)
    await teacher.del(`/api/resources/${id}/files/${file.id}`)
    const rows = await withSql(async (sql) => {
      return sql`
        SELECT action, target_type, target_id FROM audit_logs
        WHERE target_type = 'file' AND target_id = ${file.id} AND action = 'resource.update'
      `
    })
    assert.equal(rows.length >= 1, true, '删除文件必须留痕')
  })

  test('删除之后票据仍然指向那张票据本身（历史不丢）', async () => {
    const id = await newResource()
    const file = await upload(id)
    await teacher.del(`/api/resources/${id}/files/${file.id}`)
    const rows = await withSql(async (sql) => {
      return sql`
        SELECT consumed_at, consumed_file_id FROM upload_tickets WHERE storage_key = ${file.storageKey}
      `
    })
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0].consumed_at, null, '消费时间要留着')
    // 文件被删 → ON DELETE SET NULL；约束不能因此报错（第一版就是这里 500 的）
    assert.equal(rows[0].consumed_file_id, null)
  })
})
