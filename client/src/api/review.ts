import type {
  ResourceListParams,
  ResourceListResponse,
  ReviewRecord,
} from '@shared/api.interface';

import { axiosForBackend, handleApiError } from './client';

export async function getPendingReviews(params: ResourceListParams = {}): Promise<ResourceListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/review/pending', { params });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getPendingReviews');
  }
}

export async function reviewResource(
  id: string,
  action: 'approve' | 'reject',
  comment?: string,
): Promise<void> {
  try {
    await axiosForBackend.post(`/api/review/resources/${id}`, { action, comment });
  } catch (error) {
    handleApiError(error, 'reviewResource');
  }
}

export async function getReviewHistory(id: string): Promise<ReviewRecord[]> {
  try {
    const resp = await axiosForBackend.get(`/api/review/resources/${id}/history`);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getReviewHistory');
  }
}
