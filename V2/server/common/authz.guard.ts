import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { Sql } from 'postgres'
import { createHash } from 'node:crypto'
import { SQL } from '../db/database.module'
import {
  AUTHENTICATED_ONLY,
  DIRECTORY_SOURCE,
  PUBLIC_ROUTE,
  REQUIRE_PERMISSION,
  type DirectorySource,
} from '../common/decorators'
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../config'
import type { AuthUser } from '../common/auth-user'
import { normalizeUserRole, type PermissionCode } from '../../shared/permissions'
import { AuthorizationService } from '../authz/authorization.service'
import { AuditService } from '../audit/audit.service'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * AuthzGuard —— 认证 + 授权 + CSRF 的唯一入口（全局注册）
 * ============================================================================
 * 顺序：会话 → CSRF → 权限声明 → 目录范围 → 通过/拒绝。
 *
 * **fail closed**：没有 `@RequirePermission` 也没有 `@Public` 的路由直接 403。
 * V1 的默认是"没声明就放行"，于是新增接口忘加注解时所有测试仍然全绿
 * （因为测试用管理员账号），而线上那个接口对任何登录用户开放。
 */
@Injectable()
export class AuthzGuard implements CanActivate {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>()
    const handler = context.getHandler()
    const cls = context.getClass()

    const isPublic =
      this.reflector.get<boolean>(PUBLIC_ROUTE, handler) === true ||
      this.reflector.get<boolean>(PUBLIC_ROUTE, cls) === true

    // 会话解析：即便是公开路由也要做（登录接口需要认得出"已登录"以便写审计）。
    const user = await this.resolveUser(req)
    if (user) req.user = user

    if (isPublic) return true

    const authenticatedOnly =
      this.reflector.get<boolean>(AUTHENTICATED_ONLY, handler) === true ||
      this.reflector.get<boolean>(AUTHENTICATED_ONLY, cls) === true

