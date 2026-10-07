/**
 * shared/resource-status.ts —— 资源状态机（V2 **唯一**一份实现）
 * ============================================================================
 * 业主原话：「必须有严格状态机」「审核操作不要混用」。
 *
 * Service、测试、界面文案全部从这里派生。V1 的经验是状态规则散落在 service 的
 * if 里，于是"提交审核成功但状态没变"这类缺陷不会被任何接口测试发现 ——
 * 因为测试也只看它自己的 if。
 */

export const RESOURCE_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'REJECTED',
  'RECALLED',
] as const
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number]

export const RESOURCE_STATUS_LABEL: Readonly<Record<ResourceStatus, string>> = Object.freeze({
  DRAFT: '草稿',
  PENDING_REVIEW: '待审核',
  PUBLISHED: '已发布',
  REJECTED: '已退回',
  RECALLED: '已撤回',
})

export function isResourceStatus(value: unknown): value is ResourceStatus {
  return typeof value === 'string' && (RESOURCE_STATUSES as readonly string[]).includes(value)
}

/**
 * 动作名。这三个名字**必须区分开**（业主：「审核操作不要混用」）：
 *   · `review.approve` 通过 → PUBLISHED
 *   · `review.reject`  退回 → REJECTED
 *   · `review.recall`  撤回 → RECALLED（**不是** reject）
 *
 * 撤回走独立的动作与独立的接口，绝不写进 `review_records` 的 reject 里 ——
 * 否则「我的资源」会显示一条**假的退回原因**，教师以为自己的东西被别人否了。
 * 这正是 V1 "published 资源被误撤回"缺陷的根因。
 */
export const RESOURCE_ACTIONS = [
  'create',
  'update',
  'submit',
  'review.approve',
  'review.reject',
  'review.recall',
  'delete',
  'restore',
  'purge',
] as const
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number]

export interface TransitionSpec {
  readonly from: ResourceStatus
  readonly to: ResourceStatus
  readonly action: ResourceAction
  /** 需要哪个权限（`resource.publish` 等），由 authz 层判定。 */
  readonly permission: string
  /** 是否要求操作者是资源所有者（管理员可越过）。 */
  readonly requireOwner: boolean
  /** 退回必须带原因；其他转换不接受也不要求。 */
  readonly requireComment: boolean
}

/**
 * 完整转换表。**表里没有的转换一律 409 `ILLEGAL_TRANSITION`。**
 *
 * 例如 `DRAFT → PUBLISHED`（跳过审核）、`PUBLISHED → PENDING_REVIEW`（绕过撤回）
 * 都因为不在表里而被拒绝。
 */
export const TRANSITIONS: readonly TransitionSpec[] = Object.freeze([
  {
    from: 'DRAFT',
    to: 'PENDING_REVIEW',
    action: 'submit',
    permission: 'resource.submit',
    requireOwner: true,
    requireComment: false,
  },
  {
    from: 'REJECTED',
    to: 'DRAFT',
    action: 'update',
    permission: 'resource.update.own',
    requireOwner: true,
    requireComment: false,
  },
  {
    from: 'REJECTED',
    to: 'PENDING_REVIEW',
    action: 'submit',
    permission: 'resource.submit',
    requireOwner: true,
    requireComment: false,
  },
  {
    from: 'PENDING_REVIEW',
    to: 'PUBLISHED',
    action: 'review.approve',
    permission: 'resource.publish',
    requireOwner: false,
    requireComment: false,
  },
  {
    from: 'PENDING_REVIEW',
    to: 'REJECTED',
    action: 'review.reject',
    permission: 'resource.review',
    requireOwner: false,
    requireComment: true,
  },
  {
    from: 'PUBLISHED',
    to: 'RECALLED',
    action: 'review.recall',
    permission: 'resource.submit',
    requireOwner: true,
    requireComment: false,
  },
  {
    from: 'RECALLED',
    to: 'DRAFT',
    action: 'update',
    permission: 'resource.update.own',
    requireOwner: true,
    requireComment: false,
  },
])

export function findTransition(
  from: ResourceStatus,
  to: ResourceStatus,
): TransitionSpec | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to)
}

export function isLegalTransition(from: ResourceStatus, to: ResourceStatus): boolean {
  return findTransition(from, to) !== undefined
}

/** 从某个状态出发，允许到达哪些状态 —— 供界面决定显示哪些按钮。 */
export function allowedNextStatuses(from: ResourceStatus): readonly ResourceStatus[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to)
}

/** 只有这些状态可以被编辑（其余必须先走合法转换）。 */
export const EDITABLE_STATUSES: readonly ResourceStatus[] = ['DRAFT', 'REJECTED', 'RECALLED']

/** 只有这些状态可以被软删除。已发布必须先撤回，防止误删线上内容。 */
export const DELETABLE_STATUSES: readonly ResourceStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'REJECTED',
  'RECALLED',
]

/**
 * 编辑一个**已发布**的资源不允许原地覆盖：
 * 必须 `version += 1` 并回到 DRAFT，重新走审核。
 * 业主：「如果用户修改已经发布的资源，不要直接覆盖。」
 */
export const PUBLISHED_REQUIRES_NEW_VERSION = true

export function editOutcomeFor(status: ResourceStatus): {
  status: ResourceStatus
  bumpVersion: boolean
} {
  if (status === 'PUBLISHED') return { status: 'DRAFT', bumpVersion: true }
  return { status, bumpVersion: false }
}

/** 预览白名单（业主 §14）：只有这四类在网页里预览，其余一律只下载。 */
/*
 * 预览策略**不在这里**。
 *
 * 「哪些类型能在页面内预览」是**文件**的属性，不是资源状态的属性；
 * 而且它必须与"允许上传哪些类型"读同一份表，否则会出现
 * "允许上传但永远预览不了"或者反过来。
 * 唯一实现见 `shared/file-policy.ts`：
 *   PREVIEWABLE_MIME_TYPES / isPreviewableMime / isPreviewable / viewerFor /
 *   PREVIEW_UNSUPPORTED_MESSAGE
 */