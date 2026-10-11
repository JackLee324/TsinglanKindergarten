/**
 * tests/unit/security-headers.test.mjs —— 安全响应头必须由**应用**保证
 * ============================================================================
 * 2026-10-11 实测发现的缺口：这六个头以前只由演练栈的 Nginx 加
 * （`deploy/nginx.conf.template`），而正式环境（Zeabur）是容器直接对外、没有 Nginx
 * —— 结果首页只有 `Content-Type`，项目自己的 `deploy/verify.mjs` 第 4 项必然失败。
 *
 * 这份测试钉住三件事：
 *   ① 六个头一个不少，取值满足 verify.mjs 的判据（HSTS 有 max-age、XCTO 是 nosniff…）；
 *   ② CSP 放行**对象存储的 origin**（浏览器直传上传与 PDF/图片预览都靠它），
 *      而且取不到 origin 时**不能**退化成通配符；
 *   ③ 中间件不覆盖路由已经设过的头（存储下载那条路由自己设 XCTO）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { securityHeaders } from '../helpers/modules.mjs'

const { buildSecurityHeaders, buildContentSecurityPolicy, securityOriginOf, securityHeadersMiddleware } =
  securityHeaders

/** verify.mjs 第 4 项的判据（两处必须一致，所以这里照抄它）。 */
const REQUIRED = [
  ['Strict-Transport-Security', /max-age=\d+/],
  ['X-Content-Type-Options', /nosniff/],
  ['Referrer-Policy', /./],
  ['X-Frame-Options', /SAMEORIGIN|DENY/],
  ['Content-Security-Policy', /default-src/],
  ['Permissions-Policy', /camera=/],
]

describe('① 六个安全响应头齐全且取值正确', () => {
  const headers = buildSecurityHeaders('https://r2.example.com')

  test('verify.mjs 要求的六项全部满足', () => {
    for (const [name, pattern] of REQUIRED) {
      const value = headers[name]
      assert.equal(typeof value, 'string', `缺少响应头 ${name}`)
      assert.match(value, pattern, `${name} 的取值不符合判据：${value}`)
    }
  })

  test('CSP 的具体内容：脚本只允许同源，不允许 unsafe-inline 脚本', () => {
    const csp = headers['Content-Security-Policy']
    assert.match(csp, /default-src 'self'/)
    assert.match(csp, /script-src 'self'/)
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, '不允许给脚本开 unsafe-inline')
    assert.match(csp, /object-src 'none'/)
    assert.match(csp, /frame-ancestors 'self'/)
  })

  test('任何取值里都没有通配符', () => {
    for (const [name, value] of Object.entries(headers)) {
      assert.doesNotMatch(value, /(^|[;\s])\*([;\s]|$)/, `${name} 不该出现通配符：${value}`)
    }
  })
})

describe('② CSP 必须放行对象存储（否则浏览器直传上传必失败）', () => {
  test('给了存储 origin → img-src / frame-src / connect-src 都放行它', () => {
    const csp = buildContentSecurityPolicy('https://acct.r2.cloudflarestorage.com')
    for (const directive of ['img-src', 'frame-src', 'connect-src']) {
      const part = csp.split('; ').find((d) => d.startsWith(directive))
      assert.ok(part, `缺少 ${directive}`)
      assert.ok(
        part.includes('https://acct.r2.cloudflarestorage.com'),
        `${directive} 必须放行存储 origin（浏览器直传/预览）：${part}`,
      )
    }
  })

  test('没有存储 origin → 不放行任何外部域，也绝不退化成通配符', () => {
    const csp = buildContentSecurityPolicy(null)
    assert.doesNotMatch(csp, /\*/, '不能退化成通配符')
    assert.doesNotMatch(csp, /null|undefined/, '不能把 null/undefined 拼进策略里')
    // img-src 保留 data: / blob:（前端本地预览与头像用），这是原策略的一部分；
    // frame-src / connect-src 在没有存储 origin 时必须**只有** 'self'。
    for (const directive of ['img-src', 'frame-src', 'connect-src']) {
      const part = csp.split('; ').find((d) => d.startsWith(directive))
      const expected = directive === 'img-src' ? "img-src 'self' data: blob:" : `${directive} 'self'`
      assert.equal(part, expected, `${directive} 不该出现外部域：${part}`)
    }
  })
})

describe('③ 从配置里取 origin 的规则', () => {
  test('去掉路径、保留端口；非法输入一律 null（不猜、不兜底成通配）', () => {
    assert.equal(securityOriginOf('https://a.example.com'), 'https://a.example.com')
    assert.equal(securityOriginOf('https://a.example.com:8443/x/y'), 'https://a.example.com:8443')
    assert.equal(securityOriginOf('  https://a.example.com  '), 'https://a.example.com')
    for (const bad of ['', '   ', 'not-a-url', 'ftp://a.example.com', 'https://']) {
      assert.equal(securityOriginOf(bad), null, `${JSON.stringify(bad)} 应当取不到 origin`)
    }
  })
})

describe('④ 中间件行为', () => {
  const fakeRes = (existing = {}) => {
    const store = { ...existing }
    return {
      store,
      hasHeader: (n) => Object.prototype.hasOwnProperty.call(store, n.toLowerCase()) || n in store,
      setHeader: (n, v) => {
        store[n] = v
      },
    }
  }

  test('给每个响应加头，并且不动路由已经设过的值', () => {
    const res = fakeRes({ 'X-Content-Type-Options': '路由自己设的值' })
    let called = false
    securityHeadersMiddleware('https://r2.example.com')({}, res, () => {
      called = true
    })
    assert.equal(called, true, '必须放行到下一个中间件')
    assert.equal(res.store['X-Content-Type-Options'], '路由自己设的值', '不该覆盖已有的头')
    assert.equal(res.store['Strict-Transport-Security'].includes('max-age='), true)
    assert.equal(
      String(res.store['Content-Security-Policy']).includes('https://r2.example.com'),
      true,
      'CSP 要放行存储 origin',
    )
  })
})
