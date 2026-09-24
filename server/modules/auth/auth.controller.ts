import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import { getClientIp } from '@server/common/http/client-ip';
import { Public, CurrentTeacher } from './auth.guard';
import { AuthorizationService } from '../authz/authorization.service';
import { MfaService } from './mfa.service';
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
    private readonly mfaService: MfaService,
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
  ): Promise<
    | { mfaRequired: true; challengeToken: string; expiresAt: string }
    | { mfaRequired: false; teacher: AuthUser }
  > {
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(
      body.username,
      body.password,
      ipAddress,
      userAgent,
    );

    // Second factor pending. Deliberately NO cookie is set: a half-authenticated
    // caller must not hold anything that reaches a protected route.
    // ('sessionId' in result narrows the union explicitly; relying on the boolean
    // discriminant did not narrow under this tsconfig.)
    if (!('sessionId' in result)) {
      return {
        mfaRequired: true as const,
        challengeToken: result.challengeToken,
        expiresAt: result.expiresAt,
      };
    }

    res.cookie(
      this.authService.getSessionCookieName(),
      result.sessionId,
      this.authService.getCookieOptions(),
    );

    return { mfaRequired: false as const, teacher: result.teacher };
  }

  // ===========================================================================
  // MFA
  // ===========================================================================

  /**
   * Step 2 of login. @Public() because the caller has no session yet — the
   * challenge token issued by step 1 is the credential, it is single-use, expires
   * in five minutes, and allows at most 5 attempts.
   */
  @Public()
  @Post('mfa/verify')
  async verifyMfa(
    @Body() body: { challengeToken: string; code: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ teacher: AuthUser }> {
    if (!body?.challengeToken || !body?.code) {
      throw new UnauthorizedException('缺少验证信息');
    }
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    const teacherId = await this.mfaService.consumeChallenge(body.challengeToken);
    const outcome = await this.mfaService.verify(teacherId, body.code);

    if (!outcome.ok) {
      const { remaining } = await this.mfaService.recordFailedAttempt(body.challengeToken);
      await this.authService.auditMfa('mfa_failed', {
        teacherId,
        ipAddress,
        userAgent,
        detail: `invalid second factor; attempts remaining=${remaining}`,
      });
      throw new UnauthorizedException(
        remaining > 0
          ? `验证码不正确，还可尝试 ${remaining} 次`
          : '验证失败次数过多，请重新登录',
      );
    }

    if (outcome.method === 'recovery') {
      await this.authService.auditMfa('mfa_recovery_used', {
        teacherId,
        ipAddress,
        userAgent,
        detail: 'recovery code consumed',
      });
    }

    const { sessionId, teacher } = await this.authService.completeMfaLogin(
      teacherId,
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

  /** Current MFA state for the signed-in account. */
  @Get('mfa/status')
  async mfaStatus(@CurrentTeacher() teacher: AuthUser) {
    return this.mfaService.getStatus(teacher.id);
  }

  /**
   * Begin enrolment. Returns the secret and otpauth URI ONCE.
   * A super_admin that has not yet enrolled can reach this (see the MFA gate in
   * AuthGuard), which is what makes the mandatory-MFA requirement self-serviceable
   * instead of requiring manual database work.
   */
  @Post('mfa/enroll')
  async mfaEnroll(@CurrentTeacher() teacher: AuthUser, @Req() req: Request) {
    const result = await this.mfaService.beginEnrollment(teacher.id, teacher.username || teacher.name);
    await this.authService.auditMfa('mfa_enrolled', {
      teacherId: teacher.id, teacherName: teacher.name,
      ipAddress: this.getIpAddress(req), userAgent: req.headers['user-agent'],
      detail: 'enrolment started',
    });
    return result;
  }

  /** Finish enrolment; returns the recovery codes ONCE. */
  @Post('mfa/confirm')
  async mfaConfirm(
    @CurrentTeacher() teacher: AuthUser,
    @Body() body: { code: string },
    @Req() req: Request,
  ) {
    const result = await this.mfaService.confirmEnrollment(teacher.id, body?.code ?? '');
    await this.authService.auditMfa('mfa_enabled', {
      teacherId: teacher.id, teacherName: teacher.name,
      ipAddress: this.getIpAddress(req), userAgent: req.headers['user-agent'],
      detail: 'second factor enabled',
    });
    return result;
  }

  /** Replace recovery codes. Invalidates all existing ones. */
  @Post('mfa/recovery-codes')
  async mfaRecoveryCodes(
    @CurrentTeacher() teacher: AuthUser,
    @Body() body: { code: string },
    @Req() req: Request,
  ) {
    // Re-authenticate with a current code before issuing new recovery material.
    const outcome = await this.mfaService.verify(teacher.id, body?.code ?? '');
    if (!outcome.ok) {
      throw new UnauthorizedException('需要当前有效验证码才能重新生成恢复码');
    }
    const codes = await this.mfaService.regenerateRecoveryCodes(teacher.id);
    await this.authService.auditMfa('mfa_recovery_regenerated', {
      teacherId: teacher.id, teacherName: teacher.name,
      ipAddress: this.getIpAddress(req), userAgent: req.headers['user-agent'],
      detail: 'recovery codes regenerated',
    });
    return { recoveryCodes: codes };
  }

  /**
   * Disable MFA. Requires a current valid code (proof of possession) and is
   * refused outright for roles that must keep MFA enabled.
   */
  @Post('mfa/disable')
  async mfaDisable(
    @CurrentTeacher() teacher: AuthUser,
    @Body() body: { code: string },
    @Req() req: Request,
  ) {
    const outcome = await this.mfaService.verify(teacher.id, body?.code ?? '');
    if (!outcome.ok) throw new UnauthorizedException('需要当前有效验证码才能解除绑定');
    await this.mfaService.assertMayDisable(teacher.id);
    await this.mfaService.disable(teacher.id);
    await this.authService.auditMfa('mfa_disabled', {
      teacherId: teacher.id, teacherName: teacher.name,
      ipAddress: this.getIpAddress(req), userAgent: req.headers['user-agent'],
      detail: 'second factor disabled by owner',
    });
    return { success: true };
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
