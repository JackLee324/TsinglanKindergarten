import {
  Inject,
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/database/database.module';
import { withRbacWriteContext } from '@server/database/rbac-write-context';

import {
  teachersTable,
  subjectPermissionsTable,
  accountPermissionOverrides,
  accountScopes,
} from '@server/database/schema';
import {
  roleDefaults,
  isKnownPermission,
  isKnownRole,
  canGrantRole,
  canManageAccount,
  highestRole,
  isProtectedRole,
  scopeSatisfies,
  isPlatformAdmin,
  roleSubjectScope,
  roleScopeCovers,
  SUPER_ADMIN_ROLE,
  ROLE_RANK,
  DATA_SCOPED_PERMISSIONS,
  type RoleCode,
  type PermissionCode,
  type ProgramCode,
  type ScopeBinding,
  type WritableScopeBinding,
  type ScopeTarget,
  type EffectivePermissions,
} from '@shared/rbac';

/**
 * AuthorizationService — the SINGLE authorization entry point.
 * ===========================================================
 *
 * WHY THIS EXISTS
 *   Before this service, authorization was 37 scattered `roles.includes(...)`
 *   checks spread over 7 files, with different controllers enforcing different
 *   subsets (and some enforcing none). Any new endpoint could silently omit a
 *   check, and there was no way to express "which data" — only "yes/no".
 *
 * EVERY authorization decision must go through:
 *     await this.authz.requirePermission(actor, 'resource.delete', target)
 * and every privilege MUTATION through the `admin*` methods below, which enforce
 * `canGrantRole` / `canManageAccount` and write an audit record.
 *
 * TWO LAYERS OF DEFENCE
 *   1. This service — readable rules, audit trail, good error messages.
 *   2. Database triggers from migration 0003 — they hold even if some code path
 *      forgets to call this service. In particular a `principal` cannot promote
 *      anyone (including itself) to `super_admin`, nor touch a `super_admin` row.
 *
 * CRITICAL IMPLEMENTATION CONSTRAINT
 *   The trigger reads the transaction-local setting `app.rbac_actor_super_admin`.
 *   `set_config(..., true)` is TRANSACTION-LOCAL and is lost between autocommit
 *   statements (verified in tests/rbac-database.test.mjs). Super-admin writes
 *   therefore go through `withSuperAdminAuthority()`, which opens one explicit
 *   transaction, declares the authority, performs the write, and commits.
 *   Without that wrapper every legitimate super-admin write fails closed with 42501.
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  // ===========================================================================
  // Effective permission resolution
  // ===========================================================================

  /**
   * Compute the effective permission set for an account.
   *
   *   effective = (role defaults  ∪  grants)  −  denies
   *
   * `deny` always wins. Expired overrides are ignored.
   */
  async getEffectivePermissions(teacherId: string): Promise<EffectivePermissions> {
    const teacherRows = await this.db
      .select({
        id: teachersTable.id,
        roles: teachersTable.roles,
        status: teachersTable.status,
        permissionsVersion: teachersTable.permissionsVersion,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (teacherRows.length === 0) {
      throw new NotFoundException('账号不存在');
    }
    const row = teacherRows[0];
    const roles = ((row.roles ?? []) as RoleCode[]).filter(isKnownRole);

    const base = roleDefaults(roles);

    const overrideRows = await this.db
      .select({
        permission: accountPermissionOverrides.permission,
        effect: accountPermissionOverrides.effect,
        expiresAt: accountPermissionOverrides.expiresAt,
      })
      .from(accountPermissionOverrides)
      .where(eq(accountPermissionOverrides.teacherId, teacherId));

    const now = Date.now();
    const granted: PermissionCode[] = [];
    const denied: PermissionCode[] = [];

    for (const o of overrideRows) {
      if (!isKnownPermission(o.permission)) {
        // An override for a permission that no longer exists in the catalog is
        // ignored rather than trusted. Recorded so it can be cleaned up.
        this.logger.warn(
          `Stale permission override ignored: teacher=${teacherId} permission=${o.permission}`,
        );
        continue;
      }
      if (o.expiresAt && new Date(o.expiresAt).getTime() <= now) continue;
      if (o.effect === 'grant') granted.push(o.permission);
      else denied.push(o.permission);
    }

    const effective = new Set<PermissionCode>(base);
    for (const p of granted) effective.add(p);
    for (const p of denied) effective.delete(p);

    const scopeRows = await this.db
      .select({
        permission: accountScopes.permission,
        kind: accountScopes.kind,
        program: accountScopes.program,
        subject: accountScopes.subject,
        subSubject: accountScopes.subSubject,
      })
      .from(accountScopes)
      .where(eq(accountScopes.teacherId, teacherId));

    const scopes: WritableScopeBinding[] = scopeRows.map((s) => ({
      permission: s.permission ?? null,
      kind: s.kind as ScopeBinding['kind'],
      program: s.program ?? null,
      subject: s.subject ?? undefined,
      subSubject: s.subSubject ?? null,
      // permission is carried through for targeted scoping
      ...(s.permission ? { permission: s.permission } : {}),
    }));

    return {
      teacherId,
      roles,
      permissions: [...effective].sort(),
      sources: {
        fromRoles: [...base].sort(),
        granted: [...new Set(granted)].sort(),
        denied: [...new Set(denied)].sort(),
      },
      scopes,
      permissionsVersion: row.permissionsVersion ?? 1,
    };
  }

  /** Roles of an account, filtered to known ones. */
  async rolesOf(teacherId: string): Promise<RoleCode[]> {
    const rows = await this.db
      .select({ roles: teachersTable.roles })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);
    if (rows.length === 0) return [];
    return ((rows[0].roles ?? []) as RoleCode[]).filter(isKnownRole);
  }

  // ===========================================================================
  // Permission checks
  // ===========================================================================

  /**
   * Does `authz` satisfy `permission`, optionally for a specific data `target`?
   *
   * Scope semantics (see RBAC.md §7):
   *   - System/administrative permissions are not data-scoped: permission alone decides.
   *   - Data-scoped permissions consult the account's scope bindings. If the
   *     account has none, the permission is allowed: `subject_permissions` (the
   *     pre-existing table) is still applied by the calling service, exactly as
   *     before this change, so existing accounts keep their current behaviour.
   */
  can(
    authz: EffectivePermissions,
    permission: PermissionCode,
    target?: ScopeTarget,
  ): boolean {
    if (!authz.permissions.includes(permission)) return false;
    if (!DATA_SCOPED_PERMISSIONS.includes(permission)) return true;
    if (!target) return true;

    // super_admin bypasses scope entirely (RBAC.md §3.1).
    if (authz.roles.includes(SUPER_ADMIN_ROLE)) return true;

    // 不再强转：`authz.scopes` 的类型本身就带 `permission`
    // （库里的 `account_scopes.permission` 一直被读出来又被丢掉，
    // 于是这里只能靠 `as` 把它"变"回来 —— 那是类型定义错了，不是用法特殊）。
    const relevant = authz.scopes.filter((s) => !s.permission || s.permission === permission);
    if (relevant.length === 0) return true; // no binding => governed by subject_permissions

    return relevant.some((binding) => scopeSatisfies(binding, target, authz.teacherId));
  }

  /** Throwing form of `can`. Every guarded endpoint must use this. */
  require(
    authz: EffectivePermissions,
    permission: PermissionCode,
    target?: ScopeTarget,
  ): void {
    if (this.can(authz, permission, target)) return;

    this.logger.warn(
      `Permission denied: teacher=${authz.teacherId} roles=[${authz.roles.join(',')}] ` +
        `permission=${permission} target=${JSON.stringify(target ?? null)}`,
    );
    throw new ForbiddenException(`缺少权限：${permission}`);
  }

  /** Requires super_admin specifically (not merely many permissions). */
  requireSuperAdmin(authz: EffectivePermissions): void {
    if (authz.roles.includes(SUPER_ADMIN_ROLE)) return;
    throw new ForbiddenException('该操作仅系统超级管理员可执行');
  }

  // ===========================================================================
  // Privilege mutation guards (application layer)
  // ===========================================================================

  /** Throws unless the actor outranks the role being granted (RBAC.md §3.2). */
  assertCanGrantRole(actorRoles: readonly RoleCode[], targetRole: RoleCode): void {
    if (!canGrantRole(actorRoles, targetRole)) {
      throw new ForbiddenException(
        `无权授予角色 ${targetRole}（不能授予不低于自身等级的角色，且 super_admin 只能由 super_admin 授予）`,
      );
    }
  }

  /** Throws unless the actor may administer the target account at all. */
  async assertCanManageAccount(
    actorRoles: readonly RoleCode[],
    targetTeacherId: string,
  ): Promise<RoleCode[]> {
    const targetRoles = await this.rolesOf(targetTeacherId);
    if (!canManageAccount(actorRoles, targetRoles)) {
      throw new ForbiddenException('无权管理该账号（不能管理同级或更高级别的账号）');
    }
    return targetRoles;
  }

  /** Validates a requested role set against the catalog and the grant ceiling. */
  validateAssignableRoles(actorRoles: readonly RoleCode[], requested: unknown): RoleCode[] {
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new BadRequestException('至少需要指定一个角色');
    }
    const roles: RoleCode[] = [];
    for (const r of requested) {
      if (!isKnownRole(r)) {
        throw new BadRequestException(`未知角色：${String(r)}`);
      }
      this.assertCanGrantRole(actorRoles, r);
      roles.push(r);
    }
    return [...new Set(roles)];
  }

  // ===========================================================================
  // Super-admin authority plumbing
  // ===========================================================================

  /**
   * Run `fn` in a transaction that declares super-admin authority, so the
   * database triggers permit modifying a `super_admin` row.
   *
   * MUST be used for every write that touches an account holding super_admin:
   * role changes, status changes, username/name/email edits and password resets.
   * Operational writes (last_login_at, failed_login_attempts) do NOT need it —
   * the trigger deliberately exempts them so login keeps working.
   */
  async withSuperAdminAuthority<T>(
    actor: { id: string; roles: readonly RoleCode[] },
    fn: (tx: PostgresJsDatabase) => Promise<T>,
  ): Promise<T> {
    this.requireSuperAdmin({
      teacherId: actor.id,
      roles: [...actor.roles],
      permissions: [],
      sources: { fromRoles: [], granted: [], denied: [] },
      scopes: [],
      permissionsVersion: 0,
    });

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.rbac_actor_super_admin', 'on', true)`);
      await tx.execute(sql`select set_config('app.rbac_actor_id', ${actor.id}, true)`);
      return fn(tx as unknown as PostgresJsDatabase);
    });
  }

  /** Declare a non-privileged actor id for the duration of one transaction. */
  async withActor<T>(
    actorId: string,
    fn: (tx: PostgresJsDatabase) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.rbac_actor_id', ${actorId}, true)`);
      return fn(tx as unknown as PostgresJsDatabase);
    });
  }

  // ===========================================================================
  // Privilege mutation operations (each enforces its guards)
  // ===========================================================================

  /**
   * Replace an account's roles. Enforces:
   *   - actor may grant every requested role (ceiling rule, super_admin rule)
   *   - actor may manage the target account as it stands
   *   - assigning super_admin requires super_admin authority
   * The database trigger bumps permissions_version automatically, so every live
   * session for this account becomes stale and is forced to re-authenticate.
   */
  async setRoles(
    actor: { id: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    requestedRoles: unknown,
  ): Promise<{ before: RoleCode[]; after: RoleCode[] }> {
    const before = await this.assertCanManageAccount(actor.roles, targetTeacherId);
    const after = this.validateAssignableRoles(actor.roles, requestedRoles);

    const touchesSuperAdmin =
      before.includes(SUPER_ADMIN_ROLE) || after.includes(SUPER_ADMIN_ROLE);

    const write = async (tx: PostgresJsDatabase) => {
      await tx
        .update(teachersTable)
        .set({ roles: after as unknown as string[] })
        .where(eq(teachersTable.id, targetTeacherId));
    };

    if (touchesSuperAdmin) {
      await this.withSuperAdminAuthority(actor, write);
    } else {
      await write(this.db);
    }

    return { before, after };
  }

  /** Grant or deny a single permission for one account. */
  async setPermissionOverride(
    actor: { id: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    permission: string,
    effect: 'grant' | 'deny',
    reason?: string,
    expiresAt?: Date | null,
  ): Promise<void> {
    if (!isKnownPermission(permission)) {
      throw new BadRequestException(`未知权限：${permission}`);
    }
    // A denied actor must not be able to deny permissions (that is itself a
    // privilege operation); the route-level permission check covers this, but we
    // re-assert here so a direct service call is also safe.
    await this.assertCanManageAccount(actor.roles, targetTeacherId);

    // 必须在 `authenticated_` 下写：这张表上的 AFTER 触发器会去 UPDATE
    // `teachers.permissions_version`，而 migration 0005 已 REVOKE 掉 `anon_` 在
    // teachers 上的 UPDATE。以前这条语句是**必 500** 的（42501，而且报的是 teachers，
    // 不是本次要写的表），所以这套机制不只是"没人调用"，是"调用了也跑不起来"。
    // 详见 server/database/rbac-write-context.ts。
    await withRbacWriteContext(this.db, actor.id, async (tx) => {
      await tx.unsafe(
        `INSERT INTO account_permission_overrides
           (teacher_id, permission, effect, reason, granted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (teacher_id, permission) DO UPDATE
           SET effect = EXCLUDED.effect,
               reason = EXCLUDED.reason,
               granted_by = EXCLUDED.granted_by,
               expires_at = EXCLUDED.expires_at`,
        [targetTeacherId, permission, effect, reason ?? null, actor.id, expiresAt ?? null],
      );
    });
  }

  async clearPermissionOverride(
    actor: { id: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    permission: string,
  ): Promise<void> {
    await this.assertCanManageAccount(actor.roles, targetTeacherId);
    // 同上：DELETE 也会触发那个 bump 触发器，所以同样需要 authenticated_。
    await withRbacWriteContext(this.db, actor.id, async (tx) => {
      await tx.unsafe(
        'DELETE FROM account_permission_overrides WHERE teacher_id = $1 AND permission = $2',
        [targetTeacherId, permission],
      );
    });
  }

  /** Replace all scope bindings for an account in one transaction. */
  async setScopes(
    actor: { id: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    bindings: Array<{
      permission?: string | null;
      kind: ScopeBinding['kind'];
      program?: string | null;
      subject?: string | null;
      subSubject?: string | null;
    }>,
  ): Promise<void> {
    await this.assertCanManageAccount(actor.roles, targetTeacherId);
    for (const b of bindings) {
      if (b.permission && !isKnownPermission(b.permission)) {
        throw new BadRequestException(`未知权限：${b.permission}`);
      }
      /**
       * **形状校验**：`kind` 决定了哪些字段必须/不得出现。
       *
       * WHY: 这条规则**已经**由数据库约束 `account_scopes_shape_check`
       * （migration 0003）强制着 —— 但只靠它，非法输入会以 Postgres 的
       * 约束违例冒上来，客户端收到的是 **500**，而不是"你少填了 subject"。
       * 实测就是这么发现的：`{ kind: 'SUBJECT', program: 'prek' }`（缺 subject）
       * 返回 500 —— 一次完全正常的表单错误被报成了服务端故障，
       * 管理员看不出该改什么，监控上还多一条假告警。
       *
       * 所以这里**故意**把 DB 约束的规则在代码里再说一遍，但目的不同：
       * DB 约束是**执行**，这段是**解释**。两者分叉会很难查（一边放行、一边 500），
       * 因此 `tests/data-scope-shape.test.mjs` 用同一张真值表把两边钉在一起。
       */
      switch (b.kind) {
        case 'ALL':
        case 'OWN':
          if (b.program || b.subject || b.subSubject) {
            throw new BadRequestException(
              `kind=${b.kind} 表示"全部"或"仅自己创建"，不能再指定 program / subject / subSubject`,
            );
          }
          break;
        case 'PROGRAM':
          if (!b.program) {
            throw new BadRequestException('kind=PROGRAM 必须指定 program（例如 prek / k）');
          }
          if (b.subject || b.subSubject) {
            throw new BadRequestException('kind=PROGRAM 只能指定 program，不能同时指定 subject / subSubject');
          }
          break;
        case 'SUBJECT':
          if (!b.program || !b.subject) {
            throw new BadRequestException(
              'kind=SUBJECT 必须同时指定 program 与 subject（例如 prek + virtue）',
            );
          }
          break;
        default:
          throw new BadRequestException(`未知的数据范围 kind：${String(b.kind)}`);
      }
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(accountScopes).where(eq(accountScopes.teacherId, targetTeacherId));
      if (bindings.length > 0) {
        await tx.insert(accountScopes).values(
          bindings.map((b) => ({
            teacherId: targetTeacherId,
            permission: b.permission ?? null,
            kind: b.kind,
            program: b.program ?? null,
            subject: b.subject ?? null,
            subSubject: b.subSubject ?? null,
            createdBy: actor.id,
          })),
        );
      }
    });
  }

  /**
   * Enable or disable an account. Disabling takes effect immediately:
   *   - the database trigger bumps permissions_version (roles/status change),
   *   - and all of the account's sessions are revoked in the same transaction,
   * so a disabled user cannot keep using an existing session.
   */
  async setStatus(
    actor: { id: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    status: 'active' | 'inactive',
    reason?: string,
  ): Promise<void> {
    if (status !== 'active' && status !== 'inactive') {
      throw new BadRequestException('状态必须是 active 或 inactive');
    }
    await this.assertCanManageAccount(actor.roles, targetTeacherId);

    const targetRoles = await this.rolesOf(targetTeacherId);
    const touchesSuperAdmin = targetRoles.includes(SUPER_ADMIN_ROLE);

    const write = async (tx: PostgresJsDatabase) => {
      await tx
        .update(teachersTable)
        .set({ status })
        .where(eq(teachersTable.id, targetTeacherId));

      if (status === 'inactive') {
        // Immediate effect: revoke every live session for this account.
        await tx.execute(sql`
          UPDATE sessions
             SET revoked = true,
                 revoked_at = CURRENT_TIMESTAMP,
                 revoke_reason = ${reason ?? 'account_disabled'}
           WHERE teacher_id = ${targetTeacherId}
             AND revoked = false
        `);
      }
    };

    if (touchesSuperAdmin) {
      await this.withSuperAdminAuthority(actor, write);
    } else {
      await write(this.db);
    }
  }

  /** Revoke every live session for an account (force logout). */
  async revokeAllSessions(
    actor: { id: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    reason: string,
  ): Promise<number> {
    await this.assertCanManageAccount(actor.roles, targetTeacherId);
    const result = await this.db.execute(sql`
      UPDATE sessions
         SET revoked = true,
             revoked_at = CURRENT_TIMESTAMP,
             revoke_reason = ${reason}
       WHERE teacher_id = ${targetTeacherId}
         AND revoked = false
      RETURNING id
    `);
    const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown[]);
    return Array.isArray(rows) ? rows.length : 0;
  }

  // ===========================================================================
  // 科目级数据范围 —— **唯一**实现
  // ===========================================================================

  /**
   * 「这个账号能不能在这个 (班型, 科目[, 子科目]) 上做这件事」—— 全平台只有这一份实现。
   *
   * WHY THIS METHOD EXISTS
   *   在这之前，这条规则在 `resources.service.ts` 里被完整实现了一遍
   *   （自己查 `teachers.roles`、自己调 `isPlatformAdmin` / `roleScopeCovers`、
   *   自己查 `subject_permissions` 并处理"只配了父科目"的回落），
   *   而 `AuthorizationService.hasSubjectPermission()` 又实现了
   *   `subject_permissions` 那一半。于是同一个问题有两个答案来源，
   *   改一处漏一处只是时间问题 —— 这正是 §3 要清掉的东西。
   *
   * 判定顺序（**刻意与旧实现逐条一致**，这是一次搬移而不是改写）：
   *   1. 账号不存在 → false（失败关闭）
   *   2. 平台管理员（principal / curriculum_director / super_admin）→ true
   *   3. 角色范围覆盖该 (program, subject) → true（prek_head → 整个 prek；等等）
   *   4. 否则查 `subject_permissions`；只配了科目没配子科目时，子科目查询回落到父行
   *   5. 都没有 → false
   *
   * 为什么不顺手把它改成"先查权限码再查范围"：那会改变语义。
   * 权限码（`resource.view` 等）与 `subject_permissions` 是两层，
   * 有些账号靠后者拿访问权而不持有对应的角色默认权限码。合并会静默收窄权限，
   * 而"收窄"在权限系统里同样是缺陷。搬移保持行为，语义变更要单独做、单独验。
   */
  async canAccessSubject(
    teacherId: string,
    action: 'view' | 'upload',
    program: ProgramCode | string,
    subject: string,
    subSubject?: string,
  ): Promise<boolean> {
    const teacherRows = await this.db
      .select({ roles: teachersTable.roles })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (teacherRows.length === 0) return false;
    const roles = ((teacherRows[0].roles ?? []) as RoleCode[]).filter(isKnownRole);

    if (isPlatformAdmin(roles)) return true;
    if (roleScopeCovers(roleSubjectScope(roles), program as ProgramCode, subject)) return true;

    return this.hasSubjectPermission(teacherId, program, subject, subSubject, action);
  }

  /**
   * 平台管理员（能看到全部课程数据的账号）—— 规则在 `shared/rbac.ts`，
   * 这里只是**唯一**的读取口。各服务不再直接 import `isPlatformAdmin`，
   * 于是"谁算管理员"这个问题只有一处可改。
   */
  isPlatformAdminAccount(roles: readonly RoleCode[] | string[]): boolean {
    return isPlatformAdmin(roles as RoleCode[]);
  }

  /**
   * 角色范围结构（`roleSubjectScope`）—— 同上，唯一读取口。
   * 给需要把范围翻译成 SQL 条件的地方用（如资源列表过滤）：
   * 规则仍然只有一份，调用方只做翻译。
   */
  subjectScopeOf(roles: readonly RoleCode[] | string[]) {
    return roleSubjectScope((roles ?? []) as RoleCode[]);
  }

  /**
   * `subject_permissions` 里"这个账号能看哪些 (program, subject, subSubject)"——
   * 布尔版是 `hasSubjectPermission`，这是它的列表版。
   *
   * 为什么需要列表版：资源列表要把范围**翻译成 SQL**，而 SQL 条件需要枚举，
   * 不是一个是/否。以前这个枚举在 `resources.service.ts` 里自己查表，
   * 于是 `subject_permissions` 的读取散落成三处。现在两版都在这里，
   * 表结构变了也只有这一处要改。
   */
  async subjectPermissionRowsFor(
    teacherId: string,
    action: 'view' | 'upload',
    filter?: { program?: string; subject?: string },
  ): Promise<Array<{ program: string; subject: string; subSubject: string | null }>> {
    const conditions = [
      eq(subjectPermissionsTable.teacherId, teacherId),
      eq(
        action === 'view' ? subjectPermissionsTable.canView : subjectPermissionsTable.canUpload,
        true,
      ),
    ];
    if (filter?.program) conditions.push(eq(subjectPermissionsTable.program, filter.program));
    if (filter?.subject) conditions.push(eq(subjectPermissionsTable.subject, filter.subject));

    return this.db
      .select({
        program: subjectPermissionsTable.program,
        subject: subjectPermissionsTable.subject,
        subSubject: subjectPermissionsTable.subSubject,
      })
      .from(subjectPermissionsTable)
      .where(and(...conditions));
  }

  // ===========================================================================
  // Legacy bridge — subject_permissions
  // ===========================================================================

  /**
   * Existing per-subject upload/view grants. Kept because the 20 seeded accounts
   * and any data already in production rely on this table; `account_scopes` is
   * layered on top rather than replacing it (no migration risk).
   */
  async hasSubjectPermission(
    teacherId: string,
    program: string,
    subject: string,
    subSubject: string | undefined,
    action: 'view' | 'upload',
  ): Promise<boolean> {
    const conditions = [
      eq(subjectPermissionsTable.teacherId, teacherId),
      eq(subjectPermissionsTable.program, program),
      eq(subjectPermissionsTable.subject, subject),
    ];
    if (subSubject) {
      conditions.push(eq(subjectPermissionsTable.subSubject, subSubject));
    } else {
      conditions.push(isNull(subjectPermissionsTable.subSubject));
    }

    const rows = await this.db
      .select({
        canView: subjectPermissionsTable.canView,
        canUpload: subjectPermissionsTable.canUpload,
      })
      .from(subjectPermissionsTable)
      .where(and(...conditions))
      .limit(1);

    if (rows.length > 0) {
      return action === 'view' ? rows[0].canView : rows[0].canUpload;
    }
    return false;
  }

  // ===========================================================================
  // Helpers used by the guard
  // ===========================================================================

  /** Highest role of an actor, for the grant-ceiling rule. */
  actorRank(roles: readonly RoleCode[]): number {
    const top = highestRole(roles);
    return top === null ? -1 : ROLE_RANK[top];
  }

  isProtected(role: RoleCode): boolean {
    return isProtectedRole(role);
  }
}
