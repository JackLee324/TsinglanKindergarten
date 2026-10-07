/**
 * tests/integration/download-preview.integration.test.mjs —— 预览与下载的语义
 * ============================================================================
 * 业主 §9 / §10 / §11 / §36 / §38 全在这一份里。四条主线：
 *
 * 1. **哪些能预览、用哪个 viewer**：PDF / 图片 / TXT 内联，Office 与 ZIP 只下载。
 *    不支持的类型返回的是**可读的一句话**，不是一个坏链接 ——
 *    "点按钮没有反应"正是业主点名要消灭的体验。
 *
 * 2. **类型由服务端决定**。响应头里的 `Content-Type` 来自数据库里的 mime，
 *    不是客户端传参；而且一律带 `nosniff`。于是"上传一个 HTML 再骗过预览去执行脚本"
 *    这条路是堵死的：它只会以 `text/plain` 被当作文本显示。
 *
 * 3. **地址是短命的、不可猜的**。过期、改一个字符、换 object key 都必须失效。
 *    这一份用 3 秒的 TTL 把"过期"真的跑一遍，而不是只读代码。
 *
 * 4. **缓存与凭据**：私有资源不允许被浏览器长期缓存（`no-store`），
 *    响应里也不出现 bucket / storage key / 密钥。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  TEST_BASE,
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
  testStorageDir,
  withSql,
} from '../helpers/harness.mjs'

let teacher
let ids = {}
const resources = []
const GET_TTL_SECONDS = 3

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 各类文件的真实字节（magic 必须对得上，否则登记这一关就过不去）。 */
const FIXTURES = {
  pdf: {
    fileName: '美德教案.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('1 0 obj<</Type/Catalog>>endobj\n'.repeat(20)),
      Buffer.from('%%EOF\n'),
    ]),
    viewer: 'pdf',
  },
  png: {
    fileName: '观察照片.png',
    mimeType: 'image/png',
    bytes: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('png bytes\n'.repeat(20)),
    ]),
    viewer: 'image',
  },
  jpeg: {
    fileName: '照片.jpg',
    mimeType: 'image/jpeg',
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('jpeg bytes\n'.repeat(20)),
    ]),
    viewer: 'image',
  },
  txt: {
    fileName: '观察记录.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('第一行\n第二行\n幼儿园观察记录\n', 'utf8'),
    viewer: 'text',
  },
  docx: {
    fileName: '周计划.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      Buffer.from('docx bytes\n'.repeat(20)),
    ]),
    viewer: null,
  },
  xlsx: {
    fileName: '出勤表.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      Buffer.from('xlsx bytes\n'.repeat(20)),
    ]),
    viewer: null,
  },
  pptx: {
    fileName: '课件.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      Buffer.from('pptx bytes\n'.repeat(20)),
    ]),
    viewer: null,
  },
  zip: {
    fileName: '素材包.zip',
    mimeType: 'application/zip',
    bytes: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      Buffer.from('zip bytes\n'.repeat(20)),
    ]),
    viewer: null,
  },
}

