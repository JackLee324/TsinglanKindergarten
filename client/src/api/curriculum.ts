import type { ProgramStructure, RoleCode } from '@shared/api.interface';

import { axiosForBackend, handleApiError } from './client';

export async function getCurriculumStructure(): Promise<ProgramStructure[]> {
  try {
    const resp = await axiosForBackend.get('/api/curriculum/structure');
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getCurriculumStructure');
  }
}

export async function getFolders(): Promise<{ key: string; name: string; nameEn: string }[]> {
  try {
    const resp = await axiosForBackend.get('/api/curriculum/folders');
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getFolders');
  }
}

export async function getRoles(): Promise<RoleCode[]> {
  try {
    const resp = await axiosForBackend.get('/api/curriculum/roles');
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getRoles');
  }
}
