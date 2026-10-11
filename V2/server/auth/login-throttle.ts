/**
 * server/auth/login-throttle.ts —— 登录**失败**限流（应用自己出）
 * ============================================================================
 * 为什么必须在应用里做（2026-10-11 实测发现）：
 *
 *   限流以前**只**在演练栈的 Nginx 上（`limit_req_zone ... rate=${LOGIN_RATE_LIMIT_RPM}r/m`）。
 *   Zeabur 上没有 Nginx，于是正式环境**完全没有暴力破解防护**；
 *   项目自己的部署自检 `deploy/verify.mjs` 第 7 项（连续错口令 → 429）必然失败
 *   —— 实测：本机以生产配置连打 10 次错口令，得到 `401×10`，没有 429。
 *   而集成测试里甚至钉着一条"V2 没有实现限流"，正是这件事的化石。
 *
 * 三个刻意的设计决定：
 *
 * ① **只数失败，不数成功**。
 *    成功登录不消耗配额 —— 否则"老师一天里登几次"和"运维脚本/验收套件反复登录"
 *    都会把自己锁在门外。这也与业界惯例一致：要拦的是**猜口令**，不是登录本身。
 *    代价是"用正确口令打流量"不受限 —— 那不是暴力破解，另有别的层（QPS/连接数）。
 *
 * ② **默认只在生产开启**（`NODE_ENV=production` → 5 次/分钟、突发 3）。
 *    非生产环境默认关闭：集成测试与浏览器验收会合法地反复登录（同一 IP、同一账号），
 *    在生产策略下会把测试自己挡在门外，而那不是产品缺陷。
 *    两个方向都能用环境变量显式覆盖：`LOGIN_RATE_LIMIT_RPM` / `LOGIN_RATE_LIMIT_BURST`
 *    （0 = 关闭，也可以在非生产环境打开来验证限流本身）。
 *
 * ③ **令牌桶，按客户端 IP**（`req.ip`，配合 `TRUST_PROXY=1` 才拿到真实来源）。
 *    内存实现，**单实例有效**。多实例部署时每个实例各算一份配额 ——
 *    这条限制写在这里，不假装它不存在：真要横向扩容，需要换成共享存储
 *    （Redis / 数据库计数器）；当前 v2-app 是单实例。
 */
import type { Request, RequestHandler, Response } from 'express'

export interface LoginThrottleLimits {
  /** 每分钟补充的失败配额；0 = 关闭限流。 */
  readonly rpm: number
  /** 桶容量：短时间内允许的连续失败次数。 */
  readonly burst: number
}

export const LOGIN_THROTTLE_MESSAGE = '登录尝试过于频繁，请稍后再试。'

/**
 * 解析限流参数。
 *
 * 生产默认 5/分钟、突发 3；非生产默认关闭。显式给了环境变量就听环境变量的
 * （`0` 表示明确关闭），非法值回落到默认，不静默变成"无限"。
 */
export function resolveLoginThrottleLimits(
  env: Record<string, string | undefined> = process.env,
  isProduction = false,
): LoginThrottleLimits {
  const readNumber = (raw: string | undefined, fallback: number): number => {
    const text = String(raw ?? '').trim()
    if (text === '') return fallback
    const value = Number(text)
    if (!Number.isFinite(value) || value < 0) return fallback
    return Math.floor(value)
  }
  const rpm = readNumber(env.LOGIN_RATE_LIMIT_RPM, isProduction ? 5 : 0)
  const burst = readNumber(env.LOGIN_RATE_LIMIT_BURST, isProduction ? 3 : 0)
  if (rpm === 0 || burst === 0) return { rpm: 0, burst: 0 }
  return { rpm, burst: Math.max(1, burst) }
}

/**
 * 限流判定结果。
 *
 * 刻意用 `blocked`（是否已被限流）而不是 `allowed`：限流说的不是"你有没有权限"，
 * 而是"这个来源现在还能不能再试"。命名上就别和**授权**混在一起 ——
 * 项目里有一条守卫（`tests/unit/route-declarations.test.mjs`）专门盯
 * `allowed: true` 这种硬编码放行，那是授权的事；限流不该长得像它。
 */
export interface LoginThrottleVerdict {
  readonly blocked: boolean
  readonly retryAfterSeconds: number
}

export interface LoginThrottle {
  readonly enabled: boolean
  readonly limits: LoginThrottleLimits
  /** 这个来源现在还能不能尝试登录（blocked=true 就是要回 429）。 */
  check(key: string, at?: number): LoginThrottleVerdict
  /** 记一次失败：消耗一个令牌。 */
  recordFailure(key: string, at?: number): void
  /** 登录成功：清掉这个来源的失败记录。 */
  recordSuccess(key: string): void
  /** 当前在跟踪的来源数量（测试与运维观察用）。 */
  size(): number
}

export function createLoginThrottle(
  limits: LoginThrottleLimits,
  now: () => number = Date.now,
): LoginThrottle {
  const capacity = limits.burst
  const refillPerMs = limits.rpm / 60_000
  const buckets = new Map<string, { tokens: number; updatedAt: number }>()
  const enabled = limits.rpm > 0 && limits.burst > 0

  const refill = (bucket: { tokens: number; updatedAt: number }, at: number): void => {
    const elapsed = Math.max(0, at - bucket.updatedAt)
    // 长期没人再碰的来源：整体补满即可（不做无界增长）
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs)
    bucket.updatedAt = at
  }

  return {
    enabled,
    limits,
    check(key, at = now()) {
      if (!enabled) return { blocked: false, retryAfterSeconds: 0 }
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: at }
      refill(bucket, at)
      buckets.set(key, bucket)
      if (bucket.tokens >= 1) return { blocked: false, retryAfterSeconds: 0 }
      const waitMs = (1 - bucket.tokens) / refillPerMs
      return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
    },
    recordFailure(key, at = now()) {
      if (!enabled) return
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: at }
      refill(bucket, at)
      bucket.tokens = Math.max(0, bucket.tokens - 1)
      buckets.set(key, bucket)
    },
    recordSuccess(key) {
      buckets.delete(key)
    },
    size: () => buckets.size,
  }
}

/** 一个请求的来源标识：优先 `req.ip`（配 TRUST_PROXY 才是真实 IP）。 */
export function clientKeyOf(req: Request): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? ''
  return ip === '' ? 'unknown' : ip
}

/**
 * 挂到 `POST /api/auth/login` 上的中间件。
 *
 * 顺序：先判"还能不能试"，能试就放行并在响应结束时按**结果**记账
 * （4xx 记失败、2xx 清空记录）。这样 429 只会在**已经失败够多次**之后出现，
 * 正常登录永远不会被自己的历史成功记录挡住。
 */
export function loginThrottleMiddleware(throttle: LoginThrottle): RequestHandler {
  if (!throttle.enabled) {
    return (_req: Request, _res: Response, next) => next()
  }
  return (req, res, next) => {
    const key = clientKeyOf(req)
    const verdict = throttle.check(key)
    if (verdict.blocked) {
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds))
      res.status(429).json({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
        message: LOGIN_THROTTLE_MESSAGE,
      })
      return
    }
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500) throttle.recordFailure(key)
      else if (res.statusCode < 300) throttle.recordSuccess(key)
    })
    next()
  }
}
