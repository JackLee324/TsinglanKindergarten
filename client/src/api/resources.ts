import type {
  CreateResourceRequest,
  Resource,
  ResourceListParams,
  ResourceListResponse,
  UpdateResourceRequest,
} from '@shared/api.interface';

import { axiosForBackend, handleApiError } from './client';

export async function getResources(params: ResourceListParams = {}): Promise<ResourceListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/resources', { params });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getResources');
  }
}

export async function getResource(id: string): Promise<Resource> {
  try {
    const resp = await axiosForBackend.get(`/api/resources/${id}`);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getResource');
  }
}

export async function createResource(data: CreateResourceRequest): Promise<Resource> {
  try {
    const resp = await axiosForBackend.post('/api/resources', data);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'createResource');
  }
}

export async function updateResource(
  id: string,
  data: UpdateResourceRequest,
): Promise<Resource> {
  try {
    const resp = await axiosForBackend.patch(`/api/resources/${id}`, data);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'updateResource');
  }
}

export async function deleteResource(id: string): Promise<void> {
  try {
    await axiosForBackend.delete(`/api/resources/${id}`);
  } catch (error) {
    handleApiError(error, 'deleteResource');
  }
}

export async function submitReview(id: string): Promise<Resource> {
  try {
    const resp = await axiosForBackend.post(`/api/resources/${id}/submit-review`);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'submitReview');
  }
}

export async function getMyResources(params: ResourceListParams = {}): Promise<ResourceListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/resources/mine', { params });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getMyResources');
  }
}

/**
 * URL for downloading a resource.
 *
 * CONTRACT: the server responds with a 302 redirect to a short-lived signed URL,
 * not with a JSON body. The previous client called this endpoint through axios and
 * looked for `response.data.downloadUrl`; axios followed the redirect, returned the
 * file BYTES, the field was undefined, and the download button silently did
 * nothing — no error, no toast, nothing to debug.
 *
 * A browser navigation is the correct client for a redirect + Content-Disposition
 * response: the session cookie is sent automatically, the browser follows the 302
 * and saves the file. No auth header is needed, which is also why using axios here
 * bought nothing.
 */
export function getDownloadUrl(resourceId: string): string {
  return `/api/resources/${resourceId}/download`;
}

export function getStorybookCoverUrl(resourceId: string, index: number): string {
  return `/api/resources/${resourceId}/storybook-cover/${index}`;
}
