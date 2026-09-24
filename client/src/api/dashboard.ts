import { axiosForBackend, handleApiError } from './client';

export interface TeacherDashboardStats {
  myResources: number;
  pendingReview: number;
  monthlyUpload: number;
  published: number;
  myPublished?: number;
  authorizedSubjects: number;
  prekCount?: number;
  kCount?: number;
  coverCount?: number;
}

export async function getStats(): Promise<TeacherDashboardStats> {
  try {
    const resp = await axiosForBackend.get('/api/dashboard/stats');
    const data = resp.data;
    return {
      ...data,
      published: data.myPublished ?? data.published ?? 0,
    };
  } catch (error) {
    return handleApiError(error, 'getStats');
  }
}

export async function getRecentUpdates(limit = 10): Promise<{
  items: Array<{
    id: string;
    title: string;
    titleEn?: string;
    program: string;
    subject: string;
    subSubject?: string;
    folderType: string;
    uploaderName: string;
    updatedAt: string;
  }>;
  total: number;
}> {
  try {
    const resp = await axiosForBackend.get('/api/dashboard/recent', {
      params: { limit },
    });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getRecentUpdates');
  }
}
