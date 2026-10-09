/**
 * tests/unit/r2-inventory-safety.test.mjs —— 生产对象清单工具的**安全边界**
 * ============================================================================
 * 业主 Stage 13C §3 的原话：**未核实以前，不删除或覆盖任何生产对象**。
 * 这条要求不能只写在文档里 —— 工具本身必须是只读的，而且这条边界要**被测试盯着**：
 *
 *   ① 源码里**不许出现**任何写/删动作（PutObject / DeleteObject / CopyObject /
 *      DeleteObjects / PutBucketPolicy …）—— 静态扫描，改坏了立刻红；
 *   ② 缺配置就退出（不猜默认桶），且退出信息里**不含**凭证；
 *   ③ 控制台导出（CSV/JSON）解析出来的清单形状正确；
 *   ④ 摘要（对象数 / 总字节 / 前缀分布）算得对。
 *
 * ⚠️ 第 ① 条是"静态"检查：它拦的是"以后有人顺手加一个 --delete"这种改动，
 *    不是运行时行为。运行时的只读由"只调用 List/Head"来保证。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInventoryArtifact, isLoopbackHost, resolveR2Config, summarizeObjects } from '../../scripts/lib/r2-target.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SOURCE = readFileSync(join(ROOT, 'scripts', 'r2-inventory.mjs'), 'utf8')

describe('① 只读：源码里不许有任何写/删动作', () => {
  test('没有 Put / Delete / Copy / 策略类调用', () => {
    const forbidden = [
      'PutObjectCommand',
      'DeleteObjectCommand',
      'DeleteObjectsCommand',
      'CopyObjectCommand',
      'PutBucketPolicyCommand',
      'DeleteBucketCommand',
      'CreateBucketCommand',
      'PutBucketCorsCommand',
      'PutBucketLifecycleConfigurationCommand',
    ]
    for (const name of forbidden) {
      assert.equal(SOURCE.includes(name), false, `只读工具里出现了写操作：${name}`)
    }
  })

  test('只导入 List / Head 两个动作', () => {
    const imports = SOURCE.match(/import \{([^}]*)\} from '@aws-sdk\/client-s3'/)
    assert.ok(imports, '要能从 @aws-sdk/client-s3 导入')
    const names = imports[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
    assert.deepEqual(names.sort(), ['HeadBucketCommand', 'ListObjectsV2Command', 'S3Client'], names.join('、'))
  })

  test('产物里没有任何凭证字段（直接断言构造出来的对象）', () => {
    const artifact = buildInventoryArtifact({
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'ListObjectsV2 endpoint=acct.r2.cloudflarestorage.com bucket=b',
      objects: [{ key: 'uploads/a/1.png', size: 10, etag: 'abc', lastModified: '2026-01-01' }],
      scope: { method: 'api-list', endpointHost: 'acct.r2.cloudflarestorage.com', bucket: 'b', prefix: '' },
      completeness: { complete: true, reason: 'listed-all-pages' },
    })
    // 顶层字段是**枚举式**断言：多一个字段就要人来确认它写的是什么（防止以后混进凭证）
    assert.deepEqual(Object.keys(artifact).sort(), [
      'compare',
      'complete',
      'completeness',
      'generatedAt',
      'objects',
      'readOnly',
      'scope',
      'source',
      'summary',
    ])
    // 完整性字段是**枚举式**断言：以后多写一个字段就要人来确认它写的是什么
    // （尤其是"操作者声明"与"工具验证"必须分开——报告里不能把两者混为一谈）
    assert.deepEqual(Object.keys(artifact.completeness).sort(), [
      'complete',
      'declaredBy',
      'expectSource',
      'expectedCount',
      'explanation',
      'observedCount',
      'reason',
      'usableForProductionComparison',
      'verification',
    ])
    assert.deepEqual(Object.keys(artifact.scope).sort(), [
      'bucket',
      'endpointHost',
      'method',
      'prefix',
      'prefixFilterApplied',
    ])
    assert.deepEqual(Object.keys(artifact.objects[0]).sort(), ['etag', 'key', 'lastModified', 'size'])
    const text = JSON.stringify(artifact)
    for (const secret of ['secretAccessKey', 'accessKeyId', 'SECRET', 'AKIA']) {
      assert.equal(text.includes(secret), false, `产物里不该出现 ${secret}`)
    }
    assert.equal(artifact.readOnly, true, '产物要自带"这是只读清单"的标记')
  })
})

describe('② 缺配置就退出（不猜桶、不回显凭证）', () => {
  test('四个变量都缺 → 逐条列出缺什么，且理由里没有凭证形状的内容', () => {
    const out = resolveR2Config({})
    assert.equal(out.ok, false)
    for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      assert.match(out.reason, new RegExp(name), `要说清缺 ${name}`)
    }
    assert.equal(/:\/\/[^\s@/]+:[^\s@/]+@/.test(out.reason), false, '理由里不该出现带口令的连接串')
  })

  test('只缺桶名时也拒绝（不猜默认桶）', () => {
    const out = resolveR2Config({
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'AK',
      R2_SECRET_ACCESS_KEY: 'SK',
    })
    assert.equal(out.ok, false)
    assert.match(out.reason, /R2_BUCKET/)
  })

  test('配齐时给出脱敏 endpoint（只有主机名）', () => {
    const out = resolveR2Config({
      R2_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
      R2_BUCKET: 'tsinglan-curriculum',
      R2_ACCESS_KEY_ID: 'AK',
      R2_SECRET_ACCESS_KEY: 'SK',
    })
    assert.equal(out.ok, true)
    assert.equal(out.redactedEndpoint, 'acct123.r2.cloudflarestorage.com')
    assert.equal(out.bucket, 'tsinglan-curriculum')
  })

  test('非 http(s) 端点被拒', () => {
    const out = resolveR2Config({
      R2_ENDPOINT: 'ftp://x',
      R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'AK',
      R2_SECRET_ACCESS_KEY: 'SK',
    })
    assert.equal(out.ok, false)
    assert.match(out.reason, /http/)
  })
})

describe('②bis 端点安全：默认只允许 HTTPS（业主 Stage 13C.1 §一）', () => {
  const base = { R2_BUCKET: 'tsinglan-curriculum', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK' }

  test('http:// 默认被拒（凭证不许明文发送），并说清怎么开本地开关', () => {
    const out = resolveR2Config({ ...base, R2_ENDPOINT: 'http://127.0.0.1:18443' })
    assert.equal(out.ok, false)
    assert.match(out.reason, /必须是 https/)
    assert.match(out.reason, /--allow-http-local/, '要告诉操作者本地模拟器怎么开')
    assert.equal(out.reason.includes('AK'), false, '理由里不能出现 Access Key')
  })

  test('即使开了 --allow-http-local，**远端** http 仍然被拒', () => {
    for (const host of ['evil.example.com', 'acct123.r2.cloudflarestorage.com', '10.0.0.5', '0.0.0.0']) {
      const out = resolveR2Config({ ...base, R2_ENDPOINT: `http://${host}` }, { allowInsecureLocal: true })
      assert.equal(out.ok, false, `${host} 不该被放行`)
      assert.match(out.reason, /本机/)
    }
  })

  test('本地模拟器：显式开关 + 本机地址才放行，并标记 insecureLocal', () => {
    for (const host of ['127.0.0.1:18443', 'localhost:18443', '[::1]:18443']) {
      const out = resolveR2Config({ ...base, R2_ENDPOINT: `http://${host}` }, { allowInsecureLocal: true })
      assert.equal(out.ok, true, `${host} 应当放行`)
      assert.equal(out.insecureLocal, true)
    }
  })

  test('https 永远放行（含远端），且不标记 insecureLocal', () => {
    const out = resolveR2Config({ ...base, R2_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com' })
    assert.equal(out.ok, true)
    assert.equal(out.insecureLocal, false)
  })

  test('其它协议一律拒绝', () => {
    for (const url of ['ftp://x/y', 'file:///etc/passwd', 's3://bucket']) {
      const out = resolveR2Config({ ...base, R2_ENDPOINT: url })
      assert.equal(out.ok, false, url)
      assert.match(out.reason, /http\(s\)/)
    }
  })

  test('isLoopbackHost：只认真正的本机写法', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'x.localhost', '::1']) {
      assert.equal(isLoopbackHost(host), true, host)
    }
    for (const host of ['0.0.0.0', '10.0.0.1', 'example.com', 'localhost.evil.com', '']) {
      assert.equal(isLoopbackHost(host), false, host)
    }
  })
})

describe('③ 摘要计算', () => {
  test('对象数 / 总字节 / 前缀分布', () => {
    const summary = summarizeObjects([
      { key: 'uploads/a/1.png', size: 100 },
      { key: 'uploads/a/2.png', size: 200 },
      { key: 'uploads/b/3.pdf', size: 300 },
      { key: 'top.txt', size: 7 },
    ])
    assert.equal(summary.count, 4)
    assert.equal(summary.totalBytes, 607)
    assert.deepEqual(summary.prefixes[0], { prefix: 'uploads', count: 3 })
    assert.deepEqual(
      summary.prefixes.find((p) => p.prefix === '(根目录)'),
      { prefix: '(根目录)', count: 1 },
    )
  })

  test('空桶不炸', () => {
    const summary = summarizeObjects([])
    assert.equal(summary.count, 0)
    assert.equal(summary.totalBytes, 0)
    assert.deepEqual(summary.prefixes, [])
  })
})
