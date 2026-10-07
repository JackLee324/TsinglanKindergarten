/**
 * tests/integration/upload.integration.test.mjs —— 上传链路的完整契约
 * ============================================================================
 * 被测的四步（业主 §4）：
 *   ① `POST /api/resources/:id/files/upload-url` —— 校验 + 生成**带 sha256 的**签名地址 + 写票据
 *   ② 浏览器直接 `PUT` 到那个地址（本地驱动走 `/api/storage/local`，行为与 S3 一致）
 *   ③ `POST /api/resources/:id/files/register` —— 确认对象在、大小对、内容类型对
 *   ④ 写 `resource_files`，票据作废
 *
 * 这一份的主角是**第 ② 步的拒绝能力**：业主 §8 要的不是"上传完之后比一下哈希"，
 * 而是"字节不对就根本别落盘"。所以下面专门有一条用例把
 * **声明 sha256=A、实际 PUT 字节 B** 打进去，断言两件事：
 *   · PUT 被拒；
 *   · 对象**不在**存储里（哪怕事后想登记也登记不上）。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  TEST_BASE,
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  runProjectScriptCaptured,
  startServer,
  stopServer,
  testStorageDir,
  withSql,
} from '../helpers/harness.mjs'
import { filePolicy } from '../helpers/modules.mjs'

const { MAX_FILE_SIZE_BYTES, ALLOWED_FILE_TYPES } = filePolicy
const DOCX_MIME = ALLOWED_FILE_TYPES.find((t) => t.ext === 'docx').mime

/** 一小段真正的 PDF 字节（magic 必须是 %PDF-）。 */
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'.repeat(30)),
  Buffer.from('%%EOF\n'),
])
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png payload for preview test\n'.repeat(4)),
])
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  Buffer.from('fake docx (a zip container)\n'.repeat(4)),
])
/** 一个 ELF 可执行文件的头 —— 用来验证"改名成 .pdf 也不行"。 */
const ELF_BYTES = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
  Buffer.from('not a pdf at all\n'.repeat(8)),
])

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let teacher
let other
let admin
let ids = {}
let base = ''
/** 本次套件造的资源 id —— after 里按 id 清掉（资源删掉，文件行随之级联）。 */
const resources = []

/** 建一个草稿资源。 */
async function newResource(owner = teacher, title = '上传探针') {
  const res = await owner.post('/api/resources', { directoryId: ids.virtueResources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

/** ① 申请上传地址。 */
async function askUpload(resourceId, over = {}, as = teacher) {
  return as.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName: '美德教案.pdf',
    mimeType: 'application/pdf',
    size: PDF_BYTES.length,
    sha256: sha256(PDF_BYTES),
    ...over,
  })
}

/** ② 真的 PUT。返回 { status, body }。 */
async function putObject(uploadUrl, body, headers) {
  const url = uploadUrl.startsWith('http') ? uploadUrl : `${base}${uploadUrl}`
  const res = await fetch(url, { method: 'PUT', headers, body })
  return { status: res.status, body: await res.text() }
}

/** ③ 登记。 */
async function register(resourceId, uploadId, as = teacher) {
  return as.post(`/api/resources/${resourceId}/files/register`, { uploadId })
}

/** 走完一整条链路，返回登记出来的文件。 */
async function uploadFile(resourceId, { bytes = PDF_BYTES, fileName = '美德教案.pdf', mimeType = 'application/pdf', as = teacher } = {}) {
  const ask = await askUpload(resourceId, { fileName, mimeType, size: bytes.length, sha256: sha256(bytes) }, as)
  assert.equal(ask.status, 201, JSON.stringify(ask.data))
  const put = await putObject(ask.data.uploadUrl, bytes, ask.data.headers)
  assert.equal(put.status, 200, `PUT 应当成功：${put.body}`)
  const reg = await register(resourceId, ask.data.uploadId, as)
  assert.equal(reg.status, 201, JSON.stringify(reg.data))
  return { file: reg.data, uploadId: ask.data.uploadId, storageKey: ask.data.storageKey }
}

before(async () => {
  await resetDatabase()
  await createAdmin('up_admin', 'UpAdminPass!1')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtueLesson = await directoryIdByPath('education/pre-k/virtue/lesson')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  await startServer()
  base = TEST_BASE

  admin = client()
  await admin.login('up_admin', 'UpAdminPass!1')

  await createTeacher('up_t', 'UpTeacherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.download', directoryId: virtue },
    { permission: 'resource.submit', directoryId: virtue },
  ], '上传老师')
  teacher = client()
  await teacher.login('up_t', 'UpTeacherPass!1')

  await createTeacher('up_other', 'UpOtherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.submit', directoryId: virtue },
  ], '别人')
  other = client()
  await other.login('up_other', 'UpOtherPass!1')
})

