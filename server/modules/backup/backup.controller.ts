import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuditLoggerService } from '@server/modules/audit/audit-logger.service';
import { RequireSuperAdmin } from '@server/modules/authz/permission.decorator';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import { BackupService } from './backup.service';

/**
 * POST /api/admin/data-export —— 全量逻辑导出（见 BackupService 的说明）。
 *
 * ⚠️ **INTERNAL-ONLY / 生产高危运维功能（§14）—— 刻意没有界面入口。**
 *
 * §14 要求「必须有 UI 或明确标记为 internal-only，不要让它扩大范围」。
 * 这里选后者，而且是**有意的**，不是"还没做完"：
 *   · 它是一次性动作，不是日常操作。界面按钮会在值班时被误点，
 *     而每被点一次，整库明文就多离开平台一次；
 *   · 结果是几百 MB 的 NDJSON 流，在浏览器里下载完还是要放到服务器上
 *     做恢复演练 —— 界面一步都省不掉；
 *   · 一旦有了按钮，下一步就会有人要求"支持只导某几张表 / 按时间范围导 /
 *     加个定时"。它现在的价值恰恰在于**范围极小且不可配置：要么整库，要么不导**。
 *
 * 运维怎么调用、导出后必须做什么（chmod 600 / 记 sha256 / 核对审计），
 * 写在 `RUNBOOK.md` 第 10 节 —— 那里是这份能力的**唯一入口文档**。
 * 修改本路由时请同时更新那一节，否则文档会变成谎言。
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
