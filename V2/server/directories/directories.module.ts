import { Module } from '@nestjs/common'
import { DirectoriesController } from './directories.controller'
import { DirectoriesService } from './directories.service'

@Module({
  controllers: [DirectoriesController],
  providers: [DirectoriesService],
  // 导出给 ResourcesModule：资源创建要问"这个目录可用吗"，
  // 而"可用"（自身与祖先都 enabled）的判定只应该有**一份**实现。
  exports: [DirectoriesService],
})
export class DirectoriesModule {}
