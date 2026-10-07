/**
 * 文件：四步链路必须**真的**成立。
 *
 * 这里不做任何 mock：申请地址 → 浏览器 PUT → 服务端读回对象校验 → 登记。
 * 校验用的是真实字节与真实 sha256，所以"数据库说有文件、存储里没有"这件事
 * 在结构上不可能发生。
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
} from '../helpers/harness.mjs'

let admin
let teacher
let ids = {}

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const DOCX_BYTES = Buffer.from('PK\u0003\u0004fake-docx-bytes', 'binary')

before(async () => {
  await resetDatabase()
  await createAdmin('f_admin', 'FileAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  await startServer()
  admin = client()
  await admin.login('f_admin', 'FileAdminPass!1')
  await createTeacher(
    'file_teacher',
    'FileTeacherPass!1',
    [
      { permission: 'resource.view', directoryId: ids.virtue },
      { permission: 'resource.create', directoryId: ids.virtue },
      { permission: 'resource.update.own', directoryId: ids.virtue },
      { permission: 'resource.delete.own', directoryId: ids.virtue },
      { permission: 'resource.submit', directoryId: ids.virtue },
      { permission: 'resource.download', directoryId: ids.virtue },
    ],
    '陈老师',
  )
  teacher = client()
  await teacher.login('file_teacher', 'FileTeacherPass!1')
})
after(async () => {
  await stopServer()
})

async function newResource(title) {
  const res = await teacher.post('/api/resources', { directoryId: ids.resources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  return res.data.id
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

describe('上传链路', () => {
  test('① 申请地址 → ② PUT → ③ 校验 → ④ 登记，全部真的发生', async () => {
    const id = await newResource('真实上传')
    const request = await teacher.post(`/api/resources/${id}/files/upload-url`, {
      fileName: '教学详案.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
    })
    assert.equal(request.status, 201, JSON.stringify(request.data))
    assert.ok(request.data.uploadUrl.includes('token='), '必须是签名地址')
    assert.equal(request.data.method, 'PUT')

    const put = await fetch(`${TEST_BASE}${request.data.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: PDF_BYTES,
    })
    assert.equal(put.status, 200, `PUT 必须成功，实际 ${put.status}`)

    const reg = await teacher.post(`/api/resources/${id}/files/register`, {
      storageKey: request.data.storageKey,
      fileName: '教学详案.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
      sha256: sha256(PDF_BYTES),
    })
    assert.equal(reg.status, 201, JSON.stringify(reg.data))
    assert.equal(reg.data.size, PDF_BYTES.byteLength)
    assert.equal(reg.data.sha256, sha256(PDF_BYTES))
    assert.equal(reg.data.previewable, true)
  })

  test('sha256 对不上 → 拒绝登记（服务端真的读了对象）', async () => {
    const id = await newResource('校验 sha256')
    const request = await teacher.post(`/api/resources/${id}/files/upload-url`, {
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
    })
    await fetch(`${TEST_BASE}${request.data.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: PDF_BYTES,
    })
    const reg = await teacher.post(`/api/resources/${id}/files/register`, {
      storageKey: request.data.storageKey,
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
      sha256: 'a'.repeat(64),
    })
    assert.equal(reg.status, 409)
    assert.match(reg.data.message, /sha256/)
  })

  test('大小对不上 → 拒绝登记', async () => {
    const id = await newResource('校验大小')
    const request = await teacher.post(`/api/resources/${id}/files/upload-url`, {
      fileName: 'y.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
    })
    await fetch(`${TEST_BASE}${request.data.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: PDF_BYTES,
    })
    const reg = await teacher.post(`/api/resources/${id}/files/register`, {
      storageKey: request.data.storageKey,
      fileName: 'y.pdf',
      mimeType: 'application/pdf',
      size: 999999,
      sha256: sha256(PDF_BYTES),
    })
    assert.equal(reg.status, 409)
    assert.match(reg.data.message, /大小/)
  })

  test('根本没有上传对象 → 拒绝登记（这就是 V1 的"假文件"缺陷）', async () => {
    const id = await newResource('对象不存在')
    const request = await teacher.post(`/api/resources/${id}/files/upload-url`, {
      fileName: 'missing.pdf',
      mimeType: 'application/pdf',
      size: 10,
    })
    const reg = await teacher.post(`/api/resources/${id}/files/register`, {
      storageKey: request.data.storageKey,
      fileName: 'missing.pdf',
      mimeType: 'application/pdf',
      size: 10,
      sha256: 'b'.repeat(64),
    })
    assert.equal(reg.status, 409)
    assert.equal(reg.data.code, 'FILE_MISSING')
  })

  test('拿别的资源的上传地址来登记 → 拒绝（不能把别人的对象挂到自己名下）', async () => {
    const a = await newResource('资源 A')
    const b = await newResource('资源 B')
    const request = await teacher.post(`/api/resources/${a}/files/upload-url`, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
    })
    await fetch(`${TEST_BASE}${request.data.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: PDF_BYTES,
    })
    const reg = await teacher.post(`/api/resources/${b}/files/register`, {
      storageKey: request.data.storageKey,
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
      sha256: sha256(PDF_BYTES),
    })
    assert.equal(reg.status, 403)
  })

  test('一个资源可以有多个文件（+ 添加文件）', async () => {
    const id = await newResource('多文件资源')
    for (const [fileName, mime, bytes] of [
      ['教案.pdf', 'application/pdf', PDF_BYTES],
      ['课件.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', DOCX_BYTES],
      ['工作单.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOCX_BYTES],
    ]) {
      const req = await teacher.post(`/api/resources/${id}/files/upload-url`, {
        fileName,
        mimeType: mime,
        size: bytes.byteLength,
      })
      await fetch(`${TEST_BASE}${req.data.uploadUrl}`, {
        method: 'PUT',
        headers: { 'content-type': mime },
        body: bytes,
      })
      const reg = await teacher.post(`/api/resources/${id}/files/register`, {
        storageKey: req.data.storageKey,
        fileName,
        mimeType: mime,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      })
      assert.equal(reg.status, 201, `${fileName}：${JSON.stringify(reg.data)}`)
    }
    const detail = await teacher.get(`/api/resources/${id}`)
    assert.equal(detail.data.files.length, 3)
    assert.equal(detail.data.fileCount, 3)
  })
})

describe('下载与预览', () => {
  let resourceId
  let pdfFileId

  before(async () => {
    resourceId = await newResource('下载与预览')
    const req = await teacher.post(`/api/resources/${resourceId}/files/upload-url`, {
      fileName: '预览用.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
    })
    await fetch(`${TEST_BASE}${req.data.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: PDF_BYTES,
    })
    const reg = await teacher.post(`/api/resources/${resourceId}/files/register`, {
      storageKey: req.data.storageKey,
      fileName: '预览用.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.byteLength,
      sha256: sha256(PDF_BYTES),
    })
    pdfFileId = reg.data.id
  })

  test('下载：字节与上传的完全一致', async () => {
    const res = await teacher.get(`/api/resources/${resourceId}/files/${pdfFileId}/download`)
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.ok(res.data.url.includes('token='))

    const bytes = await fetch(`${TEST_BASE}${res.data.url}`)
    assert.equal(bytes.status, 200)
    const buf = Buffer.from(await bytes.arrayBuffer())
    assert.equal(buf.byteLength, PDF_BYTES.byteLength)
    assert.equal(sha256(buf), sha256(PDF_BYTES), '下载到的字节必须与上传的完全一致')
    assert.match(String(bytes.headers.get('content-disposition')), /attachment/)
  })

  test('PDF 可以网页内预览（inline）', async () => {
    const res = await teacher.get(`/api/resources/${resourceId}/files/${pdfFileId}/preview`)
    assert.equal(res.status, 200)
    assert.equal(res.data.previewable, true)
    const bytes = await fetch(`${TEST_BASE}${res.data.url}`)
    assert.equal(bytes.status, 200)
    assert.equal(bytes.headers.get('content-type'), 'application/pdf')
    assert.match(String(bytes.headers.get('content-disposition')), /inline/)
  })

  test('不支持预览的类型：返回可读说明，而不是一个坏链接', async () => {
    const req = await teacher.post(`/api/resources/${resourceId}/files/upload-url`, {
      fileName: '课件.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: DOCX_BYTES.byteLength,
    })
    await fetch(`${TEST_BASE}${req.data.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: DOCX_BYTES,
    })
    const reg = await teacher.post(`/api/resources/${resourceId}/files/register`, {
      storageKey: req.data.storageKey,
      fileName: '课件.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: DOCX_BYTES.byteLength,
      sha256: sha256(DOCX_BYTES),
    })
    assert.equal(reg.status, 201)
    assert.equal(reg.data.previewable, false)

    const res = await teacher.get(`/api/resources/${resourceId}/files/${reg.data.id}/preview`)
    assert.equal(res.status, 200)
    assert.equal(res.data.previewable, false)
    assert.equal(res.data.message, '此文件类型暂不支持在线预览，请下载查看。')

    // 但它**可以下载**（业主：DOCX/XLSX/PPTX 至少支持下载）
    const dl = await teacher.get(`/api/resources/${resourceId}/files/${reg.data.id}/download`)
    assert.equal(dl.status, 200)
  })

  test('签名不能猜：改一个字符就失效', async () => {
    const res = await teacher.get(`/api/resources/${resourceId}/files/${pdfFileId}/preview`)
    const tampered = res.data.url.replace(/token=([^&]+)/, (m, t) => `token=${t.slice(0, -1)}X`)
    const bad = await fetch(`${TEST_BASE}${tampered}`)
    assert.equal(bad.status, 403)
  })

  test('没有权限的人拿不到下载地址', async () => {
    await createTeacher('nosy', 'NosyPass!12345', [])
    const c = client()
    await c.login('nosy', 'NosyPass!12345')
    const res = await c.get(`/api/resources/${resourceId}/files/${pdfFileId}/download`)
    assert.equal(res.status, 403)
  })
})

describe('上传前置条件', () => {
  test('超过 50MB 被拒', async () => {
    const id = await newResource('超大文件')
    const res = await teacher.post(`/api/resources/${id}/files/upload-url`, {
      fileName: 'huge.zip',
      mimeType: 'application/zip',
      size: 60 * 1024 * 1024,
    })
    assert.equal(res.status, 409)
    assert.match(res.data.message, /50 MB/)
  })

  test('别人的资源不能上传文件', async () => {
    const id = await newResource('别人的资源')
    await createTeacher(
      'other_up',
      'OtherUpPass!1',
      [
        { permission: 'resource.view', directoryId: ids.virtue },
        { permission: 'resource.update.own', directoryId: ids.virtue },
      ],
    )
    const other = client()
    await other.login('other_up', 'OtherUpPass!1')
    const res = await other.post(`/api/resources/${id}/files/upload-url`, {
      fileName: 'steal.pdf',
      mimeType: 'application/pdf',
      size: 10,
    })
    assert.equal(res.status, 403)
  })
})
