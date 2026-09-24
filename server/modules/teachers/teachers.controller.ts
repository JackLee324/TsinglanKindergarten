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
import {
  CreateTeacherDto,
  ListTeachersQueryDto,
  UpdatePermissionsDto,
  UpdateTeacherDto,
} from './teachers.dto';
import type {
  RoleCode,
  SubjectPermission,
  Teacher,
  TeacherDetail,
} from '@shared/api.interface';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import { RequirePermission } from '@server/modules/authz/permission.decorator';
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
    @Body() dto: CreateTeacherDto,
    @Req() req: Request,
  ): Promise<TeacherDetail> {
    const ip = auditClientIp(req);

    return this.teachersService.createTeacher(
      dto,
      teacher.id,
      teacher.name,
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
      ip,
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
