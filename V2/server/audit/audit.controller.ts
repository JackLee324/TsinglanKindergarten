import { Controller, Get, Query } from '@nestjs/common'
import { AuditService } from './audit.service'
import { RequirePermission } from '../common/decorators'
import { AUDIT_ACTIONS } from '../../shared/audit-actions'

/**
 * 空字符串按"没有这个筛选"处理。
 *
 * 界面上清空一个输入框会送出 `?action=`，如果把它当成"筛选 action = ''"，
 * 结果会永远是 0 条 —— 而用户以为自己只是清空了搜索框。
 */
function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** 审计查询。标签从 `shared/audit-actions.ts` 同源生成，不需要手工同步。 */
@Controller('api/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * 审计明细（业主 §14）。
   *
   * 筛选参数：动作 / 结果 / 操作者 / 对象类型 / 对象 id / 时间区间。
   * 分页保持 limit+offset —— 界面上是"上一页/下一页"，不需要游标。
   */
  @Get('logs')
  @RequirePermission('audit.view')
  async logs(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('action') action?: string,
    @Query('result') result?: string,
    @Query('actorId') actorId?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const parsedLimit = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200)
    const parsedOffset = Math.max(Number(offset ?? 0) || 0, 0)
    return this.audit.query({
      limit: parsedLimit,
      offset: parsedOffset,
      action: blank(action),
      result: blank(result),
      actorId: blank(actorId),
      targetType: blank(targetType),
      targetId: blank(targetId),
      from: blank(from),
      to: blank(to),
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
