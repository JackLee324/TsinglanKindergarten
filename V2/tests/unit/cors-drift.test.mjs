/**
 * tests/unit/cors-drift.test.mjs —— 桶 CORS 与当前部署域名的一致性规则
 * ============================================================================
 * 这组用例锁死的是 2026-10-12 那次线上上传故障的判断逻辑：
 *   教师平台换了域名，桶的 CORS 还停在旧域名上，而当时的自检**看不出来**
 *   （旧域名既不是通配符、也不为空）。
 *
 * 这里全是**纯函数**：不连桶、不需要凭据、不产生任何副作用。
 * 真正"脚本会不会以非零退出码结束"由 cors-drift-check.test.mjs 用真桶验证。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUIRED_ALLOWED_HEADERS,
  REQUIRED_METHODS,
  evaluateBucketCors,
  normalizeOrigin,
  normalizeOriginList,
} from '../../scripts/lib/cors-drift.mjs'

const NEW_ORIGIN = 'https://tsinglanteachers.zeabur.app'
const OLD_ORIGIN = 'https://tsinglan.zeabur.app'

/** 一份"完全合规"的策略；各用例只改需要出问题的那一处。 */
function policy(overrides = {}) {
  return {
    CORSRules: [
      {
        AllowedOrigins: [NEW_ORIGIN],
        AllowedMethods: [...REQUIRED_METHODS],
        AllowedHeaders: [...REQUIRED_ALLOWED_HEADERS],
        ExposeHeaders: ['ETag', 'x-amz-checksum-sha256'],
        MaxAgeSeconds: 3600,
        ...overrides,
      },
    ],
  }
}

describe('Origin 规范化（按 Origin 语义，不做宽松化）', () => {
  test('协议与主机大小写归一', () => {
    assert.equal(normalizeOrigin('HTTPS://TsinglanTeachers.Zeabur.APP'), NEW_ORIGIN)
    assert.equal(normalizeOrigin('https://TSINGLANTEACHERS.zeabur.app'), NEW_ORIGIN)
  })

  test('末尾路径分隔符不改变 Origin；任意路径都不改变', () => {
    assert.equal(normalizeOrigin(`${NEW_ORIGIN}/`), NEW_ORIGIN)
    assert.equal(normalizeOrigin(`${NEW_ORIGIN}/login`), NEW_ORIGIN, '--base 给的可能是带路径的部署地址')
    assert.equal(normalizeOrigin(`${NEW_ORIGIN}/a/b?x=1#y`), NEW_ORIGIN)
  })

  test('默认端口省略（443 与不写是同一个 Origin）', () => {
    assert.equal(normalizeOrigin(`${NEW_ORIGIN}:443`), NEW_ORIGIN)
  })

  test('不同协议 / 不同主机 / 不同非默认端口 **不是** 同一个 Origin', () => {
    assert.notEqual(normalizeOrigin('http://tsinglanteachers.zeabur.app'), NEW_ORIGIN, '协议不同')
    assert.notEqual(normalizeOrigin('https://tsinglanteachers.zeabur.com'), NEW_ORIGIN, '主机不同')
    assert.notEqual(normalizeOrigin('https://tsinglanteachers.zeabur.app:8443'), NEW_ORIGIN, '端口不同')
    assert.notEqual(normalizeOrigin('https://other.tsinglanteachers.zeabur.app'), NEW_ORIGIN, '子域不同')
  })

  test('不是合法 http(s) 地址的一律拒绝（通配符也在内）', () => {
    for (const bad of ['', '   ', '*', 'tsinglanteachers.zeabur.app', 'ftp://a.com', 'javascript:alert(1)', null, undefined]) {
      assert.equal(normalizeOrigin(bad), null, `${String(bad)} 不该被当成 Origin`)
    }
  })

  test('normalizeOriginList 去重并挑出非法项', () => {
    const { origins, invalid } = normalizeOriginList([
      NEW_ORIGIN,
      `${NEW_ORIGIN}/`,
      '',
      '*',
    ])
    assert.deepEqual(origins, [NEW_ORIGIN])
    assert.deepEqual(invalid, ['', '*'])
  })
})

