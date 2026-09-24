import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import { getClientIp } from '@server/common/http/client-ip';
import { Public, CurrentTeacher } from './auth.guard';
import { AuthorizationService } from '../authz/authorization.service';
import type {
  AuthUser,
  LoginRequest,
  ChangePasswordRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
  AuthConfigResponse,
} from '@shared/api.interface';
import type { EffectivePermissions } from '@shared/rbac';

@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly authorization: AuthorizationService,
  ) {}

  /**
   * The caller's own effective permissions.
   *
   * PURPOSE: lets the UI render the right navigation and buttons without
   * duplicating the permission rules on the client.
   *
   * SECURITY: this endpoint is PRESENTATION ONLY. It returns the caller's own
   * (already resolved) permission set — it never accepts a teacher id, so it
   * cannot be used to probe another account. Every actual decision is made
   * server-side by PermissionGuard / AuthorizationService, so a client that
   * ignores or forges this response still gets 403 from the API.
   */
  @Get('me/permissions')
  async getMyPermissions(
    @CurrentTeacher() teacher: AuthUser,
  ): Promise<EffectivePermissions> {
    return this.authorization.getEffectivePermissions(teacher.id);
  }

  @Public()
  @Get('config')
  getAuthConfig(): AuthConfigResponse {
    return { loginType: 'password' };
  }

  @Public()
  @Post('login')
  async login(
    @Body() body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ teacher: AuthUser }> {
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];
    const { sessionId, teacher } = await this.authService.login(
      body.username,
      body.password,
      ipAddress,
      userAgent,
    );

    res.cookie(
      this.authService.getSessionCookieName(),
      sessionId,
      this.authService.getCookieOptions(),
    );

    return { teacher };
  }

  @Post('change-password')
  async changePassword(
    @Body() body: ChangePasswordRequest,
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
  ): Promise<{ success: boolean; teacher: AuthUser }> {
    const sessionId =
      req.cookies?.[this.authService.getSessionCookieName()] || '';
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];
    const updatedTeacher = await this.authService.changePassword(
      teacher.id,
      body.currentPassword,
      body.newPassword,
      ipAddress,
      userAgent,
      sessionId,
    );
    return { success: true, teacher: updatedTeacher };
  }

  @Post('reset-password')
  async resetPassword(
    @Body() body: ResetPasswordRequest,
    @CurrentTeacher() operator: AuthUser,
    @Req() req: Request,
  ): Promise<ResetPasswordResponse> {
    if (!operator.roles.includes('principal')) {
      throw new NotFoundException();
    }
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];
    return this.authService.resetPassword(
      operator.id,
      operator.name,
      body.teacherId,
      ipAddress,
      userAgent,
    );
  }

  @Get('me')
  getCurrentUser(@CurrentTeacher() teacher: AuthUser): AuthUser {
    return teacher;
  }

  @Post('logout')
  async logout(
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    const sessionId =
      req.cookies?.[this.authService.getSessionCookieName()] || '';
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    await this.authService.logout(sessionId, teacher, ipAddress, userAgent);

    res.clearCookie(
      this.authService.getSessionCookieName(),
      this.authService.getClearCookieOptions(),
    );

    return { success: true };
  }

  /**
   * Client IP for rate limiting and audit.
   *
   * Delegates to the shared trust-aware resolver. This method previously read
   * `x-forwarded-for` and took its FIRST element — the value the client itself
   * supplies — which made the per-IP login rate limit bypassable and every audit
   * row forgeable (audit finding D-10).
   */
  private getIpAddress(req: Request): string {
    return getClientIp(req);
  }
}
