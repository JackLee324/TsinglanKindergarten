import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { UsersService } from './users.service'
import { CreateUserDto, ListUsersDto, SetPermissionsDto, UpdateUserDto } from './users.dto'
import { DEFAULT_PAGE_SIZE } from '../../shared/resource-query'
import { CurrentUser, RequirePermission, RequireSuperAdmin } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'

/**
 * 账号与权限接口。
 *
 * 两层门槛，**都在服务端**（业主 Stage 13 §4）：
 *   1. `@RequirePermission('user.manage')` —— 声明"这是账号管理动作"；
 *   2. `@RequireSuperAdmin()` —— 真正的门槛：**只有超级管理员**（本项目即 ADMIN 身份）能调。
 *
 * WHY 必须两层：`user.manage` 是**可授予**的权限，一旦某个老师被误配了它，
 * 只靠第一层就等于把"建管理员 / 改别人身份"的通道打开（前端藏按钮挡不住直接调 API）。
 * 所以账号管理的门槛是**身份**，而身份的判定只有一处
 * （`AuthorizationService.assertSuperAdmin`，角色字面量在全仓库只允许出现在那里）。
 *
 * 管理员界面上只会出现中文勾选框与一棵目录树；`permission` 这个字段名
 * 不会出现在界面文案里。
 */
@Controller('api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * 教师账号列表：**服务端搜索 + 分页**（业主 §28）。
   * 默认每页 20，与资源列表同一个常量 —— 界面上两处"每页多少条"不该有两个数。
   */
  @Get()
  @RequirePermission('user.manage')
  @RequireSuperAdmin()
  async list(@CurrentUser() actor: AuthUser, @Query() query: ListUsersDto) {
    return this.users.list(actor, {
      q: query.q ?? null,
      role: query.role ?? null,
      status: query.status ?? null,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
    })
  }

  @Get(':id')
  @RequirePermission('user.manage')
  @RequireSuperAdmin()
  async getOne(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.users.getById(actor, id)
  }

  @Post()
  @RequirePermission('user.manage')
  @RequireSuperAdmin()
  async create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(actor, dto)
  }

  @Patch(':id')
  @RequirePermission('user.manage')
  @RequireSuperAdmin()
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(actor, id, dto)
  }

  @Get(':id/permissions')
  @RequirePermission('user.manage')
  @RequireSuperAdmin()
  async getPermissions(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return { items: await this.users.getPermissions(actor, id) }
  }

  @Put(':id/permissions')
  @RequirePermission('user.manage')
  @RequireSuperAdmin()
  async setPermissions(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetPermissionsDto,
  ) {
    return this.users.setPermissions(actor, id, dto.permissions)
  }
}
