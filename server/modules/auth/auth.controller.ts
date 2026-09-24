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
import { Public, CurrentTeacher } from './auth.guard';
import type {
  AuthUser,
  LoginRequest,
  ChangePasswordRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
  AuthConfigResponse,
} from '@shared/api.interface';

@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

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

  private getIpAddress(req: Request): string {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
      return xForwardedFor.split(',')[0].trim();
    }
    return req.ip || '';
  }
}
