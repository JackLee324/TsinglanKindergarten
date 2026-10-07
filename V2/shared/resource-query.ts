/**
 * shared/resource-query.ts —— 资源查询的**纯逻辑**（无数据库、无框架）
 * ============================================================================
 * 放在 shared 里是因为"分页怎么算"和"我的资源有哪些分栏"这两件事
 * 前后端必须完全一致 —— 前端要渲染分栏、要显示页码，如果两边各算一遍，
 * 迟早会出现"界面说有 3 页、接口只给 2 页"。
 */

/** 一页最多返回多少条。与后端 DTO 的上限保持一致。 */
export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 20

/**
 * 计算总页数。
 *
 * `total = 0` 时返回 **1**，不是 0 —— 界面显示"第 1 页 / 共 1 页"比
 * "第 1 页 / 共 0 页"更不容易让人以为坏了。空状态由 `total === 0` 单独判断。
 */
export function computeTotalPages(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  // ⚠️ `pageSize` 也要判 `isFinite`：`Math.max(1, Math.floor(NaN))` 是 **NaN**，
  // 于是 `Math.ceil(total / NaN)` 还是 NaN —— 界面上会显示"共 NaN 页"。
  // 这个坑是写这段的单元测试时发现的（断言 NaN 那一条直接失败）。
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 1
  return Math.max(1, Math.ceil(total / size))
}

/** 把越界的页码收进合法区间。 */
export function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), Math.max(1, totalPages))
}

/**
 * 列表排序方式（**白名单**）。
 *
 * 白名单而不是"把参数拼进 ORDER BY"：那个参数来自客户端，
 * 拼进 SQL 就是注入。而且排序字段一旦随便传，分页的不重不漏也会被破坏。
 */
export const RESOURCE_SORTS = [
  { key: 'updated_desc', label: '最近更新', sql: 'updated_desc' },
  { key: 'updated_asc', label: '最早更新', sql: 'updated_asc' },
  { key: 'created_desc', label: '最近创建', sql: 'created_desc' },
  { key: 'title_asc', label: '按标题', sql: 'title_asc' },
] as const

export type ResourceSortKey = (typeof RESOURCE_SORTS)[number]['key']
export const DEFAULT_RESOURCE_SORT: ResourceSortKey = 'updated_desc'

export function isResourceSortKey(value: unknown): value is ResourceSortKey {
  return typeof value === 'string' && RESOURCE_SORTS.some((s) => s.key === value)
}

/** 审核队列的分栏。与资源状态一一对应，界面直接用。 */
export const REVIEW_QUEUE_TABS = [
  { key: 'PENDING_REVIEW', label: '待审核' },
  { key: 'PUBLISHED', label: '已发布' },
  { key: 'REJECTED', label: '已退回' },
] as const

export type ReviewQueueTabKey = (typeof REVIEW_QUEUE_TABS)[number]['key']

/** 「我的资源」的分栏。顺序即界面上的顺序。 */
export const MY_RESOURCE_TABS = [
  { key: 'ALL', label: '全部', status: null },
  { key: 'DRAFT', label: '草稿', status: 'DRAFT' },
  { key: 'PENDING_REVIEW', label: '待审核', status: 'PENDING_REVIEW' },
  { key: 'PUBLISHED', label: '已发布', status: 'PUBLISHED' },
  { key: 'REJECTED', label: '已退回', status: 'REJECTED' },
  { key: 'RECALLED', label: '已撤回', status: 'RECALLED' },
] as const

export type MyResourceTabKey = (typeof MY_RESOURCE_TABS)[number]['key']
