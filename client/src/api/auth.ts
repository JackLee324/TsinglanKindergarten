import type {
  AuthUser,
  LoginRequest,
  ChangePasswordRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
  AuthConfigResponse,
} from '@shared/api.interface';

import { axiosForBackend, handleApiError, handleSilentUnauthorized } from './client';

export async function getAuthConfig(): Promise<AuthConfigResponse> {
  try {
    const resp = await axiosForBackend.get('/api/auth/config');
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getAuthConfig');
  }
}

/**
 * 登录结果。**必须**是这两种之一，不能只返回 AuthUser。
 *
 * 服务器在启用了第二因素时返回 `{ mfaRequired: true, challengeToken }`，**不签发会话
 * Cookie**。而这里以前写的是 `return resp.data.teacher` —— 于是那种响应会得到
 * `undefined`，调用方再把它当作"已登录用户"塞进 auth context：
 * 界面上是一个"已登录"的空壳，服务端却一个受保护接口都不会放行。
 * 也就是说，一旦有人启用 MFA，前端会以一个**看起来正常、其实完全没登录**的状态继续跑。
 * 这正是本轮要消灭的假成功，只不过它在登录入口。
 */
export type LoginResult =
  | { mfaRequired: false; teacher: AuthUser }
  | { mfaRequired: true; challengeToken: string; expiresAt: string };

export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    const resp = await axiosForBackend.post<
      LoginRequest,
      { data: LoginResult }
    >('/api/auth/login', { username, password });
    const data = resp.data;
    if (!data || typeof data !== 'object' || !('mfaRequired' in data)) {
      // 明确失败，而不是让 undefined 流下去变成"已登录"。
      throw new Error('登录响应格式异常：既没有 teacher 也没有 mfaRequired');
    }
    return data;
  } catch (error) {
    return handleApiError(error, 'login');
  }
}

/** 登录第二步：提交 TOTP 或恢复码，成功后服务端才签发会话。 */
export async function verifyMfa(challengeToken: string, code: string): Promise<AuthUser> {
  try {
    const resp = await axiosForBackend.post<{ teacher: AuthUser }, { data: { teacher: AuthUser } }>(
      '/api/auth/mfa/verify',
      { challengeToken, code },
    );
    return resp.data.teacher;
  } catch (error) {
    return handleApiError(error, 'verifyMfa');
  }
}

export interface MfaStatusResponse {
  /** 已开始登记但还没用验证码确认。 */
  pending: boolean;
  /** 已确认、已启用。 */
  enabled: boolean;
  enabledAt?: string;
  /** 剩余可用恢复码数量 —— 归零意味着丢了手机就进不来。 */
  recoveryCodesRemaining: number;
}

/** 当前账号的 MFA 状态。 */
export async function getMfaStatus(): Promise<MfaStatusResponse> {
  try {
    const resp = await axiosForBackend.get('/api/auth/mfa/status');
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getMfaStatus');
  }
}

/** 开始登记：返回密钥与 otpauth URI，**只返回一次**。 */
export async function enrollMfa(): Promise<{ secret: string; otpauthUri: string }> {
  try {
    const resp = await axiosForBackend.post('/api/auth/mfa/enroll');
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'enrollMfa');
  }
}

/** 用验证码确认登记：返回恢复码，**只返回一次**。 */
export async function confirmMfa(code: string): Promise<{ recoveryCodes: string[] }> {
  try {
    const resp = await axiosForBackend.post('/api/auth/mfa/confirm', { code });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'confirmMfa');
  }
}

/** 重新生成恢复码（需要当前有效验证码）。 */
export async function regenerateRecoveryCodes(code: string): Promise<{ recoveryCodes: string[] }> {
  try {
    const resp = await axiosForBackend.post('/api/auth/mfa/recovery-codes', { code });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'regenerateRecoveryCodes');
  }
}

/** 解除绑定（需要当前有效验证码；某些角色会被服务端拒绝）。 */
export async function disableMfa(code: string): Promise<{ success: boolean }> {
  try {
    const resp = await axiosForBackend.post('/api/auth/mfa/disable', { code });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'disableMfa');
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ success: boolean; teacher: AuthUser }> {
  try {
    const resp = await axiosForBackend.post<ChangePasswordRequest, { data: { success: boolean; teacher: AuthUser } }>(
      '/api/auth/change-password',
      { currentPassword, newPassword },
    );
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'changePassword');
  }
}

export async function resetPassword(teacherId: string): Promise<ResetPasswordResponse> {
  try {
    const resp = await axiosForBackend.post<ResetPasswordRequest, { data: ResetPasswordResponse }>(
      '/api/auth/reset-password',
      { teacherId },
    );
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'resetPassword');
  }
}

export async function getMe(): Promise<AuthUser | null> {
  try {
    const resp = await axiosForBackend.get('/api/auth/me');
    return resp.data;
  } catch (error) {
    return handleSilentUnauthorized(error, 'getMe');
  }
}

export async function logout(): Promise<void> {
  try {
    await axiosForBackend.post('/api/auth/logout');
  } catch (error) {
    handleApiError(error, 'logout');
  }
}