async function newResource(title = '预览探针') {
  const res = await teacher.post('/api/resources', { directoryId: ids.resources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

async function upload(resourceId, fixture, over = {}) {
  const bytes = over.bytes ?? fixture.bytes
  const ask = await teacher.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName: over.fileName ?? fixture.fileName,
    mimeType: over.mimeType ?? fixture.mimeType,
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
  const reg = await teacher.post(`/api/resources/${resourceId}/files/register`, { uploadId: ask.data.uploadId })
  assert.equal(reg.status, 201, JSON.stringify(reg.data))
  return { ...reg.data, storageKey: ask.data.storageKey }
}

/** 直接取签名地址后面的原始响应，用来断言响应头。 */
async function fetchSigned(url) {
  return fetch(url.startsWith('http') ? url : `${TEST_BASE}${url}`)
}

before(async () => {
  await resetDatabase()
  await createAdmin('dp_admin', 'DpAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  // 下载地址 TTL 设成 3 秒：过期这一类必须**真的**等它过期再断言。
  await startServer({ env: { STORAGE_GET_TTL_SECONDS: String(GET_TTL_SECONDS) } })

  await createTeacher('dp_t', 'DpTeacherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.download', directoryId: virtue },
  ], '预览老师')
  teacher = client()
  await teacher.login('dp_t', 'DpTeacherPass!1')
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

describe('哪些能预览、用哪个 viewer（§9）', () => {
  for (const fixture of Object.values(FIXTURES)) {
    test(`${fixture.fileName} → ${fixture.viewer ?? '只能下载'}`, async () => {
      const id = await newResource()
      const file = await upload(id, fixture)
      const res = await teacher.get(`/api/resources/${id}/files/${file.id}/preview`)
      assert.equal(res.status, 200, JSON.stringify(res.data))

      if (fixture.viewer === null) {
        assert.equal(res.data.previewable, false)
        assert.equal(res.data.url, undefined, '不支持预览时不能给地址 —— 那会变成一个"点了没反应"的按钮')
        assert.equal(res.data.viewer, null)
        assert.equal(res.data.message, '此文件类型暂不支持在线预览，请下载查看。')
        // 文件列表里也要带上同样的话，界面直接用，不自己拼文案
        const list = await teacher.get(`/api/resources/${id}/files`)
        assert.equal(
          list.data.items[0].previewMessage,
          '此文件类型暂不支持在线预览，请下载查看。',
        )
      } else {
        assert.equal(res.data.previewable, true)
        assert.equal(res.data.viewer, fixture.viewer)
        assert.equal(typeof res.data.url, 'string')
        assert.equal(res.data.expiresInSeconds > 0, true)
      }
    })
  }
})

describe('类型由服务端决定（§36）', () => {
  test('PDF 预览：Content-Type 是 application/pdf，inline，带 nosniff', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const res = await teacher.get(`/api/resources/${id}/files/${file.id}/preview`)
    const raw = await fetchSigned(res.data.url)
    assert.equal(raw.status, 200)
    assert.equal(raw.headers.get('content-type'), 'application/pdf')
    assert.equal(raw.headers.get('content-disposition'), 'inline')
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(raw.headers.get('cache-control'), 'private, no-store, max-age=0')
  })

  test('下载：attachment + 中文文件名（RFC 5987），并声明 no-store', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const res = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const raw = await fetchSigned(res.data.url)
    assert.equal(raw.status, 200)
    const disposition = raw.headers.get('content-disposition') ?? ''
    assert.match(disposition, /^attachment;/)
    assert.match(disposition, /filename\*=UTF-8''%E7%BE%8E%E5%BE%B7%E6%95%99%E6%A1%88\.pdf/, disposition)
    assert.equal(raw.headers.get('cache-control'), 'private, no-store, max-age=0')
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff')
  })

  test('把 HTML 内容命名成 .txt → 以 text/plain 返回（不会被浏览器当网页执行）', async () => {
    const id = await newResource()
    const html = Buffer.from('<!DOCTYPE html><script>alert("xss")</script>', 'utf8')
    const file = await upload(id, FIXTURES.txt, { bytes: html })
    const res = await teacher.get(`/api/resources/${id}/files/${file.id}/preview`)
    assert.equal(res.data.previewable, true)
    assert.equal(res.data.viewer, 'text', 'HTML 内容按纯文本预览 —— viewer 由扩展名决定')
    const raw = await fetchSigned(res.data.url)
    assert.equal(raw.headers.get('content-type'), 'text/plain')
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await raw.text()).includes('<script>'), true, '内容原样给出，但只是文本')
  })

  test('追加查询参数改不掉响应类型（类型只存在于签名里）', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.png)
    const res = await teacher.get(`/api/resources/${id}/files/${file.id}/preview`)
    // 第一版把 type / name / disposition 放在查询参数里，而签名只覆盖 (op, key, exp) ——
    // 于是追加 `&type=text/html` 就能改掉响应头（实测拿到了 `image/png, text/html`）。
    // 现在这些值都在令牌里，查询参数一律不看。
    const raw = await fetchSigned(`${res.data.url}&type=text/html`)
    assert.equal(raw.headers.get('content-type'), 'image/png', '类型不能被 URL 参数改写')
  })

  test('追加查询参数也改不掉下载文件名（Content-Disposition 注入）', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const raw = await fetchSigned(`${dl.data.url}&name=evil.exe&disposition=inline`)
    const disposition = raw.headers.get('content-disposition') ?? ''
    assert.match(disposition, /^attachment;/, '处置方式由签名决定，不能被查询参数改成 inline')
    assert.equal(disposition.includes('evil.exe'), false, `文件名不能被注入：${disposition}`)
    assert.match(disposition, /%E7%BE%8E%E5%BE%B7%E6%95%99%E6%A1%88\.pdf/)
  })

  test('TXT 预览的字节与上传的完全一致', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.txt)
    const res = await teacher.get(`/api/resources/${id}/files/${file.id}/preview`)
    const bytes = Buffer.from(await (await fetchSigned(res.data.url)).arrayBuffer())
    assert.equal(sha256(bytes), sha256(FIXTURES.txt.bytes))
  })
})

