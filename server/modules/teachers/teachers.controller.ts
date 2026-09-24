import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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

interface TeacherListResponse {
  items: Teacher[];
  total: number;
  page: number;
  pageSize: number;
}

const WRITE_ROLES: RoleCode[] = ['principal'];
const READ_ROLES: RoleCode[] = ['principal', 'curriculum_director'];

function requireAnyRole(
  roles: RoleCode[],
  allowed: RoleCode[],
  message = '权限不足',
): void {
  const hasRole = roles.some((r: RoleCode) => allowed.includes(r));
  if (!hasRole) {
    throw new ForbiddenException(message);
  }
}

function getClientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0]?.trim();
  return req.ip;
}

@Controller('api/teachers')
export class TeachersController {
  constructor(private readonly teachersService: TeachersService) {}

  @Get()
  async listTeachers(
    @CurrentTeacher() teacher: { id: string; roles: RoleCode[] },
    @Query() query: ListTeachersQueryDto,
  ): Promise<TeacherListResponse> {
    requireAnyRole(teacher.roles, READ_ROLES);

    return this.teachersService.listTeachers({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      role: query.role,
      status: query.status,
    });
  }

  @Get(':id')
  async getTeacher(
    @CurrentTeacher() teacher: { id: string; roles: RoleCode[] },
    @Param('id') id: string,
  ): Promise<TeacherDetail> {
    requireAnyRole(teacher.roles, READ_ROLES);

    return this.teachersService.getTeacherDetail(id);
  }

  @Post()
  async createTeacher(
    @CurrentTeacher() teacher: {
      id: string;
      name: string;
      roles: RoleCode[];
    },
    @Body() dto: CreateTeacherDto,
    @Req() req: Request,
  ): Promise<TeacherDetail> {
    requireAnyRole(teacher.roles, WRITE_ROLES);

    const ip = getClientIp(req);

    return this.teachersService.createTeacher(
      dto,
      teacher.id,
      teacher.name,
      ip,
    );
  }

  @Patch(':id')
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
    requireAnyRole(teacher.roles, WRITE_ROLES);

    const ip = getClientIp(req);

    return this.teachersService.updateTeacher(
      id,
      dto,
      teacher.id,
      teacher.name,
      ip,
    );
  }

  @Delete(':id')
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
    requireAnyRole(teacher.roles, WRITE_ROLES);

    const ip = getClientIp(req);

    await this.teachersService.deleteTeacher(
      id,
      teacher.id,
      teacher.name,
      ip,
    );
  }

  @Post(':id/permissions')
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
    requireAnyRole(teacher.roles, WRITE_ROLES);

    const ip = getClientIp(req);

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
