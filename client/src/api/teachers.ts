import type {
  CreateTeacherRequest,
  SubjectPermissionInput,
  Teacher,
  TeacherDetail,
} from '@shared/api.interface';

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