after(async () => {
  // 探针清理：删掉本套件建的资源（resource_files / upload_tickets 都是 ON DELETE CASCADE）。
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

describe('完整链路：申请 → PUT → 登记', () => {
  test('四步都真的发生了，登记出来的文件带 sha256 / 大小 / 预览能力', async () => {
    const id = await newResource()
    const { file } = await uploadFile(id)

    assert.equal(file.fileName, '美德教案.pdf')
    assert.equal(file.mimeType, 'application/pdf')
    assert.equal(file.size, PDF_BYTES.length)
    assert.equal(file.sha256, sha256(PDF_BYTES))
    assert.equal(file.previewable, true)
    assert.equal(file.viewer, 'pdf')
    assert.equal(file.previewMessage, null)
    assert.equal(file.sizeLabel.endsWith('B'), true)
  })

  test('对象 key 的形状是 resources/{resourceId}/{uuid}-{safeName}（§7）', async () => {
    const id = await newResource()
    const ask = await askUpload(id, { fileName: '幼儿园美德课程教案.pdf' })
    assert.equal(ask.status, 201)
    const key = ask.data.storageKey
    assert.equal(key.startsWith(`resources/${id}/`), true, `实际 key：${key}`)
    // 中文保留，uuid 前缀保证同名文件不会互相覆盖
    assert.match(key, /^resources\/[0-9a-f-]{36}\/[0-9a-f-]{36}-幼儿园美德课程教案\.pdf$/)
  })

  test('刷新后再查：文件还在（不是"上传成功但刷新就没了"）', async () => {
    const id = await newResource()
    const { file } = await uploadFile(id)
    const again = await teacher.get(`/api/resources/${id}/files`)
    assert.equal(again.status, 200)
    assert.deepEqual(again.data.items.map((f) => f.id), [file.id])
    // 资源详情里也要能看到这个文件（详情页读的是这一份）
    const detail = await teacher.get(`/api/resources/${id}`)
    assert.equal(detail.data.files.length, 1)
    assert.equal(detail.data.files[0].sha256, file.sha256)
  })

  test('回读的字节与上传的字节 sha256 完全一致（§8）', async () => {
    const id = await newResource()
    const { file } = await uploadFile(id)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const bytes = Buffer.from(await (await fetch(`${base}${dl.data.url}`)).arrayBuffer())
    assert.equal(sha256(bytes), sha256(PDF_BYTES), '下载回来的字节必须与上传的逐字节一致')
    assert.equal(bytes.length, PDF_BYTES.length)
  })
})

describe('完整性由**存储层**强制（§8）', () => {
  test('声明的 sha256 与实际 PUT 的字节不符 → 存储层拒绝，且对象不落地', async () => {
    const id = await newResource()
    const ask = await askUpload(id, { sha256: sha256(PDF_BYTES) })
    assert.equal(ask.status, 201)

    // 声明的是 PDF_BYTES 的哈希，实际传**同样长度**但内容不同的字节。
    // ⚠️ 长度必须一致：否则先撞上的是大小校验，就测不到哈希这一关了
    // （第一版就是这么写的，失败信息是 FILE_SIZE_MISMATCH 而不是 HASH_MISMATCH）。
    const tampered = Buffer.from(PDF_BYTES)
    tampered.write('XX', 6) // 仍然以 %PDF- 开头，只是内容被动了
    assert.equal(tampered.length, PDF_BYTES.length)
    assert.notEqual(sha256(tampered), sha256(PDF_BYTES))

    const put = await putObject(ask.data.uploadUrl, tampered, ask.data.headers)
    assert.equal(put.status, 400, `与声明哈希不符的 PUT 必须被拒，实际 ${put.status} ${put.body}`)
    assert.match(put.body, /FILE_HASH_MISMATCH|sha256/)

    // 关键：对象**没有**落盘 —— 于是"先传坏的、再登记好的"这条路是不存在的。
    const head = await withSql(async (sql) => {
      const rows = await sql`SELECT 1 AS one FROM resource_files WHERE storage_key = ${ask.data.storageKey}`
      return rows.length
    })
    assert.equal(head, 0, '失败的上传不该留下任何数据库痕迹')

    // 连登记都登记不上（对象不存在）。
    const reg = await register(id, ask.data.uploadId)
    assert.equal(reg.status, 400)
    assert.match(JSON.stringify(reg.data), /FILE_NOT_FOUND|找不到/)
  })

  test('实际字节数与申请时声明的不符 → 存储层拒绝', async () => {
    const id = await newResource()
    // 声明得比真实字节多 10 个
    const ask = await askUpload(id, { size: PDF_BYTES.length + 10, sha256: sha256(PDF_BYTES) })
    assert.equal(ask.status, 201)
    const put = await putObject(ask.data.uploadUrl, PDF_BYTES, ask.data.headers)
    assert.equal(put.status, 400)
    assert.match(put.body, /FILE_SIZE_MISMATCH|大小/)
  })

  test('上传地址被改一个字符就失效（签名不可猜）', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    const broken = ask.data.uploadUrl.replace('token=', 'token=X')
    const put = await putObject(broken, PDF_BYTES, ask.data.headers)
    assert.equal(put.status, 403)
  })

  test('没有上传对象就登记 → 拒绝（这就是 V1 的"假文件"缺陷）', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    // 完全跳过 PUT
    const reg = await register(id, ask.data.uploadId)
    assert.equal(reg.status, 400)
    assert.match(JSON.stringify(reg.data), /FILE_NOT_FOUND|找不到/)
  })
})

