import { api } from './http'
import type { DirectoryNode, DirectoryNodeDetail } from './types'

/**
 * 目录接口。
 *
 * 全站目录数据的**唯一**来源。任何页面都不得自己拼目录路径或维护目录数组 ——
 * 那正是 V1 "改名后某处没同步"的根源。
 */
export const directoriesApi = {
  tree: () => api.get<{ roots: DirectoryNode[] }>('/api/directories/tree'),

  /**
   * 按 slug 路径解析（`pre-k/virtue`）。
   * 解析不到时服务端会**退到最近一个可用祖先**，并给出 `resolvedCount` 与剩余段 ——
   * 界面据此提示"已回到 X"，而不是白屏或 404。
   */
  byPath: (path: string) =>
    api.get<{
      node: DirectoryNodeDetail | null
      resolvedCount: number
      restSegments: string[]
    }>(`/api/directories/by-path?path=${encodeURIComponent(path)}`),

  get: (id: string) => api.get<DirectoryNodeDetail>(`/api/directories/${id}`),

  create: (input: {
    parentId?: string | null
    name: string
    nameEn?: string | null
    description?: string | null
    slug?: string
    type?: string
    allowChildren?: boolean
    allowFiles?: boolean
    allowCustomFolders?: boolean
  }) => api.post<DirectoryNode>('/api/directories', input),

  /**
   * 改目录。**只提交展示层字段** —— `slug` 与 `parentId` 不在其中，
   * 服务端的 DTO 也会拒绝它们（`forbidNonWhitelisted`）。
   */
  update: (
    id: string,
    input: {
      name?: string
      nameEn?: string | null
      description?: string | null
      enabled?: boolean
      allowChildren?: boolean
      allowFiles?: boolean
      allowCustomFolders?: boolean
    },
  ) => api.patch<DirectoryNode>(`/api/directories/${id}`, input),

  move: (id: string, parentId: string | null) =>
    api.post<DirectoryNode>(`/api/directories/${id}/move`, { parentId }),

  reorder: (id: string, direction: 'up' | 'down') =>
    api.post<{ ok: true }>(`/api/directories/${id}/reorder`, { direction }),

  remove: (id: string) => api.del<{ ok: true; name: string }>(`/api/directories/${id}`),

  createFolder: (input: { parentId: string; name: string; nameEn?: string | null }) =>
    api.post<DirectoryNode>('/api/directories/folders', input),
}
