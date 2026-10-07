import {
  Body,
  Controller,
  createParamDecorator,
  Get,
  Post,
  Req,
  Res,
  type ExecutionContext,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuthService, newCsrfToken } from './auth.service'
import { ChangePasswordDto, LoginDto } from './auth.dto'
import { AuthenticatedOnly, CurrentUser, Public } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'
import { CSRF_COOKIE, SESSION_COOKIE, loadConfig } from '../config'
import { AuthorizationService } from '../authz/authorization.service'

/** 可选用户：logout 允许未登录时调用（幂等），因此不能用 CurrentUser（它要求已登录）。 */
export const CurrentUserOptional = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AuthUser | null => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>()
    return req.user ?? null
  },
)

/**
 * 认证接口。
 *
 * cookie 有两块：
 *   · `v2_session` —— HttpOnly + SameSite=Lax（+ 生产 Secure）。前端读不到，只能带。
 *   · `v2_csrf`    —— **故意**非 HttpOnly：前端要把它读出来放进 `x-v2-csrf` 头。
 *                     这就是双提交 cookie；它防的是"别的站点替我发请求"。
 */
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly authz: AuthorizationService,
  ) {}

  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const config = loadConfig()
    const result = await this.auth.login(
      dto.username,
      dto.password,
      req.ip ?? null,
      req.get('user-agent') ?? null,
    )
    setSessionCookie(res, result.token, result.expiresAt, config.isProduction)
    setCsrfCookie(res, newCsrfToken(), config.isProduction)
    return { user: result.user, permissions: result.permissions }
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUserOptional() user: AuthUser | null,
  ) {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>
    await this.auth.logout(cookies[SESSION_COOKIE], user)
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.clearCookie(CSRF_COOKIE, { path: '/' })
    return { ok: true }
  }

  @AuthenticatedOnly()
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const result = await this.auth.me(user)
    return { user: result.user, permissions: result.permissions }
  }

  /**
   * 前端用它来决定"能力开关"，避免把权限码与角色判断硬编码进页面。
   *
   * ⚠️ 这里**不再**出现 `user.role === 'ADMIN' || ...` ——
   * 那种写法等于在 controller 里又实现了一遍管理员放行。
   * 能力开关统一由 AuthorizationService.capabilitiesFor() 计算。
   */
  @AuthenticatedOnly()
  @Get('capabilities')
  async capabilities(@CurrentUser() user: AuthUser) {
    return this.authz.capabilitiesFor(user)
  }

  @AuthenticatedOnly()
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.changePassword(
      user,
      dto.currentPassword,
      dto.newPassword,
      req.ip ?? null,
    )
    // 会话已被撤销，清掉 cookie，界面会跳到登录页。
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.clearCookie(CSRF_COOKIE, { path: '/' })
    return result
  }
}

function setSessionCookie(res: Response, token: string, expiresAt: Date, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  })
}

function setCsrfCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // 前端必须读得到它，才能放进请求头
    sameSite: 'lax',
    secure,
    path: '/',
  })
}