describe('登记只认票据（客户端不能再声明一次元数据）', () => {
  test('同一张票据不能登记两次', async () => {
    const id = await newResource()
    const { uploadId } = await uploadFile(id)
    const again = await register(id, uploadId)
    assert.equal(again.status, 409)
    assert.match(JSON.stringify(again.data), /已经登记过/)
  })

  test('登记时多声明 size / sha256 / key → 直接 400（未知字段不允许出现）', async () => {
    // 全局 ValidationPipe 是 `forbidNonWhitelisted`，所以"客户端想再声明一次元数据"
    // 这件事在**协议层面**就不成立：多传字段是 400，不是被忽略。
    const id = await newResource()
    const ask = await askUpload(id)
    await putObject(ask.data.uploadUrl, PDF_BYTES, ask.data.headers)
    const reg = await teacher.post(`/api/resources/${id}/files/register`, {
      uploadId: ask.data.uploadId,
      sha256: 'f'.repeat(64),
      size: 1,
      fileName: 'hacked.exe',
      storageKey: 'resources/x/y',
    })
    assert.equal(reg.status, 400, JSON.stringify(reg.data))
    assert.match(JSON.stringify(reg.data), /VALIDATION_FAILED/)
  })

  test('登记出来的元数据逐项等于申请时的那份（来自票据，不是客户端二次声明）', async () => {
    const id = await newResource()
    const ask = await askUpload(id, {
      fileName: '幼儿园美德教案.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.length,
      sha256: sha256(PDF_BYTES),
    })
    await putObject(ask.data.uploadUrl, PDF_BYTES, ask.data.headers)
    const reg = await register(id, ask.data.uploadId)
    assert.equal(reg.status, 201, JSON.stringify(reg.data))
    assert.equal(reg.data.fileName, '幼儿园美德教案.pdf')
    assert.equal(reg.data.mimeType, 'application/pdf')
    assert.equal(reg.data.size, PDF_BYTES.length)
    assert.equal(reg.data.sha256, sha256(PDF_BYTES))

    // 数据库里存的也是这些值（不是只在响应里对）
    const row = await withSql(async (sql) => {
      const rows = await sql`
        SELECT file_name, size::int AS size, sha256 FROM resource_files WHERE id = ${reg.data.id}
      `
      return rows[0]
    })
    assert.deepEqual(row, {
      file_name: '幼儿园美德教案.pdf',
      size: PDF_BYTES.length,
      sha256: sha256(PDF_BYTES),
    })
  })

  test('别人的票据不能拿来登记到自己的资源上', async () => {
    const mine = await newResource()
    const theirs = await newResource(other)
    const ask = await askUpload(theirs, {}, other)
    assert.equal(ask.status, 201)
    await putObject(ask.data.uploadUrl, PDF_BYTES, ask.data.headers)

    const reg = await register(mine, ask.data.uploadId, teacher)
    assert.equal(reg.status, 403, JSON.stringify(reg.data))
  })

  test('不存在的票据 → 404', async () => {
    const id = await newResource()
    const reg = await register(id, '11111111-1111-4111-8111-111111111111')
    assert.equal(reg.status, 404)
  })

  test('过期的票据不能登记（并把对象记成孤儿）', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    await putObject(ask.data.uploadUrl, PDF_BYTES, ask.data.headers)
    // 直接把票据的过期时间拨到过去：不 sleep，也不依赖系统时钟。
    await withSql(async (sql) => {
      await sql`UPDATE upload_tickets SET expires_at = now() - interval '1 second' WHERE id = ${ask.data.uploadId}`
    })
    const reg = await register(id, ask.data.uploadId)
    assert.equal(reg.status, 400)
    assert.match(JSON.stringify(reg.data), /过期/)

    const markers = await withSql(async (sql) => {
      const rows = await sql`
        SELECT reason FROM storage_orphans
        WHERE storage_key = ${ask.data.storageKey} AND cleaned_at IS NULL
      `
      return rows.map((r) => r.reason)
    })
    assert.deepEqual(markers, ['TICKET_EXPIRED'], '过期后留下的对象必须被登记为孤儿')
  })
})

