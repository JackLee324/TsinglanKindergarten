import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { PurgeScheduler } from './purge.scheduler';

@Module({
  controllers: [ResourcesController],
  // PurgeScheduler 只负责"到期清理"这一件事：启动时跑一次 + 之后按周期跑（§18）。
  // 以前 purgeExpiredResources() 没有任何调用者，回收站到期资源永远不会被清掉。
  providers: [ResourcesService, PurgeScheduler],
  exports: [ResourcesService],
})
export class ResourcesModule {}
