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

/**
 * 状态机动作 → 审计动作。
 *
 * 为什么需要这张映射：业主 Stage 7 §20 点名要记
 * `resource.submit_review / resource.approve / resource.reject / resource.recall`，
 * 而状态机内部用的是 `submit / review.approve / review.reject / review.recall`
 * （这三个 review.* 名字**必须**互相区分，业主在阶段 2 就强调过"审核操作不要混用"）。
 *
 * 两套名字之间只允许有**这一个**映射函数 —— 在 service 里散着写字符串，
 * 迟早会出现"有人改了状态机动作、审计却还在记旧名字"，而审计断了是查不出来的。
 */
export const ACTION_AUDIT_NAME: Readonly<Record<ResourceAction, AuditActionName>> = Object.freeze({
  create: 'resource.create',
  update: 'resource.update',
  submit: 'resource.submit_review',
  'review.approve': 'resource.approve',
  'review.reject': 'resource.reject',
  'review.recall': 'resource.recall',
  delete: 'resource.delete',
  restore: 'resource.restore',
  purge: 'resource.purge',
})

/** 审计动作名（沿用 `shared/audit-actions.ts` 的键类型，避免两处定义）。 */
export type AuditActionName =
  | 'resource.create'
  | 'resource.update'
  | 'resource.submit_review'
  | 'resource.approve'
  | 'resource.reject'
  | 'resource.recall'
  | 'resource.delete'
  | 'resource.restore'
  | 'resource.purge'

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
 * 只有这六条（业主 Stage 7 §1 逐条列出的就是这六条）：
 *
 * ```
 * DRAFT          → PENDING_REVIEW     教师提交审核
 * PENDING_REVIEW → PUBLISHED          管理员通过并发布
 * PENDING_REVIEW → REJECTED           管理员退回（必须写原因）
 * REJECTED       → DRAFT              教师编辑（编辑动作本身会把它变回草稿）
 * PUBLISHED      → RECALLED           撤回
 * RECALLED       → DRAFT              教师编辑
 * ```
 *
 * 被这张表挡住的典型（每条都有对应用例）：
 *   · `DRAFT → PUBLISHED`（跳过审核）
 *   · `DRAFT → REJECTED`（还没提交就"退回"）
 *   · `PUBLISHED → REJECTED`（已发布的东西不能"退回"，只能撤回）
 *   · `REJECTED → PUBLISHED`（跳过复审）
 *   · `RECALLED → PUBLISHED`（绕过重新审核）
 *   · `REJECTED → PENDING_REVIEW`（**不经修改直接重新提交**）
 *
 * 最后这一条是 Stage 7 特意去掉的：退回之后"原样再交一次"会让审核员看到一模一样的内容，
 * 而业主的流程是「REJECTED → 编辑 → 提交」。去掉它之后，"重新提交"这条路上
 * 必然经过一次编辑动作（该动作把状态变回 DRAFT）。
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
 * 超级管理员可以**强制**把资源改成任何一个状态（业主 2026-10-15 的决定）。
 *
 * 这是一次**绕过状态机**的操作，与教师/审核员走的六条合法转换是两回事：
 *   · 它不检查 `TRANSITIONS`；
 *   · 它必须留下与流程动作**不同**的审计（`resource.status.force`）；
 *   · 界面上对"改成已发布"多要一次确认（那一步会绕过审核）。
 *
 * ⚠️ 它不改变"普通角色"的任何行为：六条合法转换、`DELETABLE_STATUSES`
 * 对一个只持权限码的教师**完全照旧**。
 */
export const FORCE_STATUS_TARGETS: readonly ResourceStatus[] = RESOURCE_STATUSES

/**
 * 强制改到这些状态时**必须**写原因。
 *
 * 只有 `REJECTED`：教师端"我的资源"卡片上直接显示退回原因，
 * 不写原因的话教师只会看到"已退回"而不知道为什么
 * （数据库上也有同名 CHECK 约束，见 `resource_reviews_reject_needs_comment`）。
 */
export const FORCE_STATUS_REQUIRES_COMMENT: readonly ResourceStatus[] = ['REJECTED']

/**
 * 目标状态 → 写进 `resource_reviews.action` 的那个动作。
 *
 * 为什么需要这张表：`resource_reviews.action` 有 CHECK 约束，只接受
 * `submit / review.approve / review.reject / review.recall` 四种
 * —— 所以"改成 DRAFT"**没有**对应的流程动作（教师编辑回草稿走的是
 * `resource.update` 审计，本来就不写 review 行）。
 *
 * `null` = 不写 review 行，只写审计。
 */
export const FORCE_STATUS_REVIEW_ACTION: Readonly<
  Record<ResourceStatus, 'submit' | 'review.approve' | 'review.reject' | 'review.recall' | null>
> = Object.freeze({
  DRAFT: null,
  PENDING_REVIEW: 'submit',
  PUBLISHED: 'review.approve',
  REJECTED: 'review.reject',
  RECALLED: 'review.recall',
})

/**
 * 强制改状态时，写进 review 行的说明。
 *
 * 时间线上必须一眼看出"这一步不是审核出来的" —— 否则一条
 * "审核通过并发布"会让人以为有人真审过。
 */
export const FORCE_STATUS_COMMENT_PREFIX = '超级管理员强制修改状态'

/**
 * 软删除一条**已发布**资源时，先记下来的那一步。
 *
 * 业主 2026-10-15 的决定：超管可以直接删除已发布的资源，
 * 但**要先记为「已撤回」再进回收站** —— 于是
 *   · 审核时间线里留下"这东西为什么下线了"；
 *   · 从回收站恢复之后是「已撤回」而不是「已发布」，
 *     不会一恢复就重新对全园可见（要重新编辑 / 提交）。
 */
export const PUBLISHED_DELETE_VIA_RECALL = true

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
  // 已发布：+1 版本并回到草稿，重新走审核（不原地覆盖线上内容）。
  if (status === 'PUBLISHED') return { status: 'DRAFT', bumpVersion: true }
  // 已退回 / 已撤回：编辑即回到草稿。
  //
  // ⚠️ 这两条以前是"编辑之后仍是原状态"，因为当时存在 REJECTED→PENDING_REVIEW 这条直接转换。
  // 阶段 7 去掉了那条转换（业主流程是「REJECTED → 编辑 → 提交」），
  // 于是编辑必须把状态带回 DRAFT —— 否则教师编辑完了却卡在 REJECTED，
  // 提交按钮永远点不动，而"重新提交"这条路就断了。
  if (status === 'REJECTED') return { status: 'DRAFT', bumpVersion: false }
  if (status === 'RECALLED') return { status: 'DRAFT', bumpVersion: false }
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