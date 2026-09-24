import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditLoggerService } from './audit-logger.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditLoggerService],
  exports: [AuditLoggerService],
})
export class AuditModule {}
