import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common'
import { UsersService } from './users.service'
import { CreateUserDto, SetPermissionsDto, UpdateUserDto } from './users.dto'
import { CurrentUser, RequirePermission } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'

/**
 * 账号与权限接口。
 *
 * 全部要求 `user.manage` —— 一个**全平台**权限（不带目录范围），
 * 所以不声明 DirectoryScope，AuthzGuard 会按"任意范围持有"判定。
 *
 * 管理员界面上只会出现中文勾选框与一棵目录树；`permission` 这个字段名
 * 不会出现在界面文案里。
 */
@Controller('api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user.manage')
  async list() {
    return { items: await this.users.list() }
  }

  @Get(':id')
  @RequirePermission('user.manage')
  async getOne(@Param('id') id: string) {
    return this.users.getById(id)
  }

  @Post()
  @RequirePermission('user.manage')
  async create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(actor, dto)
  }

  @Patch(':id')
  @RequirePermission('user.manage')
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(actor, id, dto)
  }

  @Get(':id/permissions')
  @RequirePermission('user.manage')
  async getPermissions(@Param('id') id: string) {
    return { items: await this.users.getPermissions(id) }
  }

  @Put(':id/permissions')
  @RequirePermission('user.manage')
  async setPermissions(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetPermissionsDto,
  ) {
    return this.users.setPermissions(actor, id, dto.permissions)
  }
}