describe('桶 CORS 一致性判断', () => {
  test('① 期望的新域名在 AllowedOrigins 里 → 通过', () => {
    const r = evaluateBucketCors(policy(), [NEW_ORIGIN])
    assert.equal(r.ok, true, r.problems.join('; '))
    assert.deepEqual(r.problems, [])
    assert.deepEqual(r.missingOrigins, [])
  })

  test('② 只有旧域名、期望是新域名 → 必须失败', () => {
    const r = evaluateBucketCors(policy({ AllowedOrigins: [OLD_ORIGIN] }), [NEW_ORIGIN])
    assert.equal(r.ok, false, '旧域名存在不代表新域名已授权')
    assert.deepEqual(r.missingOrigins, [NEW_ORIGIN])
    assert.deepEqual(r.unauthorizedOrigins, [OLD_ORIGIN])
  })

  test('③ 只有通配符 → 必须失败', () => {
    const r = evaluateBucketCors(policy({ AllowedOrigins: ['*'] }), [NEW_ORIGIN])
    assert.equal(r.ok, false)
    assert.equal(r.wildcard, true)
    assert.match(r.problems.join(' '), /通配符/)
    assert.deepEqual(r.missingOrigins, [NEW_ORIGIN])
  })

  test('④ 协议不同 → 必须失败', () => {
    const r = evaluateBucketCors(policy({ AllowedOrigins: ['http://tsinglanteachers.zeabur.app'] }), [NEW_ORIGIN])
    assert.equal(r.ok, false)
    assert.deepEqual(r.missingOrigins, [NEW_ORIGIN], 'https 与 http 不是同一个 Origin')
  })

  test('⑤ 主机不同 → 必须失败', () => {
    const r = evaluateBucketCors(policy({ AllowedOrigins: ['https://tsinglan.zeabur.app'] }), [NEW_ORIGIN])
    assert.equal(r.ok, false)
    assert.deepEqual(r.missingOrigins, [NEW_ORIGIN])
  })

  test('⑥ 端口不同 → 必须失败', () => {
    const r = evaluateBucketCors(policy({ AllowedOrigins: [`${NEW_ORIGIN}:8443`] }), [NEW_ORIGIN])
    assert.equal(r.ok, false)
    assert.deepEqual(r.missingOrigins, [NEW_ORIGIN])
  })

  test('⑦ 缺少期望 Origin 时不能静默通过（空策略 / 空 origin）', () => {
    for (const bad of [
      { CORSRules: [] },
      {},
      null,
      { CORSRules: [{ AllowedMethods: REQUIRED_METHODS, AllowedHeaders: REQUIRED_ALLOWED_HEADERS }] },
      policy({ AllowedOrigins: [] }),
    ]) {
      const r = evaluateBucketCors(bad, [NEW_ORIGIN])
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 不该判过`)
      assert.ok(r.problems.length > 0, '必须给出原因')
    }
  })

  test('⑧ PUT 不在 AllowedMethods 里 → 必须失败', () => {
    const r = evaluateBucketCors(policy({ AllowedMethods: ['GET', 'HEAD'] }), [NEW_ORIGIN])
    assert.equal(r.ok, false)
    assert.deepEqual(r.missingMethods, ['PUT'])
    assert.match(r.problems.join(' '), /PUT/)
  })

  test('⑧b GET / HEAD 缺失也失败（预览与下载要用）', () => {
    const r = evaluateBucketCors(policy({ AllowedMethods: ['PUT'] }), [NEW_ORIGIN])
    assert.equal(r.ok, false)
    assert.deepEqual(r.missingMethods, ['GET', 'HEAD'])
  })

  test('⑧c 预签名会带的请求头缺失也失败', () => {
    const r = evaluateBucketCors(policy({ AllowedHeaders: ['content-type'] }), [NEW_ORIGIN])
    assert.equal(r.ok, false)
    assert.deepEqual(r.missingHeaders, ['x-amz-checksum-sha256', 'x-amz-date', 'authorization'])
  })

  test('⑧d 方法/头的大小写不影响判断', () => {
    const r = evaluateBucketCors(
      policy({ AllowedMethods: ['put', 'get', 'head'], AllowedHeaders: ['Content-Type', 'AUTHORIZATION', 'X-Amz-Date', 'X-Amz-Checksum-Sha256'] }),
      [NEW_ORIGIN],
    )
    assert.equal(r.ok, true, r.problems.join('; '))
  })

  test('⑨ 多个合法 Origin：期望的那个被允许、其余策略合法 → 通过', () => {
    const r = evaluateBucketCors(
      policy({ AllowedOrigins: [NEW_ORIGIN, 'https://staging.example.com'] }),
      [NEW_ORIGIN],
    )
    assert.equal(r.ok, true, r.problems.join('; '))
    // 期望之外的来源只报告、不判失败 —— 它可能仍被别的环境在用。
    assert.deepEqual(r.unauthorizedOrigins, ['https://staging.example.com'])
  })

  test('⑨b 期望多个 Origin 时，必须**每一个**都在列表里', () => {
    const r = evaluateBucketCors(
      policy({ AllowedOrigins: [NEW_ORIGIN, 'https://staging.example.com'] }),
      [NEW_ORIGIN, 'https://admin.example.com'],
    )
    assert.equal(r.ok, false)
    assert.deepEqual(r.missingOrigins, ['https://admin.example.com'])
  })

  test('期望列表为空时不会"因为没什么可查"而判过', () => {
    // 这一条是给调用方的护栏：check-storage.mjs 在没有期望 Origin 时
    // 必须先报 BLOCKED 而不是走到这里当成通过。
    const r = evaluateBucketCors(policy(), [])
    assert.equal(r.missingOrigins.length, 0)
    assert.equal(r.expected.length, 0, '调用方必须自己拦住"没有期望值"这种情况')
  })
})
