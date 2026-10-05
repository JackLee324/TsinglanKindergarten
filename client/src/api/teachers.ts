import type {
  CreateTeacherRequest,
  SubjectPermissionInput,
  Teacher,
  TeacherDetail,
} from '@shared/api.interface';
import type { EffectivePermissions } from '@shared/rbac';

import { axiosForBackend, handleApiError } from './client';

interface TeacherListParams {
  page?: number;
  pageSize?: number;
  status?: 'active' | 'inactive';
  keyword?: string;
  role?: string;
}

interface TeacherListResponse {
  items: Teacher[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getTeachers(params: TeacherListParams = {}): Promise<TeacherListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/teachers', { params });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getTeachers');
  }
}

export async function getTeacher(id: string): Promise<TeacherDetail> {
  try {
    const resp = await axiosForBackend.get(`/api/teachers/${id}`);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getTeacher');
  }
}

export async function createTeacher(data: CreateTeacherRequest): Promise<Teacher> {
  try {
    const resp = await axiosForBackend.post('/api/teachers', data);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'createTeacher');
  }
}

export async function updateTeacher(
  id: string,
  data: Partial<CreateTeacherRequest>,
): Promise<Teacher> {
  try {
    const resp = await axiosForBackend.patch(`/api/teachers/${id}`, data);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'updateTeacher');
  }
}

export async function updateTeacherPermissions(
  id: string,
  permissions: SubjectPermissionInput[],
): Promise<TeacherDetail> {
  try {
    const resp = await axiosForBackend.post(`/api/teachers/${id}/permissions`, {
      permissions,
    });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'updateTeacherPermissions');
  }
}

// =============================================================================
// §11 按账号授权 —— 生效权限 / 追加授权 / 显式禁止 / 清除覆盖
// =============================================================================
//
// 对应 RBAC.md §5 的模型：有效权限 = (角色默认 ∪ 追加) − 显式禁止，且**禁止优先**。
// 服务端返回的 `sources` 会说明每一项的来源，界面据此把"角色自带"与"单独开/单独收"
// 区分开来 —— 否则管理员看不到自己那条覆盖到底生效了没有。

/** 某个账号的生效权限（含来源）。 */
export async function getEffectivePermissions(teacherId: string): Promise<EffectivePermissions> {
  try {
    const resp = await axiosForBackend.get(`/api/teachers/${teacherId}/effective-permissions`);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getEffectivePermissions');
  }
}

/** 追加授权：即使角色默认没有，也给这个账号开这个权限。 */
export async function grantPermission(teacherId: string, permission: string, reason?: string): Promise<EffectivePermissions> {
  try {
    const resp = await axiosForBackend.post(`/api/teachers/${teacherId}/permission-overrides/grant`, { permission, reason });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'grantPermission');
  }
}

/** 显式禁止：即使角色默认包含，也把这个权限收回来。 */
export async function denyPermission(teacherId: string, permission: string, reason?: string): Promise<EffectivePermissions> {
  try {
    const resp = await axiosForBackend.post(`/api/teachers/${teacherId}/permission-overrides/deny`, { permission, reason });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'denyPermission');
  }
}

/** 清除覆盖项，回到角色默认。 */
export async function clearPermissionOverride(teacherId: string, permission: string): Promise<EffectivePermissions> {
  try {
    const resp = await axiosForBackend.delete(`/api/teachers/${teacherId}/permission-overrides/${encodeURIComponent(permission)}`);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'clearPermissionOverride');
  }
}
