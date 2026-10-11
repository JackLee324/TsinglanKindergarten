/**
 * server/ai/ai-rate-limit.ts —— AI 提问的用户级限流与并发闸门
 * ============================================================================
 * 业主 Stage 15 §四.6 / §四.7：要有限流、并发上限与成本监控，
 * "避免循环请求造成意外费用"。前端一个 bug（重复提交、无限重试）就足以烧钱，
 * 所以闸门放在**服务端**。
 *
 * 与登录失败限流的区别：那个只数失败；这里数的是**每一次模型调用**（成功也算），
 * 因为花钱的是调用本身。内存实现、单实例有效 —— 与索引 worker 同一条已知限制。
 */
import { AiProviderError } from './ai.types'

interface Bucket {
  tokens: number
  updatedAt: number
}

export class AiRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private active = 0

  constructor(
    private readonly perMinute: number,
    private readonly maxConcurrent: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 取一个配额；拿不到就抛 429 语义的错误。 */
  acquire(userId: string): void {
    const at = this.now()
    const bucket = this.buckets.get(userId) ?? { tokens: this.perMinute, updatedAt: at }
    const refillPerMs = this.perMinute / 60_000
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + Math.max(0, at - bucket.updatedAt) * refillPerMs)
    bucket.updatedAt = at
    this.buckets.set(userId, bucket)
    if (bucket.tokens < 1) {
      throw new AiProviderError('rate_limited', `提问过于频繁（每分钟最多 ${this.perMinute} 次），请稍后再试`)
    }
    bucket.tokens -= 1
  }

  /** 进并发闸门；超出上限直接拒绝（不排队 —— 排队会让前端以为"卡住了"）。 */
  enter(): () => void {
    if (this.active >= this.maxConcurrent) {
      throw new AiProviderError('rate_limited', `同时进行的提问过多（上限 ${this.maxConcurrent}），请稍后再试`)
    }
    this.active += 1
    let released = false
    return () => {
      if (!released) {
        released = true
        this.active = Math.max(0, this.active - 1)
      }
    }
  }

  get activeCount(): number {
    return this.active
  }
}
