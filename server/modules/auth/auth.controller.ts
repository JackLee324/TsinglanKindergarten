import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  Logger,
  BadRequestException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import { getClientIp } from '@server/common/http/client-ip';
import { Public, CurrentTeacher } from './auth.guard';
import { AuthorizationService } from '../authz/authorization.service';
import { MfaService } from './mfa.service';
import { MfaExempt, RequirePermission, CurrentAuthz } from '../authz/permission.decorator';
import type {
  AuthUser,
  LoginRequest,
  ChangePasswordRequest,
  ResetPasswordRequest,
  AuthConfigResponse,
} from '@shared/api.interface';
import type { EffectivePermissions } from '@shared/rbac';

/**
 * Request body of the administrative reset.
 *
 * `mfaCode` is OPTIONAL in the type because it is optional in the protocol: it is
 * required exactly when the caller has a second factor (the service enforces
 * that). It deliberately lives here rather than in `@shared/api.interface`
 * `ResetPasswordRequest` so the published contract the client already codes
 * against (`{ teacherId }`) is unchanged: an operator without MFA keeps working,
 * an operator WITH MFA must supply the code.
 */
type ResetPasswordBody = ResetPasswordRequest & { mfaCode?: string };

/**
 * Shape check for the target selector.
 *
 * A malformed id would otherwise be handed to PostgreSQL as a uuid comparison and
 * surface as a 500 (invalid input syntax for type uuid, 22P02), which tells an
 * operator nothing. Rejecting it here makes the answer deterministic.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete credential fields from the parsed request body once the handler has
 * consumed them.
 *
 * WHY THIS IS NECESSARY (verified against a live server, not assumed)
 * ------------------------------------------------------------------
 * The platform's HTTP trace interceptor wrote the REQUEST BODY of every
 * successful request to the application log, unconditionally, BEFORE consulting
 * its own `logRequestBody` / `logResponseBody` options (those flags only gated
 * the other two branches). Grepping the log of a live gate run found 28 plaintext
 * login passwords and every MFA code that run sent.
 *
 * THAT INTERCEPTOR IS GONE — it was part of `PlatformModule`, and scrubbing
 * request bodies is why its removal is a security fix rather than a tidiness
 * change. The application now logs with the standard Nest `Logger`, which records
 * messages and never payloads.
 *
 * This scrub stays anyway, as defence in depth for the requirement "never log a
 * password, token or MFA secret": a credential that has already been consumed has
 * no further use in the request object, so the value exists in a local variable
 * for the duration of the handler and nowhere else.
 *
 * (The response half — a response body that carries a freshly issued credential —
 * is handled per route below by sending the response explicitly, since the same
 * interceptor logs the handler's return value.)
 */
