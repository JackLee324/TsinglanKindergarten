import { api } from './http'
import type { ResourceDetail, ResourceListPage, ResourceStatus } from './types'

export interface ResourceListQuery {
  readonly directoryId?: string | null
  readonly includeSubtree?: boolean
  readonly status?: ResourceStatus | null
  readonly q?: string | null
  readonly page?: number
  readonly pageSize?: number
}

function toQueryString(query: ResourceListQuery): string {
  const params = new URLSearchParams()
  if (query.directoryId != null && query.directoryId !== '') params.set('directoryId', query.directoryId)
  if (query.includeSubtree === true) params.set('includeSubtree', 'true')
  if (query.status != null) params.set('status', query.status)
  if (query.q != null && query.q !== '') params.set('q', query.q)
  if (query.page != null) params.set('page', String(query.page))
  if (query.pageSize != null) params.set('pageSize', String(query.pageSize))
  return params.toString()
}

/**
 * 资源接口（读取面 + 改标题/英文名/描述）。
 *
 * 文件相关的接口（上传 / 预览 / 下载 / 删除）在 `files.ts` ——
 * 它们有独立的失败语义（网络中断、取消、存储不可用），
 * 混在一起会让这里的错误处理变成一锅粥。
 *
 * 审核裁决（approve / reject）仍然不在这里：那是另一条业务链。
 */
export const resourcesApi = {
  /**
   * 建草稿资源。
   *
   * `directoryId` 是**必填且唯一**的分类字段（业主 §35：不许再有 program / subject /
   * folderType）。界面上它来自"老师当前所在的目录"，不是让他从下拉里挑。
   */
  create: (input: { directoryId: string; title: string; titleEn?: string | null; description?: string | null }) =>
    api.post<ResourceDetail>('/api/resources', input),

  list: (query: ResourceListQuery) =>
    api.get<ResourceListPage>(`/api/resources?${toQueryString(query)}`),

  mine: (query: Omit<ResourceListQuery, 'directoryId' | 'includeSubtree'>) =>
    api.get<ResourceListPage>(`/api/resources/mine?${toQueryString(query)}`),

  /** 详情按 **id** 取（标题可改、可重复，不能做 URL identity）。 */
  get: (id: string) => api.get<ResourceDetail>(`/api/resources/${id}`),

  /** 只改展示字段。目录归属的变更与文件替换都不在本阶段。 */
  update: (
    id: string,
    input: { title?: string; titleEn?: string | null; description?: string | null },
  ) => api.patch<ResourceDetail>(`/api/resources/${id}`, input),
}
