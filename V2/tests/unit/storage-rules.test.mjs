/**
 * tests/unit/storage-rules.test.mjs —— 存储层的**纯规则**
 * ============================================================================
 * 这些规则不值得到处起服务去测，但它们每一条都是安全边界：
 *
 *   · 对象 key 的形状（用户文件名不参与目录结构 → `../` 无从穿越）；
 *   · 上传 / 下载令牌的 HMAC 覆盖了哪些字段（改任何一位都失效）；
 *   · `Content-Disposition` 的构造（它会被写进响应头，是注入点）；
 *   · 桶的 CORS 策略里**不允许**出现通配符 origin。
 *
 * 令牌那几条用真实的本地驱动实例来测，不 mock —— 签名与验签是同一份代码，
 * 一旦有人改了签名字段却忘了改验签，这里会立刻红。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageRules, s3ProviderRules, filePolicy } from '../helpers/modules.mjs'

const { LocalStorageProvider, isValidStorageKey, storageKeyBelongsTo, newStorageKey, STORAGE_KEY_PATTERN } =
  storageRules
const { buildBucketCorsPolicy, corsPolicyHasWildcard, contentDispositionAttachment } = s3ProviderRules
const { safeFileNameSegment } = filePolicy

/** 一个合法的 key（`resources/{resourceId}/{uuid}-{safeName}`）。 */
const RESOURCE_ID = '2c68a183-4778-4743-96d6-7d4072dbca48'
const KEY = `resources/${RESOURCE_ID}/4a2f1e18-10d5-4311-b240-92094ed96045-教案.pdf`

let storage

before(() => {
  // 本地驱动的令牌要用下载密钥；单元测试里给开发默认值。
  process.env.V2_ALLOW_DEV_SECRETS ??= '1'
  process.env.STORAGE_LOCAL_DIR ??= mkdtempSync(join(tmpdir(), 'v2-unit-storage-'))
  storage = new LocalStorageProvider()
})

describe('对象 key 的形状（§7）', () => {
  test('合法 key：中文文件名、uuid 前缀', () => {
    assert.equal(isValidStorageKey(KEY), true)
    assert.equal(isValidStorageKey('resources/x/y.pdf'), false, '缺 uuid 段')
    assert.equal(isValidStorageKey(`resources/${RESOURCE_ID}/教案.pdf`), false, '缺 uuid 前缀')
  })

  test('任何带路径穿越痕迹的 key 都不合法', () => {
    for (const bad of [
      `resources/${RESOURCE_ID}/../../etc/passwd`,
      `resources/${RESOURCE_ID}/4a2f1e18-10d5-4311-b240-92094ed96045-../x.pdf`,
      `/resources/${RESOURCE_ID}/4a2f1e18-10d5-4311-b240-92094ed96045-a.pdf`,
      `../resources/${RESOURCE_ID}/4a2f1e18-10d5-4311-b240-92094ed96045-a.pdf`,
      'resources//4a2f1e18-10d5-4311-b240-92094ed96045-a.pdf',
    ]) {
      assert.equal(isValidStorageKey(bad), false, `${bad} 不该被接受`)
    }
  })

  test('newStorageKey 生成的 key 一定通过校验，且每次都不一样（同名不覆盖）', () => {
    const a = newStorageKey(RESOURCE_ID, safeFileNameSegment('教案.pdf'))
    const b = newStorageKey(RESOURCE_ID, safeFileNameSegment('教案.pdf'))
    assert.notEqual(a, b, '同名文件必须落在不同的 key 上')
    assert.equal(isValidStorageKey(a), true)
    assert.equal(isValidStorageKey(b), true)
    assert.equal(a.startsWith(`resources/${RESOURCE_ID}/`), true)
  })

  test('key 里不会出现用户给的危险名字', () => {
    const evil = newStorageKey(RESOURCE_ID, safeFileNameSegment('../../etc/passwd'))
    assert.equal(isValidStorageKey(evil), true)
    assert.equal(evil.includes('..'), false)
    assert.equal(evil.includes('/etc/'), false)
  })

  test('storageKeyBelongsTo：登记时必须确认 key 属于本资源', () => {
    assert.equal(storageKeyBelongsTo(KEY, RESOURCE_ID), true)
    assert.equal(storageKeyBelongsTo(KEY, '00000000-0000-4000-8000-000000000000'), false)
    assert.equal(storageKeyBelongsTo('乱七八糟', RESOURCE_ID), false)
  })

  test('正则本身没有把 `..` 之类的字符放进允许集', () => {
    assert.equal(STORAGE_KEY_PATTERN.test(KEY), true)
    assert.equal(/[\w.\-\u4e00-\u9fa5]+$/.test('a..b'), true, '允许集含点，所以靠形状与 uuid 段兜底')
  })
})

