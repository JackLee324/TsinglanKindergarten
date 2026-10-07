/**
 * client/src/api/types.ts —— 前端使用的接口形状。
 *
 * 与后端 `shared/api.ts` 是同一套概念。**没有第二份定义**：
 * 能直接引用 shared 的地方就引用，这里只放前端特有的展示型类型。
 */
import type { PermissionCode, UserRole } from '@shared/permissions'

export type { PermissionCode, UserRole }

export interface SessionUser {
  readonly id: string
  readonly username: string
  readonly name: string
  readonly nameEn: string | null
  readonly role: UserRole
}

export interface Capabilities {
  readonly role: UserRole
  /**
   * 这个账号是不是管理员。**展示用**（界面上的「管理员」标签）。
   *
   * 前端自己不比较角色：能不能做某件事一律看下面的能力位，
   * 而"是不是管理员"这件事由服务端算好告诉界面。
   */
  readonly isAdmin: boolean
  readonly permissions: readonly string[]
  readonly canManageDirectories: boolean
  readonly canManageUsers: boolean
  readonly canReview: boolean
  readonly canPublish: boolean
  readonly canViewAudit: boolean
  readonly canUpload: boolean
}

/** 服务端算好的能力位。**前端不得自行推断**（否则按钮显隐与接口判定会分叉）。 */
export interface NodeCapabilities {
  readonly canManage: boolean
  readonly canCreateChild: boolean
  readonly canUpload: boolean
  readonly canCreateFolder: boolean
}

export interface DirectoryNode {
  readonly id: string
  readonly parentId: string | null
  readonly slug: string
  readonly name: string
  readonly nameEn: string | null
  readonly description: string | null
  readonly type: 'ROOT' | 'CATEGORY' | 'SECTION' | 'FOLDER'
  readonly sortOrder: number
  readonly enabled: boolean
  readonly allowChildren: boolean
  readonly allowFiles: boolean
  readonly allowCustomFolders: boolean
  readonly icon: string | null
  readonly path: string
  readonly capabilities: NodeCapabilities
  readonly resourceCount: number
  readonly children: readonly DirectoryNode[]
}

export type ResourceStatus = 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'REJECTED' | 'RECALLED'

