import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { auditLogs } from '@server/database/schema';
import type { AuditAction, AuditLog } from '@shared/api.interface';

@Injectable()
export class AuditLoggerService {
  private readonly logger = new Logger(AuditLoggerService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async log(action: AuditAction, data: Partial<AuditLog>): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        action,
        wecomUserId: data.wecomUserId,
        teacherId: data.teacherId,
        teacherName: data.teacherName,
        ipAddress: data.ipAddress,
        resourceId: data.resourceId,
        resourceTitle: data.resourceTitle,
        program: data.program,
        subject: data.subject,
        detail: data.detail,
        success: data.success ?? true,
        errorMessage: data.errorMessage,
      });
    } catch (error) {
      // 审计日志写入失败不影响主流程，仅记录错误
      this.logger.error(`审计日志写入失败: ${action}`, error instanceof Error ? error.stack : String(error));
    }
  }
}
