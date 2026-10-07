import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ResourcesService, type ResourceFilters } from './resources.service'
import {
  CreateResourceDto,
  ListResourcesDto,
  RecallResourceDto,
  ReviewResourceDto,
  UpdateResourceDto,
} from './resources.dto'
import { CurrentUser, DirectoryScope, RequirePermission } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'
import type { ResourceStatus } from '../../shared/resource-status'

/**
 * 资源接口。
 *
 * 权限声明的三种形状，正好对应三类操作：
 *   · 列表类（GET 集合）           → 目录范围在 service 里做 WHERE 过滤
 *   · 目标资源类（:id）            → @DirectoryScope({kind:'resource'})，守卫查该资源的目录
 *   · 目标目录类（create）         → @DirectoryScope({kind:'body', name:'directoryId'})
 */
@Controller('api/resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  @RequirePermission('resource.view')
  async list(@CurrentUser() user: AuthUser, @Query() query: ListResourcesDto) {
    const filters: ResourceFilters = {
      directoryId: query.directoryId ?? null,
      includeSubtree: query.includeSubtree === true,
      status: (query.status as ResourceStatus | undefined) ?? null,
      q: query.q ?? null,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    }
    return this.resources.list(user, filters)
  }

  /**
   * 「我的资源」。
   *
   * 支持按状态筛选（对应界面上的 全部/草稿/待审核/已发布/已退回/已撤回 分栏）
   * 与服务端分页 —— 不分栏、不分页地一次拉全部，会随着资源增长变成
   * "打开页面卡一下、而且某天开始只显示前 N 条"。
   */
  @Get('mine')
  @RequirePermission('resource.view')
  async mine(@CurrentUser() user: AuthUser, @Query() query: ListResourcesDto) {
    return this.resources.mine(user, 'active', {
      status: (query.status as ResourceStatus | undefined) ?? null,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
  }

  /** 「我的资源」回收站分栏。本阶段只有接口，界面在后续阶段。 */
  @Get('mine/recycle-bin')
  @RequirePermission('resource.view')
  async mineRecycleBin(@CurrentUser() user: AuthUser, @Query() query: ListResourcesDto) {
    return this.resources.mine(user, 'recycle', {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
  }

  @Get('recycle-bin')
  @RequirePermission('resource.view')
  async recycleBin(@CurrentUser() user: AuthUser) {
    return this.resources.recycleBin(user)
  }

  @Get(':id')
  @RequirePermission('resource.view')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.resources.getById(user, id)
  }

  @Get(':id/review-history')
  @RequirePermission('resource.view')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async reviewHistory(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.resources.reviewHistory(user, id)
  }

  @Post()
  @RequirePermission('resource.create')
  @DirectoryScope({ kind: 'body', name: 'directoryId' })
  async create(@CurrentUser() actor: AuthUser, @Body() dto: CreateResourceDto) {
    return this.resources.create(actor, dto)
  }

  @Patch(':id')
  @RequirePermission('resource.update.own')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateResourceDto,
  ) {
    return this.resources.update(actor, id, dto)
  }

  @Post(':id/submit')
  @RequirePermission('resource.submit')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async submit(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.resources.submit(actor, id)
  }

  /** 审核裁决：通过 / 退回。撤回**不在这里**。 */
  @Post(':id/review')
  @RequirePermission('resource.review', 'resource.publish')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async review(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReviewResourceDto,
  ) {
    return this.resources.review(actor, id, dto.action, dto.comment ?? null)
  }

  /**
   * 撤回：独立动作、独立接口，**绝不调用 reject**。
   *
   * 原因可选（业主 §25 界面上会让人填一句），给了就记进审核时间线。
   */
  @Post(':id/recall')
  @RequirePermission('resource.submit')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async recall(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: RecallResourceDto,
  ) {
    return this.resources.recall(actor, id, dto.comment ?? null)
  }

  @Delete(':id')
  @RequirePermission('resource.delete.own')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async softDelete(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.resources.softDelete(actor, id)
  }

  @Post(':id/restore')
  @RequirePermission('resource.delete.own')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async restore(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.resources.restore(actor, id)
  }

  /** 永久删除：数据库 + 对象存储 + 审计。 */
  @Post(':id/purge')
  @RequirePermission('resource.delete.own')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async purge(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.resources.purge(actor, id)
  }
}
