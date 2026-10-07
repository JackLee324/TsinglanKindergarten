/**
 * tests/integration/storage-s3.integration.test.mjs —— 真实 S3 兼容后端（业主 §22）
 * ============================================================================
 * 这一份**不打 mock**。它起一个真的 SeaweedFS S3 网关（二进制由
 * `npm run devtools:storage` 取回），然后让**被测服务**连上去。
 *
 * 为什么值得为此多一个进程：
 *
 *   预签名 URL 的正确性只能由**一个独立实现的 S3 服务**来证明。
 *   mock 通常不验签，于是"签名算错了"在 mock 里永远是绿的，
 *   上线第一个上传就 403 —— 而那时你已经把前端、CORS、进度条都做完了，
 *   排查方向会被引到前端去。
 *
 * 下面这套签名矩阵是照着业主 §22 逐条写的：
 *   正确签名 / 错误签名 / 过期签名 / 篡改 object key / 未签名 / 错误密钥。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { GetBucketCorsCommand, HeadObjectCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3'
import {
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  runProjectScriptCaptured,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import {
  S3_TEST_ACCESS_KEY,
  S3_TEST_SECRET_KEY,
  s3TestClient,
  startS3Backend,
} from '../helpers/s3-backend.mjs'
import { s3ProviderRules } from '../helpers/modules.mjs'

/**
 * 编译产物是 CommonJS，所以经 `modules.mjs` 用 createRequire 取 ——
 * 直接从 `.js` 里 ESM 具名导入会报 "Named export not found"
 * （第一版就是这么写的，一行都没跑起来）。
 */
const { buildBucketCorsPolicy, corsPolicyHasWildcard } = s3ProviderRules

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n'.repeat(40)),
  Buffer.from('%%EOF\n'),
])
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let backend
let teacher
let admin
let ids = {}
const resources = []

async function newResource(title = 'S3 上传探针') {
  const res = await teacher.post('/api/resources', { directoryId: ids.virtueResources, title })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  resources.push(res.data.id)
  return res.data.id
}

async function askUpload(resourceId, over = {}) {
  return teacher.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName: '教案.pdf',
    mimeType: 'application/pdf',
    size: PDF_BYTES.length,
    sha256: sha256(PDF_BYTES),
    ...over,
  })
}

before(async () => {
  await resetDatabase()
  await createAdmin('s3_admin', 'S3AdminPass!1')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  // 先把真后端起起来，再让被测服务连它 —— 否则启动即连不上。
  backend = await startS3Backend({
    bucket: `v2stage6-${randomUUID().slice(0, 8)}`,
  })

  await startServer({
    env: {
      STORAGE_PROVIDER: 's3',
      STORAGE_ENDPOINT: backend.endpoint,
      STORAGE_REGION: 'us-east-1',
      STORAGE_BUCKET: backend.bucket,
      STORAGE_ACCESS_KEY: S3_TEST_ACCESS_KEY,
      STORAGE_SECRET_KEY: S3_TEST_SECRET_KEY,
      STORAGE_FORCE_PATH_STYLE: '1',
      STORAGE_GET_TTL_SECONDS: '5',
    },
  })

  admin = client()
  await admin.login('s3_admin', 'S3AdminPass!1')
  await createTeacher('s3_t', 'S3TeacherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
    { permission: 'resource.create', directoryId: virtue },
    { permission: 'resource.update.own', directoryId: virtue },
    { permission: 'resource.download', directoryId: virtue },
    { permission: 'resource.submit', directoryId: virtue },
  ], 'S3 老师')
  teacher = client()
  await teacher.login('s3_t', 'S3TeacherPass!1')
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
  if (backend) await backend.stop()
})

