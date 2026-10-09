/**
 * shared/permissions.ts —— 权限目录（V2 唯一的授权词汇表）
 * ============================================================================
 * 这是**代码里的常量**，与"谁被授予了它"（数据库 `user_permissions` 表）严格分离。
 *
 * 业主最终确认：**12 项，不再增加。** 要加必须先证明现有 12 项表达不了。
 *
 * 每一项都必须在服务端被真实接口引用 —— 定义了却没有业务的"幽灵权限"由
 * `tests/unit/permission-catalog.test.mjs` 静态拒绝。
 *
 * ⚠️ 这个文件里**没有**、也永远不会有：
 *   deny / grant / override / role ceiling / permission version / 多套 Scope。
 * 管理员界面上也不会出现这些词，只出现 `label` 里的中文。
 */

/** 权限码的权威列表。顺序即管理界面的展示顺序（不允许按字母排序）。 */
export const PERMISSION_CODES = [
  'resource.view',
  'resource.create',
  'resource.update.own',
  'resource.delete.own',
  'resource.download',
  'resource.submit',
  'resource.review',
  'resource.publish',
  'directory.manage',
  'directory.create_folder',
  'user.manage',
  'audit.view',
] as const

export type PermissionCode = (typeof PERMISSION_CODES)[number]

/** 授权是按目录生效（directory）还是全平台（global）。 */
export type PermissionScope = 'directory' | 'global'

export interface PermissionMeta {
  /** 管理员界面显示的**唯一**文案。界面不得显示权限码本身。 */
  readonly label: string
  /** 英文界面用。 */
  readonly labelEn: string
  readonly scope: PermissionScope
  /** 一句话说明它的业务含义，用于文档与测试失败信息。 */
  readonly description: string
}

export const PERMISSIONS: Readonly<Record<PermissionCode, PermissionMeta>> = Object.freeze({
  'resource.view': {
    label: '查看资源',
    labelEn: 'View resources',
    scope: 'directory',
    description: '能看到该目录（含子树）下的资源列表与详情。',
  },
  'resource.create': {
    label: '上传资源',
    labelEn: 'Upload resources',
    scope: 'directory',
    description: '能在该目录（含子树）下新建资源。目录本身还必须 allowFiles = true。',
  },
  'resource.update.own': {
    label: '编辑自己的资源',
    labelEn: 'Edit own resources',
    scope: 'directory',
    description: '能编辑**自己上传**的资源；别人的资源即使在同一目录也不可编辑。',
  },
  'resource.delete.own': {
    label: '删除自己的资源',
    labelEn: 'Delete own resources',
    scope: 'directory',
    description:
      '能把**自己上传**的资源软删除进回收站并恢复；能看到自己的回收站条目。' +
      '管理员不受此限制，且只有管理员能永久删除。',
  },
  'resource.download': {
    label: '下载资源',
    labelEn: 'Download resources',
    scope: 'directory',
    description: '能下载与在线预览该目录（含子树）下资源的文件。',
  },
  'resource.submit': {
    label: '提交审核',
    labelEn: 'Submit for review',
    scope: 'directory',
    description: '能把自己的草稿提交审核、并撤回自己已发布的资源。',
  },
  'resource.review': {
    label: '审核资源',
    labelEn: 'Review resources',
    scope: 'directory',
    description: '能看到待审列表并**退回**（reject）该目录（含子树）下的资源。',
  },
  'resource.publish': {
    label: '发布资源',
    labelEn: 'Publish resources',
    scope: 'directory',
    description: '能**通过**（approve）待审资源使其发布，也能直接改任何人的资源。',
  },
  'directory.manage': {
    label: '管理目录',
    labelEn: 'Manage directories',
    scope: 'directory',
    description:
      '能新增/改名/改英文名/改说明/排序/启停/删除（仅限空目录）该目录（含子树）下的节点。',
  },
  'directory.create_folder': {
    label: '新建文件夹',
    labelEn: 'Create folders',
    scope: 'directory',
    description:
      '能在该目录（含子树）下建文件夹；目标目录本身还必须 allowCustomFolders = true。',
  },
  'user.manage': {
    label: '管理教师',
    labelEn: 'Manage users',
    scope: 'global',
    description: '能创建/编辑/停用账号，并修改任何人的权限与开放范围。',
  },
  'audit.view': {
    label: '查看审计',
    labelEn: 'View audit log',
    scope: 'global',
    description: '能查询审计日志（谁在什么时候做了什么、结果如何）。',
  },
})

