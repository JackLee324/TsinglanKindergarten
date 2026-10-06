import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import type { WritableScopeBinding } from '@shared/rbac';
import { withRbacWriteContext } from '@server/database/rbac-write-context';
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

  // ===========================================================================
  // §11 按账号授权 —— 追加授权 / 显式禁止
  // ===========================================================================
  //
  // RBAC.md §5 把模型写死了：
  //
  //     有效权限 = ( 角色默认权限的并集 ∪ 追加授权 ) − 显式禁止      （禁止永远优先）
  //
  // 表（`account_permission_overrides`）、读（`getEffectivePermissions`）、
  // 写（`setPermissionOverride` / `clearPermissionOverride`）三样早已存在，
  // 但**没有任何 API 或界面调用过它们** —— 需求第七条
  // 「角色默认权限 + 单独追加权限 + 单独撤销权限」在代码里定义完整却完全无法使用。
  // 下面把这条链路接上，每次变更都写 `permission_change` 审计。

  /** 读取某个账号的**生效权限**（含每一项的来源：角色默认 / 追加 / 被禁止）。 */
  async getAccountEffectivePermissions(targetTeacherId: string): Promise<EffectivePermissions> {
    const target = await this.requireTeacher(targetTeacherId);
    void target;
    return this.authz.getEffectivePermissions(targetTeacherId);
  }

  /** 追加授权（grant）或显式禁止（deny）某一个权限。 */
  async overrideAccountPermission(
    targetTeacherId: string,
    permission: string,
    effect: 'grant' | 'deny',
    reason: string | undefined,
    actor: { id: string; name: string; roles: readonly RoleCode[] },
    operatorIp?: string,
  ): Promise<EffectivePermissions> {
    const target = await this.requireTeacher(targetTeacherId);

    // 接口层的权限只回答"能不能做这类事"，不回答"能不能对**这个人**做"。
    // 与角色变更同一套理由：两件事都要成立（assertCanManageAccount 在 service 里再挡一次）。
    await this.authz.setPermissionOverride(
      { id: actor.id, roles: actor.roles },
      targetTeacherId,
      permission,
      effect,
      reason,
    );

    await this.db.insert(auditLogs).values({
      action: 'permission_change' as AuditAction,
      teacherId: targetTeacherId,
      teacherName: target.name,
      ipAddress: operatorIp,
      detail:
        `${effect === 'grant' ? '追加授权' : '显式禁止'} ${permission}；` +
        `目标角色=${(target.roles ?? []).join(',')}；操作人=${actor.name}` +
        (reason ? `；理由=${reason}` : ''),
      success: true,
    });

    return this.authz.getEffectivePermissions(targetTeacherId);
  }

  /** 清除覆盖项，让该权限回到角色默认。 */
  async clearAccountPermissionOverride(
    targetTeacherId: string,
    permission: string,
    actor: { id: string; name: string; roles: readonly RoleCode[] },
    operatorIp?: string,
  ): Promise<EffectivePermissions> {
    const target = await this.requireTeacher(targetTeacherId);

    await this.authz.clearPermissionOverride(
      { id: actor.id, roles: actor.roles },
      targetTeacherId,
      permission,
    );

    await this.db.insert(auditLogs).values({
      action: 'permission_change' as AuditAction,
      teacherId: targetTeacherId,
      teacherName: target.name,
      ipAddress: operatorIp,
      detail:
        `清除覆盖项 ${permission}（回到角色默认）；` +
        `目标角色=${(target.roles ?? []).join(',')}；操作人=${actor.name}`,
      success: true,
    });

    return this.authz.getEffectivePermissions(targetTeacherId);
  }

  // ===========================================================================
  // §12 数据范围（scope）—— 查看与编辑
  // ===========================================================================
  //
  // `AuthorizationService.setScopes()` 与 `account_scopes` 表早就存在，
  // 但**没有任何 API 或界面能调用它们** —— 于是"把某个主任的数据范围限制到
  // 只有 Pre-K"这件事，在库里定义完整、在界面里完全不可达。
  // 与上面 grant/deny 那段同样的处境，所以同样在这里把链路接上。
  //
  // 语义（与 `shared/rbac.ts` 的 `scopeSatisfies` 逐字一致，不另立一套）：
  //   · **空数组 = 不受限**，按角色默认（这是刻意的：绝大多数账号不需要显式绑定）；
  //   · 一旦有绑定，就按 kind 判定：ALL / PROGRAM / SUBJECT / OWN；
  //   · `permission` 为 null 表示该绑定对**所有数据权限**生效。
  //
  // 写路径全部由 `setScopes()` 在**一个事务里整表替换**，不做增量 —— 增量容易
  // 在并发下留下半套绑定，而"半套绑定"在权限系统里的表现是"有人能看到不该看的"。

  /** 读取某个账号的数据范围绑定（空数组 = 按角色默认，不受限）。 */
  async getAccountScopes(targetTeacherId: string): Promise<{ scopes: WritableScopeBinding[] }> {
    await this.requireTeacher(targetTeacherId);
    const effective = await this.authz.getEffectivePermissions(targetTeacherId);
    return { scopes: effective.scopes };
  }

  /**
   * 整表替换某个账号的数据范围绑定。
   *
   * `bindings: []`（空数组）是**合法输入**，含义是"清除全部显式绑定、回到角色默认"。
   * 不提供"清空=省略"的写法：省略与"清空"必须能区分，否则一次忘记传字段的
   * 请求就会静默把人的数据范围放大到角色默认。
   */
  async setAccountScopes(
    targetTeacherId: string,
    bindings: WritableScopeBinding[],
    actor: { id: string; name: string; roles: readonly RoleCode[] },
    operatorIp?: string,
  ): Promise<{ scopes: WritableScopeBinding[] }> {
    const target = await this.requireTeacher(targetTeacherId);

    await this.authz.setScopes({ id: actor.id, roles: actor.roles }, targetTeacherId, bindings);

    await this.db.insert(auditLogs).values({
      action: 'permission_change' as AuditAction,
      teacherId: targetTeacherId,
      teacherName: target.name,
      ipAddress: operatorIp,
      detail:
        `设置数据范围：` +
        (bindings.length === 0
          ? '清除全部显式绑定（回到角色默认）'
          : bindings
              .map(
                (b) =>
                  `${b.permission ?? '（全部数据权限）'}=${b.kind}` +
                  (b.program ? `/${b.program}` : '') +
                  (b.subject ? `/${b.subject}` : '') +
                  (b.subSubject ? `/${b.subSubject}` : ''),
              )
              .join('、')) +
        `；目标角色=${(target.roles ?? []).join(',')}；操作人=${actor.name}`,
      success: true,
    });

    const effective = await this.authz.getEffectivePermissions(targetTeacherId);
    return { scopes: effective.scopes };
  }

  /** 取账号且不存在就抛 404（三处共用一份判定）。 */
  private async requireTeacher(id: string): Promise<{ name: string; roles: RoleCode[] }> {
    const rows = await this.db
      .select({ name: teachers.name, roles: teachers.roles })
      .from(teachers)
      .where(eq(teachers.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('账号不存在');
    return { name: rows[0].name, roles: (rows[0].roles ?? []) as RoleCode[] };
  }

  /**
   * 角色分配权限（`role.assign`）。
   *
   * 判定读的是**生效权限**（含按账号的追加授权/显式禁止），不是角色列表 ——
   * 与 AuthGuard 交给 PermissionGuard 的是同一份数据，所以两边不可能给出不同答案。
   *
   * `authz` 缺失时**拒绝**（fail closed）：那说明接口层漏传了上下文。
   * 漏传没有任何症状，正是这条权限长期变成幽灵权限的原因。
   *
   * ⚠️ 这个方法的存在本身就是一次事故的产物：上一轮我把 `authz` 形参加进了
   * createTeacher/updateTeacher、调用方也传了，但**方法体里从没读过它** ——
   * 于是"强制 role.assign"根本没发生，而 lint 的 `args: 'after-used'`
   * 对"后面还有别的参数被使用"的情况不会报警，静默通过。
   * 现在 eslint 已改为 `args: 'all'`，这类"加了参数却没用"会被报出来。
   */
  private assertCanAssignRoles(authz: EffectivePermissions | undefined, what: string): void {
    if (!authz) {
      throw new ForbiddenException(`缺少生效权限上下文，拒绝${what}`);
    }
    if (!authz.permissions.includes(ROLE_ASSIGN_PERMISSION)) {
      throw new ForbiddenException(`缺少权限：${ROLE_ASSIGN_PERMISSION}（无法${what}）`);
    }
  }

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
    _operatorId: string,
    _operatorName: string,
    operatorRoles: RoleCode[],
    authz: EffectivePermissions | undefined,
    operatorIp?: string,
  ): Promise<TeacherDetail> {
    // §9：角色不是"随便传的字段"。DTO 只保证"是已知角色"，**谁能授予**由这里决定：
    // 不能授予不低于自身等级的角色，且 super_admin 只能由 super_admin 授予。
    //
    // §4：`role.assign` 必须真的拦住。`validateAssignableRoles` 回答的是
    // "你能不能授予**这个**角色"（等级规则），它不回答"你有没有变更角色的**能力**"。
    this.assertCanAssignRoles(authz, '创建账号时指定角色');
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
    _operatorName: string,
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
      // §4：`assertCanManageAccount` 管的是"不能动同级/更高级"，不等价于
      // "你有权分配角色"。两件事都要成立，所以 `role.assign` 也在这里挡一次。
      this.assertCanAssignRoles(authz, '变更账号角色');
      await this.authz.assertCanManageAccount(operatorRoles, id);
      nextRoles = this.authz.validateAssignableRoles(operatorRoles, dto.roles);
      patch.roles = nextRoles;
    }
    if (dto.status !== undefined) patch.status = dto.status;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }

    try {
      // 必须在 `authenticated_` 下写。`teachers` 的 UPDATE 权限在 migration 0005 里
      // 已从 `anon_` 收回（只重新授予了 last_login_at / failed_login_attempts /
      // locked_until 三列），而每个 HTTP 请求默认以 `anon_` 执行 SQL ——
      // 所以这条语句**一直是 500**（42501 permission denied for table teachers）。
      // 它此前没被发现，是因为改角色的用例都会在授权判定那一步就被拒绝、走不到写入，
      // 而"只改名字"这条路径没有任何套件覆盖。本轮由 §11 的行为测试带出来。
      // 写入走原生 SQL（为了切角色），读回仍用 drizzle —— 这样方法其余部分拿到的
      // 依旧是完整的、有类型的行，不必把列名一个个抄进 RETURNING 里。
      const cols = Object.keys(patch);
      await withRbacWriteContext(this.db, operatorId, async (tx) => {
        const sets = cols.map((k, i) => `"${toSnake(k)}" = $${i + 1}`).join(', ');
        await tx.unsafe(
          `UPDATE teachers SET ${sets} WHERE id = $${cols.length + 1}`,
          [...cols.map((k) => (patch as Record<string, unknown>)[k]), id],
        );
      });
      const updated = await this.db.select().from(teachers).where(eq(teachers.id, id)).limit(1);

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
    _operatorName: string,
    operatorIp?: string,
  ): Promise<void> {
    try {
      // 同上：这也是对 `teachers` 的 UPDATE，同样必须走 authenticated_。
      // 这正是之前 `DELETE /api/teachers/:id` 稳定 500（42501）的根因 ——
      // 当时我把它记成"与本次改动无关的既有缺陷"就搁下了，本轮才定位到。
      // 同样必须走 authenticated_（见 updateTeacher 的注释）：
      // 这就是 `DELETE /api/teachers/:id` 此前稳定 500 的根因。
      await withRbacWriteContext(this.db, operatorId, async (tx) => {
        await tx.unsafe("UPDATE teachers SET status = 'inactive' WHERE id = $1", [id]);
      });
      const updated = await this.db
        .select({ id: teachers.id, name: teachers.name, wecomUserId: teachers.wecomUserId })
        .from(teachers)
        .where(eq(teachers.id, id))
        .limit(1);

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
    _operatorId: string,
    _operatorName: string,
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


/**
 * camelCase → snake_case，仅用于把 patch 的键名映射成列名。
 *
 * 这次写入必须走 `$client`（为了能切到 `authenticated_` 角色），而它只接受原生 SQL，
 * 所以要手拼列名 —— 映射逻辑集中在这一个函数里，避免散落。
 * 只接受本模块真正会写的键；出现未登记的键会抛错，而不是拼出一个坏 SQL。
 */
const COLUMN_NAMES: Record<string, string> = {
  name: 'name',
  nameEn: 'name_en',
  email: 'email',
  roles: 'roles',
  status: 'status',
  mustChangePassword: 'must_change_password',
};

function toSnake(key: string): string {
  const mapped = COLUMN_NAMES[key];
  if (!mapped) {
    throw new BadRequestException(`不支持的更新字段：${key}`);
  }
  return mapped;
}