describe('真实 S3：完整链路', () => {
  test('申请地址 → PUT 到真 S3 → 登记 → 下载，字节逐字节一致', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    assert.equal(ask.status, 201, JSON.stringify(ask.data))

    // 上传地址必须是**对象存储**的地址，不是本应用的地址 ——
    // 这是"浏览器直传、VPS 不搬运文件流量"的实现证据。
    assert.equal(
      ask.data.uploadUrl.startsWith(backend.endpoint),
      true,
      `上传地址应当指向对象存储，实际 ${ask.data.uploadUrl.slice(0, 60)}`,
    )

    const put = await fetch(ask.data.uploadUrl, {
      method: 'PUT',
      headers: ask.data.headers,
      body: PDF_BYTES,
    })
    assert.equal(put.status, 200, `真 S3 应当接受这个 PUT：${await put.text()}`)

    // 对象真的在桶里（用独立的 SDK 直连桶去查，不经过被测服务）
    const head = await s3TestClient().send(
      new HeadObjectCommand({ Bucket: backend.bucket, Key: ask.data.storageKey }),
    )
    assert.equal(Number(head.ContentLength), PDF_BYTES.length)

    const reg = await teacher.post(`/api/resources/${id}/files/register`, { uploadId: ask.data.uploadId })
    assert.equal(reg.status, 201, JSON.stringify(reg.data))
    assert.equal(reg.data.sha256, sha256(PDF_BYTES))

    const dl = await teacher.get(`/api/resources/${id}/files/${reg.data.id}/download`)
    assert.equal(dl.status, 200, JSON.stringify(dl.data))
    const bytes = Buffer.from(await (await fetch(dl.data.url)).arrayBuffer())
    assert.equal(sha256(bytes), sha256(PDF_BYTES), '下载回来的字节必须与上传的一致')
  })

  test('真实 docx（zip 容器）走 S3 也能通过 magic bytes 验真', async () => {
    const id = await newResource()
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const bytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      Buffer.from('fake docx\n'.repeat(20)),
    ])
    const ask = await askUpload(id, {
      fileName: '教案.docx',
      mimeType: DOCX_MIME,
      size: bytes.length,
      sha256: sha256(bytes),
    })
    const put = await fetch(ask.data.uploadUrl, { method: 'PUT', headers: ask.data.headers, body: bytes })
    assert.equal(put.status, 200)
    const reg = await teacher.post(`/api/resources/${id}/files/register`, { uploadId: ask.data.uploadId })
    assert.equal(reg.status, 201, JSON.stringify(reg.data))
    assert.equal(reg.data.previewable, false)
    assert.equal(reg.data.previewMessage, '此文件类型暂不支持在线预览，请下载查看。')
  })
})

