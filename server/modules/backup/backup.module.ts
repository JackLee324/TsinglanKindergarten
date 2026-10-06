import { Module } from '@nestjs/common';

import { AuditModule } from '@server/modules/audit/audit.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/**
 * 备份/导出模块。只有一条路由（`POST /api/admin/data-export`），
 * 见 `BackupService` 的说明：它是在拿到 `pg_dump` 通路之前的兜底，
 * 不是 pg_dump 的替代品。
 */
@Module({
  imports: [AuditModule],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
