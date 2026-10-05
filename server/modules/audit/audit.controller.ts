import { Controller, Get, Header, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import type { AuditAction, AuditLogListParams, AuditLogListResponse } from '@shared/api.interface';
import { RequirePermission } from '@server/modules/authz/permission.decorator';

@Controller('api/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Audit log query.
   *
   * Before this change the check was an inline
   * `if (!teacher.roles.includes('principal')) throw ...` — a hard-coded role
   * test that `curriculum_director` could never be given access to without a code
   * change, and that was invisible to anyone reading the route table. It is now a
   * declarative permission, so granting audit access to another role is a data
   * change (permission override / role default), not a code change.
   *
   * The permission is enforced by PermissionGuard; the database-level guards from
   * migration 0003 remain the backstop for privilege MUTATIONS.
   */
  @Get('logs')
  @RequirePermission('audit.view')
  async getLogs(
    @Query('action') action?: string,
    @Query('teacherId') teacherId?: string,
    @Query('program') program?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AuditLogListResponse> {
    return this.auditService.getLogs({
      action: action as AuditAction | undefined,
      teacherId,
      program,
      startDate,
      endDate,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  /**
   * 导出审计日志为 CSV 文件（§19）。
   *
   * 权限刻意用 `audit.export`（highRisk）而不是 `audit.view`：能把整份日志带成文件的人，
   * 与能在页面里翻看的人，不是同一档能力。
   */
  @Get('logs/export')
  @RequirePermission('audit.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audit-logs.csv"')
  async exportLogs(
    @Query() query: AuditLogListParams & { startDate?: string; endDate?: string },
  ): Promise<string> {
    return this.auditService.exportCsv(query);
  }
}