describe('申请地址时的静态校验（§5 / §6）', () => {
  test('危险扩展名 / 双扩展名 / 路径穿越 → 400，且不产生票据', async () => {
    const id = await newResource()
    const before = await withSql(async (sql) => {
      const rows = await sql`SELECT count(*)::int AS n FROM upload_tickets WHERE resource_id = ${id}`
      return rows[0].n
    })
    for (const fileName of ['evil.exe', 'test.pdf.exe', 'test.exe.pdf', '../../etc/passwd', 'a.php.pdf', 'x.html']) {
      const res = await askUpload(id, { fileName })
      assert.equal(res.status, 400, `${fileName} 应当被拒，实际 ${res.status}`)
    }
    const after = await withSql(async (sql) => {
      const rows = await sql`SELECT count(*)::int AS n FROM upload_tickets WHERE resource_id = ${id}`
      return rows[0].n
    })
    assert.equal(after, before, '被拒的申请不该留下票据')
  })

  test('MIME 与扩展名不符 → 400', async () => {
    const id = await newResource()
    const res = await askUpload(id, { fileName: 'a.pdf', mimeType: 'text/html' })
    assert.equal(res.status, 400)
    assert.match(JSON.stringify(res.data), /FILE_TYPE_NOT_ALLOWED/)
  })

  test('超过 50MB → 413，并且错误里说得出上限是多少', async () => {
    const id = await newResource()
    const res = await askUpload(id, { size: MAX_FILE_SIZE_BYTES + 1 })
    assert.equal(res.status, 413, JSON.stringify(res.data))
    assert.match(JSON.stringify(res.data), /50 MB/)
  })

  test('sha256 格式不对 → 400（不接受长度不对的"哈希"）', async () => {
    const id = await newResource()
    for (const bad of ['', 'abc', 'z'.repeat(64), 'A'.repeat(63)]) {
      const res = await askUpload(id, { sha256: bad })
      assert.equal(res.status, 400, `sha256=${bad} 应当被拒`)
    }
  })

  test('大小 0 / 负数 → 400', async () => {
    const id = await newResource()
    for (const size of [0, -1]) {
      const res = await askUpload(id, { size })
      assert.equal(res.status, 400, `size=${size} 应当被拒`)
    }
  })

  test('策略接口与前端读的是同一份常量', async () => {
    const id = await newResource()
    const res = await teacher.get(`/api/resources/${id}/files/policy`)
    assert.equal(res.status, 200)
    assert.equal(res.data.maxFileSizeBytes, MAX_FILE_SIZE_BYTES)
    assert.deepEqual(res.data.allowedExtensions, ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'xlsx', 'pptx', 'zip'])
  })
})

