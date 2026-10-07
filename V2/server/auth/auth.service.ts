import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { SessionService } from './session.service'
import { hashPassword, verifyPassword } from './password'
import { AuthorizationService } from '../authz/authorization.service'
import type { AuthUser } from '../common/auth-user'
import type { PermissionCode } from '../../shared/permissions'
import { PERMISSION_CODES, normalizeUserRole } from '../../shared/permissions'

interface UserRow {
  id: string
  username: string
  name: string
  name_en: string | null
  password_hash: string
  role: string
  status: string
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
  ) {}

  /**
   * 登录。
   *
   * 失败时**不区分**"用户名不存在"与"密码不对"，只给一句话 ——
   * 否则登录接口本身就成了账号枚举器。同时两种情况都写审计。
   */
  async login(
    username: string,
    password: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ token: string; expiresAt: Date; user: AuthUser; permissions: PermissionCode[] }> {
    const rows = await this.sql<UserRow[]>`
      SELECT id, username, name, name_en, password_hash, role, status
      FROM users WHERE lower(username) = lower(${username})
    `
    const genericFailure = new UnauthorizedException({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
      message: '用户名或密码不正确',
    })

    if (rows.length === 0) {
      await this.audit.write({
        actorId: null,
        actorName: username,
        action: 'auth.login',
        targetType: 'session',
        targetId: null,
        result: 'failed',
        detail: { reason: '账号不存在' },
        ip,
      })
      throw genericFailure
    }

    const row = rows[0]
    if (row.status !== 'active') {
      await this.audit.write({
        actorId: row.id,
        actorName: row.name,
        action: 'auth.login',
        targetType: 'session',
        targetId: null,
        result: 'denied',
        detail: { reason: '账号已停用' },
        ip,
      })
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'ACCOUNT_DISABLED',
        message: '账号已停用，请联系管理员',
      })
    }

    if (!verifyPassword(password, row.password_hash)) {
      await this.audit.write({
        actorId: row.id,
        actorName: row.name,
        action: 'auth.login',
        targetType: 'session',
        targetId: null,
        result: 'failed',
        detail: { reason: '口令不正确' },
        ip,
      })
      throw genericFailure
    }

    const { token, expiresAt } = await this.sessions.create(row.id, ip, userAgent)
    const user = toAuthUser(row)
    const permissions = (await this.authz.grantsOf(row.id)).map((g) => g.permission)

    await this.audit.write({
      actorId: row.id,
      actorName: row.name,
      action: 'auth.login',
      targetType: 'session',
      targetId: null,
      result: 'success',
      ip,
    })

    return {
      token,
      expiresAt,
      user,
      permissions: permissions.filter((p): p is PermissionCode =>
        (PERMISSION_CODES as readonly string[]).includes(p),
      ),
    }
  }

  async logout(token: string | undefined, user: AuthUser | null): Promise<void> {
    if (token) await this.sessions.revokeByToken(token)
    if (user) {
      await this.audit.write({
        actorId: user.id,
        actorName: user.name,
        action: 'auth.logout',
        targetType: 'session',
        targetId: null,
        result: 'success',
      })
    }
  }

  async me(user: AuthUser): Promise<{ user: AuthUser; permissions: PermissionCode[] }> {
    const grants = await this.authz.grantsOf(user.id)
    return {
      user,
      permissions: grants
        .map((g) => g.permission)
        .filter((p): p is PermissionCode => (PERMISSION_CODES as readonly string[]).includes(p)),
    }
  }

  async changePassword(
    user: AuthUser,
    currentPassword: string,
    newPassword: string,
    ip: string | null,
  ): Promise<{ revokedSessions: number }> {
    const rows = await this.sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE id = ${user.id}
    `
    if (rows.length === 0) throw new UnauthorizedException({ statusCode: 401, code: 'UNAUTHENTICATED', message: '请先登录' })
    if (!verifyPassword(currentPassword, rows[0].password_hash)) {
      await this.audit.write({
        actorId: user.id,
        actorName: user.name,
        action: 'auth.change_password',
        targetType: 'user',
        targetId: user.id,
        result: 'failed',
        detail: { reason: '当前密码不正确' },
        ip,
      })
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'WRONG_PASSWORD',
        message: '当前密码不正确',
      })
    }

    await this.sql`
      UPDATE users SET password_hash = ${hashPassword(newPassword)}, updated_at = now()
      WHERE id = ${user.id}
    `
    // 改密后撤销**全部**会话（包括当前这一个）：界面上会提示重新登录。
    // 只保留当前会话会让"密码可能已泄漏"这个前提无法排除。
    const revoked = await this.sessions.revokeAllForUser(user.id)

    await this.audit.write({
      actorId: user.id,
      actorName: user.name,
      action: 'auth.change_password',
      targetType: 'user',
      targetId: user.id,
      result: 'success',
      detail: { revokedSessions: revoked },
      ip,
    })
    return { revokedSessions: revoked }
  }
}

export function toAuthUser(row: {
  id: string
  username: string
  name: string
  name_en: string | null
  role: string
}): AuthUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    nameEn: row.name_en,
    role: normalizeUserRole(row.role),
  }
}

/** CSRF 令牌：随机值放 cookie（非 HttpOnly，前端要读它放进请求头）。 */
export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url')
}
