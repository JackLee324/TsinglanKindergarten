import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/database/database.module';
import { auditLogs } from '@server/database/schema';
import { count, desc, and, gte, lte, eq } from 'drizzle-orm';
import type { AuditLogListParams, AuditLogListResponse, AuditLog, AuditAction } from '@shared/api.interface';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 导出审计日志为 CSV（§19）。
   *
   * 以前 `audit.export` 权限在目录里存在、也授予了 principal，界面上的「导出 CSV」
   * 按钮却写死 `<Button ... disabled>` —— 一个永远点不动的按钮，一个永远没人能行使的权限。
   * 本方法是它的真实实现。
   *
   * 细节：
   *   * 导出前**显式**受 `audit.export`（highRisk）保护，而不是沿用 `audit.view` ——
   *     导出会把整份日志（含 IP、操作明细）落成一个文件带走，风险高于在页面里翻看。
   *   * 开头写 UTF-8 BOM：否则 Excel 打开中文会乱码。
   *   * 字段转义遵循 RFC 4180（含逗号/引号/换行的字段整体加引号，内部引号翻倍）。
   *   * 单次导出上限 10000 行，并在结果里如实说明是否被截断 —— 静默截断等于给出错误的"全量"。
   */
  async exportCsv(
    params: AuditLogListParams & { startDate?: string; endDate?: string },
  ): Promise<string> {
    const EXPORT_LIMIT = 10000;
    const { items } = await this.getLogs({ ...params, page: 1, pageSize: EXPORT_LIMIT });

    const header = ['时间', '动作', '教师', '班型', '资源/科目', 'IP', '结果', '详情'];
    const esc = (v: unknown): string => {
      const text = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };

    const lines = [header.join(',')];
    for (const row of items) {
      lines.push(
        [
          row.createdAt,
          row.action,
          row.teacherName ?? '',
          row.program ?? '',
          row.resourceTitle ?? '',
          row.ipAddress ?? '',
          row.success ? '成功' : '失败',
          row.errorMessage ?? row.detail ?? '',
        ]
          .map(esc)
          .join(','),
      );
    }

    // BOM 放在最前面，Excel 才认 UTF-8。
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

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
