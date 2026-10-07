import { Controller, Get, Query } from '@nestjs/common'
import { AuditService } from './audit.service'
import { RequirePermission } from '../common/decorators'
import { AUDIT_ACTIONS } from '../../shared/audit-actions'

/** 审计查询。标签从 `shared/audit-actions.ts` 同源生成，不需要手工同步。 */
@Controller('api/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('logs')
  @RequirePermission('audit.view')
  async logs(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('action') action?: string,
    @Query('result') result?: string,
    @Query('actorId') actorId?: string,
  ) {
    const parsedLimit = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200)
    const parsedOffset = Math.max(Number(offset ?? 0) || 0, 0)
    return this.audit.query({
      limit: parsedLimit,
      offset: parsedOffset,
      action,
      result,
      actorId,
    })
  }

  /** 界面上的下拉选项：动作 + 中文标签，一次给全。 */
  @Get('actions')
  @RequirePermission('audit.view')
  actions() {
    return {
      items: Object.entries(AUDIT_ACTIONS).map(([action, label]) => ({ action, label })),
    }
  }
}