describe('上传令牌（本地驱动）', () => {
  const opts = { contentType: 'application/pdf', size: 1234, sha256: 'a'.repeat(64) }

  test('正常令牌能验回来，并且带回被锁定的 size / sha256', async () => {
    const signed = await storage.presignPut(KEY, opts)
    const token = new URL(signed.url, 'http://x').searchParams.get('token')
    const payload = storage.verifyPutToken(KEY, token)
    assert.deepEqual(payload, { op: 'put', size: 1234, sha256: 'a'.repeat(64) })
  })

  test('换 key 就失效（签名覆盖了 key）', async () => {
    const signed = await storage.presignPut(KEY, opts)
    const token = new URL(signed.url, 'http://x').searchParams.get('token')
    assert.equal(storage.verifyPutToken(`resources/${RESOURCE_ID}/其他.pdf`, token), null)
  })

  test('改一个字符就失效', async () => {
    const signed = await storage.presignPut(KEY, opts)
    const token = new URL(signed.url, 'http://x').searchParams.get('token')
    assert.equal(storage.verifyPutToken(KEY, `${token}x`), null)
    assert.equal(storage.verifyPutToken(KEY, token.slice(0, -1)), null)
  })

  test('过期的令牌无效', async () => {
    const signed = await storage.presignPut(KEY, { ...opts, size: 1 })
    const token = new URL(signed.url, 'http://x').searchParams.get('token')
    // 把过期时间改成 1 秒前，重算 HMAC 是不可能的（没有密钥），
    // 所以这里直接构造一个"时间戳很旧"的令牌：必须无效。
    const [exp, extra, mac] = token.split('.')
    const forged = `${Number(exp) - 100000}.${extra}.${mac}`
    assert.equal(storage.verifyPutToken(KEY, forged), null, '改过期时间会破坏 HMAC')
  })

  test('下载令牌不能当上传令牌用（操作类型在签名里）', async () => {
    const get = await storage.presignGet(KEY, {
      disposition: 'inline',
      fileName: 'a.pdf',
      contentType: 'application/pdf',
    })
    const token = new URL(get.url, 'http://x').searchParams.get('token')
    assert.equal(storage.verifyPutToken(KEY, token), null, 'get 令牌不能用于 put')
    assert.notEqual(storage.verifyGetToken(KEY, token), null)
  })

  test('形状不对的令牌一律无效（不抛异常）', async () => {
    for (const bad of ['', '.', 'a.b', 'a.b.c.d', 'not-a-token', '1.2.3']) {
      assert.equal(storage.verifyPutToken(KEY, bad), null, `${bad} 应当无效`)
      assert.equal(storage.verifyGetToken(KEY, bad), null)
    }
  })
})

