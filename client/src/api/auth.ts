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

export async function login(username: string, password: string): Promise<AuthUser> {
  try {
    const resp = await axiosForBackend.post<LoginRequest, { data: { teacher: AuthUser } }>(
      '/api/auth/login',
      { username, password },
    );
    return resp.data.teacher;
  } catch (error) {
    return handleApiError(error, 'login');
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
