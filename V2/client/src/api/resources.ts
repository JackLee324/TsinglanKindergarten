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
 * 资源接口（阶段 5 只用到读 + 改标题/英文名/描述）。
 *
 * 上传、下载、预览、审核**都不在这个文件里** —— 它们属于后续阶段，
 * 在这个阶段出现就等于给了用户一个点了会失败的按钮。
 */
export const resourcesApi = {
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
