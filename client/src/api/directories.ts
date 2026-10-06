import type { DirectoryNode, DirectoryTreeResponse } from '@shared/api.interface';

import { axiosForBackend, handleApiError } from './client';

/**
 * 目录树接口（PDF《教师平台》权威结构，migration 0009 落库）。
 *
 * 与 `./curriculum` 的区别：`curriculum.getCurriculumStructure()` 返回的是
 * 既有页面用的课程卡片树（来自 `shared/curriculum.ts` 常量），而这里返回的是
 * **数据库里那棵完整的目录树**（含两个根、教师成长分支、以及「允许自建文件夹」
 * 标记）。管理员改目录改的是后者。
 */
export async function getDirectoryTree(): Promise<DirectoryTreeResponse> {
  try {
    const resp = await axiosForBackend.get('/api/directories/tree');
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getDirectoryTree');
  }
}

/**
 * 单个节点及子树。
 *
 * 无权限与不存在都返回 404（服务端刻意不区分，避免泄露目录结构），
 * 所以调用方无法据此判断"到底是没有还是没权限"——这是有意的。
 */
export async function getDirectoryNode(code: string): Promise<DirectoryNode> {
  try {
    const resp = await axiosForBackend.get('/api/directories/node', { params: { code } });
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'getDirectoryNode');
  }
}

/** 在允许自建的资料夹下新建子文件夹（需要 curriculum.manage）。 */
export async function createDirectoryFolder(input: {
  parentCode: string;
  name: string;
  nameEn?: string;
  description?: string;
}): Promise<DirectoryNode> {
  try {
    const resp = await axiosForBackend.post('/api/directories/folder', input);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'createDirectoryFolder');
  }
}

/** 重命名自建文件夹（仅自建节点；系统节点服务端会拒绝）。 */
export async function updateDirectoryNode(
  code: string,
  input: {
    name?: string;
    nameEn?: string;
    description?: string;
    /** 排序值，同级内从小到大。系统节点也可排序。 */
    sortOrder?: number;
    /** 启用/停用。停用后该节点从目录树上消失，可随时重新启用。 */
    enabled?: boolean;
  },
): Promise<DirectoryNode> {
  try {
    const resp = await axiosForBackend.patch(`/api/directories/node/${encodeURIComponent(code)}`, input);
    return resp.data;
  } catch (error) {
    return handleApiError(error, 'updateDirectoryNode');
  }
}

/** 删除自建文件夹（仅自建、且必须无子节点）。 */
export async function deleteDirectoryNode(code: string): Promise<void> {
  try {
    await axiosForBackend.delete(`/api/directories/node/${encodeURIComponent(code)}`);
  } catch (error) {
    return handleApiError(error, 'deleteDirectoryNode');
  }
}
