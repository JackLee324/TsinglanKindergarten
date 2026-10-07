import { Controller, Get, Query } from '@nestjs/common'
import { CurrentUser, RequirePermission } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'
import { ResourcesService } from '../resources/resources.service'
import { ReviewQueueDto } from '../resources/resources.dto'
import { DEFAULT_PAGE_SIZE, DEFAULT_RESOURCE_SORT, isResourceSortKey } from '../../shared/resource-query'
import type { ResourceStatus } from '../../shared/resource-status'

/**
 * 审核工作台。
 *
 * 只提供**读**：待审列表与审核历史。
 * 裁决动作（approve / reject）与撤回（recall）留在资源模块 ——
 * 它们改的是资源状态，必须和状态机在同一处，否则规则会分叉成两份。
 */
@Controller('api/reviews')
export class ReviewsController {
  constructor(private readonly resources: ResourcesService) {}

  /**
   * 待审队列（业主 §3）。
   *
   * 支持搜索 / 目录过滤 / 时间排序 / **服务端分页**。
   * 业主明确要求"不要一次返回全部数据" —— 之前的 pageSize=100 是写死的，
   * 资源一多就会静默截断（"某一页之后的东西再也看不到"）。
   */
  @Get('pending')
  @RequirePermission('resource.review')
  async pending(@CurrentUser() user: AuthUser, @Query() query: ReviewQueueDto) {
    return this.queueFor(user, 'PENDING_REVIEW', query)
  }

  /** 已发布 / 已退回：审核台的两个只读分栏，与待审共用同一套查询。 */
  @Get('published')
  @RequirePermission('resource.review')
  async published(@CurrentUser() user: AuthUser, @Query() query: ReviewQueueDto) {
    return this.queueFor(user, 'PUBLISHED', query)
  }

  @Get('rejected')
  @RequirePermission('resource.review')
  async rejected(@CurrentUser() user: AuthUser, @Query() query: ReviewQueueDto) {
    return this.queueFor(user, 'REJECTED', query)
  }

  /**
   * 三个分栏只差一个状态 —— 查询、可见性、排序、分页**只有一份实现**。
   * 排序 key 会在服务端校验白名单；不认识的值退回默认（不报错、也不拼进 SQL）。
   */
  private queueFor(user: AuthUser, status: ResourceStatus, query: ReviewQueueDto) {
    return this.resources.queue(user, status, {
      directoryId: query.directoryId ?? null,
      q: query.q ?? null,
      sort: isResourceSortKey(query.sort) ? query.sort : DEFAULT_RESOURCE_SORT,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
    })
  }
}
