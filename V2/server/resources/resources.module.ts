import { Module } from '@nestjs/common'
import { ResourcesController } from './resources.controller'
import { ResourcesService } from './resources.service'
import { FilesController } from '../files/files.controller'
import { FilesService } from '../files/files.service'

@Module({
  controllers: [ResourcesController, FilesController],
  providers: [ResourcesService, FilesService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