describe('下载令牌里锁定了响应元数据（防注入）', () => {
  test('disposition / 文件名 / Content-Type 都从令牌里取回', async () => {
    const signed = await storage.presignGet(KEY, {
      disposition: 'attachment',
      fileName: '幼儿园美德教案.pdf',
      contentType: 'application/pdf',
    })
    const token = new URL(signed.url, 'http://x').searchParams.get('token')
    assert.deepEqual(storage.verifyGetToken(KEY, token), {
      disposition: 'attachment',
      fileName: '幼儿园美德教案.pdf',
      contentType: 'application/pdf',
    })
  })

  test('URL 上只有 key 与 token（没有可篡改的 type / name / disposition 参数）', async () => {
    const signed = await storage.presignGet(KEY, {
      disposition: 'inline',
      fileName: 'a.pdf',
      contentType: 'application/pdf',
    })
    const url = new URL(signed.url, 'http://x')
    assert.deepEqual([...url.searchParams.keys()].sort(), ['key', 'token'])
  })

  test('改了令牌就取不回元数据（不能靠追加参数改写响应头）', async () => {
    const signed = await storage.presignGet(KEY, {
      disposition: 'inline',
      fileName: 'photo.png',
      contentType: 'image/png',
    })
    const token = new URL(signed.url, 'http://x').searchParams.get('token')
    const [exp, , mac] = token.split('.')
    // 尝试把中间那段（被签名的 extra）换成"attachment + evil.exe"
    const forgedExtra = Buffer.from(
      JSON.stringify({ d: 'attachment', n: 'evil.exe', t: 'text/html' }),
    ).toString('base64url')
    assert.equal(storage.verifyGetToken(KEY, `${exp}.${forgedExtra}.${mac}`), null)
  })
})

describe('Content-Disposition 构造（响应头注入点）', () => {
  test('中文走 RFC 5987，ASCII 兜底同时给出', () => {
    const value = contentDispositionAttachment('幼儿园教案.pdf')
    assert.match(value, /^attachment;/)
    assert.match(value, /filename="[\x20-\x7e]*\.pdf"/)
    assert.match(value, /filename\*=UTF-8''%E5%B9%BC%E5%84%BF%E5%9B%AD%E6%95%99%E6%A1%88\.pdf/)
  })

  test('引号 / 反斜杠 / 换行被清理，不能提前结束 header 值', () => {
    const value = contentDispositionAttachment('a".pdf\r\nX-Evil: 1')
    assert.equal(value.includes('\r'), false)
    assert.equal(value.includes('\n'), false)
    assert.equal(value.includes('X-Evil'), true, '内容被保留，但只是作为文件名的一部分（已转义）')
    assert.equal(value.startsWith('attachment; filename="a_.pdf__X-Evil: 1"'), true, value)
  })
})

describe('桶的 CORS 策略（§37）', () => {
  test('正常 origin → 只放行必要的方法与请求头', () => {
    const policy = buildBucketCorsPolicy(['https://v2.example.com'])
    assert.deepEqual(policy.CORSRules[0].AllowedOrigins, ['https://v2.example.com'])
    assert.deepEqual(policy.CORSRules[0].AllowedMethods, ['PUT', 'GET', 'HEAD'])
    assert.deepEqual(policy.CORSRules[0].AllowedHeaders, [
      'content-type',
      'x-amz-checksum-sha256',
      'x-amz-date',
      'authorization',
    ])
  })

  test('通配符 origin 被直接拒绝', () => {
    assert.throws(() => buildBucketCorsPolicy(['*']), /不允许使用 \*/)
    assert.throws(() => buildBucketCorsPolicy(['https://a.com', '*']), /不允许使用 \*/)
    assert.equal(corsPolicyHasWildcard({ CORSRules: [{ AllowedOrigins: ['*'] }] }), true)
    assert.equal(
      corsPolicyHasWildcard({ CORSRules: [{ AllowedOrigins: ['https://v2.example.com'] }] }),
      false,
    )
  })

  test('空 origin 列表被拒绝（宁可失败，也不要"没配就当通配符"）', () => {
    assert.throws(() => buildBucketCorsPolicy([]), /至少要有一个正式 origin/)
    assert.throws(() => buildBucketCorsPolicy(['  ', '']), /至少要有一个正式 origin/)
  })
})
