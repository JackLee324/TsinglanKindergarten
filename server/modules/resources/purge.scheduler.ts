import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ResourcesService } from './resources.service';

/**
 * 回收站到期清理的**调度器**（§18）。
 *
 * 为什么需要它
 * ------------
 * `ResourcesService.purgeExpiredResources()` 早就实现了（按 `purgeAfter <= now` 找行 →
 * 删库 → 写审计），但**全仓没有任何调用者**：`grep -rn purgeExpiredResources server/`
 * 只匹配到它自己的定义与日志字符串。也就是说"资源到期后会被永久删除"这件事
 * **从来不会发生** —— 回收站只会越积越多。
 *
 * 为什么不用 @nestjs/schedule
 * --------------------------
 * 没有装这个依赖，而这个需求本质就是"每隔一段时间跑一次、且重复执行安全"。本仓库的部署
 * 形态是**单实例**（见生产报告附录 B3），所以一个进程内定时器就够，不值得为此加依赖。
 * （若将来要多副本，正确做法不是加 cron，而是给清理加分布式锁或改成独立的 job runner —— 
 * 多个副本同时清理会打架。这一点写在这里，避免以后有人以为"再多起一个副本就行"。）
 *
 * 安全性质
 *   * 幂等：`purgeExpiredResources` 只处理到期行，重复运行不会误删；没有到期行时是一次空查。
 *   * 不阻塞启动：启动后的首次清理是 fire-and-forget，失败只记日志，绝不因此拒绝启动
 *     —— 清理失败不该让整个平台起不来。
 *   * 不重叠：用 `running` 标志防止上一轮未结束就开下一轮（大批量删除时可能超过一个周期）。
 *   * 可关闭：`PURGE_SCHEDULER=off` 关闭；周期用 `PURGE_SWEEP_INTERVAL_MINUTES` 调整。
 */
@Injectable()
export class PurgeScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PurgeScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly resources: ResourcesService) {}

  private get disabled(): boolean {
    return (process.env.PURGE_SCHEDULER ?? '').trim().toLowerCase() === 'off';
  }

  private get intervalMs(): number {
    const raw = Number(process.env.PURGE_SWEEP_INTERVAL_MINUTES ?? '60');
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : 60;
    return minutes * 60 * 1000;
  }

  onApplicationBootstrap(): void {
    if (this.disabled) {
      this.logger.log('回收站到期清理调度器已关闭（PURGE_SCHEDULER=off）');
      return;
    }
    // 启动后跑一次：部署重启后不必等一个完整周期才清理。
    void this.sweep('bootstrap');
    this.timer = setInterval(() => void this.sweep('interval'), this.intervalMs);
    // 不因为这个定时器而阻止进程退出（优雅关闭时还会显式 clear，这里是第二道保险）。
    this.timer.unref?.();
    this.logger.log(
      `回收站到期清理调度器已启动：每 ${this.intervalMs / 60000} 分钟一次` +
        '（PURGE_SCHEDULER=off 可关闭）',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 跑一轮清理。**永不抛异常**：调度线程里的异常会让 Node 进程退出，
   * 而"清理失败"绝不能升级成"平台挂掉"。
   */
  async sweep(trigger: 'bootstrap' | 'interval' | 'manual'): Promise<void> {
    if (this.running) {
      this.logger.warn(`上一轮清理尚未结束，跳过本轮（trigger=${trigger}）`);
      return;
    }
    this.running = true;
    try {
      const result = await this.resources.purgeExpiredResources(new Date(), {});
      if (result.purged > 0) {
        this.logger.log(
          `回收站到期清理完成（trigger=${trigger}）：永久删除 ${result.purged} 条资源 ` +
            `[${result.resourceIds.join(', ')}]`,
        );
      } else {
        this.logger.log(`回收站到期清理完成（trigger=${trigger}）：没有到期资源`);
      }
    } catch (error) {
      // 可追踪：把 trigger 与错误一起打出来。单条资源删除失败已在 service 内部逐条记录，
      // 这里兜住的是更上层（例如数据库不可达）的失败。
      this.logger.error(
        `回收站到期清理失败（trigger=${trigger}）：${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