describe('登记时用 magic bytes 验内容（§5 的最后一关）', () => {
  test('把可执行文件改名成 .pdf 上传 → 哈希能对上，但登记被拒 + 记孤儿', async () => {
    const id = await newResource()
    // 哈希是对的（客户端算的就是这段字节的哈希），所以存储层这一关会放行。
    // 挡住它的是登记时的内容验真 —— 这正是"只看扩展名"会漏掉的那一类。
    const ask = await askUpload(id, { size: ELF_BYTES.length, sha256: sha256(ELF_BYTES) })
    assert.equal(ask.status, 201, '申请阶段只能看扩展名与 MIME，所以这里会通过')
    const put = await putObject(ask.data.uploadUrl, ELF_BYTES, ask.data.headers)
    assert.equal(put.status, 200, '字节与声明的哈希一致，存储层放行')

    const reg = await register(id, ask.data.uploadId)
    assert.equal(reg.status, 400, JSON.stringify(reg.data))
    assert.match(JSON.stringify(reg.data), /FILE_TYPE_NOT_ALLOWED|内容与扩展名不符/)

    const markers = await withSql(async (sql) => {
      const rows = await sql`
        SELECT reason FROM storage_orphans
        WHERE storage_key = ${ask.data.storageKey} AND cleaned_at IS NULL
      `
      return rows.map((r) => r.reason)
    })
    assert.deepEqual(markers, ['CONTENT_TYPE_MISMATCH'], '被拒的对象必须留下清理标记')
  })

  test('把 zip 改名成 .pdf → 同样被拒', async () => {
    const id = await newResource()
    const ask = await askUpload(id, { size: ZIP_BYTES.length, sha256: sha256(ZIP_BYTES) })
    await putObject(ask.data.uploadUrl, ZIP_BYTES, ask.data.headers)
    const reg = await register(id, ask.data.uploadId)
    assert.equal(reg.status, 400)
    assert.match(JSON.stringify(reg.data), /压缩包|内容与扩展名不符/)
  })

  test('真的 docx（zip 容器 + 正确 MIME）→ 通过，并且是"只能下载"', async () => {
    const id = await newResource()
    const { file } = await uploadFile(id, {
      bytes: ZIP_BYTES,
      fileName: '教案.docx',
      mimeType: DOCX_MIME,
    })
    assert.equal(file.previewable, false)
    assert.equal(file.viewer, null)
    assert.equal(file.previewMessage, '此文件类型暂不支持在线预览，请下载查看。')
  })
})

