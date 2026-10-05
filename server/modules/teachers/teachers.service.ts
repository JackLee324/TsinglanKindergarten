import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/database/database.module';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type {
  AuditAction,
  RoleCode,
  SubjectPermission,
  Teacher,
  TeacherDetail,
} from '@shared/api.interface';
import {
  ROLE_ASSIGN_PERMISSION,
  type EffectivePermissions,
} from '@shared/rbac';
import {
  auditLogs,
  subjectPermissions,
  teachers,
} from '@server/database/schema';
import type { CreateTeacherDto, UpdateTeacherDto } from './teachers.dto';
import { AuthService } from '../auth/auth.service';
// 角色变更的**授权**判定只有这一处：AuthzModule 是 @Global()，无需改模块接线。
import { AuthorizationService } from '../authz/authorization.service';

interface TeacherListResult {
  items: Teacher[];
  total: number;
  page: number;
  pageSize: number;
}

function extractPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

function mapTeacher(row: typeof teachers.$inferSelect): Teacher {
  return {
    id: row.id,
    username: row.username ?? undefined,
    wecomUserId: row.wecomUserId ?? undefined,
    name: row.name,
    nameEn: row.nameEn ?? undefined,
    email: row.email ?? undefined,
    roles: (row.roles as RoleCode[]) ?? [],
    status: row.status as 'active' | 'inactive',
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapPermission(row: typeof subjectPermissions.$inferSelect): SubjectPermission {
  return {
    id: row.id,
    teacherId: row.teacherId,
    program: row.program as 'prek' | 'k',
    subject: row.subject,
    subSubject: row.subSubject ?? undefined,
    canView: row.canView,
    canUpload: row.canUpload,
  };
}

@Injectable()
export class TeachersService {
  private readonly logger = new Logger(TeachersService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly authService: AuthService,
    private readonly authz: AuthorizationService,
  ) {}

  async listTeachers(params: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    role?: RoleCode;
    status?: 'active' | 'inactive';
  }): Promise<TeacherListResult> {
    const pageNum: number = params.page ?? 1;
    const pageSizeNum: number = params.pageSize ?? 20;
    const offset: number = (pageNum - 1) * pageSizeNum;

    const conditions = [];
    if (params.keyword) {
      const kw = `%${params.keyword}%`;
      conditions.push(
        or(
          ilike(teachers.name, kw),
          ilike(teachers.nameEn, kw),
          ilike(teachers.wecomUserId, kw),
          ilike(teachers.email, kw),
        ),
      );
    }
    if (params.role) {
      conditions.push(sql`${teachers.roles} @> ARRAY[${params.role}]::varchar[]`);
    }
    if (params.status) {
      conditions.push(eq(teachers.status, params.status));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    try {
      const [countResult, rows] = await Promise.all([
        this.db
          .select({ count: count() })
          .from(teachers)
          .where(whereClause),
        this.db
          .select()
          .from(teachers)
          .where(whereClause)
          .orderBy(desc(teachers.createdAt))
          .limit(pageSizeNum)
          .offset(offset),
      ]);

      const total: number = countResult[0]?.count ?? 0;
      const items: Teacher[] = rows.map((row) => mapTeacher(row));

      return { items, total, page: pageNum, pageSize: pageSizeNum };
    } catch (error) {
      this.logger.error(`查询教师列表失败: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async getTeacherDetail(id: string): Promise<TeacherDetail> {
    try {
      const rows = await this.db.select().from(teachers).where(eq(teachers.id, id)).limit(1);
      if (rows.length === 0) {
        throw new NotFoundException('教师不存在');
      }
      const teacher: Teacher = mapTeacher(rows[0]);

      const permRows = await this.db
        .select()
        .from(subjectPermissions)
        .where(eq(subjectPermissions.teacherId, id))
        .orderBy(subjectPermissions.program, subjectPermissions.subject, subjectPermissions.subSubject);
      const permissions: SubjectPermission[] = permRows.map((row) => mapPermission(row));

      return { ...teacher, permissions };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`获取教师详情失败 id=${id}: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async createTeacher(
    dto: CreateTeacherDto,
    operatorId: string,
    operatorName: string,
    operatorRoles: RoleCode[],
    authz: EffectivePermissions | undefined,
    operatorIp?: string,
  ): Promise<TeacherDetail> {
    // §9：角色不是"随便传的字段"。DTO 只保证"是已知角色"，**谁能授予**由这里决定：
    // 不能授予不低于自身等级的角色，且 super_admin 只能由 super_admin 授予。
    const grantedRoles = this.authz.validateAssignableRoles(operatorRoles, dto.roles);
    try {
      const username = dto.username?.trim().toLowerCase() || AuthService.generateUsername(dto.name);
      const temporaryPassword = this.authService.generateTemporaryPassword();
      const passwordHash = this.authService.hashPasswordWithRandomSalt(temporaryPassword);

      return await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(teachers)
          .values({
            username,
            wecomUserId: dto.wecomUserId || null,
            name: dto.name,
            nameEn: dto.nameEn,
            email: dto.email,
            roles: grantedRoles,
             status: dto.status ?? 'active',
             passwordHash,
             // 创建接口返回的是**临时密码**（响应体里的 temporaryPassword），
             // 所以这一行必须同时把"必须先改密"置上 —— 否则那个临时密码就是永久密码：
             // 管理员把它念给老师之后，它一直有效，且没有任何环节会提醒更换。
             // 服务端会据此拦截其它接口（见 auth.guard.ts），不是只靠前端跳转。
             mustChangePassword: true,
          })
          .returning();

        if (inserted.length === 0) {
          throw new BadRequestException('创建教师失败');
        }
        const teacher: Teacher = mapTeacher(inserted[0]);
        let permissions: SubjectPermission[] = [];

        if (dto.permissions && dto.permissions.length > 0) {
          const permInserted = await tx
            .insert(subjectPermissions)
            .values(
              dto.permissions.map((p) => ({
                teacherId: teacher.id,
                program: p.program,
                subject: p.subject,
                subSubject: p.subSubject,
                canView: p.canView,
                canUpload: p.canUpload,
              })),
            )
            .returning();
          permissions = permInserted.map((row) => mapPermission(row));
        }

        await tx.insert(auditLogs).values({
          action: 'teacher_create' as AuditAction,
          teacherId: teacher.id,
          teacherName: teacher.name,
          wecomUserId: teacher.wecomUserId || null,
          ipAddress: operatorIp,
          detail: `创建教师: ${teacher.name} (${username})，角色: ${teacher.roles.join(',')}`,
          success: true,
        });

        return { ...teacher, permissions, temporaryPassword } as TeacherDetail & { temporaryPassword: string };
      });
    } catch (error) {
      const pgCode = extractPostgresErrorCode(error);
      if (pgCode === '23505') {
        throw new ConflictException('用户名或企业微信用户ID已存在');
      }
      this.logger.error(`创建教师失败: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async updateTeacher(
    id: string,
    dto: UpdateTeacherDto,
    operatorId: string,
    operatorName: string,
    operatorRoles: RoleCode[],
    authz: EffectivePermissions | undefined,
    operatorIp?: string,
  ): Promise<Teacher> {
    const patch: Partial<typeof teachers.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.nameEn !== undefined) patch.nameEn = dto.nameEn;
    if (dto.email !== undefined) patch.email = dto.email;
    // §9：改角色的路径以前**完全没有授权判定** —— 唯一挡住"园长把自己/别人提成
    // super_admin"的，是 teachers.dto.ts 里那份漏掉 super_admin 的角色白名单（返回 400）。
    // 那是一个偶然的保护：一旦 DTO 的角色表与 shared/rbac.ts 对齐（§10 的要求），
    // 提权漏洞就会直接打开。所以这两件事必须一起做，而且授权判定要先落地。
    let nextRoles: RoleCode[] | undefined;
    if (dto.roles !== undefined) {
      await this.authz.assertCanManageAccount(operatorRoles, id);
      nextRoles = this.authz.validateAssignableRoles(operatorRoles, dto.roles);
      patch.roles = nextRoles;
    }
    if (dto.status !== undefined) patch.status = dto.status;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }

    try {
      const updated = await this.db
        .update(teachers)
        .set(patch)
        .where(eq(teachers.id, id))
        .returning();

      if (updated.length === 0) {
        throw new NotFoundException('教师不存在');
      }

      const teacher: Teacher = mapTeacher(updated[0]);

      await this.db.insert(auditLogs).values({
        action: 'teacher_update' as AuditAction,
        teacherId: teacher.id,
        teacherName: teacher.name,
        wecomUserId: teacher.wecomUserId,
        ipAddress: operatorIp,
        detail: `更新教师信息: ${Object.keys(patch).join(',')}`,
        success: true,
      });

      return teacher;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) throw error;
      const pgCode = extractPostgresErrorCode(error);
      if (pgCode === '23505') {
        throw new ConflictException('企业微信用户ID已存在');
      }
      this.logger.error(`更新教师失败 id=${id}: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async deleteTeacher(
    id: string,
    operatorId: string,
    operatorName: string,
    operatorIp?: string,
  ): Promise<void> {
    try {
      const updated = await this.db
        .update(teachers)
        .set({ status: 'inactive' })
        .where(eq(teachers.id, id))
        .returning({ id: teachers.id, name: teachers.name, wecomUserId: teachers.wecomUserId });

      if (updated.length === 0) {
        throw new NotFoundException('教师不存在');
      }

      await this.db.insert(auditLogs).values({
        action: 'teacher_update' as AuditAction,
        teacherId: updated[0].id,
        teacherName: updated[0].name,
        wecomUserId: updated[0].wecomUserId,
        ipAddress: operatorIp,
        detail: '删除教师（软删除，状态置为 inactive）',
        success: true,
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`删除教师失败 id=${id}: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async updatePermissions(
    teacherId: string,
    permissionsInput: { program: string; subject: string; subSubject?: string; canView: boolean; canUpload: boolean }[],
    operatorId: string,
    operatorName: string,
    operatorIp?: string,
  ): Promise<SubjectPermission[]> {
    try {
      const teacherRows = await this.db
        .select({ id: teachers.id, name: teachers.name, wecomUserId: teachers.wecomUserId })
        .from(teachers)
        .where(eq(teachers.id, teacherId))
        .limit(1);
      if (teacherRows.length === 0) {
        throw new NotFoundException('教师不存在');
      }
      const teacherInfo = teacherRows[0];

      const result = await this.db.transaction(async (tx) => {
        await tx.delete(subjectPermissions).where(eq(subjectPermissions.teacherId, teacherId));

        let newPerms: SubjectPermission[] = [];
        if (permissionsInput.length > 0) {
          const inserted = await tx
            .insert(subjectPermissions)
            .values(
              permissionsInput.map((p) => ({
                teacherId,
                program: p.program,
                subject: p.subject,
                subSubject: p.subSubject,
                canView: p.canView,
                canUpload: p.canUpload,
              })),
            )
            .returning();
          newPerms = inserted.map((row) => mapPermission(row));
        }
        return newPerms;
      });

      await this.db.insert(auditLogs).values({
        action: 'permission_change' as AuditAction,
        teacherId: teacherInfo.id,
        teacherName: teacherInfo.name,
        wecomUserId: teacherInfo.wecomUserId,
        ipAddress: operatorIp,
        detail: `更新科目权限，共 ${permissionsInput.length} 条`,
        success: true,
      });

      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`更新教师权限失败 teacherId=${teacherId}: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async getTeachersWithPermissions(teacherIds: string[]): Promise<Map<string, SubjectPermission[]>> {
    if (teacherIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(subjectPermissions)
      .where(inArray(subjectPermissions.teacherId, teacherIds));
    const map = new Map<string, SubjectPermission[]>();
    for (const row of rows) {
      const perm = mapPermission(row);
      const existing = map.get(perm.teacherId) ?? [];
      existing.push(perm);
      map.set(perm.teacherId, existing);
    }
    return map;
  }
}
