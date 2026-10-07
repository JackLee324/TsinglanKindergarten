import { Controller, Get, Query } from '@nestjs/common'
import { CurrentUser, RequirePermission } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'
import { ResourcesService } from '../resources/resources.service'

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

  @Get('pending')
  @RequirePermission('resource.review')
  async pending(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.resources.list(user, {
      status: 'PENDING_REVIEW',
      q: q ?? null,
      page: 1,
      pageSize: 100,
    })
  }

  @Get('published')
  @RequirePermission('resource.review')
  async published(@CurrentUser() user: AuthUser) {
    return this.resources.list(user, {
      status: 'PUBLISHED',
      page: 1,
      pageSize: 100,
    })
  }

  @Get('rejected')
  @RequirePermission('resource.review')
  async rejected(@CurrentUser() user: AuthUser) {
    return this.resources.list(user, {
      status: 'REJECTED',
      page: 1,
      pageSize: 100,
    })
  }
}
