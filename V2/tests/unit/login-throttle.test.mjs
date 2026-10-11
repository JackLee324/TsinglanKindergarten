/**
 * tests/unit/login-throttle.test.mjs —— 登录**失败**限流的三条契约
 * ============================================================================
 * 2026-10-11 实测发现的缺口：限流以前只在演练栈的 Nginx 上，正式环境（Zeabur）
 * 没有 Nginx —— 连打 10 次错口令全是 401，`deploy/verify.mjs` 第 7 项必然失败。
 *
 * 搬进应用时定了三条规矩，这份测试逐条钉住：
 *   ① **只数失败**：成功登录不消耗配额（否则验收套件与运维脚本会把自己锁在门外）；
 *   ② **默认只在生产开启**（5 次/分钟、突发 3），两个方向都能用环境变量覆盖，
 *      非法值回落到默认而**不是**静默变成"无限"；
 *   ③ 令牌桶按来源 IP：桶空 → 429 + Retry-After，随时间恢复。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { loginThrottle } from '../helpers/modules.mjs'

const { resolveLoginThrottleLimits, createLoginThrottle, loginThrottleMiddleware, clientKeyOf } =
  loginThrottle

describe('① 默认策略：生产开启、非生产关闭', () => {
  test('生产默认 5 次/分钟、突发 3', () => {
    assert.deepEqual(resolveLoginThrottleLimits({}, true), { rpm: 5, burst: 3 })
  })

  test('非生产默认关闭（集成测试与浏览器验收会合法地反复登录）', () => {
    assert.deepEqual(resolveLoginThrottleLimits({}, false), { rpm: 0, burst: 0 })
  })

  test('环境变量两个方向都能覆盖；0 = 明确关闭', () => {
    assert.deepEqual(
      resolveLoginThrottleLimits({ LOGIN_RATE_LIMIT_RPM: '20', LOGIN_RATE_LIMIT_BURST: '8' }, false),
      { rpm: 20, burst: 8 },
    )
    assert.deepEqual(
      resolveLoginThrottleLimits({ LOGIN_RATE_LIMIT_RPM: '0' }, true),
      { rpm: 0, burst: 0 },
      '生产里显式写 0 也要能关掉',
    )
    assert.deepEqual(
      resolveLoginThrottleLimits({ LOGIN_RATE_LIMIT_RPM: '5', LOGIN_RATE_LIMIT_BURST: '0' }, true),
      { rpm: 0, burst: 0 },
    )
  })

  test('非法值回落到默认 —— 绝不静默变成"没有限制"', () => {
    for (const bad of ['abc', '-1', 'NaN', '1.5e999']) {
      const limits = resolveLoginThrottleLimits({ LOGIN_RATE_LIMIT_RPM: bad }, true)
      assert.equal(limits.rpm, 5, `${bad} 应当回落到生产默认值，而不是关闭限流`)
    }
    // 小数向下取整，不会出现"0.5 次/分钟"这种没法执行的配额
    assert.equal(resolveLoginThrottleLimits({ LOGIN_RATE_LIMIT_RPM: '2.9' }, true).rpm, 2)
  })
})

describe('② 令牌桶：连续失败到阈值 → 429，随时间恢复', () => {
  let clock = 0
  const now = () => clock
  const make = (limits = { rpm: 5, burst: 3 }) => createLoginThrottle(limits, now)

  test('突发 3：前 3 次失败放行，第 4 次开始拒绝并给出 Retry-After', () => {
    clock = 0
    const throttle = make()
    for (let i = 0; i < 3; i += 1) {
      assert.equal(throttle.check('1.2.3.4').blocked, false, `第 ${i + 1} 次失败应当还在配额内`)
      throttle.recordFailure('1.2.3.4')
    }
    const verdict = throttle.check('1.2.3.4')
    assert.equal(verdict.blocked, true, '配额用尽后必须拒绝')
    assert.equal(verdict.retryAfterSeconds >= 1, true, '要给 Retry-After（秒）')
  })

  test('等满一个补充周期后恢复（5 次/分钟 → 12 秒补 1 个）', () => {
    clock = 0
    const throttle = make()
    for (let i = 0; i < 3; i += 1) throttle.recordFailure('9.9.9.9')
    assert.equal(throttle.check('9.9.9.9').blocked, true)
    clock = 12_000
    assert.equal(throttle.check('9.9.9.9').blocked, false, '12 秒后应当补回一个令牌')
  })

  test('不同来源互不影响，成功登录清掉记录', () => {
    clock = 0
    const throttle = make()
    for (let i = 0; i < 3; i += 1) throttle.recordFailure('1.1.1.1')
    assert.equal(throttle.check('1.1.1.1').blocked, true)
    assert.equal(throttle.check('2.2.2.2').blocked, false, '别的 IP 不该被牵连')
    throttle.recordSuccess('1.1.1.1')
    assert.equal(throttle.check('1.1.1.1').blocked, false, '成功登录后应当清空该来源的失败记录')
  })

  test('关闭状态（rpm=0）永远放行，且不记账', () => {
    clock = 0
    const throttle = make({ rpm: 0, burst: 0 })
    assert.equal(throttle.enabled, false)
    for (let i = 0; i < 50; i += 1) throttle.recordFailure('1.2.3.4')
    assert.equal(throttle.check('1.2.3.4').blocked, false)
    assert.equal(throttle.size(), 0, '关闭时不该留下状态')
  })
})

describe('③ 中间件：只对失败计数，成功不消耗配额', () => {
  /** 极简的 Express req/res 假件：只实现中间件真正用到的部分。 */
  const fakeExchange = (ip = '10.0.0.1') => {
    const handlers = {}
    const res = {
      statusCode: 200,
      body: undefined,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        this.body = payload
        return this
      },
      on(event, cb) {
        handlers[event] = cb
      },
      /** 模拟响应结束（Express 会在 finish 事件时触发记账）。 */
      finish(status) {
        this.statusCode = status
        if (handlers.finish) handlers.finish()
      },
    }
    return { req: { ip, socket: {} }, res }
  }

  test('成功的登录永远不消耗配额（连登 20 次都不该被挡）', () => {
    const throttle = createLoginThrottle({ rpm: 5, burst: 3 })
    const middleware = loginThrottleMiddleware(throttle)
    for (let i = 0; i < 20; i += 1) {
      const { req, res } = fakeExchange()
      let nextCalled = false
      middleware(req, res, () => {
        nextCalled = true
      })
      assert.equal(nextCalled, true, `第 ${i + 1} 次登录不该被挡`)
      res.finish(201) // 登录成功
    }
    assert.equal(throttle.size(), 0, '成功不该留下失败记录')
  })

  test('连续失败到阈值后，中间件直接回 429 且不再往下走', () => {
    const throttle = createLoginThrottle({ rpm: 5, burst: 3 })
    const middleware = loginThrottleMiddleware(throttle)
    for (let i = 0; i < 3; i += 1) {
      const { req, res } = fakeExchange()
      middleware(req, res, () => {})
      res.finish(401) // 错口令
    }
    const { req, res } = fakeExchange()
    let nextCalled = false
    middleware(req, res, () => {
      nextCalled = true
    })
    assert.equal(nextCalled, false, '配额用尽后不该继续处理登录')
    assert.equal(res.statusCode, 429)
    assert.equal(res.body.code, 'TOO_MANY_REQUESTS')
    assert.equal(typeof res.body.message, 'string')
    assert.equal(Number(res.headers['Retry-After']) >= 1, true, '要带 Retry-After 头')
  })

  test('关闭时中间件是直通的（不产生任何行为变化）', () => {
    const middleware = loginThrottleMiddleware(createLoginThrottle({ rpm: 0, burst: 0 }))
    const { req, res } = fakeExchange()
    let nextCalled = false
    middleware(req, res, () => {
      nextCalled = true
    })
    assert.equal(nextCalled, true)
    assert.equal(res.statusCode, 200, '不该改写状态码')
  })

  test('来源标识优先用 req.ip（配 TRUST_PROXY 才是真实 IP）', () => {
    assert.equal(clientKeyOf({ ip: '203.0.113.7', socket: {} }), '203.0.113.7')
    assert.equal(clientKeyOf({ ip: undefined, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
    assert.equal(clientKeyOf({ ip: undefined, socket: {} }), 'unknown')
  })
})
