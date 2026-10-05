import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { TeachersService } from './teachers.service';
import {CreateTeacherDto, ListTeachersQueryDto, PermissionOverrideDto, UpdatePermissionsDto, UpdateTeacherDto} from './teachers.dto';
import type {
  RoleCode,
  SubjectPermission,
  Teacher,
  TeacherDetail,
} from '@shared/api.interface';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import { CurrentAuthz, RequirePermission } from '@server/modules/authz/permission.decorator';
import type { EffectivePermissions } from '@shared/rbac';
import { getClientIp as resolveClientIp } from '@server/common/http/client-ip';

interface TeacherListResponse {
  items: Teacher[];
  total: number;
  page: number;
  pageSize: number;
}

// Role lists and `requireAnyRole()` were REMOVED here on purpose.
//
// They hard-coded `['principal']` / `['principal','curriculum_director']` inline,
// which meant the only way to let another role manage accounts was to edit code,
// and the requirement was invisible in the route table. Each route below now
// declares the capability it needs via @RequirePermission, enforced centrally by
// PermissionGuard and backed by the database guards from migration 0003.

/**
 * Client IP for audit records.
 * Delegates to the shared trust-aware resolver — see client-ip.ts.
 */
function auditClientIp(req: Request): string | undefined {
  return resolveClientIp(req) || undefined;
}

@Controller('api/teachers')
export class TeachersController {
  constructor(private readonly teachersService: TeachersService) {}

  @Get()
  @RequirePermission('account.view')
  async listTeachers(
    @Query() query: ListTeachersQueryDto,
  ): Promise<TeacherListResponse> {
    return this.teachersService.listTeachers({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      role: query.role,
      status: query.status,
    });
  }

  @Get(':id')
  @RequirePermission('account.view')
  async getTeacher(
    @Param('id') id: string,
  ): Promise<TeacherDetail> {
    return this.teachersService.getTeacherDetail(id);
  }

  @Post()
  @RequirePermission('account.create')
  async createTeacher(
    @CurrentTeacher() teacher: {
      id: string;
      name: string;
      roles: RoleCode[];
    },
    @CurrentAuthz() authz: EffectivePermissions,
    @Body() dto: CreateTeacherDto,
    @Req() req: Request,
  ): Promise<TeacherDetail> {
    const ip = auditClientIp(req);

    return this.teachersService.createTeacher(
      dto,
      teacher.id,
      teacher.name,
      teacher.roles,
      authz,
      ip,
    );
  }

  @Patch(':id')
  @RequirePermission('account.update')
  async updateTeacher(
    @CurrentTeacher() teacher: {
      id: string;
      name: string;
      roles: RoleCode[];
    },
    @CurrentAuthz() authz: EffectivePermissions,
    @Param('id') id: string,
    @Body() dto: UpdateTeacherDto,
    @Req() req: Request,
  ): Promise<Teacher> {
    const ip = auditClientIp(req);

    return this.teachersService.updateTeacher(
      id,
      dto,
      teacher.id,
      teacher.name,
      teacher.roles,
      authz,
      ip,
    );
  }

  // ---------------------------------------------------------------------------
  // §11 按账号授权 —— 生效权限 / 追加授权 / 显式禁止 / 清除覆盖
  //
  // grant 与 deny 刻意**分成两条路由**，而不是一条路由按请求体决定要求哪个权限：
  //   · 装饰器是声明式的、可 grep 的，幽灵权限审计也才看得到消费点；
  //   · "同一条路由按 body 决定权限"必须在控制器里手写判定，那是权限判定最容易出错的形式。
  // 清除覆盖同样是特权操作（撤掉一条 deny 等于放开），所以也归 `permission.revoke`。
  // ---------------------------------------------------------------------------

  /** 读取某个账号的生效权限（含每一项的来源：角色默认 / 追加 / 被禁止）。 */
  @Get(':id/effective-permissions')
  @RequirePermission('permission.view')
  async getEffectivePermissions(@Param('id') id: string) {
    return this.teachersService.getAccountEffectivePermissions(id);
  }

  /** 追加授权：即使角色默认没有，也给这个账号开这个权限。 */
  @Post(':id/permission-overrides/grant')
  @RequirePermission('permission.grant')
  async grantPermission(
    @CurrentTeacher() teacher: { id: string; name: string; roles: RoleCode[] },
    @Param('id') id: string,
    @Body() body: PermissionOverrideDto,
    @Req() req: Request,
  ) {
    return this.teachersService.overrideAccountPermission(
      id,
      body.permission,
      'grant',
      body.reason,
      { id: teacher.id, name: teacher.name, roles: teacher.roles },
      auditClientIp(req),
    );
  }

  /** 显式禁止：即使角色默认包含，也把这个权限收回来（**禁止永远优先**）。 */
  @Post(':id/permission-overrides/deny')
  @RequirePermission('permission.revoke')
  async denyPermission(
    @CurrentTeacher() teacher: { id: string; name: string; roles: RoleCode[] },
    @Param('id') id: string,
    @Body() body: PermissionOverrideDto,
    @Req() req: Request,
  ) {
    return this.teachersService.overrideAccountPermission(
      id,
      body.permission,
      'deny',
      body.reason,
      { id: teacher.id, name: teacher.name, roles: teacher.roles },
      auditClientIp(req),
    );
  }

  /** 清除覆盖项，回到角色默认。 */
  @Delete(':id/permission-overrides/:permission')
  @RequirePermission('permission.revoke')
  async clearPermissionOverride(
    @CurrentTeacher() teacher: { id: string; name: string; roles: RoleCode[] },
    @Param('id') id: string,
    @Param('permission') permission: string,
    @Req() req: Request,
  ) {
    return this.teachersService.clearAccountPermissionOverride(
      id,
      permission,
      { id: teacher.id, name: teacher.name, roles: teacher.roles },
      auditClientIp(req),
    );
  }

  @Delete(':id')
  @RequirePermission('account.disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTeacher(
    @CurrentTeacher() teacher: {
      id: string;
      name: string;
      roles: RoleCode[];
    },
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    const ip = auditClientIp(req);

    await this.teachersService.deleteTeacher(
      id,
      teacher.id,
      teacher.name,
      ip,
    );
  }

  @Post(':id/permissions')
  @RequirePermission('permission.grant')
  async updatePermissions(
    @CurrentTeacher() teacher: {
      id: string;
      name: string;
      roles: RoleCode[];
    },
    @Param('id') id: string,
    @Body() body: UpdatePermissionsDto,
    @Req() req: Request,
  ): Promise<{ permissions: SubjectPermission[] }> {
    const ip = auditClientIp(req);

    const permissions = await this.teachersService.updatePermissions(
      id,
      body.permissions,
      teacher.id,
      teacher.name,
      ip,
    );
    return { permissions };
  }
}