describe('地址短命且不可猜（§10 / §11）', () => {
  test(`过了 ${GET_TTL_SECONDS} 秒之后地址失效（403）`, async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    assert.equal((await fetchSigned(dl.data.url)).status, 200, '刚签发时可用')

    await new Promise((r) => setTimeout(r, (GET_TTL_SECONDS + 1) * 1000))
    const late = await fetchSigned(dl.data.url)
    assert.equal(late.status, 403, `过期后必须 403，实际 ${late.status}`)
  })

  test('改一个字符就失效', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const broken = dl.data.url.replace('token=', 'token=X')
    assert.notEqual(broken, dl.data.url)
    assert.equal((await fetchSigned(broken)).status, 403)
  })

  test('把 key 换成另一个对象 → 403（签名覆盖了 key）', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const other = await upload(id, FIXTURES.png)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const swapped = dl.data.url.replace(
      encodeURIComponent(file.storageKey),
      encodeURIComponent(other.storageKey),
    )
    assert.notEqual(swapped, dl.data.url, '替换应当真的改掉了地址')
    assert.equal((await fetchSigned(swapped)).status, 403)
  })

  test('完全不带签名 → 403（本地驱动的数据面也不是公开目录）', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const res = await fetch(`${TEST_BASE}/api/storage/local?key=${encodeURIComponent(file.storageKey)}`)
    assert.equal(res.status, 403)
  })

  test('签名地址本身就是凭证：不带 cookie 也能下载（与 S3 行为一致）', async () => {
    // 这是**有意**的设计：浏览器直传/直下时不走会话 cookie，安全完全由签名保证。
    // 把它写成用例，是为了防止有人"顺手"给数据面加上鉴权，
    // 那会让 S3 驱动的行为与本地驱动分叉。
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const raw = await fetchSigned(dl.data.url) // 裸 fetch，没有任何 cookie
    assert.equal(raw.status, 200)
    assert.equal(sha256(Buffer.from(await raw.arrayBuffer())), sha256(FIXTURES.pdf.bytes))
  })
})

describe('失败路径要诚实（§20）', () => {
  test('对象被外部删掉之后下载 → 404 + 可读说明（不是 500）', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    const dl = await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    // 绕过接口直接删对象（模拟运维事故 / 存储侧数据损坏）
    rmSync(join(testStorageDir(), file.storageKey), { force: true })

    const raw = await fetchSigned(dl.data.url)
    assert.equal(raw.status, 404, `对象没了应当 404，实际 ${raw.status}`)
    const body = await raw.text()
    assert.match(body, /FILE_NOT_FOUND|文件已不存在/)
  })

  test('下载写审计（谁下了哪个文件）', async () => {
    const id = await newResource()
    const file = await upload(id, FIXTURES.pdf)
    await teacher.get(`/api/resources/${id}/files/${file.id}/download`)
    const rows = await withSql(async (sql) => {
      return sql`
        SELECT action, result FROM audit_logs
        WHERE target_type = 'file' AND target_id = ${file.id} AND action = 'resource.download'
      `
    })
    assert.equal(rows.length >= 1, true, '下载必须留痕（监管要求）')
    assert.equal(rows[0].result, 'success')
  })
})