export interface ResourceListItem {
  readonly id: string
  readonly directoryId: string
  /** 资源所在位置（完整目录路径），例如 `education/pre-k/virtue/resources`。 */
  readonly directoryPath: string
  readonly title: string
  readonly titleEn: string | null
  readonly description: string | null
  readonly status: ResourceStatus
  readonly version: number
  readonly uploaderId: string | null
  readonly uploaderName: string | null
  readonly fileCount: number
  readonly hasFile: boolean
  /** 最新一条退回意见（业主 §16：列表上就要能看到"为什么被退回来了"）。 */
  readonly latestReviewComment: string | null
  readonly publishedAt: string | null
  readonly deletedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 服务端分页。`totalPages` 由服务端算，前端不自己推导。 */
export interface ResourceListPage {
  readonly items: readonly ResourceListItem[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly totalPages: number
}

export interface ResourceDetail extends ResourceListItem {
  readonly reviewComment: string | null
  /** 资源里的文件（阶段 6）。**不含** storage key —— 那不该到前端来。 */
  readonly files: readonly ResourceFileSummary[]
  /**
   * 服务端算出的能力位 —— 前端不判断"我是不是上传者""我是不是审核员"。
   *
   * 它**不是**安全边界：每个动作的接口都会用同一套授权再拒一次。
   * 它只决定"这个按钮要不要摆出来"（业主：不允许假成功、不摆必然失败的按钮）。
   */
  readonly capabilities: ResourceCapabilities
}

export interface ResourceCapabilities {
  readonly canEdit: boolean
  readonly canSubmit: boolean
  /** 「通过并发布」是一步（业主 §14），所以只有待审核时才为 true。 */
  readonly canApprove: boolean
  readonly canReject: boolean
  readonly canRecall: boolean
  readonly canDelete: boolean
  /** 审核类动作被拒的原因（例如 `self-review`），界面据此解释而不是只说"没权限"。 */
  readonly reviewDeniedReason: string | null
}

/** 审核时间线的一条（业主 §7：多次审核全部保留，不覆盖）。 */
export interface ResourceReviewRecord {
  readonly id: string
  readonly action: string
  readonly actionLabel: string
  readonly fromStatus: string
  readonly toStatus: string
  readonly comment: string | null
  readonly actorId: string | null
  readonly actorName: string | null
  readonly createdAt: string
}

export interface DirectoryNodeDetail extends Omit<DirectoryNode, 'children'> {
  readonly children: readonly DirectoryNode[]
  readonly ancestors: readonly DirectoryNode[]
}

/** 列表排序（与 `shared/resource-query.ts` 的白名单同一份，由 shared 推导）。 */
export type ResourceSortKey = 'updated_desc' | 'updated_asc' | 'created_desc' | 'title_asc'

// ─────────────────────────────────────────────────────────────────────────────
// 管理员（阶段 8）
// ─────────────────────────────────────────────────────────────────────────────

/** 一条授权：权限 + 目录。`directoryId = null` 表示全平台。 */
export interface PermissionGrant {
  readonly permission: string
  readonly directoryId: string | null
}

/**
 * **读回来**的授权项：比提交用的 `PermissionGrant` 多一个 `label`。
 *
 * 界面要显示中文名而不是权限码，所以读接口必须把它带上；但提交时**不能**
 * 把读回来的对象原样发回去 —— 服务端 DTO 开了白名单，多一个字段就是 400，
 * 而管理员看到的只有"请求参数不合法"。
 *
 * 这个差别值得写进类型：Stage 8 的浏览器用例（⑦ 打开一位老师、
 * 一个字都不改就点保存）第一次跑就是在这里红的。
 */
export interface PermissionItem extends PermissionGrant {
  readonly label: string
}

/** 列表上的权限摘要（人事化说法，不出现权限码）。 */
export interface PermissionSummaryEntry {
  readonly permission: string
  readonly label: string
  readonly directoryCount: number
  /** 全平台授权（不针对某个目录）。 */
  readonly global: boolean
}

export interface AdminUserRow {
  readonly id: string
  /** 展示用（列表上的「管理员」标签）；判定不在前端。 */
  readonly isAdmin: boolean
  readonly username: string
  readonly name: string
  readonly nameEn: string | null
  readonly role: UserRole
  readonly status: 'active' | 'inactive'
  readonly createdAt: string
  readonly updatedAt: string
  /** 最后一次登录时间（来自会话表；从未登录过是 null）。 */
  readonly lastLoginAt: string | null
  readonly permissionCount: number
  readonly directoryCount: number
  readonly permissionSummary: readonly PermissionSummaryEntry[]
}

export interface AdminUserDetail extends AdminUserRow {
  readonly permissions: readonly PermissionGrant[]
}

export interface UserListPage {
  readonly items: readonly AdminUserRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly totalPages: number
}

export interface AuditLogRow {
  readonly id: string
  readonly actorId: string | null
  readonly actorName: string
  readonly action: string
  readonly actionLabel?: string
  readonly targetType: string
  readonly targetId: string | null
  readonly result: 'success' | 'denied' | 'failed'
  readonly detail: Record<string, unknown> | null
  readonly ip: string | null
  readonly createdAt: string
}

export interface AuditLogPage {
  readonly items: readonly AuditLogRow[]
  readonly total: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件（阶段 6）
// ─────────────────────────────────────────────────────────────────────────────

/** 界面上的文件条目。**不含** storage key / bucket —— 那些不该到前端来。 */
export interface ResourceFileSummary {
  readonly id: string
  readonly fileName: string
  readonly mimeType: string
  readonly size: number
  /** 服务端格式化好的大小（界面不自己算，免得出现两种写法）。 */
  readonly sizeLabel: string
  readonly sha256: string
  readonly previewable: boolean
  /** 用哪个 viewer：pdf / image / text；不能预览时是 null。 */
  readonly viewer: 'pdf' | 'image' | 'text' | null
  /** 不能预览时界面**逐字**显示这句话；能预览时是 null。 */
  readonly previewMessage: string | null
  readonly createdAt: string
}

/** ① 申请上传地址的返回。`size` 与 `sha256` 已经在签名里，客户端改不了。 */
export interface UploadTicket {
  readonly uploadId: string
  readonly storageKey: string
  readonly uploadUrl: string
  readonly method: 'PUT'
  /** 必须原样发送（S3 校验签名头；少一个就 403）。 */
  readonly headers: Record<string, string>
  readonly expiresInSeconds: number
  readonly maxBytes: number
  readonly fileName: string
  readonly mimeType: string
}

export type PreviewResponse =
  | {
      readonly previewable: true
      readonly url: string
      readonly mimeType: string
      readonly fileName: string
      readonly viewer: 'pdf' | 'image' | 'text'
      readonly expiresInSeconds: number
    }
  | {
      readonly previewable: false
      readonly mimeType: string
      readonly fileName: string
      readonly viewer: null
      readonly message: string
    }

export interface DownloadResponse {
  readonly url: string
  readonly fileName: string
  readonly mimeType: string
  readonly size: number
  readonly sha256: string
  readonly expiresInSeconds: number
}

/** 服务端生效的文件策略（与 `shared/file-policy.ts` 同一份常量）。 */
export interface FilePolicySummary {
  readonly maxFileSizeBytes: number
  readonly maxFileSizeLabel: string
  readonly allowedExtensions: readonly string[]
  readonly allowedTypesLabel: string
  readonly previewUnsupportedMessage: string
}