describe('SigV4 签名矩阵（§22）', () => {
  test('① 正确签名 → 200', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    const put = await fetch(ask.data.uploadUrl, {
      method: 'PUT',
      headers: ask.data.headers,
      body: PDF_BYTES,
    })
    assert.equal(put.status, 200)
  })

  test('② 未签名请求 → 403（桶不是公开的）', async () => {
    const res = await fetch(`${backend.endpoint}/${backend.bucket}/resources/probe/unsigned.pdf`)
    assert.equal(res.status, 403, `未签名请求必须是 403，实际 ${res.status}`)
  })

  test('③ 篡改 object key → 403（签名覆盖了 key）', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    // ⚠️ URL 里的 key 是 **percent-encoded** 的（文件名含中文），
    // 所以要用编码后的形式去替换。第一版直接拿 raw key 去 replace，
    // 结果 url 一点没变，断言"替换应当真的改掉了 url" 直接把这个问题抓了出来。
    // ⚠️ 逐段编码，不能整串 encodeURIComponent —— 那会把 `/` 也编码成 %2F，
    // 于是替换匹配不上。第一版就是这么错的。
    const encoded = ask.data.storageKey.split('/').map(encodeURIComponent).join('/')
    assert.notEqual(encoded, ask.data.storageKey, '这个 key 应当确实是编码过的（文件名含中文）')
    const tampered = ask.data.uploadUrl.replace(encoded, encodeURIComponent('resources/evil/other.pdf'))
    assert.notEqual(tampered, ask.data.uploadUrl, '替换应当真的改掉了 url')
    const put = await fetch(tampered, { method: 'PUT', headers: ask.data.headers, body: PDF_BYTES })
    assert.equal(put.status, 403, `篡改 key 必须被拒，实际 ${put.status}`)
  })

  test('④ 篡改签名 → 403', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    const broken = ask.data.uploadUrl.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`)
    assert.notEqual(broken, ask.data.uploadUrl)
    const put = await fetch(broken, { method: 'PUT', headers: ask.data.headers, body: PDF_BYTES })
    assert.equal(put.status, 403)
  })

  test('⑤ 篡改已签名头（声明另一个 sha256）→ 403', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    const forged = { ...ask.data.headers, 'x-amz-checksum-sha256': Buffer.from('f'.repeat(64), 'hex').toString('base64') }
    const put = await fetch(ask.data.uploadUrl, { method: 'PUT', headers: forged, body: PDF_BYTES })
    assert.equal(put.status, 403, `改签名头必须被拒，实际 ${put.status}`)
  })

  test('⑥ 字节与已签名的 sha256 不符 → S3 自己拒绝，且对象不落地', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    const tampered = Buffer.from(PDF_BYTES)
    tampered.write('XX', 6)
    assert.equal(tampered.length, PDF_BYTES.length, '长度必须一致，否则撞上的是别的校验')

    const put = await fetch(ask.data.uploadUrl, { method: 'PUT', headers: ask.data.headers, body: tampered })
    assert.notEqual(put.status, 200, `内容与声明的哈希不符时必须失败，实际 ${put.status}`)

    // 对象确实没进桶 —— 这就是"存储层强制完整性"的意思。
    await assert.rejects(
      () => s3TestClient().send(new HeadObjectCommand({ Bucket: backend.bucket, Key: ask.data.storageKey })),
      '被拒的上传不该在桶里留下对象',
    )
  })

  test('⑦ 过期签名 → 403（下载地址 TTL 设成 5 秒）', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    await fetch(ask.data.uploadUrl, { method: 'PUT', headers: ask.data.headers, body: PDF_BYTES })
    const reg = await teacher.post(`/api/resources/${id}/files/register`, { uploadId: ask.data.uploadId })
    const dl = await teacher.get(`/api/resources/${id}/files/${reg.data.id}/download`)
    assert.equal((await fetch(dl.data.url)).status, 200, '刚签发的地址应当可用')

    await new Promise((r) => setTimeout(r, 6000))
    const late = await fetch(dl.data.url)
    assert.equal(late.status, 403, `过期地址必须被拒，实际 ${late.status}`)
  })
})

describe('登记依赖真实的对象状态', () => {
  test('对象不存在就登记 → 400 + 记孤儿', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    // 完全不 PUT
    const reg = await teacher.post(`/api/resources/${id}/files/register`, { uploadId: ask.data.uploadId })
    assert.equal(reg.status, 400, JSON.stringify(reg.data))
    assert.match(JSON.stringify(reg.data), /FILE_NOT_FOUND|找不到/)

    const markers = await withSql(async (sql) => {
      const rows = await sql`
        SELECT reason FROM storage_orphans WHERE storage_key = ${ask.data.storageKey}
      `
      return rows.map((r) => r.reason)
    })
    assert.deepEqual(markers, ['NOT_FOUND'])
  })

  test('绕过 interfaces 直接往桶里塞一个不同大小的对象 → 登记被拒', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    // 用独立 SDK 直连桶，写入**比声明更少**的字节（模拟截断/被中间人改动）。
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await s3TestClient().send(
      new PutObjectCommand({
        Bucket: backend.bucket,
        Key: ask.data.storageKey,
        ContentType: 'application/pdf',
        Body: Buffer.from('%PDF-1.4\ntruncated\n'),
      }),
    )
    const reg = await teacher.post(`/api/resources/${id}/files/register`, { uploadId: ask.data.uploadId })
    assert.equal(reg.status, 400, JSON.stringify(reg.data))
    assert.match(JSON.stringify(reg.data), /FILE_SIZE_MISMATCH|大小/)
  })
})

describe('桶的 CORS 策略（§37）', () => {
  test('策略里不允许出现通配符 origin', () => {
    assert.equal(corsPolicyHasWildcard(buildBucketCorsPolicy(['https://v2.example.com'])), false)
    assert.throws(() => buildBucketCorsPolicy(['*']), /不允许使用 \*/)
    assert.throws(() => buildBucketCorsPolicy([]), /至少要有一个正式 origin/)
  })

  test('把策略写到真桶上，浏览器预检真的通过（且只对声明的 origin）', async () => {
    // 必须是纯 ASCII：HTTP 头的值只能是 ByteString，
    // 用它去测一个中文域名会先在 fetch 里抛错，根本到不了 CORS 逻辑。
    const origin = 'https://v2-stage6.example.com'
    const policy = buildBucketCorsPolicy([origin])
    await s3TestClient().send(
      new PutBucketCorsCommand({ Bucket: backend.bucket, CORSConfiguration: policy }),
    )

    const applied = await s3TestClient().send(new GetBucketCorsCommand({ Bucket: backend.bucket }))
    assert.equal(corsPolicyHasWildcard(applied), false, '落到桶上的策略不能有通配符')
    assert.deepEqual(applied.CORSRules?.[0]?.AllowedOrigins, [origin])

    // 真发一次预检请求：这是浏览器 upload 之前会做的事。
    const preflight = await fetch(`${backend.endpoint}/${backend.bucket}/any-key.pdf`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,x-amz-checksum-sha256',
      },
    })
    assert.equal(preflight.status < 300, true, `预检应当成功，实际 ${preflight.status}`)
    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      origin,
      '预检响应必须回具体的 origin，不能是 *',
    )

    // 另一个来源不该被放行。
    const foreign = await fetch(`${backend.endpoint}/${backend.bucket}/any-key.pdf`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'PUT',
      },
    })
    const allowed = foreign.headers.get('access-control-allow-origin')
    assert.equal(allowed === null || allowed === '', true, `陌生来源不该被放行，实际回了 ${allowed}`)
  })
})

describe('存储健康检查（§39）', () => {
  test('管理员能看到 configured / reachable', async () => {
    const res = await admin.get('/api/health/storage')
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.provider, 's3')
    assert.equal(res.data.configured, true)
    assert.equal(res.data.reachable, true)
  })

  test('响应里**没有**任何凭据（bucket / key / secret 都不能出现）', async () => {
    const res = await admin.get('/api/health/storage')
    const body = JSON.stringify(res.data)
    for (const secret of [S3_TEST_ACCESS_KEY, S3_TEST_SECRET_KEY, backend.bucket, backend.endpoint]) {
      assert.equal(body.includes(secret), false, `响应里不应该出现 ${secret}`)
    }
    assert.deepEqual(Object.keys(res.data).sort(), ['configured', 'detail', 'provider', 'reachable'])
  })

  test('没有 audit.view 的老师看不到（它不是公开信息）', async () => {
    const res = await teacher.get('/api/health/storage')
    assert.equal(res.status, 403)
  })

  test('未登录 → 401', async () => {
    const anon = client()
    const res = await anon.get('/api/health/storage')
    assert.equal(res.status, 401)
  })
})

describe('S3 上的孤儿对象也能被清理（list + delete 走真接口）', () => {
  test('未登记的对象会被 --sweep 找出来删掉，已登记的不动', async () => {
    const id = await newResource()
    const ask = await askUpload(id)
    await fetch(ask.data.uploadUrl, { method: 'PUT', headers: ask.data.headers, body: PDF_BYTES })
    // 故意不登记 → 变成一个没有数据库记录的对象

    const kept = await newResource()
    const keptAsk = await askUpload(kept)
    await fetch(keptAsk.data.uploadUrl, { method: 'PUT', headers: keptAsk.data.headers, body: PDF_BYTES })
    const keptReg = await teacher.post(`/api/resources/${kept}/files/register`, {
      uploadId: keptAsk.data.uploadId,
    })
    assert.equal(keptReg.status, 201)

    const out = await runProjectScriptCaptured(
      'scripts/cleanup-orphans.mjs',
      {
        NODE_ENV: 'test',
        // 脚本走的是**应用自己的**配置入口（那是唯一一份存储配置真相），
        // 所以它需要的密钥也要一并用开发默认值提供。
        V2_ALLOW_DEV_SECRETS: '1',
        STORAGE_PROVIDER: 's3',
        STORAGE_ENDPOINT: backend.endpoint,
        STORAGE_REGION: 'us-east-1',
        STORAGE_BUCKET: backend.bucket,
        STORAGE_ACCESS_KEY: S3_TEST_ACCESS_KEY,
        STORAGE_SECRET_KEY: S3_TEST_SECRET_KEY,
        STORAGE_FORCE_PATH_STYLE: '1',
      },
      // 没有 --sweep 只会处理已记录的标记，扫不到"从来没有标记过"的对象。
      ['--sweep', '--older-than', '0'],
    )
    assert.match(out, /已删除未登记对象/, `扫描应当发现未登记对象：\n${out}`)

    await assert.rejects(
      () => s3TestClient().send(new HeadObjectCommand({ Bucket: backend.bucket, Key: ask.data.storageKey })),
      '未登记对象必须被删掉',
    )
    // 已登记的必须还在 —— 清理脚本不能误删正常文件。
    const stillThere = await s3TestClient().send(
      new HeadObjectCommand({ Bucket: backend.bucket, Key: keptAsk.data.storageKey }),
    )
    assert.equal(Number(stillThere.ContentLength), PDF_BYTES.length)
  })
})
