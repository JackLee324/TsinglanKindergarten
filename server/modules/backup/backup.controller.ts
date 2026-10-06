import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuditLoggerService } from '@server/modules/audit/audit-logger.service';
import { RequireSuperAdmin } from '@server/modules/authz/permission.decorator';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import { BackupService } from './backup.service';

/**
 * POST /api/admin/data-export —— 全量逻辑导出（见 BackupService 的说明）。
 *
 * 为什么是 **POST** 而不是 GET：这个应用对**变更型**请求做 CSRF 校验
 * （`csrf-check.middleware.ts`：GET 不在校验范围内）。一次全库导出会把
 * 每一张表的内容吐出来，把它放在受 CSRF 保护的方法上更稳妥 ——
 * 否则一个被诱导的 GET（图片标签、链接预取）就可能触发导出。
 *
 * 三重闸：
 *   1. `@RequireSuperAdmin()` —— 不是"有某个权限"，而是**只有 super_admin**。
 *      导出等于整库读取，它是这个系统里权限最高的一类操作；
 *   2. 全局 AuthGuard 的强制 MFA 与密码变更闸同样适用（本路由没有 @MfaExempt）；
 *   3. 每次导出都写审计（`data_export`），含操作者、IP、表数与行数 ——
 *      "谁在什么时候把整库拉走了"必须可查。
 */
@Controller('api/admin')
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  private getIp(req: Request): string | undefined {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
    return req.ip || undefined;
  }

  @Post('data-export')
  @RequireSuperAdmin()
  async export(
    @CurrentTeacher() teacher: { id: string; name: string },
    @Req() req: Request,
    @Res() res: Response,
    // body 允许为空对象；用 @Body() 是为了让它参与 CSRF 校验的整条链路。
    @Body() _body?: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.backupService.exportLogicalDump();

    await this.auditLogger.log('data_export', {
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress: this.getIp(req),
      success: true,
      detail:
        `逻辑导出：database=${result.database}，${result.tables} 张表 / ${result.rows} 行。` +
        '注意：这不是 pg_dump 归档，不含 roles/授权、RLS 策略、索引、触发器、序列、WAL。',
    });

    res
      .status(200)
      .type('application/x-ndjson; charset=utf-8')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="qls-logical-${new Date().toISOString().slice(0, 10)}.ndjson"`,
      )
      .send(result.ndjson);
  }
}
