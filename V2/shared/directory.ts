/**
 * shared/directory.ts —— 目录（V2 唯一的导航与分类真相）
 * ============================================================================
 * 业主原话：「Directory 必须成为整个网页课程导航的唯一真相。」
 *
 * 目录是一个**通用树**：`parentId` 是唯一的结构事实，行为由节点自己的能力开关决定。
 * 它同时承载：
 *   · 教育教学 / 教师成长（PDF 初始目录）
 *   · 管理员以后新增的 活动 / 班级 / 校历 / 教研 / 培训 / 会议 / 通知 …
 *
 * ⚠️ 这里**没有** program / subject / subSubject / folderType / isSystem。
 * 那些列会把树锁死在"课程"这一种形状上，是 V1 多套目录真相的根源。
 */

/**
 * 节点类型**只影响展示**（缩进、默认图标、默认文案）。
 *
 * ⚠️ 任何业务规则都**不允许**按 `type` 分支 —— 行为一律看能力开关。
 * 这条由 `tests/unit/directory-capabilities.test.mjs` 静态保证。
 */
export const DIRECTORY_TYPES = ['ROOT', 'CATEGORY', 'SECTION', 'FOLDER'] as const
export type DirectoryType = (typeof DIRECTORY_TYPES)[number]

export function isDirectoryType(value: unknown): value is DirectoryType {
  return typeof value === 'string' && (DIRECTORY_TYPES as readonly string[]).includes(value)
}

/** 目录树的深度硬上限：防止病态树把递归查询与界面拖垮。 */
export const MAX_DIRECTORY_DEPTH = 12

/** slug 只允许小写字母、数字、连字符；长度 1–64。 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value)
}

/**
 * 由展示名生成候选 slug。
 *
 * 中文名无法音译，因此中文输入会得到空串 —— **这时必须由调用方要求管理员显式给 slug**，
 * 而不是编造一个 `node-1` 之类无意义的值（那会让 URL 永远无法阅读）。
 * 英文名可以直接规范化。
 */
export function slugifyCandidate(source: string): string {
  return source
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** 同级冲突时的候选：`virtue` → `virtue-2` → `virtue-3` … */
export function slugWithSuffix(base: string, attempt: number): string {
  if (attempt <= 1) return base
  const suffix = `-${attempt}`
  return `${base.slice(0, 64 - suffix.length)}${suffix}`
}

/**
 * 节点的能力开关。`enabled` 之外的三项决定界面：
 *   · `allowChildren`       → 能不能在其下继续建子目录
 *   · `allowFiles`          → 「上传资源」按钮出不出现
 *   · `allowCustomFolders`  → 普通教师的「新建文件夹」按钮出不出现
 *
 * 服务端按当前用户权限**算好**这些值再返回给前端；前端不得自行推断
 * （否则"按钮隐藏"与"接口拒绝"会分叉）。
 */
export interface DirectoryCapabilities {
  readonly allowChildren: boolean
  readonly allowFiles: boolean
  readonly allowCustomFolders: boolean
}

export interface DirectoryNode {
  readonly id: string
  readonly parentId: string | null
  /** 不可变。URL 用它。改名不动它。 */
  readonly slug: string
  /** 可编辑的展示名（中文）。 */
  readonly name: string
  readonly nameEn: string | null
  readonly description: string | null
  readonly type: DirectoryType
  readonly sortOrder: number
  readonly enabled: boolean
  readonly allowChildren: boolean
  readonly allowFiles: boolean
  readonly allowCustomFolders: boolean
  readonly icon: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DirectoryTreeNode extends DirectoryNode {
  readonly children: readonly DirectoryTreeNode[]
  /** 该节点（含子树）下的资源总数，用于卡片上的数量。 */
  readonly resourceCount: number
}

/** 目录 URL 的唯一 authority。前端与服务端**共用这一个函数**。 */
export function directoryPath(ancestors: readonly string[], slug: string): string {
  return `/directory/${[...ancestors, slug].join('/')}`
}

/**
 * 解析失败时向"最近一个仍可解析的祖先"回退，而不是 404 或白屏。
 * 输入是 URL 段，输出是"能解析到第几段"的结论 —— 由服务端做，前端只渲染结果。
 */
export function resolveFallbackDepth(exists: readonly boolean[]): number {
  let depth = 0
  for (const ok of exists) {
    if (!ok) break
    depth += 1
  }
  return depth
}
