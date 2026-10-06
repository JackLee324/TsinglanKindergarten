import type {
  CreateResourceRequest,
  Resource,
  ResourceListParams,
  ResourceListResponse,
  UnderFiledListResponse,
  ResourceVersion,
  UpdateResourceRequest,
} from '@shared/api.interface';

import { axiosForBackend, handleApiError, readListResponse } from './client';

export async function getResources(params: ResourceListParams = {}): Promise<ResourceListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/resources', { params });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getResources');
  }
}

/** 版本历史（§15）。新的在前。 */
export async function getResourceVersions(id: string): Promise<ResourceVersion[]> {
  try {
    const resp = await axiosForBackend.get(`/api/resources/${id}/versions`);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getResourceVersions');
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

/**
 * 回收站列表（**管理员能力**：服务端在该路由上要求 `resource.restore`）。
 *
 * 与"我的资源"不是一回事：这里列出的是**已被软删除**的行，可以由具备
 * `resource.restore` 的人恢复。没有这个界面之前，老师误删之后只能由管理员
 * 直接调接口恢复 —— 界面上无路可走。
 */
export async function getRecycleBin(params: ResourceListParams = {}): Promise<ResourceListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/resources/recycle-bin', { params });
    // 与 `getMyResources` 同一套读法：服务端返回 { items, total, page, pageSize }。
    // 用 readListResponse 兜住"403 被当成空列表"的情况，避免把无权限渲染成"回收站是空的"。
    const { items, total } = readListResponse<Resource>(resp.data, 'getRecycleBin');
    const body = (resp.data ?? {}) as { page?: number; pageSize?: number };
    return {
      items,
      total,
      page: typeof body.page === 'number' ? body.page : (params.page ?? 1),
      pageSize: typeof body.pageSize === 'number' ? body.pageSize : (params.pageSize ?? 20),
    };
  } catch (error) {
    return handleApiError(error, 'getRecycleBin');
  }
}

/** 从回收站恢复一条资源（服务端审计动作 `resource_restore`）。 */
export async function restoreResource(id: string): Promise<void> {
  try {
    await axiosForBackend.post(`/api/resources/${id}/restore`);
  } catch (error) {
    return handleApiError(error, 'restoreResource');
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

// =============================================================================
// §4/§23 真实上传：申请直传地址 → PUT 字节 → 登记
// =============================================================================
//
// 三步是分开的，而且**必须**分开：
//   1. `getUploadUrl`   —— 服务端决定对象键并签发短期 PUT 地址；
//   2. `putFileBytes`   —— 浏览器直接把字节 PUT 给对象存储（不经过应用服务器）；
//   3. `registerResourceFile` —— 服务端做文件名清洗、类型/大小/魔数校验后登记。
// 拿到第 1 步的地址**不代表**已经被信任：不登记的话，行里就不会有文件，
// 界面也不会显示可下载 —— 这正是"直传 URL 泄露也不等于数据进来"的那层保护。

export interface UploadUrlResponse {
  uploadUrl: string;
  bucketId: string;
  filePath: string;
  expiresInSeconds: number;
}

/** 申请客户端直传地址。存储未配置时服务端返回 503（这是正确行为，应当如实告诉用户）。 */
export async function getUploadUrl(resourceId: string, fileName: string): Promise<UploadUrlResponse> {
  try {
    const resp = await axiosForBackend.post(`/api/resources/${resourceId}/upload-url`, { fileName });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getUploadUrl');
  }
}

/** 把字节直接 PUT 到预签名地址。**不走 axiosForBackend**：那是应用 API 的客户端。 */
export async function putFileBytes(uploadUrl: string, file: File): Promise<void> {
  const resp = await fetch(uploadUrl, { method: 'PUT', body: file });
  if (!resp.ok) {
    throw new Error(`上传到对象存储失败：HTTP ${resp.status}`);
  }
}

/** 读取文件头部若干字节并 base64 编码 —— 服务端用它做魔数校验。 */
async function readHeadBase64(file: File, bytes = 16): Promise<string> {
  const buf = await file.slice(0, bytes).arrayBuffer();
  let binary = '';
  const view = new Uint8Array(buf);
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** 登记文件（服务端校验通过后才算真正有文件）。 */
export async function registerResourceFile(
  resourceId: string,
  file: File,
  loc: { bucketId: string; filePath: string },
): Promise<{ hasFile: boolean }> {
  try {
    const head = await readHeadBase64(file);
    const resp = await axiosForBackend.post(`/api/resources/${resourceId}/file`, {
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      head,
      fileBucketId: loc.bucketId,
      filePath: loc.filePath,
    });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'registerResourceFile');
  }
}

/**
 * §8 待补齐资源列表（管理员）：完全没有目录归属的，以及只到科目/子科层、
 * 没精确到资料夹的。
 *
 * 两种原因由服务端在每条记录的 `reason` 上区分，并用 `counts` 给出各自总数
 * （不受分页影响）—— 界面上那句"共 349 条：1 条未归属、348 条只到科目层"
 * 必须来自服务端统计，不能由当前页推算。
 */
export async function listUnderFiledResources(params: {
  mode?: 'all' | 'unassigned' | 'subject_level';
  page?: number;
  pageSize?: number;
} = {}): Promise<UnderFiledListResponse> {
  try {
    const resp = await axiosForBackend.get('/api/resources/under-filed', { params });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'listUnderFiledResources');
  }
}

/**
 * §8 批量归档到资料夹。
 *
 * 服务端语义是"要么全部成功、要么一条都不动"：逐条校验通过后才执行一次
 * UPDATE，并核对影响行数。所以调用方**不需要**自己处理"部分成功"，
 * 失败就是整体失败，且响应里会说明原因。
 */
export async function assignResourcesToDirectory(input: {
  resourceIds: string[];
  directoryId: string;
  syncLegacyFolderType?: boolean;
}): Promise<{ assigned: number; folderTypeUpdates: number; directoryCode: string }> {
  try {
    const resp = await axiosForBackend.post('/api/resources/assign-directory', input);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'assignResourcesToDirectory');
  }
}
