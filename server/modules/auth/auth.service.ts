import {
  Injectable,
  Inject,
  Logger,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  DrizzleDatabaseManager,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

import { SessionService } from './session.service';
import { MfaService } from './mfa.service';
import { AuthorizationService } from '../authz/authorization.service';
import { teachersTable, auditLogs } from '@server/database/schema';
import type { AuthUser, AuditAction, RoleCode, ResetPasswordResponse } from '@shared/api.interface';
import {
  canManageAccount,
  isKnownRole,
  isPrivilegedAccount,
  SUPER_ADMIN_ROLE,
  RESET_PRIVILEGED_PASSWORD_PERMISSION,
  type EffectivePermissions,
} from '@shared/rbac';

import { SEED_TEACHERS } from './seed-teachers';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
/**
 * Per-IP login rate limit.
 *
 * Configurable through the environment (the specification requires the thresholds
 * to be operable, not hard-coded). Defaults keep the previously-shipped behaviour.
 *
 * NOTE (known limitation, tracked in PRODUCTION_READINESS.md §D-12): this counter
 * lives in a per-process Map, so with more than one instance each replica enforces
 * its own budget and the effective limit is multiplied by the replica count. The
 * store is to be abstracted behind a replaceable RateLimitStore; until then this is
 * a brake, not a hard bound.
 *
 * The values are read once at module load; a change requires a restart.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const IP_RATE_LIMIT_WINDOW_MS = readPositiveInt('LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS', 60) * 1000;
const IP_RATE_LIMIT_MAX = readPositiveInt('LOGIN_IP_RATE_LIMIT_MAX', 30);

/** The slice of the postgres.js client this service needs (see writePasswordReset). */
interface RawSqlTransaction {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

interface RawSqlClient {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  begin<T>(fn: (tx: RawSqlTransaction) => Promise<T>): Promise<T>;
}

/**
 * The raw postgres.js client behind a drizzle instance.
 *
 * Drizzle's postgres-js driver attaches it as `$client` (a documented drizzle
 * accessor). The platform's drizzle monkey patch hooks
 * `PostgresJsPreparedQuery.prototype.execute` — drizzle query objects only — so
 * statements issued on this client are the only ones NOT preceded by the
 * platform's `SET LOCAL ROLE 'anon_'` preamble. That is what makes an explicit
 * role switch possible at all; see writePasswordReset.
 *
 * IMPORTANT: this must be called with `DrizzleDatabaseManager.getDatabase()` —
 * the real drizzle instance — NOT with the injected `DRIZZLE_DATABASE`, which is
 * a `Proxy` that rebinds every function-valued property
 * (`typeof sql === 'function'`, so `$client` comes back as a bound copy whose
 * `begin`/`unsafe` are gone). Verified against the running server.
 *
 * Fails loudly rather than quietly writing as the wrong role.
 */
function rawPostgresClient(db: PostgresJsDatabase): RawSqlClient {
  const client = (db as unknown as { $client?: RawSqlClient }).$client;
  if (!client || typeof client.begin !== 'function' || typeof client.unsafe !== 'function') {
    throw new Error(
      'auth: the drizzle instance does not expose a usable postgres.js client ($client), so the ' +
        'privileged password write cannot be performed under the authenticated_ role. ' +
        'Refusing to attempt the write instead of failing with a confusing 42501.',
    );
  }
  return client;
}

interface AuditLogInput {
  action: AuditAction;
  wecomUserId?: string;
  teacherId?: string;
  teacherName?: string;
  ipAddress?: string;
  userAgent?: string;
  detail?: string;
  success: boolean;
  errorMessage?: string;
  resourceId?: string;
  resourceTitle?: string;
  program?: string;
  subject?: string;
}

/**
 * Everything the administrative password reset needs, resolved by the controller:
 * the caller's session identity, the caller's EFFECTIVE permissions (so the
 * service can decide on capabilities instead of on role strings) and the single
 * target selector.
 */
export interface AdminPasswordResetInput {
  /** Effective permissions of the caller, resolved once per request by AuthGuard. */
  authz: EffectivePermissions;
  /** The caller, for the ceiling rule, the super-admin authority and the audit row. */
  actor: { id: string; name: string; roles: readonly RoleCode[] };
  /** Account whose password is being reset — the ONLY target selector accepted. */
  targetTeacherId: string;
  /**
   * A current second factor for the CALLER. Required when the caller has MFA
   * enabled, ignored otherwise. Never logged and never stored.
   */
  mfaCode?: string;
  ipAddress: string;
  userAgent?: string;
}

interface IpRateRecord {
  count: number;
  windowStart: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly ipRateMap = new Map<string, IpRateRecord>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly mfaService: MfaService,
    private readonly authorization: AuthorizationService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    // The platform's database manager, injected for ONE purpose: it exposes the
    // real drizzle instance, whose `$client` is the raw postgres.js client. The
    // `DRIZZLE_DATABASE` token above is a Proxy that rebinds function-valued
    // properties, which strips `$client` of its methods (see rawPostgresClient).
    private readonly dbManager: DrizzleDatabaseManager,
  ) {}

  async onModuleInit(): Promise<void> {
    // -------------------------------------------------------------------------
    // Seed failures MUST NOT be swallowed (project rule: never catch an error
    // and keep starting as if everything succeeded).
    // -------------------------------------------------------------------------
    // This used to be:
    //     try { await this.seedTeachers(); }
    //     catch (err) { this.logger.error(...) }
    // i.e. ANY seeding failure - including "every single insert failed" - was
    // logged and startup continued. Verified consequence on a database built
    // from the shipped `init.sql`: `teachers.wecom_user_id` was NOT NULL while
    // the seed never set it, so all 20 inserts raised 42703/23502, every one was
    // swallowed by the per-account catch below, and the process logged
    // "created=0, skipped=0" and reported itself healthy with ZERO usable
    // accounts. Operators saw a running platform and no way to log in.
    //
    // The policy now distinguishes three outcomes:
    //   * everything skipped  -> accounts already exist, nothing to do
    //   * partial failure     -> loud ERROR naming the accounts, but the system
    //                            is genuinely usable, so do not abort
    //   * TOTAL failure       -> nothing exists and nothing could be created;
    //                            throw so Nest aborts startup
    //                            (`abortOnError` is true outside development)
    // Rather than a silently healthy process with no accounts.
    let seedResult: {
      created: number;
      skipped: number;
      failed: number;
      failedUsernames: string[];
    };
    try {
      seedResult = await this.seedTeachers();
    } catch (err) {
      // Not even attemptable (e.g. the table is missing). Hard failure.
      this.logger.error(
        `Seed teachers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    if (seedResult.failed > 0) {
      const detail = `${seedResult.failed} account(s) could not be seeded: ${seedResult.failedUsernames.join(', ')}`;
      if (seedResult.created === 0 && seedResult.skipped === 0) {
        // Total failure: no account exists and none could be created. Starting
        // anyway would present a login screen that cannot possibly succeed.
        throw new Error(
          `Teacher seeding failed completely (${detail}). Refusing to start with zero usable accounts. ` +
            'Check the database schema against the migrations (node scripts/migrate.mjs status) ' +
            'and re-run with the failures fixed.',
        );
      }
      this.logger.error(
        `Partial teacher seeding failure: ${detail}. The platform is usable, ` +
          'but those accounts will be missing until seeding succeeds.',
      );
    }

    setInterval(() => {
      void this.sessionService.cleanup();
    }, 60 * 60 * 1000);
  }

  private hashPassword(password: string, salt: string): string {
    const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('base64')}`;
  }

  hashPasswordWithRandomSalt(password: string): string {
    const salt = randomBytes(SALT_LEN).toString('base64');
    return this.hashPassword(password, salt);
  }

  private verifyPassword(password: string, hash: string): boolean {
    try {
      const parts = hash.split('$');
      if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
      const n = Number(parts[1]);
      const r = Number(parts[2]);
      const p = Number(parts[3]);
      const salt = parts[4];
      const stored = Buffer.from(parts[5], 'base64');
      const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: n, r, p });
      return timingSafeEqual(stored, derived);
    } catch {
      return false;
    }
  }

  private validatePasswordComplexity(password: string): string | null {
    if (password.length < 10) return '密码至少10位';
    if (!/[A-Z]/.test(password)) return '密码必须包含大写字母';
    if (!/[a-z]/.test(password)) return '密码必须包含小写字母';
    if (!/[0-9]/.test(password)) return '密码必须包含数字';
    return null;
  }

  private checkIpRateLimit(ip: string): boolean {
    const now = Date.now();
    const record = this.ipRateMap.get(ip);
    if (!record || now - record.windowStart > IP_RATE_LIMIT_WINDOW_MS) {
      this.ipRateMap.set(ip, { count: 1, windowStart: now });
      return true;
    }
    record.count += 1;
    if (record.count > IP_RATE_LIMIT_MAX) return false;
    return true;
  }

  generateTemporaryPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const buf = randomBytes(16);
    let result = '';
    for (let i = 0; i < 16; i += 1) {
      result += chars[buf[i] % chars.length];
    }
    return result;
  }

  static generateUsername(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12);
    const suffix = randomBytes(3).toString('hex').slice(0, 4);
    return base || `user_${suffix}`;
  }

  private rowToAuthUser(row: {
    id: string;
    wecomUserId: string | null;
    username: string | null;
    name: string;
    nameEn: string | null;
    roles: string[] | null;
    status: string;
    mustChangePassword: boolean;
  }): AuthUser {
    return {
      id: row.id,
      wecomUserId: row.wecomUserId ?? undefined,
      username: row.username ?? '',
      name: row.name,
      nameEn: row.nameEn ?? undefined,
      roles: (row.roles ?? []) as string[] as AuthUser['roles'],
      status: row.status as 'active' | 'inactive',
      mustChangePassword: row.mustChangePassword,
    };
  }

  private async seedTeachers(): Promise<{
    created: number;
    skipped: number;
    failed: number;
    failedUsernames: string[];
  }> {
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const failedUsernames: string[] = [];
    for (const seed of SEED_TEACHERS) {
      try {
        const existing = await this.db
          .select({ id: teachersTable.id, passwordHash: teachersTable.passwordHash })
          .from(teachersTable)
          .where(
            and(
              sql`lower(${teachersTable.username}) = ${seed.username.toLowerCase()}`,
              isNotNull(teachersTable.username),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          if (!existing[0].passwordHash) {
            await this.db
              .update(teachersTable)
              .set({ passwordHash: seed.passwordHash })
              .where(eq(teachersTable.id, existing[0].id));
            created += 1;
          } else {
            skipped += 1;
          }
          continue;
        }
        await this.db.insert(teachersTable).values({
          username: seed.username.toLowerCase(),
          passwordHash: seed.passwordHash,
          name: seed.name,
          nameEn: seed.nameEn,
          roles: seed.roles as unknown as string[],
          status: 'active',
        });
        created += 1;
      } catch (error: unknown) {
        // Counted, not discarded. The caller decides whether this is tolerable;
        // this function never decides that a failure did not happen.
        failed += 1;
        failedUsernames.push(seed.username);
        this.logger.error(
          `Failed to seed teacher ${seed.username}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.logger.log(
      `Seed teachers: created=${created}, skipped=${skipped}, failed=${failed}`,
    );
    return { created, skipped, failed, failedUsernames };
  }

  async login(
    username: string,
    password: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<
    | { mfaRequired: true; challengeToken: string; expiresAt: string }
    | { mfaRequired: false; sessionId: string; teacher: AuthUser }
  > {
    if (!this.checkIpRateLimit(ipAddress)) {
      throw new ForbiddenException('请求过于频繁，请稍后再试');
    }

    const normalized = username.trim().toLowerCase();
    const rows = await this.db
      .select({
        id: teachersTable.id,
        wecomUserId: teachersTable.wecomUserId,
        username: teachersTable.username,
        name: teachersTable.name,
        nameEn: teachersTable.nameEn,
        roles: teachersTable.roles,
        status: teachersTable.status,
        passwordHash: teachersTable.passwordHash,
        mustChangePassword: teachersTable.mustChangePassword,
        failedLoginAttempts: teachersTable.failedLoginAttempts,
        lockedUntil: teachersTable.lockedUntil,
        permissionsVersion: teachersTable.permissionsVersion,
      })
      .from(teachersTable)
      .where(sql`lower(${teachersTable.username}) = ${normalized}`)
      .limit(1);

    if (rows.length === 0) {
      await this.writeAuditLog({
        action: 'login_failed',
        ipAddress,
        userAgent,
        detail: `username not found: ${normalized}`,
        success: false,
        errorMessage: '用户名或密码错误',
      });
      throw new UnauthorizedException('用户名或密码错误');
    }

    const row = rows[0];
    const now = new Date();

    if (row.lockedUntil && row.lockedUntil > now) {
      await this.writeAuditLog({
        action: 'login_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'account locked',
        success: false,
        errorMessage: '账号已锁定，请稍后再试',
      });
      throw new ForbiddenException('账号已锁定，请稍后再试');
    }

    if (row.status !== 'active') {
      await this.writeAuditLog({
        action: 'login_denied',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'account inactive',
        success: false,
        errorMessage: '账号已停用',
      });
      throw new ForbiddenException('账号已停用');
    }

    if (!row.passwordHash) {
      await this.writeAuditLog({
        action: 'login_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'no password hash',
        success: false,
        errorMessage: '用户名或密码错误',
      });
      throw new UnauthorizedException('用户名或密码错误');
    }

    const valid = this.verifyPassword(password, row.passwordHash);
    if (!valid) {
      const newAttempts = (row.failedLoginAttempts ?? 0) + 1;
      const patch: Partial<typeof teachersTable.$inferInsert> = {
        failedLoginAttempts: newAttempts,
      };
      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        patch.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
      }
      await this.db.update(teachersTable).set(patch).where(eq(teachersTable.id, row.id));

      await this.writeAuditLog({
        action: 'login_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: `wrong password, attempts=${newAttempts}`,
        success: false,
        errorMessage:
          newAttempts >= MAX_FAILED_ATTEMPTS
            ? '密码错误次数过多，账号已锁定15分钟'
            : '用户名或密码错误',
      });
      throw new UnauthorizedException(
        newAttempts >= MAX_FAILED_ATTEMPTS
          ? '密码错误次数过多，账号已锁定15分钟'
          : '用户名或密码错误',
      );
    }

    await this.db
      .update(teachersTable)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      })
      .where(eq(teachersTable.id, row.id));

    const teacher = this.rowToAuthUser(row);

    // ---------------------------------------------------------------------
    // Second factor. The password is verified; if MFA is enabled the login is
    // NOT complete and NO session is created. Returning a session here would
    // make the second factor decorative, because a stolen password alone would
    // already yield a usable cookie.
    //
    // Availability note: if MFA is enabled but the process cannot decrypt the
    // secret (MFA_ENCRYPTION_KEY missing or rotated), we FAIL CLOSED and refuse
    // the login rather than silently downgrading a privileged account to
    // single-factor. The alternative — letting the user in — would be an
    // attacker-triggerable MFA bypass by simply causing a key misconfiguration.
    // ---------------------------------------------------------------------
    if (await this.mfaService.isEnabled(teacher.id)) {
      const { challengeToken, expiresAt } = await this.mfaService.issueChallenge(
        teacher.id,
        ipAddress,
        userAgent,
      );

      await this.writeAuditLog({
        action: 'mfa_challenge_issued',
        teacherId: teacher.id,
        teacherName: teacher.name,
        ipAddress,
        userAgent,
        success: true,
        detail: 'password verified; awaiting second factor',
      });

      this.logger.log(
        `Password verified for ${teacher.name} (${teacher.username}); MFA challenge issued`,
      );

      return { mfaRequired: true, challengeToken, expiresAt };
    }

    // Pin the account's current authorization version onto the session, so any
    // later role/permission/status change invalidates it (RBAC.md §8).
    const sessionId = await this.sessionService.createSession(
      teacher.id,
      ipAddress,
      userAgent,
      row.permissionsVersion ?? 1,
    );

    await this.writeAuditLog({
      action: 'login',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      success: true,
    });

    this.logger.log(`Teacher logged in: ${teacher.name} (${teacher.username})`);

    return { mfaRequired: false, sessionId, teacher };
  }

  async changePassword(
    teacherId: string,
    currentPassword: string,
    newPassword: string,
    ipAddress: string,
    userAgent?: string,
    currentSessionId?: string,
  ): Promise<AuthUser> {
    const rows = await this.db
      .select({
        id: teachersTable.id,
        username: teachersTable.username,
        name: teachersTable.name,
        passwordHash: teachersTable.passwordHash,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (rows.length === 0) throw new NotFoundException('账号不存在');
    const row = rows[0];

    if (!row.passwordHash || !this.verifyPassword(currentPassword, row.passwordHash)) {
      await this.writeAuditLog({
        action: 'password_change_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'wrong current password',
        success: false,
        errorMessage: '当前密码错误',
      });
      throw new UnauthorizedException('当前密码错误');
    }

    const complexityError = this.validatePasswordComplexity(newPassword);
    if (complexityError) throw new BadRequestException(complexityError);

    if (this.verifyPassword(newPassword, row.passwordHash)) {
      throw new BadRequestException('新密码不能与当前密码相同');
    }

    const newHash = this.hashPasswordWithRandomSalt(newPassword);
    // The password write is issued on the raw client under the authenticated_
    // database role. The previous implementation used a plain drizzle UPDATE, which
    // runs as `anon_` (see writePasswordReset for the full explanation) and
    // therefore answered HTTP 500 with "42501 permission denied for table teachers"
    // — verified against the running server: the password was never changed and the
    // endpoint was unusable for every account. Same defect, same fix, same reason.
    const updated = await this.writeOwnPasswordHash(teacherId, newHash);

    if (!updated) {
      await this.writeAuditLog({
        action: 'password_change_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'update returned 0 rows',
        success: false,
        errorMessage: '密码修改失败，请稍后重试',
      });
      throw new BadRequestException('密码修改失败，请稍后重试');
    }

    await this.sessionService.revokeOtherSessions(teacherId, currentSessionId ?? null);

    await this.writeAuditLog({
      action: 'password_changed',
      teacherId: row.id,
      teacherName: row.name,
      ipAddress,
      userAgent,
      detail: 'self password change',
      success: true,
    });

    this.logger.log(`Password changed: ${row.username}`);
    return this.rowToAuthUser(updated);
  }

  /**
   * Write an account's OWN new password hash, on the raw client under the
   * authenticated_ database role.
   *
   * WHY (identical to writePasswordReset, see there for the full analysis):
   * migration 0005 grants the role every request runs as (`anon_`) UPDATE on only
   * three columns of `teachers`, so any drizzle UPDATE of `password_hash` fails with
   * 42501 and surfaces as HTTP 500. Verified for this endpoint against the running
   * server: `POST /api/auth/change-password` answered 500 and the password was never
   * changed.
   *
   * Declaring `app.rbac_actor_id` is what makes a super_admin able to rotate its own
   * password: the migration 0003 trigger permits a self-service write to a
   * super_admin row only when the actor id equals that row
   * (`tests/rbac-database.test.mjs` asserts the database allows it; before this fix
   * no application code path ever set the actor id, so the branch was unreachable).
   *
   * Returns the updated account row, or null when nothing was updated.
   */
  private async writeOwnPasswordHash(
    teacherId: string,
    passwordHash: string,
  ): Promise<{
    id: string;
    wecomUserId: string | null;
    username: string | null;
    name: string;
    nameEn: string | null;
    roles: string[] | null;
    status: string;
    mustChangePassword: boolean;
  } | null> {
    const client = rawPostgresClient(this.dbManager.getDatabase());

    return client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE 'authenticated_'");
      await tx.unsafe("SELECT set_config('app.rbac_actor_id', $1, true)", [teacherId]);

      const rows = (await tx.unsafe(
        `UPDATE teachers
            SET password_hash = $1,
                must_change_password = false,
                failed_login_attempts = 0,
                locked_until = NULL,
                password_updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        RETURNING id,
                  wecom_user_id        AS "wecomUserId",
                  username,
                  name,
                  name_en              AS "nameEn",
                  roles,
                  status,
                  must_change_password AS "mustChangePassword"`,
        [passwordHash, teacherId],
      )) as Array<{
        id: string;
        wecomUserId: string | null;
        username: string | null;
        name: string;
        nameEn: string | null;
        roles: string[] | null;
        status: string;
        mustChangePassword: boolean;
      }>;

      return rows[0] ?? null;
    });
  }

  /**
   * Administrative password reset — POST /api/auth/reset-password (audit finding G-18).
   * =============================================================================
   *
   * WHAT WAS WRONG
   *   The route had no `@RequirePermission` at all and authorised itself with
   *   `if (!operator.roles.includes('principal')) throw new NotFoundException()`:
   *   a hard-coded role string that bypassed the whole RBAC catalog (so a
   *   `super_admin` that does not ALSO hold `principal` was refused, and a future
   *   role could never be granted the capability without a code change), and it
   *   returned 404 so an operator could not tell "not allowed" from "no such
   *   account". The target was taken straight from `body.teacherId` with no check
   *   that the caller was allowed to manage that account.
   *
   * THE MODEL THIS NOW FOLLOWS (in this order — each step is a separate reason to
   * refuse, and each refusal is a 4xx rather than a silent no-op):
   *
   *   1. `account.reset_password` — enforced by PermissionGuard at the route, and
   *      re-asserted here so a future caller that forgets the decorator cannot
   *      reach the write. Not held => 403.
   *   2. `canManageAccount(actor.roles, target.roles)` — the ceiling rule from
   *      shared/rbac.ts: a target holding super_admin requires the caller to be a
   *      super_admin, and otherwise the caller's highest role must STRICTLY
   *      outrank the target's. The target's roles are read from the database,
   *      never from the request, which is what makes `teacherId` an
   *      authorised-and-resolved target instead of an IDOR handle. Not allowed => 403.
   *   3. `account.reset_privileged_password` — required in addition when the target
   *      is a privileged account (super_admin or principal). Only super_admin holds
   *      it, by catalog construction and by an assertion in
   *      `assertRbacCatalogIntegrity()`. Not held => 403.
   *   4. The account must exist => 404. This is the ONLY 404 this endpoint emits,
   *      which is the deliberate 403-vs-404 decision documented on the controller.
   *   5. Step-up: if the CALLER has a second factor, a current code is mandatory
   *      (`MfaService.verify`, the same pattern `/auth/mfa/disable` and
   *      `/auth/mfa/recovery-codes` use). Because only a super_admin may act on a
   *      privileged account, and `AuthGuard` refuses every non-MFA-exempt route for
   *      an MFA-required account that has not enrolled, every reset of a privileged
   *      account is MFA-gated in practice. Missing/invalid code => 401.
   *   6. The write, the session revocation and the audit row happen in ONE
   *      transaction, so a reset can never be committed without its audit record,
   *      and no stale session survives it.
   *
   * SECRETS
   *   The generated temporary password is returned to the caller exactly ONCE (the
   *   operator has to tell the teacher what it is — the established pattern is
   *   `/auth/mfa/enroll`, which returns the TOTP secret once for the same reason).
   *   It is NEVER logged, NEVER written to audit_logs, NEVER stored in plaintext
   *   (only the scrypt hash is persisted) and NEVER echoed in an error message.
   *   The caller-supplied second factor is likewise never logged or stored.
   */
  async resetPassword(input: AdminPasswordResetInput): Promise<ResetPasswordResponse> {
    const { authz, actor, targetTeacherId, mfaCode, ipAddress, userAgent } = input;

    // (1) Capability. Re-asserted for direct callers of this service.
    this.authorization.require(authz, 'account.reset_password');

    // (2) WHO MAY RESET WHOSE PASSWORD — the ceiling rule, against the target's
    //     CURRENT roles read from the database (never from the request body).
    let targetRoles: RoleCode[];
    try {
      targetRoles = await this.authorization.assertCanManageAccount(
        actor.roles,
        targetTeacherId,
      );
    } catch (error) {
      await this.auditRefusedReset(
        actor,
        targetTeacherId,
        ipAddress,
        userAgent,
        'target is outside the caller authority (equal or higher role)',
      );
      throw error;
    }

    // (3) Privileged accounts are a separate tier: super_admin only.
    if (
      isPrivilegedAccount(targetRoles) &&
      !authz.permissions.includes(RESET_PRIVILEGED_PASSWORD_PERMISSION)
    ) {
      await this.auditRefusedReset(
        actor,
        targetTeacherId,
        ipAddress,
        userAgent,
        `target is a privileged account (requires ${RESET_PRIVILEGED_PASSWORD_PERMISSION})`,
      );
      throw new ForbiddenException(
        '无权重置该账号的密码：系统/管理账号仅可由超级管理员重置',
      );
    }

    // (4) Existence. Note that a missing target reaches here only from a caller
    //     that already holds account.reset_password (step 1), and every role that
    //     holds it also holds account.view, so this 404 discloses nothing that the
    //     caller could not already read from GET /api/teachers.
    const rows = await this.db
      .select({
        id: teachersTable.id,
        username: teachersTable.username,
        name: teachersTable.name,
        roles: teachersTable.roles,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, targetTeacherId))
      .limit(1);

    if (rows.length === 0) throw new NotFoundException('账号不存在');
    const target = rows[0];

    // (5) Re-authentication for a high-risk operation: proof of possession of the
    //     caller's own second factor, when the account has one.
    let secondFactor: 'not_enrolled' | 'totp' | 'recovery' = 'not_enrolled';
    if (await this.mfaService.isEnabled(actor.id)) {
      const outcome = await this.mfaService.verify(actor.id, mfaCode ?? '');
      if (!outcome.ok) {
        await this.auditRefusedReset(
          actor,
          targetTeacherId,
          ipAddress,
          userAgent,
          'second factor missing or invalid',
        );
        throw new UnauthorizedException(
          '重置他人密码需要当前有效的 MFA 验证码（请输入验证器或恢复码）',
        );
      }
      secondFactor = outcome.method === 'recovery' ? 'recovery' : 'totp';
    }

    // (6) Generate, then write atomically.
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = this.hashPasswordWithRandomSalt(temporaryPassword);
    const touchesSuperAdmin = targetRoles.includes(SUPER_ADMIN_ROLE);

    // Declaring super-admin authority is the same precondition
    // `AuthorizationService.withSuperAdminAuthority()` enforces before it opens its
    // transaction; asserted here because the write below runs on the raw client
    // (see writePasswordReset) and therefore cannot use that wrapper.
    if (touchesSuperAdmin) this.authorization.requireSuperAdmin(authz);

    await this.writePasswordReset({
      actor,
      authz,
      targetTeacherId,
      targetName: target.name,
      targetRoles,
      passwordHash,
      secondFactor,
      touchesSuperAdmin,
      ipAddress,
      userAgent,
    });

    this.logger.log(
      `Password reset by ${actor.name} for account ${target.username ?? targetTeacherId} ` +
        `(secondFactor=${secondFactor})`,
    );

    // The one and only disclosure of the temporary password. See SECRETS above.
    return { temporaryPassword };
  }

  /**
   * The password write, its audit row and the target's session revocation — one
   * transaction, on the RAW postgres.js client.
   * ===========================================================================
   *
   * WHY RAW SQL AND AN EXPLICIT ROLE SWITCH (not an incidental choice)
   * ------------------------------------------------------------------
   * In this standalone deployment every request's database work runs under the
   * ANONYMOUS database role. The platform's SqlExecutionContextMiddleware installs
   * a per-request preamble (`SET LOCAL app.user_id = ''; SET LOCAL ROLE 'anon_'`),
   * and its drizzle monkey patch re-applies that preamble before EVERY drizzle
   * statement, each in a nested transaction. Migration 0005 then grants `anon_`
   * UPDATE on exactly three columns of `teachers` — last_login_at,
   * failed_login_attempts, locked_until — because the login flow needs those and
   * nothing else.
   *
   * Verified consequence against the running server (this endpoint had no test
   * before, so it went unnoticed): issuing the password write through
   * `this.db.update(teachersTable)` fails with
   *
   *     42501  permission denied for table teachers
   *
   * and surfaces as HTTP 500 — the route could not have reset a password even
   * with correct authorization. Re-issuing `SET LOCAL ROLE 'authenticated_'`
   * through drizzle does not help either: the next drizzle statement resets the
   * role to `anon_` again before it runs.
   *
   * So the privileged write happens on the raw postgres.js client (`db.$client`,
   * which the drizzle patch does not intercept) inside ONE transaction that:
   *   1. switches to `authenticated_` — the role migrations 0004/0005 provision
   *      for writes made by an AUTHENTICATED application request, i.e. exactly
   *      what this is after PermissionGuard and the ceiling rule have allowed it.
   *      (`service_role_` would also work; `authenticated_` is the narrower one.)
   *   2. declares the RBAC actor id (and super-admin authority when the target is a
   *      super_admin) because the migration 0003 triggers read those
   *      transaction-local settings;
   *   3. re-verifies the ceiling rule against the row it has locked FOR UPDATE, so
   *      a role change landing between the check in resetPassword() and this write
   *      cannot authorise an account the caller may no longer manage;
   *   4. writes the hash, revokes every live session of the target, and inserts the
   *      audit row — all or nothing. A reset can therefore never be committed
   *      without its audit record, and never leaves the previous holder signed in.
   *
   * NOTE FOR REVIEWERS: this is the first write in the codebase to switch role
   * explicitly. The same `anon_` restriction applies to other privileged writes
   * (`POST /api/auth/change-password`, `PATCH /api/teachers/:id`, account status),
   * which are outside this task's scope and are reported as such.
   */
  private async writePasswordReset(input: {
    actor: { id: string; name: string; roles: readonly RoleCode[] };
    authz: EffectivePermissions;
    targetTeacherId: string;
    targetName: string;
    targetRoles: readonly RoleCode[];
    passwordHash: string;
    secondFactor: 'not_enrolled' | 'totp' | 'recovery';
    touchesSuperAdmin: boolean;
    ipAddress: string;
    userAgent?: string;
  }): Promise<void> {
    const client = rawPostgresClient(this.dbManager.getDatabase());

    await client.begin(async (tx) => {
      // The role NAME is the one migrations 0004/0005 create for this deployment
      // (`anon_` / `authenticated_` / `service_role_`, no schema suffix — the
      // migrations hard-code the same names). A deployment that sets a role schema
      // would need the suffix here; the platform's own middleware builds it as
      // `authenticated_<roleSchema>`.
      await tx.unsafe("SET LOCAL ROLE 'authenticated_'");
      await tx.unsafe("SELECT set_config('app.rbac_actor_id', $1, true)", [input.actor.id]);
      if (input.touchesSuperAdmin) {
        await tx.unsafe("SELECT set_config('app.rbac_actor_super_admin', 'on', true)");
      }

      // Lock the row and re-decide. The decision and the write now cannot disagree.
      const locked = (await tx.unsafe(
        'SELECT id, roles FROM teachers WHERE id = $1 FOR UPDATE',
        [input.targetTeacherId],
      )) as Array<{ id: string; roles: string[] | null }>;

      if (locked.length === 0) throw new NotFoundException('账号不存在');
      const liveRoles = ((locked[0].roles ?? []) as RoleCode[]).filter(isKnownRole);

      if (!canManageAccount(input.actor.roles, liveRoles)) {
        throw new ForbiddenException('无权管理该账号（不能管理同级或更高级别的账号）');
      }
      if (
        isPrivilegedAccount(liveRoles) &&
        !input.authz.permissions.includes(RESET_PRIVILEGED_PASSWORD_PERMISSION)
      ) {
        throw new ForbiddenException(
          '无权重置该账号的密码：系统/管理账号仅可由超级管理员重置',
        );
      }

      await tx.unsafe(
        `UPDATE teachers
            SET password_hash = $1,
                must_change_password = true,
                failed_login_attempts = 0,
                locked_until = NULL,
                password_updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [input.passwordHash, input.targetTeacherId],
      );

      await tx.unsafe(
        `UPDATE sessions
            SET revoked = true,
                revoked_at = CURRENT_TIMESTAMP,
                revoke_reason = 'password_reset'
          WHERE teacher_id = $1
            AND revoked = false`,
        [input.targetTeacherId],
      );

      // NOT best-effort: a failed audit insert rolls the whole reset back, so
      // "every password reset writes an audit log" holds by construction. The
      // detail carries no credential material — who did it, to which roles, and
      // whether a second factor was verified.
      await tx.unsafe(
        `INSERT INTO audit_logs
           (action, teacher_id, teacher_name, ip_address, user_agent, detail, success)
         VALUES ('password_reset', $1, $2, $3, $4, $5, true)`,
        [
          input.targetTeacherId,
          input.targetName,
          input.ipAddress,
          input.userAgent ?? null,
          `reset by ${input.actor.name} (${input.actor.id}); ` +
            `target roles=[${input.targetRoles.join(',')}]; ` +
            `secondFactor=${input.secondFactor}`,
        ],
      );
    });
  }

  /**
   * Audit a REFUSED administrative reset.
   *
   * The actor is the subject of the row (it is their attempt), the target is named
   * in the detail, and no credential material is included in either field. Written
   * best-effort: a refusal must not turn into a 500 because the audit insert failed.
   */
  private async auditRefusedReset(
    actor: { id: string; name: string; roles: readonly RoleCode[] },
    targetTeacherId: string,
    ipAddress: string,
    userAgent: string | undefined,
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      `Refused password reset: actor=${actor.id} roles=[${actor.roles.join(',')}] ` +
        `target=${targetTeacherId} reason=${reason}`,
    );
    await this.writeAuditLog({
      action: 'permission_denied',
      teacherId: actor.id,
      teacherName: actor.name,
      ipAddress,
      userAgent,
      detail: `password_reset refused: target=${targetTeacherId}; reason=${reason}`,
      success: false,
      errorMessage: '无权重置该账号的密码',
    });
  }

  /**
   * Complete a login after a successful second-factor check.
   * Used by POST /api/auth/mfa/verify, which is @Public() because the caller has
   * no session yet — the challenge token is what authorises it.
   */
  async completeMfaLogin(
    teacherId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<{ sessionId: string; teacher: AuthUser }> {
    const rows = await this.db
      .select({
        id: teachersTable.id,
        wecomUserId: teachersTable.wecomUserId,
        username: teachersTable.username,
        name: teachersTable.name,
        nameEn: teachersTable.nameEn,
        roles: teachersTable.roles,
        status: teachersTable.status,
        mustChangePassword: teachersTable.mustChangePassword,
        permissionsVersion: teachersTable.permissionsVersion,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (rows.length === 0) throw new UnauthorizedException('账号不存在');
    const row = rows[0];
    if (row.status !== 'active') throw new UnauthorizedException('账号已停用');

    const teacher = this.rowToAuthUser(row);
    const sessionId = await this.sessionService.createSession(
      teacher.id,
      ipAddress,
      userAgent,
      row.permissionsVersion ?? 1,
    );

    await this.writeAuditLog({
      action: 'mfa_success',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      success: true,
    });
    await this.writeAuditLog({
      action: 'login',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      success: true,
      detail: 'login completed after MFA',
    });

    this.logger.log(`Teacher logged in with MFA: ${teacher.name} (${teacher.username})`);
    return { sessionId, teacher };
  }

  /** Public wrapper so the MFA controller can write its own audit entries. */
  async auditMfa(
    action: 'mfa_failed' | 'mfa_enrolled' | 'mfa_enabled' | 'mfa_disabled'
      | 'mfa_reset' | 'mfa_recovery_used' | 'mfa_recovery_regenerated',
    input: { teacherId: string; teacherName?: string; ipAddress?: string; userAgent?: string; detail?: string },
  ): Promise<void> {
    await this.writeAuditLog({
      action,
      teacherId: input.teacherId,
      teacherName: input.teacherName,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      detail: input.detail,
      success: action !== 'mfa_failed',
    });
  }

  async logout(
    sessionId: string,
    teacher: AuthUser,
    ipAddress: string,
    userAgent?: string,
  ): Promise<void> {
    if (sessionId) {
      await this.sessionService.destroySession(sessionId);
    }
    await this.writeAuditLog({
      action: 'logout',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      detail: 'User logged out',
      success: true,
    });
  }

  async getTeacherById(teacherId: string): Promise<AuthUser | null> {
    const rows = await this.db
      .select({
        id: teachersTable.id,
        wecomUserId: teachersTable.wecomUserId,
        username: teachersTable.username,
        name: teachersTable.name,
        nameEn: teachersTable.nameEn,
        roles: teachersTable.roles,
        status: teachersTable.status,
        mustChangePassword: teachersTable.mustChangePassword,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.status !== 'active') return null;

    return this.rowToAuthUser(row);
  }

  async recordAuthFailure(
    sessionId: string | undefined,
    ipAddress: string,
    userAgent: string | undefined,
    action: 'session_expired' | 'login_denied',
    errorMessage: string,
  ): Promise<void> {
    await this.writeAuditLog({
      action,
      ipAddress,
      userAgent,
      detail: sessionId
        ? `session hash present but invalid/expired`
        : 'no session cookie present',
      success: false,
      errorMessage,
    });
  }

  getSessionCookieName(): string {
    return this.sessionService.getCookieName();
  }

  getCookieOptions(): ReturnType<SessionService['getCookieOptions']> {
    return this.sessionService.getCookieOptions();
  }

  getClearCookieOptions(): ReturnType<SessionService['getClearCookieOptions']> {
    return this.sessionService.getClearCookieOptions();
  }

  /** Column mapping shared by the best-effort and the strict audit writers. */
  private auditValues(input: AuditLogInput): typeof auditLogs.$inferInsert {
    return {
      action: input.action,
      wecomUserId: input.wecomUserId,
      teacherId: input.teacherId,
      teacherName: input.teacherName,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      detail: input.detail,
      success: input.success,
      errorMessage: input.errorMessage,
      resourceId: input.resourceId,
      resourceTitle: input.resourceTitle,
      program: input.program,
      subject: input.subject,
    };
  }

  /**
   * Insert an audit row through an EXPLICIT executor, letting a failure propagate.
   *
   * `writeAuditLog` below is the best-effort wrapper around this. The password
   * reset deliberately uses NEITHER: its audit row is inserted with raw SQL inside
   * the same transaction as the password write (see writePasswordReset), so "every
   * password reset writes an audit log" cannot rest on an unchecked insert in a
   * different transaction.
   */
  private async insertAuditLog(
    executor: PostgresJsDatabase,
    input: AuditLogInput,
  ): Promise<void> {
    await executor.insert(auditLogs).values(this.auditValues(input));
  }

  private async writeAuditLog(input: AuditLogInput): Promise<void> {
    try {
      await this.insertAuditLog(this.db, input);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to write audit log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
