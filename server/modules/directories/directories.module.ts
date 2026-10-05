import { Module } from '@nestjs/common';
import { AuditModule } from '@server/modules/audit/audit.module';
import { DirectoriesController } from './directories.controller';
import { DirectoriesService } from './directories.service';

@Module({
  // AuditLoggerService 由 AuditModule 导出；目录写操作必须留审计痕迹（§26）。
  imports: [AuditModule],
  controllers: [DirectoriesController],
  providers: [DirectoriesService],
  exports: [DirectoriesService],
})
export class DirectoriesModule {}
