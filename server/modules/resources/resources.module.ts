import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { PurgeScheduler } from './purge.scheduler';
import { AuthzModule } from '@server/modules/authz/authz.module';
import { ObjectStorageModule } from '@server/modules/files/object-storage.module';

@Module({
  // 上传登记必须在写库前知道"本进程有没有对象存储" —— 否则会出现
  // "行里声称有文件、下载却 503"的假成功（见 ObjectStorageModule 的注释）。
  imports: [ObjectStorageModule, AuthzModule],
  controllers: [ResourcesController],
  // PurgeScheduler 只负责"到期清理"这一件事：启动时跑一次 + 之后按周期跑（§18）。
  // 以前 purgeExpiredResources() 没有任何调用者，回收站到期资源永远不会被清掉。
  providers: [ResourcesService, PurgeScheduler],
  exports: [ResourcesService],
})
export class ResourcesModule {}
