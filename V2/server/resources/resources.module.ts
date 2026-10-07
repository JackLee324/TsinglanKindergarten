import { Module } from '@nestjs/common'
import { DirectoriesModule } from '../directories/directories.module'
import { ResourcesController } from './resources.controller'
import { ResourcesService } from './resources.service'
import { FilesController } from '../files/files.controller'
import { FilesService } from '../files/files.service'

@Module({
  imports: [DirectoriesModule],
  controllers: [ResourcesController, FilesController],
  providers: [ResourcesService, FilesService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