describe('一个资源可以有多个文件（§16）', () => {
  test('三个文件都在，同名的两个不会被覆盖', async () => {
    const id = await newResource()
    // 两个**同名同类型**的文件（业主 §16：教案.pdf 与 教案-v2.pdf 都要留下）
    const a = await uploadFile(id, { fileName: '教案.pdf', bytes: PDF_BYTES })
    const b = await uploadFile(id, { fileName: '教案.pdf', bytes: PDF_BYTES })
    const c = await uploadFile(id, { fileName: '照片.png', bytes: PNG_BYTES, mimeType: 'image/png' })

    assert.notEqual(a.storageKey, b.storageKey, '同名文件必须落在不同的对象 key 上')
    assert.notEqual(b.storageKey, c.storageKey)
    const list = await teacher.get(`/api/resources/${id}/files`)
    assert.equal(list.data.items.length, 3)
    assert.deepEqual(
      list.data.items.map((f) => f.fileName).sort(),
      ['教案.pdf', '教案.pdf', '照片.png'],
    )
    // 两条同名文件都有各自的 sha256 记录，谁也没被覆盖
    assert.equal(list.data.items.filter((f) => f.fileName === '教案.pdf').length, 2)

    // 对象存储里真的有三个对象（同名不是同一个 key）
    const keys = await withSql(async (sql) => {
      const rows = await sql`
        SELECT storage_key FROM resource_files WHERE resource_id = ${id}
      `
      return rows.map((r) => r.storage_key)
    })
    assert.equal(new Set(keys).size, 3)
  })

  test('detail 里的 fileCount / hasFile 跟着变', async () => {
    const id = await newResource()
    const empty = await teacher.get(`/api/resources/${id}`)
    assert.equal(empty.data.fileCount, 0)
    assert.equal(empty.data.hasFile, false)
    await uploadFile(id)
    const one = await teacher.get(`/api/resources/${id}`)
    assert.equal(one.data.fileCount, 1)
    assert.equal(one.data.hasFile, true)
  })
})