    if (!user) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        message: '请先登录',
      })
    }

    // CSRF：状态改变的方法必须带匹配的 token（双提交 cookie）。
    if (!SAFE_METHODS.has(req.method)) this.assertCsrf(req)

    // 登录即可：数据由 service 按权限过滤（例如目录树只返回能看到的节点）。
    if (authenticatedOnly) return true

    const required =
      this.reflector.getAllAndOverride<PermissionCode[]>(REQUIRE_PERMISSION, [handler, cls]) ?? []

    if (required.length === 0) {
      // 没声明权限 → 拒绝，并把这件事写进审计（这是配置错误，不是用户错误）。
      await this.audit.write({
        actorId: user.id,
        actorName: user.name,
        action: 'authz.missing-declaration',
        targetType: 'system',
        targetId: `${req.method} ${req.route?.path ?? req.path}`,
        result: 'denied',
        detail: { reason: '路由没有声明 @RequirePermission，也没有 @Public' },
        ip: clientIp(req),
      })
      throw new UnauthorizedAccessWithoutDeclaration()
    }

    const source =
      this.reflector.getAllAndOverride<DirectorySource>(DIRECTORY_SOURCE, [handler, cls]) ?? {
        kind: 'none',
      }

    for (const permission of required) {
      const decision = await this.decide(req, user, permission, source)
      if (!decision.allowed) {
        await this.audit.write({
          actorId: user.id,
          actorName: user.name,
          action: 'authz.denied',
          targetType: 'system',
          targetId: `${req.method} ${req.path}`,
          result: 'denied',
          detail: {
            permission,
            reason: decision.reason,
            directoryId: decision.directoryId,
          },
          ip: clientIp(req),
        })
        throw new ForbiddenByAuthz(permission, decision.reason)
      }
    }

    return true
  }

  private async decide(
    req: Request,
    user: AuthUser,
    permission: PermissionCode,
    source: DirectorySource,
  ) {
    if (source.kind === 'none') {
      // 列表类：允许调用，数据由 service 过滤。
      const allowed = await this.authz.hasPermissionAnywhere(user, permission)
      return {
        allowed,
        reason: allowed ? ('global-grant' as const) : ('no-grant' as const),
        permission,
        directoryId: null,
      }
    }

    const directoryId = await this.resolveDirectoryId(req, user, permission, source)
    if (directoryId === MISSING_TARGET) {
      // 放行与否**仍然由 AuthorizationService 决定** ——
      // 守卫里不允许出现 `allowed: true` 这种硬编码放行。
      return this.authz.decisionForMissingTarget(user, permission)
    }
    if (directoryId === NOT_RESOLVED) {
      // 目标不存在 → 由 service 负责返回 404；这里不能因为"解析不到"就放行。
      return {
        allowed: false,
        reason: 'out-of-scope' as const,
        permission,
        directoryId: null,
      }
    }
    return this.authz.can(user, permission, directoryId)
  }

  private async resolveDirectoryId(
    req: Request,
    user: AuthUser,
    permission: PermissionCode,
    source: DirectorySource,
  ): Promise<string | null | typeof NOT_RESOLVED | typeof MISSING_TARGET> {
    switch (source.kind) {
      case 'param': {
        const raw = req.params[source.name]
        return typeof raw === 'string' && raw.length > 0 ? raw : NOT_RESOLVED
      }
      case 'body': {
        const body = req.body as Record<string, unknown> | undefined
        const raw = body?.[source.name]
        if (typeof raw !== 'string' || raw.length === 0) {
          if (source.nullMeansGlobal === true) return null
          // 必填字段没给：交给 DTO 校验去说"缺少所属目录"（400），
          // 而不是在这里回一句"没有权限"（403）—— 后者会把用户引向权限排查，
          // 而真实原因是请求少了一个字段。
          return MISSING_TARGET
        }
        return raw
      }
      case 'query': {
        const raw = req.query[source.name]
        return typeof raw === 'string' && raw.length > 0 ? raw : NOT_RESOLVED
      }
      case 'resource': {
        const raw = req.params[source.param]
        if (typeof raw !== 'string' || raw.length === 0) return NOT_RESOLVED
        const rows = await this.sql<{ directory_id: string }[]>`
          SELECT directory_id FROM resources WHERE id = ${raw}
        `
        // 资源不存在（例如已被永久删除）→ 交给 service 返回 404。
        //
        // WHY 不能在这里直接拒绝：那会返回 403"没有权限"，而事实是"这个东西没有了"。
        // 一个把 404 说成 403 的系统会让人去查权限配置，方向完全错。
        // 但也不能无条件放行：只有**在某个范围内确实持有该权限**的用户才让它走到
        // service —— 否则任何人拿一个随机 id 都能探测服务端行为。
        if (rows.length === 0) {
          const anywhere = await this.authz.hasPermissionAnywhere(user, permission)
          return anywhere ? MISSING_TARGET : NOT_RESOLVED
        }
        return rows[0].directory_id
      }
      default:
        return NOT_RESOLVED
    }
  }

  private assertCsrf(req: Request): void {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>
    const cookieToken = cookies[CSRF_COOKIE]
    const headerToken = req.get(CSRF_HEADER)
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new ForbiddenCsrf()
    }
  }

  private async resolveUser(req: Request): Promise<AuthUser | null> {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>
    const token = cookies[SESSION_COOKIE]
    if (!token) return null

    const tokenHash = createHash('sha256').update(token).digest('hex')
    const rows = await this.sql<
      {
        id: string
        username: string
        name: string
        name_en: string | null
        role: string
      }[]
    >`
      SELECT u.id, u.username, u.name, u.name_en, u.role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'
    `
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      id: r.id,
      username: r.username,
      name: r.name,
      nameEn: r.name_en,
      role: normalizeUserRole(r.role),
    }
  }
}

const NOT_RESOLVED = Symbol('directory-not-resolved')
/** 目标资源不存在：放行到 service，由它返回一个诚实的 404。 */
const MISSING_TARGET = Symbol('target-missing')

/**
 * 路由既没有 @RequirePermission、也没有 @Public / @AuthenticatedOnly。
 *
 * 它必须是 **403 HttpException**，不能是一个裸 Error ——
 * 裸 Error 会被异常过滤器当成 500，于是"路由配置错误"看起来像"服务器崩了"，
 * 排查方向会完全错。这条断言（以及这条注释）就是这么来的。
 */
class UnauthorizedAccessWithoutDeclaration extends HttpException {
  constructor() {
    super(
      {
        statusCode: 403,
        code: 'ROUTE_NOT_DECLARED',
        message: '这个接口没有声明所需权限，已按 fail closed 拒绝',
      },
      403,
    )
  }
}

function clientIp(req: Request): string | null {
  return req.ip ?? null
}

import { ForbiddenException, HttpException } from '@nestjs/common'

/** 权限不足。带机器可读的 code 与权限名，前端可据此给出可读提示。 */
export class ForbiddenByAuthz extends HttpException {
  constructor(permission: string, reason: string) {
    super(
      { statusCode: 403, code: 'FORBIDDEN', message: '没有权限执行这个操作', permission, reason },
      403,
    )
  }
}

/** CSRF 校验失败。 */
export class ForbiddenCsrf extends HttpException {
  constructor() {
    super({ statusCode: 403, code: 'CSRF', message: '请求缺少有效的 CSRF 令牌，请刷新页面重试' }, 403)
  }
}

export { ForbiddenException }
