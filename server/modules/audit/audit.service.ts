import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/database/database.module';
import { auditLogs } from '@server/database/schema';
import { count, desc, and, gte, lte, eq } from 'drizzle-orm';
import type { AuditLogListParams, AuditLogListResponse, AuditLog, AuditAction } from '@shared/api.interface';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async getLogs(params: AuditLogListParams & { startDate?: string; endDate?: string }): Promise<AuditLogListResponse> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    if (params.action) conditions.push(eq(auditLogs.action, params.action));
    if (params.teacherId) conditions.push(eq(auditLogs.teacherId, params.teacherId));
    if (params.program) conditions.push(eq(auditLogs.program, params.program));
    if (params.startDate) conditions.push(gte(auditLogs.createdAt, new Date(params.startDate)));
    if (params.endDate) {
      const end = new Date(params.endDate);
      end.setHours(23, 59, 59, 999);
      conditions.push(lte(auditLogs.createdAt, end));
    }

    try {
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [totalResult, items] = await Promise.all([
        this.db
          .select({ count: count() })
          .from(auditLogs)
          .where(whereClause),
        this.db
          .select()
          .from(auditLogs)
          .where(whereClause)
          .orderBy(desc(auditLogs.createdAt))
          .limit(pageSize)
          .offset(offset),
      ]);

      const total = totalResult[0]?.count ?? 0;

      return {
        items: items.map((item) => this.mapToAuditLog(item)),
        total,
        page,
        pageSize,
      };
    } catch (error) {
      this.logger.error('获取审计日志失败', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  private mapToAuditLog(row: typeof auditLogs.$inferSelect): AuditLog {
    return {
      id: row.id,
      action: row.action as AuditAction,
      wecomUserId: row.wecomUserId ?? undefined,
      teacherId: row.teacherId ?? undefined,
      teacherName: row.teacherName ?? undefined,
      ipAddress: row.ipAddress ?? undefined,
      resourceId: row.resourceId ?? undefined,
      resourceTitle: row.resourceTitle ?? undefined,
      program: row.program ?? undefined,
      subject: row.subject ?? undefined,
      detail: row.detail ?? undefined,
      success: row.success,
      errorMessage: row.errorMessage ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
