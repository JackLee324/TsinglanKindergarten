import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import type { AuditLogListResponse, AuditAction } from '@shared/api.interface';
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
}
