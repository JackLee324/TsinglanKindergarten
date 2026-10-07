import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { DirectoriesService } from './directories.service'
import {
  CreateDirectoryDto,
  CreateFolderDto,
  MoveDirectoryDto,
  ReorderDirectoryDto,
  UpdateDirectoryDto,
} from './directories.dto'
import {
  AuthenticatedOnly,
  CurrentUser,
  DirectoryScope,
  RequirePermission,
} from '../common/decorators'
import type { AuthUser } from '../common/auth-user'
import type { DirectoryType } from '../../shared/directory'

/**
 * 目录接口。
 *
 * 读接口要 `resource.view`（列表类判定，数据在 service 里按范围过滤）；
 * 写接口要 `directory.manage`，并且**把目标目录交给 AuthzGuard 判定**
 * （`@DirectoryScope`），因此"有权限的只是 Pre-K，却去改 K 的目录"会被拒。
 */
@Controller('api/directories')
export class DirectoriesController {
  constructor(private readonly directories: DirectoriesService) {}

  @AuthenticatedOnly()
  @Get('tree')
  async tree(@CurrentUser() user: AuthUser) {
    return this.directories.getTree(user)
  }

  /**
   * 按 slug 路径解析（浏览页与老链接都走它）。
   * `?path=pre-k/virtue` ；解析不到时返回 resolvedCount 与剩余段，界面据此回退。
   */
  @AuthenticatedOnly()
  @Get('by-path')
  async byPath(@CurrentUser() user: AuthUser, @Query('path') path?: string) {
    const segments = (path ?? '').split('/').filter((s) => s.length > 0)
    return this.directories.resolvePath(user, segments)
  }

  @Get(':id')
  @RequirePermission('resource.view')
  @DirectoryScope({ kind: 'param', name: 'id' })
  async getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.directories.getById(user, id)
  }

  /** 新增目录。不带 parentId 就是**新增一级栏目**。 */
  @Post()
  @RequirePermission('directory.manage')
  // 没有 parentId = 新增**一级栏目**（平台级操作），因此显式声明 null 表示全局。
  @DirectoryScope({ kind: 'body', name: 'parentId', nullMeansGlobal: true })
  async create(@CurrentUser() actor: AuthUser, @Body() dto: CreateDirectoryDto) {
    return this.directories.create(actor, {
      ...dto,
      type: dto.type as DirectoryType | undefined,
    })
  }

  /** 改目录（只改展示层；slug/parentId 不在这里）。 */
  @Patch(':id')
  @RequirePermission('directory.manage')
  @DirectoryScope({ kind: 'param', name: 'id' })
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateDirectoryDto,
  ) {
    return this.directories.update(actor, id, {
      ...dto,
      type: dto.type as DirectoryType | undefined,
    })
  }

  @Post(':id/move')
  @RequirePermission('directory.manage')
  @DirectoryScope({ kind: 'param', name: 'id' })
  async move(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: MoveDirectoryDto,
  ) {
    return this.directories.move(actor, id, dto.parentId ?? null)
  }

  @Post(':id/reorder')
  @RequirePermission('directory.manage')
  @DirectoryScope({ kind: 'param', name: 'id' })
  async reorder(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReorderDirectoryDto,
  ) {
    return this.directories.reorder(actor, id, dto.direction)
  }

  @Delete(':id')
  @RequirePermission('directory.manage')
  @DirectoryScope({ kind: 'param', name: 'id' })
  async remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.directories.remove(actor, id)
  }

  /**
   * 普通教师建文件夹。
   *
   * 单独一个接口、单独一个权限（`directory.create_folder`），
   * 因为它是**教师的日常动作**，而 `directory.manage` 是管理员动作。
   * 目标目录还必须 `allowCustomFolders = true`（服务层会拒）。
   */
  @Post('folders')
  @RequirePermission('directory.create_folder')
  @DirectoryScope({ kind: 'body', name: 'parentId' })
  async createFolder(@CurrentUser() actor: AuthUser, @Body() dto: CreateFolderDto) {
    return this.directories.createFolder(actor, dto.parentId, dto.name, dto.nameEn ?? null)
  }
}