describe('没有文件不能提交审核（§18）', () => {
  test('草稿没有文件 → 400 + "请先上传至少一个文件。"', async () => {
    const id = await newResource()
    const res = await teacher.post(`/api/resources/${id}/submit`)
    assert.equal(res.status, 400, JSON.stringify(res.data))
    assert.equal(res.data.message, '请先上传至少一个文件。')
  })

  test('传了一个文件之后就能提交', async () => {
    const id = await newResource()
    await uploadFile(id)
    const res = await teacher.post(`/api/resources/${id}/submit`)
    assert.equal(res.status, 201, JSON.stringify(res.data))
  })

  test('空草稿**允许存在**（阶段 5 起的规则不变，只是不能提交）', async () => {
    const id = await newResource()
    const detail = await teacher.get(`/api/resources/${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.data.status, 'DRAFT')
    assert.equal(detail.data.files.length, 0)
  })
})

describe('状态锁定：待审核 / 已发布不能增删文件', () => {
  test('待审核的资源不能上传新文件 → 409', async () => {
    const id = await newResource()
    await uploadFile(id)
    await teacher.post(`/api/resources/${id}/submit`)
    const res = await askUpload(id)
    assert.equal(res.status, 409, JSON.stringify(res.data))
    assert.match(JSON.stringify(res.data), /RESOURCE_LOCKED|撤回/)
  })

  test('已发布的资源不能删文件 → 409（先撤回）', async () => {
    const id = await newResource()
    const { file } = await uploadFile(id)
    await teacher.post(`/api/resources/${id}/submit`)
    await admin.post(`/api/resources/${id}/review`, { action: 'approve' })
    const res = await teacher.del(`/api/resources/${id}/files/${file.id}`)
    assert.equal(res.status, 409, JSON.stringify(res.data))
    assert.match(JSON.stringify(res.data), /撤回/)
  })
})

describe('删除文件：先删对象，再删数据库行（§17）', () => {
  test('删除后对象真的消失了（不是只把数据库那一行删了）', async () => {
    const id = await newResource()
    const { file, storageKey } = await uploadFile(id)
    // 本地驱动的存储目录：对象文件真的在
    const path = join(storageDirOf(), storageKey)
    assert.equal(existsSync(path), true, `对象应当落在 ${path}`)

    const del = await teacher.del(`/api/resources/${id}/files/${file.id}`)
    assert.equal(del.status, 200, JSON.stringify(del.data))
    assert.equal(existsSync(path), false, '对象必须真的被删掉')
    const list = await teacher.get(`/api/resources/${id}/files`)
    assert.equal(list.data.items.length, 0)
  })

  test('存储删除失败时数据库**不能**假装删成功', async () => {
    const id = await newResource()
    const { file, storageKey } = await uploadFile(id)
    const dir = join(storageDirOf(), storageKey.split('/').slice(0, 2).join('/'))
    // 注入一次真实的失败：把资源目录设成只读，unlink 就会 EACCES。
    // 这比 mock 一个"抛错的删除函数"更可信 —— 测的是真代码路径上的真错误。
    chmodSync(dir, 0o500)
    try {
      const del = await teacher.del(`/api/resources/${id}/files/${file.id}`)
      assert.equal(del.status, 503, `存储失败应当是 503（不是 500、更不能是 200）：${JSON.stringify(del.data)}`)
      assert.match(JSON.stringify(del.data), /STORAGE_UNAVAILABLE/)
    } finally {
      chmodSync(dir, 0o700)
    }
    const list = await teacher.get(`/api/resources/${id}/files`)
    assert.equal(list.data.items.length, 1, '存储没删掉，数据库那一行就必须还在')
  })
})

describe('孤儿对象清理（§29）', () => {
  test('登记失败留下的对象会被 cleanup 脚本删掉，并置 cleaned_at', async () => {
    const id = await newResource()
    // 造一个孤儿：申请 → PUT（哈希一致，对象落地）→ 用 ELF 内容冒充 pdf 让登记失败。
    const ask = await askUpload(id, { size: ELF_BYTES.length, sha256: sha256(ELF_BYTES) })
    await putObject(ask.data.uploadUrl, ELF_BYTES, ask.data.headers)
    const reg = await register(id, ask.data.uploadId)
    assert.equal(reg.status, 400)

    const path = join(storageDirOf(), ask.data.storageKey)
    assert.equal(existsSync(path), true, '孤儿对象此刻确实在存储里')

    const out = await runProjectScriptCaptured('scripts/cleanup-orphans.mjs', cleanupEnv())
    assert.match(out, /已删除/)
    assert.equal(existsSync(path), false, '孤儿对象必须被真的删掉')

    const left = await withSql(async (sql) => {
      const rows = await sql`
        SELECT cleaned_at FROM storage_orphans WHERE storage_key = ${ask.data.storageKey}
      `
      return rows.map((r) => r.cleaned_at)
    })
    assert.equal(left.length, 1)
    assert.notEqual(left[0], null, '标记必须被置成已清理')
  })

  test('已登记的文件不在孤儿清单里（清理脚本不会误删正常文件）', async () => {
    const id = await newResource()
    const { storageKey } = await uploadFile(id)
    await runProjectScriptCaptured('scripts/cleanup-orphans.mjs', cleanupEnv())
    assert.equal(existsSync(join(storageDirOf(), storageKey)), true, '正常文件不能被清理脚本删掉')
  })
})

/** 本地驱动的存储根目录（由 harness 在启动时创建并注入）。 */
function storageDirOf() {
  return testStorageDir()
}

/**
 * 清理脚本要跑在**与被测服务同一套配置**上。
 *
 * 少了 STORAGE_LOCAL_DIR，脚本会去看 `.devdata/storage`，
 * 于是一个孤儿也删不掉，而测试却可能因为"输出里有'已删除'"而假装通过 ——
 * 所以这里把存储配置和开发密钥一起显式传下去，别让它自己去猜。
 */
function cleanupEnv() {
  return {
    NODE_ENV: 'test',
    V2_ALLOW_DEV_SECRETS: '1',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: storageDirOf(),
  }
}

describe('目录里能数到刚上传的资源（上传后"去哪了"可见）', () => {
  test('资源列表里查到它，且目录路径是完整中文链路', async () => {
    const id = await newResource(teacher, '上传后可见性探针')
    await uploadFile(id)
    const list = await teacher.get(`/api/resources?directoryId=${ids.virtueResources}&pageSize=100&q=上传后可见性探针`)
    assert.equal(list.status, 200)
    assert.equal(list.data.items.length, 1)
    assert.equal(list.data.items[0].id, id)
    assert.equal(list.data.items[0].directoryPath, 'education/pre-k/virtue/resources')
    assert.equal(list.data.items[0].fileCount, 1)
  })

  test('存储目录里真的多出了对象文件', async () => {
    const root = storageDirOf()
    const before = readdirSync(join(root, 'resources')).length
    const id = await newResource()
    await uploadFile(id)
    const after = readdirSync(join(root, 'resources')).length
    assert.equal(after > before, true, '每个资源应当在存储里有一个前缀目录')
  })
})
