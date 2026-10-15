import { api } from './http'
import type {
  ResourceDetail,
  ResourceListPage,
  ResourceReviewRecord,
  ResourceSortKey,
  ResourceStatus,
} from './types'

/** 单次批量软删除的上限 —— 与后端 `MAX_BULK_DELETE` 同一个数。 */
export const MAX_BULK_DELETE = 100

/**
 * 批量软删除里**单条**的结果。
 *
 * 三种结局必须分开看：`skipped` 是"按规则不动"（不存在 / 已在回收站 / 已发布），
 * **不是错误** —— 把它和 `failed` 混在一起，界面会把"这条本来就不该删"
 * 显示成"删除失败"，用户就会去重试一件永远不会成功的事。
 */
export interface BulkDeleteItemResult {
  readonly id: string
  readonly outcome: 'deleted' | 'skipped' | 'failed'
  readonly reason: string | null
  readonly message: string
}

export interface BulkDeleteResult {
  readonly requested: number
  readonly unique: number
  readonly duplicated: number
  readonly deleted: number
  readonly skipped: number
  readonly failed: number
  readonly items: readonly BulkDeleteItemResult[]
}

/** 单次批量**强制改状态**的上限 —— 与后端 `MAX_BULK_STATUS` 同一个数。 */
export const MAX_BULK_STATUS = 100

/**
 * 批量强制改状态里单条的结果。
 *
 * 与删除那一份同构（三种结局、`reason` 给程序、`message` 给人），
 * 成功那一档叫 `updated`；另外多带 `from` / `to`，
 * 界面才能显示「草稿 → 已发布」这种一眼看懂的变化。
 */
export interface BulkStatusItemResult {
  readonly id: string
  readonly outcome: 'updated' | 'skipped' | 'failed'
  readonly reason: string | null
  readonly message: string
  readonly from: string | null
  readonly to: string | null
}

export interface BulkStatusResult {
  readonly requested: number
  readonly unique: number
  readonly duplicated: number
  readonly updated: number
  readonly skipped: number
  readonly failed: number
  readonly status: string
  readonly items: readonly BulkStatusItemResult[]
}

export interface ResourceListQuery {
  readonly directoryId?: string | null
  readonly includeSubtree?: boolean
  readonly status?: ResourceStatus | null
  /**
   * 只看**自己上传**的（服务端按 `uploader_id` 强制过滤，不是前端过滤）。
   * 目录页用它来列"我的未发布资源" —— 自己的草稿/待审核可见，
   * 但别人的未发布内容不会因此暴露。
   */
  readonly onlyMine?: boolean
  readonly q?: string | null
  readonly sort?: ResourceSortKey
  readonly page?: number
  readonly pageSize?: number
}

function toQueryString(query: ResourceListQuery): string {
  const params = new URLSearchParams()
  if (query.directoryId != null && query.directoryId !== '') params.set('directoryId', query.directoryId)
  if (query.includeSubtree === true) params.set('includeSubtree', 'true')
  if (query.status != null) params.set('status', query.status)
  if (query.onlyMine === true) params.set('onlyMine', 'true')
  if (query.q != null && query.q !== '') params.set('q', query.q)
  if (query.sort != null) params.set('sort', query.sort)
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

  /** 提交审核（DRAFT → PENDING_REVIEW）。没有文件会被服务端拒（400）。 */
  submit: (id: string) => api.post<ResourceDetail>(`/api/resources/${id}/submit`),

  /**
   * 审核裁决。`approve` 一步到位变成已发布（业主 §14），`reject` 必须带原因。
   * 撤回**不在这里** —— 它是独立动作、独立接口（见 `recall`）。
   */
  review: (id: string, input: { action: 'approve' | 'reject'; comment?: string | null }) =>
    api.post<ResourceDetail>(`/api/resources/${id}/review`, input),

  recall: (id: string, comment?: string | null) =>
    api.post<ResourceDetail>(`/api/resources/${id}/recall`, { comment: comment ?? null }),

  /**
   * 删除资源（**软删除**：进回收站，不是抹掉）。
   *
   * 业主 §14 的回收站要求"删了能恢复"，所以界面上的词是「删除」，
   * 而数据库里发生的是 `deleted_at` 被写上 —— 历史、审核记录、审计都还在。
   */
  remove: (id: string) => api.del<ResourceDetail>(`/api/resources/${id}`),

  /** 从回收站恢复。 */
  restore: (id: string) => api.post<ResourceDetail>(`/api/resources/${id}/restore`),

  /**
   * **批量软删除**（进回收站、可恢复）。超级管理员专用。
   *
   * 返回的是逐条结果，不是 `ok: true` —— 批量里"部分成功"是常态，
   * 界面必须能分清哪条删了、哪条被跳过、哪条失败。
   * 服务端会再校验一次身份（`@RequireSuperAdmin()`），
   * 前端显示入口只是"不摆必然失败的操作"。
   */
  bulkDelete: (ids: readonly string[]) =>
    api.post<BulkDeleteResult>('/api/resources/bulk-delete', { ids: [...ids] }),

  /**
   * 批量**强制修改状态**（超级管理员）。
   *
   * 这是一次绕过状态机的覆盖：五个状态里任何一个都能设。
   * 服务端的代价与约束（退回必须带原因、改成已发布要二次确认）都在界面之外
   * **再判一次** —— 前端只是不摆必然失败的入口。
   */
  bulkUpdateStatus: (ids: readonly string[], status: ResourceStatus, comment?: string | null) =>
    api.post<BulkStatusResult>('/api/resources/bulk-status', {
      ids: [...ids],
      status,
      comment: comment ?? null,
    }),

  /** 回收站：教师看自己的，管理员看全部（服务端决定范围）。 */
  recycleBin: (query: { page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams()
    if (query.page != null) params.set('page', String(query.page))
    if (query.pageSize != null) params.set('pageSize', String(query.pageSize))
    const suffix = params.toString()
    return api.get<ResourceListPage>(`/api/resources/mine/recycle-bin${suffix ? `?${suffix}` : ''}`)
  },

  /** 管理员视角的回收站（全部人的）。 */
  allRecycleBin: () => api.get<ResourceListPage>('/api/resources/recycle-bin'),

  /** 完整审核时间线（业主 §7：多次审核全部保留）。 */
  reviewHistory: (id: string) =>
    api.get<{ items: readonly ResourceReviewRecord[] }>(`/api/resources/${id}/review-history`),
}

/** 审核队列（业主 §3）：搜索 + 目录过滤 + 排序 + 服务端分页。 */
export const reviewsApi = {
  queue: (status: ResourceStatus, query: ResourceListQuery) =>
    api.get<ResourceListPage>(`/api/reviews/${queuePath(status)}?${toQueryString(query)}`),
}

function queuePath(status: ResourceStatus): string {
  // 只有这三个分栏（业主 §3/§21）。其它状态不是"队列"关心的事：
  // 草稿是教师的私有工作区，已撤回只出现在「我的资源」。
  if (status === 'PUBLISHED') return 'published'
  if (status === 'REJECTED') return 'rejected'
  return 'pending'
}
