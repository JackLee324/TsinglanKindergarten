import { Controller, Get, Query, ForbiddenException } from '@nestjs/common';
import { AuditService } from './audit.service';
import type {
  AuditLogListResponse,
  AuditAction,
  RoleCode,
} from '@shared/api.interface';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';

@Controller('api/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('logs')
  async getLogs(
    @CurrentTeacher() teacher: { id: string; roles: RoleCode[] },
    @Query('action') action?: string,
    @Query('teacherId') teacherId?: string,
    @Query('program') program?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AuditLogListResponse> {
    if (!teacher.roles.includes('principal')) {
      throw new ForbiddenException('只有园长可以查看审计日志');
    }

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
