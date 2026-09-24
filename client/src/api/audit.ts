import type { AuditLogListParams, AuditLogListResponse } from '@shared/api.interface';

import { axiosForBackend, handleApiError } from './client';

export async function getAuditLogs(params: AuditLogListParams = {}): Promise<AuditLogListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/audit/logs', { params });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getAuditLogs');
  }
}