/** 身份：业主最终确认只有两种。 */
export const USER_ROLES = ['ADMIN', 'TEACHER'] as const
export type UserRole = (typeof USER_ROLES)[number]

export const ADMIN_ROLE: UserRole = 'ADMIN'
export const TEACHER_ROLE: UserRole = 'TEACHER'

/** 运行期校验用（不依赖 TypeScript 类型，因为值可能来自 HTTP 请求体）。 */
export function isPermissionCode(value: unknown): value is PermissionCode {
  return typeof value === 'string' && (PERMISSION_CODES as readonly string[]).includes(value)
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
}

/**
 * 把数据库/外部来的身份字符串归一化成两种之一。
 *
 * 它放在这里（词汇表）而不是放在守卫或 service 里，是为了让 `ADMIN_ROLE`
 * 这个常量在 `server/` 之下**只出现一次**（AuthorizationService）。
 * 一旦守卫里也能写 `ADMIN_ROLE`，"管理员放行"就有了第二个可写的地方。
 */
export function normalizeUserRole(value: unknown): UserRole {
  return value === ADMIN_ROLE ? ADMIN_ROLE : TEACHER_ROLE
}

/**
 * **不可授予**的权限：它是身份自带的，不是一个能发给某个账号的能力（业主 Stage 13 §4）。
 *
 * 目前只有 `user.manage`：账号管理的门槛是**身份**（超级管理员），
 * 服务端的判定在 `AuthorizationService.assertSuperAdmin()`，与这份授权表无关。
 *
 * WHY 必须显式列出来，而不是"界面上不显示就行"：
 *   · 只有一个真相 —— 界面、服务端校验、测试都读这一个常量；
 *   · 否则"某个老师被授予了管理教师"会看起来像真的（其实是空授权），
 *     日后有人顺手在守卫里加一句"有 user.manage 也放行"，提权通道就又开了。
 */
export const NON_GRANTABLE_PERMISSIONS: readonly PermissionCode[] = ['user.manage']

/** 这个权限能不能出现在勾选框里 / 能不能被写入 `user_permissions`。 */
export function isGrantable(permission: PermissionCode): boolean {
  return !NON_GRANTABLE_PERMISSIONS.includes(permission)
}

/**
 * 管理员界面的勾选框清单 —— **顺序即业主给定的顺序**。
 *
 * WHY 单独一个函数而不是直接遍历 PERMISSION_CODES：
 * 界面的阅读顺序是产品决策（资源类 → 审核类 → 管理类），
 * 而权限码的字母序会把「查看审计」排到最前面，那是给机器看的顺序。
 *
 * 不可授予的权限（见 `NON_GRANTABLE_PERMISSIONS`）**不在这里**。
 */
export function permissionChecklist(): readonly PermissionCode[] {
  return [
    'resource.view',
    'resource.create',
    'resource.update.own',
    'resource.delete.own',
    'resource.download',
    'resource.submit',
    'resource.review',
    'resource.publish',
    'directory.manage',
    'directory.create_folder',
    'audit.view',
  ].filter((code) => isGrantable(code as PermissionCode)) as PermissionCode[]
}

/** 「自己拥有」类权限：对别人的资源一律拒绝，即使目录范围覆盖。 */
export const OWN_ONLY_PERMISSIONS: readonly PermissionCode[] = ['resource.update.own']

/** 「自己拥有」类权限中，管理员可以越过所有权的那一条在这里单独列出。 */
export function requiresOwnership(permission: PermissionCode): boolean {
  return permission === 'resource.update.own' || permission === 'resource.delete.own'
}
