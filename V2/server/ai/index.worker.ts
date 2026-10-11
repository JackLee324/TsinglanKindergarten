/**
 * server/ai/index.worker.ts —— 索引 worker（应用内定时轮询）
 * ============================================================================
 * 业主 Stage 15 §八：索引必须**独立于上传请求异步执行**。
 * 这里就是那个"后台"，不做任何队列中间件（不引入新基础设施）：
 * 进程内定时器 + 数据库任务表（`ai_index_jobs`，带 `FOR UPDATE SKIP LOCKED`）。
 *
 * 三条设计取舍（写清楚，免得以后被当成疏忽）：
 *   · **单实例有效**：多实例部署时每个实例各跑一个 worker，靠 `SKIP LOCKED` 不重复处理，
 *     但"整点同时开工"的峰值会叠加 —— 当前 v2-app 是单实例，够用；
 *   · **不阻塞启动**：worker 在 `onModuleInit` 之后异步开跑，任何异常只记日志；
 *   · **可关闭**：`AI_INDEX_ENABLED=0` 时完全不启动（AI 关掉时索引也不该偷偷跑）。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { AiIndexService } from './index.service'

@Injectable()
export class AiIndexWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AiIndexWorker')
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly index: AiIndexService) {}

  onModuleInit(): void {
    const raw = String(process.env.AI_INDEX_ENABLED ?? '').trim().toLowerCase()
    if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
      this.logger.log('索引 worker 未启用（AI_INDEX_ENABLED=0）')
      return
    }
    const interval = Math.max(1000, Number(process.env.AI_INDEX_INTERVAL_MS ?? 15000) || 15000)
    this.timer = setInterval(() => void this.tick(), interval)
    // 不因为这个定时器让进程无法退出
    this.timer.unref?.()
    this.logger.log(`索引 worker 已启动：每 ${Math.round(interval / 1000)} 秒处理一批`)
    // 启动后先跑一轮，部署完不必等一个周期
    void this.tick()
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** 跑一批。重入保护：上一轮没结束就跳过本轮。 */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const result = await this.index.runOnce()
      if (result.claimed > 0) {
        this.logger.log(
          `索引一批：领取 ${result.claimed}，完成 ${result.done}，跳过 ${result.skipped}，待重试 ${result.retried}，失败 ${result.failed}`,
        )
      }
    } catch (error) {
      this.logger.warn(`索引 worker 本轮出错（下一轮继续）：${(error as Error).message}`)
    } finally {
      this.running = false
    }
  }
}