function dropConsumedCredentials(req: Request, fields: readonly string[]): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) delete body[field];
  }
}

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
  @MfaExempt()
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

  /**
   * Password step of login.
   *
   * The response is sent EXPLICITLY (rather than by returning a value) for one
   * reason: the challenge token in the `mfaRequired` branch is a live credential,
   * and the platform's HTTP trace logging writes the handler's return value into
   * the server log. Sending the body through `res.json` keeps it out of that log;
   * the wire format is byte-for-byte what the client already receives
   * (`{ mfaRequired, challengeToken, expiresAt }` / `{ mfaRequired, teacher }`).
   * The password is likewise removed from the request object once consumed.
   */
  @Public()
  @Post('login')
  async login(
    @Body() body: LoginRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(
      body.username,
      body.password,
      ipAddress,
      userAgent,
    );
    dropConsumedCredentials(req, ['password']);

    // Second factor pending. Deliberately NO cookie is set: a half-authenticated
    // caller must not hold anything that reaches a protected route.
    // ('sessionId' in result narrows the union explicitly; relying on the boolean
    // discriminant did not narrow under this tsconfig.)
    if (!('sessionId' in result)) {
      res.status(HttpStatus.CREATED).json({
        mfaRequired: true as const,
        challengeToken: result.challengeToken,
        expiresAt: result.expiresAt,
      });
      return;
    }

    res.cookie(
      this.authService.getSessionCookieName(),
      result.sessionId,
      this.authService.getCookieOptions(),
    );

    res.status(HttpStatus.CREATED).json({ mfaRequired: false as const, teacher: result.teacher });
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
    dropConsumedCredentials(req, ['challengeToken', 'code']);
    res.cookie(
      this.authService.getSessionCookieName(),
      sessionId,
      this.authService.getCookieOptions(),
    );
    return { teacher };
  }

  /** Current MFA state for the signed-in account. */
  @MfaExempt()
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
  @MfaExempt()
  @Post('mfa/enroll')
  async mfaEnroll(
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.mfaService.beginEnrollment(teacher.id, teacher.username || teacher.name);
    await this.authService.auditMfa('mfa_enrolled', {
      teacherId: teacher.id, teacherName: teacher.name,
      ipAddress: this.getIpAddress(req), userAgent: req.headers['user-agent'],
      detail: 'enrolment started',
    });
    // The TOTP secret is a live credential: sent explicitly so the platform's
    // response-body logging cannot persist it. See dropConsumedCredentials().
    res.status(HttpStatus.CREATED).json(result);
  }

  /** Finish enrolment; returns the recovery codes ONCE. */
  @MfaExempt()
  @Post('mfa/confirm')
  async mfaConfirm(
    @CurrentTeacher() teacher: AuthUser,
    @Body() body: { code: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.mfaService.confirmEnrollment(teacher.id, body?.code ?? '');
    dropConsumedCredentials(req, ['code']);
    await this.authService.auditMfa('mfa_enabled', {
      teacherId: teacher.id, teacherName: teacher.name,
      ipAddress: this.getIpAddress(req), userAgent: req.headers['user-agent'],
      detail: 'second factor enabled',
    });
    // Recovery codes are credentials: sent explicitly, never returned by value.
    res.status(HttpStatus.CREATED).json(result);
  }

  /** Replace recovery codes. Invalidates all existing ones. */
  @MfaExempt()
  @Post('mfa/recovery-codes')
  async mfaRecoveryCodes(
    @CurrentTeacher() teacher: AuthUser,
    @Body() body: { code: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Re-authenticate with a current code before issuing new recovery material.
    const outcome = await this.mfaService.verify(teacher.id, body?.code ?? '');
    if (!outcome.ok) {
      throw new UnauthorizedException('需要当前有效验证码才能重新生成恢复码');
    }
    dropConsumedCredentials(req, ['code']);
    const codes = await this.mfaService.regenerateRecoveryCodes(teacher.id);
    await this.authService.auditMfa('mfa_recovery_regenerated', {
      teacherId: teacher.id, teacherName: teacher.name,
      ipAddress: this.getIpAddress(req), userAgent: req.headers['user-agent'],
      detail: 'recovery codes regenerated',
    });
    res.status(HttpStatus.CREATED).json({ recoveryCodes: codes });
  }

  /**
   * Disable MFA. Requires a current valid code (proof of possession) and is
   * refused outright for roles that must keep MFA enabled.
   */
  @MfaExempt()
  @Post('mfa/disable')
  async mfaDisable(
    @CurrentTeacher() teacher: AuthUser,
    @Body() body: { code: string },
    @Req() req: Request,
  ) {
    const outcome = await this.mfaService.verify(teacher.id, body?.code ?? '');
    if (!outcome.ok) throw new UnauthorizedException('需要当前有效验证码才能解除绑定');
    dropConsumedCredentials(req, ['code']);
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
    // Both passwords have been consumed; neither may survive in the request
    // object, because the platform logs request bodies on success.
    dropConsumedCredentials(req, ['currentPassword', 'newPassword']);
    return { success: true, teacher: updatedTeacher };
  }

  /**
   * POST /api/auth/reset-password — administrative reset of ANOTHER account's
   * password (audit finding G-18).
   *
   * ===========================================================================
   * AUTHORIZATION (was: `if (!operator.roles.includes('principal')) throw 404`)
   * ===========================================================================
   * The route now declares the capability it needs — `account.reset_password`,
   * enforced by PermissionGuard — so who may do this is data (role defaults and
   * per-account grants/denies in the RBAC catalog), not a string in this file.
   * `super_admin` holds it by catalog construction, `principal` holds it by role
   * default, and any role can be given or denied it without a code change.
   *
   * The route alone is NOT enough for a targeted operation like this, because the
   * real question is "whose password?". The service therefore applies, in order:
   *   * the ceiling rule `canManageAccount()` (target roles read from the
   *     database, never from the request) — a caller may only act on an account it
   *     strictly outranks, and only a super_admin may act on a super_admin;
   *   * `account.reset_privileged_password` (super_admin only) for any target that
   *     holds a privileged role (super_admin / principal).
   * See AuthService.resetPassword for the full model.
   *
   * ===========================================================================
   * 403 vs 404 — A DECISION, NOT AN ACCIDENT
   * ===========================================================================
   * An authorization failure answers **403**, not 404. The previous 404 was
   * unreachable-by-design ("hide existence") but it made three different
   * situations indistinguishable — no permission, target out of scope, and no
   * such account — so an operator could not tell a misconfiguration from a
   * decommissioned teacher, and it made THIS endpoint disagree with every other
   * account-management route, where `AuthorizationService.assertCanManageAccount`
   * answers 403 for the same rule.
   *
   * The anti-enumeration argument for 404 does not apply here:
   *   * an account WITHOUT `account.reset_password` is refused by PermissionGuard
   *     before any target lookup happens, so the status code of an existing target
   *     and a missing one are identical for it (403 either way) — nothing leaks;
   *   * the only callers that reach the target lookup already hold
   *     `account.reset_password`, and that permission is held only by roles that
   *     also hold `account.view`, i.e. callers who can already enumerate every
   *     account through `GET /api/teachers`. A 404 would hide nothing from them
   *     while making legitimate support cases harder to diagnose (SECURITY.md G-18).
   * Consequently 404 is reserved for exactly one condition — the account does not
   * exist — and the tests assert both codes explicitly.
   *
   * ===========================================================================
   * OTHER REQUIREMENTS MET HERE
   * ===========================================================================
   *   * IDOR: the ONLY target selector accepted is `teacherId`; a body carrying an
   *     `accountId` (or a malformed id) is rejected instead of being aliased or
   *     passed to the database, and the id is always resolved to an account and
   *     checked against the caller's authority (AuthService.resetPassword).
   *   * Audit: every successful reset writes a `password_reset` row INSIDE the same
   *     transaction as the password change, and every refused attempt (out of
   *     scope, privileged target, failed step-up) is audited as `permission_denied`.
   *   * Secrets: the generated temporary password is disclosed once, in the 201
   *     response body, and nowhere else — not in the server log, not in audit rows,
   *     not in an error message, not in a cache. The caller's `mfaCode` is consumed
   *     and then removed from the request object for the same reason; see
   *     dropConsumedCredentials().
   *   * Re-authentication: this route is deliberately NOT `@MfaExempt`, so
   *     AuthGuard's mandatory-MFA gate applies to the caller, and the service
   *     additionally requires a current second factor whenever the caller has one.
   *
   * No `Cache-Control` is set by the platform for API responses (verified: the
   * security-headers middleware sets nosniff / framing / referrer / COOP / CORP /
   * CSP / HSTS only), so this route sets `no-store` itself on the response it sends.
   */
  @Post('reset-password')
  @RequirePermission('account.reset_password')
  async resetPassword(
    @Body() body: ResetPasswordBody,
    @CurrentTeacher() operator: AuthUser,
    @CurrentAuthz() authz: EffectivePermissions,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const raw = body as unknown as Record<string, unknown> | undefined;

    // Exactly one selector. Refusing `accountId` outright rather than ignoring it
    // means a caller cannot make the API and the audit trail disagree about which
    // account was meant.
    if (raw && Object.prototype.hasOwnProperty.call(raw, 'accountId')) {
      throw new BadRequestException('不支持 accountId 参数，请使用 teacherId');
    }
    const teacherId = typeof raw?.teacherId === 'string' ? raw.teacherId.trim() : '';
    if (!teacherId || !UUID_PATTERN.test(teacherId)) {
      throw new BadRequestException('teacherId 必须是有效的账号 ID');
    }
    const mfaCode = typeof raw?.mfaCode === 'string' ? raw.mfaCode : undefined;
    // Both fields have been read; the second factor must not survive in the request
    // object, because the platform logs request bodies of successful requests.
    dropConsumedCredentials(req, ['mfaCode']);

    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    const result = await this.authService.resetPassword({
      authz,
      actor: { id: operator.id, name: operator.name, roles: authz.roles },
      targetTeacherId: teacherId,
      mfaCode,
      ipAddress,
      userAgent,
    });

    // Sent EXPLICITLY rather than returned: the body carries the one-time temporary
    // password, and the platform's HTTP trace logging writes a handler's return
    // value into the server log — which would turn a one-time credential into a
    // durable one. `no-store` is set here rather than with @Header() because a
    // handler that owns the response also owns its headers.
    res.status(HttpStatus.CREATED);
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  }

  @MfaExempt()
  @Get('me')
  getCurrentUser(@CurrentTeacher() teacher: AuthUser): AuthUser {
    return teacher;
  }

  @MfaExempt()
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
