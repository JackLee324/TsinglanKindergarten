import {
  Inject,
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql, gt } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';

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
  SUPER_ADMIN_ROLE,
  ROLE_RANK,
  DATA_SCOPED_PERMISSIONS,
  type RoleCode,
  type PermissionCode,
  type ScopeBinding,
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

    const scopes: ScopeBinding[] = scopeRows.map((s) => ({
      kind: s.kind as ScopeBinding['kind'],
      program: (s.program ?? undefined) as ScopeBinding['program'],
      subject: s.subject ?? undefined,
      subSubject: s.subSubject ?? null,
      // permission is carried through for targeted scoping
      ...(s.permission ? { permission: s.permission } : {}),
    })) as ScopeBinding[];

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

    const relevant = (authz.scopes as (ScopeBinding & { permission?: string })[]).filter(
      (s) => !s.permission || s.permission === permission,
    );
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

    await this.db
      .insert(accountPermissionOverrides)
      .values({
        teacherId: targetTeacherId,
        permission,
        effect,
        reason: reason ?? null,
        grantedBy: actor.id,
        expiresAt: expiresAt ?? null,
      })
      .onConflictDoUpdate({
        target: [accountPermissionOverrides.teacherId, accountPermissionOverrides.permission],
        set: {
          effect,
          reason: reason ?? null,
          grantedBy: actor.id,
          expiresAt: expiresAt ?? null,
        },
      });
  }

  async clearPermissionOverride(
    actor: { id: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    permission: string,
  ): Promise<void> {
    await this.assertCanManageAccount(actor.roles, targetTeacherId);
    await this.db
      .delete(accountPermissionOverrides)
      .where(
        and(
          eq(accountPermissionOverrides.teacherId, targetTeacherId),
          eq(accountPermissionOverrides.permission, permission),
        ),
      );
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
