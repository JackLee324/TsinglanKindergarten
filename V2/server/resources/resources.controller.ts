import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ResourcesService, type ResourceFilters } from './resources.service'
import {
  BulkDeleteResourcesDto,
  BulkUpdateStatusDto,
  CreateResourceDto,
  ListResourcesDto,
  RecallResourceDto,
  ReviewResourceDto,
  UpdateResourceDto,
} from './resources.dto'
import {
  CurrentUser,
  DirectoryScope,
  RequirePermission,
  RequireSuperAdmin,
} from '../common/decorators'
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
      // ⚠️ 必须透传：DTO 里有 `onlyMine`，但控制器原先没往下传 —— 于是
      // `GET /api/resources?onlyMine=true` 会**静默退化成"看这个目录里我可见的全部"**，
      // 目录页那块"我的未发布资源"就会列到别人的待审核内容。
      // 这类"参数在 DTO 里有、却没接上"的缺口不会报错，只会让结果范围悄悄变大。
      onlyMine: query.onlyMine === true,
      recycled: false,
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

  /**
   * 批量**软**删除（进回收站、**可恢复**）。超级管理员专用。
   *
   * 两层门槛，都在服务端（与 `users.controller` 同一套写法）：
   *   1. `@RequirePermission('resource.delete.own')` —— 声明"这是删除动作"；
   *   2. `@RequireSuperAdmin()` —— 真正的门槛：只有超级管理员能调。
   *
   * WHY 必须两层：`resource.delete.own` 是**可授予**的权限。只靠第一层时，
   * 任何一个拿到它的老师都能批量删掉**别人**的资源（界面上没有入口挡不住直接调 API）。
   * service 里还会再调一次 `assertSuperAdmin()` —— 纵深防御，见 `bulkSoftDelete`。
   *
   * ⚠️ 这是**软**删除：只写 `deleted_at`，不碰对象存储、不删审核历史。
   *    永久删除是另一个接口（`POST :id/purge`），门槛更高。
   *
   * 路由声明在 `:id/...` 之前：`bulk-delete` 是静态段，
   * 放在后面会被 `:id` 抢先匹配（与 `mine` 的处理同一个原因）。
   */
  @Post('bulk-delete')
  @RequirePermission('resource.delete.own')
  @RequireSuperAdmin()
  async bulkDelete(@CurrentUser() actor: AuthUser, @Body() dto: BulkDeleteResourcesDto) {
    return this.resources.bulkSoftDelete(actor, dto.ids)
  }

  /**
   * 批量**强制修改状态**（超级管理员专用，业主 2026-10-15 新增）。
   *
   * 与六条合法转换是**两条不同的路**：那六条是流程（有前置状态、有权限码、
   * 有所有权要求，只能一格一格走）；这里是管理员直接覆盖，五个状态都能设。
   * 之所以敢开这个口子，是因为它被三件事围住：身份（双层超管判定）、
   * 留痕（独立的审计动作 + 审核时间线）、代价明确（退回必须写原因，
   * 改成已发布在界面上要二次确认，因为那一步绕过审核）。
   *
   * 门槛与 `bulk-delete` 同构的两层：
   *   1. `@RequirePermission('resource.update.own')` —— 声明"这是修改动作"；
   *   2. `@RequireSuperAdmin()` —— 真正的门槛（**不可授予**，身份自带）。
   * service 里还会再判一次 `assertSuperAdmin()`（纵深防御）。
   *
   * ⚠️ 必须声明在 `:id` 系列之前，否则 `bulk-status` 会被当成一个资源 id。
   */
  @Post('bulk-status')
  @RequirePermission('resource.update.own')
  @RequireSuperAdmin()
  async bulkStatus(@CurrentUser() actor: AuthUser, @Body() dto: BulkUpdateStatusDto) {
    return this.resources.bulkForceStatus(
      actor,
      dto.ids,
      dto.status as ResourceStatus,
      dto.comment ?? null,
    )
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

  /**
   * 永久删除（数据库行 + 对象存储文件 + 审计）。
   *
   * ⚠️ **两层门槛缺一不可**（修复于 2026-10-12 的越权缺口）：
   *   1. `@RequirePermission('resource.delete.own')` —— 声明"这是删除动作"；
   *   2. `@RequireSuperAdmin()` —— 真正的门槛。
   *
   * 修复前这里**只有第 1 层**：`resource.delete.own` 是可授予的权限，
   * 于是任何持有它的老师都能直接 `POST /api/resources/:id/purge`
   * 把自己（以及通过目录范围能触及）的资源**永久抹掉**，包括对象存储里的文件 ——
   * 这与 `RESOURCE_LIFECYCLE.md` 第 11 行「`resource.purge`（仅 ADMIN）」不符。
   * 界面上没有这个按钮**不能**作为安全依据：直接构造请求一样能打进来。
   *
   * service 层（`ResourcesService.purge`）也会再调一次 `assertSuperAdmin()`,
   * 所以就算有人绕过控制器直接调 service，门槛仍在。
   */
  @Post(':id/purge')
  @RequirePermission('resource.delete.own')
  @RequireSuperAdmin()
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async purge(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.resources.purge(actor, id)
  }
}
