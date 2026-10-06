// 前后端共享类型定义

// === 角色 ===
// SINGLE SOURCE OF TRUTH: roles, permissions and scope are defined in
// ./rbac.ts and re-exported here for backwards compatibility, so that existing
// `import { RoleCode } from '@shared/api.interface'` call sites keep working.
// Do NOT re-declare roles in this file — that is how the original 5-way drift
// (8 roles here / 7 in curriculum.data.ts / 7 in client app.tsx / missing
// k_assistant) happened.
import type { RoleCode, ProgramCode, PermissionCode, ScopeKind } from './rbac';
export type { RoleCode, ProgramCode, PermissionCode, ScopeKind };
export { ROLE_CODES } from './rbac';

// === 课程词汇（program / subject / sub-subject / theme / folder type）===
// SINGLE SOURCE OF TRUTH: the curriculum vocabulary is declared in
// ./curriculum.ts and re-exported here for backwards compatibility, so existing
// `import { FOLDER_TYPES } from '@shared/api.interface'` call sites keep working.
// `FolderType` and `FOLDER_TYPES` used to be re-declared here (a THIRD copy of
// the six folder tokens, after curriculum.data.ts and resources.dto.ts), and the
// subject/sub-subject/theme vocabulary was declared nowhere at all — each layer
// spelled it itself. Do NOT re-declare any of these tokens in this file.
// The type-only import is separate from the re-export because `FolderType` is
// used below as an annotation, and `export type { X } from ...` does not bind X
// in this scope.
import type { FolderType } from './curriculum';
export type { FolderType, CurriculumNode, ThemeDefinition } from './curriculum';
export {
  CURRICULUM,
  FOLDER_DEFINITIONS,
  FOLDER_TYPES,
  PROGRAM_CODES,
  THEME_SETS,
  findNode,
  findTheme,
  foldToken,
  isCanonicalSubject,
  isCanonicalSubSubject,
  normalizeFolderType,
  normalizeProgram,
  normalizeSubject,
  normalizeSubSubject,
  normalizeTheme,
  subSubjectNodes,
  subjectTokens,
  themeDbValue,
  themeDefinitions,
} from './curriculum';

// === 资源状态 ===
export type ResourceStatus = 'draft' | 'pending_review' | 'published' | 'rejected';

// === 审计动作 ===
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'login_denied'
  | 'logout'
  | 'session_expired'
  | 'resource_upload'
  | 'resource_download'
  | 'resource_download_denied'
  | 'storybook_cover_view'
  | 'resource_edit'
  | 'resource_submit_review'
  | 'resource_approve'
  | 'resource_recall'
  | 'resource_reject'
  | 'permission_denied'
  | 'permission_change'
  | 'teacher_create'
  | 'teacher_update'
  | 'password_changed'
  | 'password_change_failed'
  | 'password_reset'
  // --- 目录维护（§24/§25/§26，migration 0010 之后可编辑）--------------------
  // 单列三个动作而不是复用 permission_change：目录结构变更会被所有人看到，
  // 事后追查「谁把 K 班型的资料夹删了」需要能按目录动作直接筛出来。
  | 'directory_create'
  | 'directory_rename'
  | 'directory_delete'
  // 排序与启用/停用等对目录节点属性的修改。刻意**不复用** directory_rename ——
  // 审计里"改了名字"和"停用了一个科目"是完全不同的事，混在一个动作里
  // 会让事后追查变成猜谜。
  | 'directory_update'
  // --- MFA (added by migration 0006) ---------------------------------------
  | 'mfa_enrolled'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'mfa_reset'
  | 'mfa_success'
  | 'mfa_failed'
  | 'mfa_recovery_used'
  | 'mfa_recovery_regenerated'
  | 'mfa_challenge_issued'
  // --- 文件校验与回收站（phase 6 / migration 0007） -------------------------
  // Every action added here MUST also get a badge colour in
  // client/src/pages/AuditLog/AuditLogPage.tsx (that map is exhaustive over this
  // union, so omitting one is a type error) and an `audit.action.*` key for BOTH
  // zh and en in client/src/i18n/translations.ts.
  | 'resource_delete'
  | 'resource_restore'
  | 'resource_purge'
  // 全量逻辑导出（POST /api/admin/data-export）。
  // 单独一个动作而不是复用 audit.export：后者导出的是**审计日志**，
  // 前者把**整库**读走 —— 事后追查"谁在什么时候把整库拉走了"必须能单独筛出来。
  | 'data_export'
  // §8 批量归档：管理员把"只到科目层/完全未归属"的资源补到具体资料夹。
  // 它是一个**改数据的运维动作**，必须能单独筛出来 —— 谁在什么时候
  // 把哪 20 条资源挪去了哪里，事后要查得到。
  | 'resource_directory_assign'
  | 'resource_file_register'
  | 'resource_download_failed'
  | 'file_validation_rejected';

// === 教师 ===
export interface Teacher {
  id: string;
  username?: string;
  wecomUserId?: string;
  name: string;
  nameEn?: string;
  email?: string;
  roles: RoleCode[];
  status: 'active' | 'inactive';
  lastLoginAt?: string;
  createdAt: string;
}

export interface TeacherDetail extends Teacher {
  permissions?: SubjectPermission[];
}

export interface CreateTeacherRequest {
  username?: string;
  wecomUserId?: string;
  name: string;
  nameEn?: string;
  email?: string;
  roles: RoleCode[];
  status?: 'active' | 'inactive';
  permissions?: SubjectPermissionInput[];
}

export interface UpdateTeacherRequest {
  name?: string;
  nameEn?: string;
  email?: string;
  roles?: RoleCode[];
  status?: 'active' | 'inactive';
}

// === 科目权限 ===
export interface SubjectPermission {
  id: string;
  teacherId: string;
  program: ProgramCode;
  subject: string;
  subSubject?: string;
  canView: boolean;
  canUpload: boolean;
}

export interface SubjectPermissionInput {
  program: ProgramCode;
  subject: string;
  subSubject?: string;
  canView: boolean;
  canUpload: boolean;
}

// === 资源 ===
export interface Resource {
  id: string;
  title: string;
  titleEn?: string;
  program: ProgramCode;
  subject: string;
  subSubject?: string;
  /**
   * legacy 资料夹分类（6 值）。**与 directoryId 是两个维度**，并存：
   * 这一列是历史数据在用的"资料夹类型"，不因为有目录归属而被替换或改写。
   */
  folderType: FolderType;
  /**
   * 目录归属：指向可编辑目录树上的节点（§1）。与 `folderType` 是两个维度。
   * 未归属时为 null —— "尚未指定"，不是"属于某个默认目录"。
   */
  directoryId?: string | null;
  /** 该目录节点的 code，便于界面直接定位；服务端从目录表带出。 */
  directoryCode?: string | null;
  /** 该目录节点的中文名。 */
  directoryName?: string | null;
  semester?: string;
  weekNumber?: number;
  theme?: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  /**
   * Whether this resource has a REAL stored file — computed by the database from
   * the file columns (`file_path` AND `file_bucket_id` non-empty after trimming),
   * never guessed and never hand-maintained. See migration 0008 and
   * `resources.has_stored_file`.
   *
   * WHY THIS EXISTS: all 347 seeded rows have NULL file columns, so the "下载"
   * button used to render enabled on every one of them and then fail. `false`
   * means the resource is NOT downloadable and the UI must say so instead of
   * offering a download; `undefined` means the field was not provided.
   *
   * It is a statement about the ROW, not about object storage: the bucket cannot
   * be reached from this environment, so `true` means "the row points at a file",
   * which is the strongest claim that can be made from the database alone.
   */
  hasFile?: boolean;
  version: number;
  status: ResourceStatus;
  uploaderId: string;
  uploaderName: string;
  reviewerId?: string;
  reviewerName?: string;
  reviewComment?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
  // --- 回收站（migration 0007）---------------------------------------------
  // Set only on rows returned by the recycle bin. `deletedAt` is the soft-delete
  // marker: a row with it set is invisible to every normal listing and is
  // restored with POST /api/resources/:id/restore. `purgeAfter` is when the row
  // becomes eligible for permanent deletion.
  deletedAt?: string;
  deletedByName?: string;
  purgeAfter?: string;
}

export interface ResourceListResponse {
  items: Resource[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ResourceListParams {
  program?: ProgramCode;
  subject?: string;
  subSubject?: string;
  folderType?: FolderType;
  /**
   * 只列出**归属在该目录节点（含其所有子孙节点）下**的资源（§1）。
   *
   * 传的是目录 **code**（如 `prek:virtue` / `prek:virtue_outline` / 自建文件夹的
   * `prek:virtue.custom_x`），不是 uuid —— code 可读、可写进 URL、且前端从目录树
   * 直接就有。服务端负责解析成子树 id 集合。
   *
   * 含子孙是刻意的：老师在科目页期望看到"这个科目下所有资源"，
   * 而不是"正好挂在科目节点上、没进任何资料夹的那几份"。
   */
  directory?: string;
  semester?: string;
  weekNumber?: number;
  theme?: string;
  status?: ResourceStatus;
  page?: number;
  pageSize?: number;
}

export interface CreateResourceRequest {
  title: string;
  titleEn?: string;
  program: ProgramCode;
  subject: string;
  subSubject?: string;
  /**
   * legacy 资料夹分类。**新建时可省略**（§7）：
   * 服务端按 `directoryId` 指向的目录节点自动推导并维护这一列。
   * 只有需要显式覆盖（迁移、或目录无法自动推导）时才传。
   */
  folderType?: FolderType;
  /**
   * 目录归属（可编辑目录树的节点 id）。**新建时必填**（§8）。
   * 服务端会校验该节点存在、已启用、是资料夹叶节点，
   * 且与 `program`/`subject` 属于同一科目。
   */
  directoryId: string;
  semester?: string;
  weekNumber?: number;
  theme?: string;
  description?: string;
  fileBucketId?: string;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
}

export interface UpdateResourceRequest {
  title?: string;
  titleEn?: string;
  description?: string;
  status?: ResourceStatus;
  /** 目录归属（可编辑目录树的节点 id）。传 null 表示解除归属。 */
  directoryId?: string | null;
  semester?: string;
  weekNumber?: number;
  theme?: string;
  fileBucketId?: string;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
}

export interface ReviewResourceRequest {
  action: 'approve' | 'reject' | 'recall';
  comment?: string;
}

// === 审核记录 ===
export interface ReviewRecord {
  id: string;
  resourceId: string;
  reviewerId: string;
  reviewerName: string;
  action: 'approve' | 'reject';
  comment?: string;
  createdAt: string;
}

// === 审计日志 ===
export interface AuditLog {
  id: string;
  action: AuditAction;
  wecomUserId?: string;
  teacherId?: string;
  teacherName?: string;
  ipAddress?: string;
  resourceId?: string;
  resourceTitle?: string;
  program?: string;
  subject?: string;
  detail?: string;
  success: boolean;
  errorMessage?: string;
  createdAt: string;
}

export interface AuditLogListParams {
  action?: AuditAction;
  teacherId?: string;
  program?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditLogListResponse {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}

// === 认证 ===
export interface AuthUser {
  id: string;
  wecomUserId?: string;
  username: string;
  name: string;
  nameEn?: string;
  roles: RoleCode[];
  status: 'active' | 'inactive';
  mustChangePassword: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ResetPasswordRequest {
  teacherId: string;
}

export interface ResetPasswordResponse {
  temporaryPassword: string;
}

export interface AuthConfigResponse {
  loginType: 'password' | 'wecom';
}

// === 课程目录结构 ===
export interface SubjectNode {
  key: string;
  name: string;
  nameEn: string;
  path: string;
  children?: SubjectNode[];
}

export interface ProgramStructure {
  program: ProgramCode;
  name: string;
  nameEn: string;
  subjects: SubjectNode[];
}

// === 文件上传 ===
export interface UploadPreSignResponse {
  uploadUrl: string;
  fileId: string;
  bucketId: string;
}

// =============================================================================
// 目录树（PDF《教师平台》权威结构）—— 由 `directories` 表驱动（migration 0009）
// =============================================================================
//
// 与上面的 `ProgramStructure` 刻意分开，两者不是同一种东西：
//   * `ProgramStructure` / `SubjectNode` —— 应用既有页面（Pre-K/K 首页、资料夹页）
//     用的课程卡片树，来自 `shared/curriculum.ts` 里的常量。
//   * `DirectoryNode` —— PDF 那一棵**完整目录树**（含两个根：教育教学 / 教师成长，
//     含 PDF 新增的科目，含「允许自建文件夹」标记），来自数据库。
//
// 后者是「管理员可编辑」的那一份；前者暂时保留以维持现有页面不变（§1「不重做现有 UI」）。

export type DirectoryNodeType =
  | 'root'
  | 'section'
  | 'program'
  | 'subject'
  | 'sub_subject'
  | 'folder'
  | 'growth_level'
  | 'growth_node';

export interface DirectoryNode {
  id: string;
  /** 树路径式稳定标识，如 `prek:pe_lesson`、`k:chinese:reading`。全局唯一。 */
  code: string;
  name: string;
  nameEn: string;
  /**
   * 中文说明（可空）。
   *
   * 之前这一列**没有暴露到 API**，于是管理员在 `/directory` 里既看不到也改不了它，
   * 而数据库里它一直存在 —— 典型的"字段存在但没人能碰"。现在它跟着节点一起出去。
   */
  description: string | null;
  type: DirectoryNodeType;
  /** 所属班型；根/教师成长分支下为 null。 */
  program: ProgramCode | null;
  /**
   * 规范 subject token（`physical_education` 等），仅科目类节点有值。
   *
   * 曾经 PDF 新增的 `prek:english` / `k:chinese:arts` 在这里是 null（规范词汇里没有）。
   * 用户已决策把两者分别归属 prek_head / k_head，它们已正式纳入规范词汇
   * （见 shared/curriculum.ts 与 directory-vocabulary.ts），因此**全树已无 null 科目**。
   */
  subject: string | null;
  sortOrder: number;
  /**
   * PDF 里标注「允许自建文件夹」的叶节点。
   * 仅 `type = 'folder'` 且限特定科目，由数据库 CHECK 约束保证。
   */
  allowCustomFolders: boolean;
  /**
   * true = 来自 PDF《教师平台》的正式目录节点；false = 管理员自建。
   *
   * ⚠️ **这个标记不表示"不可改名"** —— 业主的规则是：
   *   显示名称（`name` / `nameEn` / `description`）随时可改，
   *   内部稳定标识（`code` / `id`）不可改。
   * 早期版本把它当成"正式目录不许改名"，是错的（保护错了对象：
   * code 才是稳定标识）。现在 `isSystem` 只用于两件事：
   *   1. 自建文件夹的父节点必须 `allowCustomFolders`；
   *   2. UI 上区分"正式目录"与"自建文件夹"。
   * 由数据库列 `is_system` 提供，不是"看 code 里有没有某段字符串"推出来的。
   */
  isSystem: boolean;
  /**
   * 是否启用。`false` 的节点**不会出现在树里**（loadAll 直接按 enabled=true 过滤），
   * 所以正常情况下读到的节点恒为 true；它出现在类型里是为了让写接口的返回与
   * "我刚刚停用了它"这件事一致，而不是让调用方以为停用没生效。
   */
  enabled: boolean;
  /** 该节点（含子树）下的资源条数，供 UI 显示徽标；无权限时为 0 而非猜测值。 */
  resourceCount: number;
  children: DirectoryNode[];
}

// === 资源版本历史（§15，migration 0011）===
export type ResourceVersionChangeKind =
  | 'backfilled'
  | 'created'
  | 'metadata_edited'
  | 'file_attached'
  | 'status_changed';

export interface ResourceVersion {
  id: string;
  resourceId: string;
  version: number;
  title: string;
  titleEn?: string;
  description?: string;
  folderType: FolderType;
  semester?: string;
  weekNumber?: number;
  theme?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  /** 该版本是否有真实文件（与 resources.has_file 同一判据，由快照列算出）。 */
  hasFile: boolean;
  status: ResourceStatus;
  /** 这一版**因为什么**产生。没有它，历史只是一串时间戳。 */
  changeKind: ResourceVersionChangeKind;
  changedBy: string;
  changedAt: string;
}

/**
 * §8 一条"待补齐"资源的只读投影。
 *
 * 它带着目录节点的 code/name/type，而 `Resource` 只带 `directoryId` ——
 * 管理页要显示"这条现在挂在哪个节点上"，光有 id 显示不出任何有意义的东西。
 * 刻意**不**并进 `Resource`：那会让每个资源列表接口都多背三个 join 字段，
 * 而那些列表并不需要它们。
 */
export interface UnderFiledResource {
  id: string;
  title: string;
  program: string;
  subject: string;
  subSubject: string | null;
  folderType: string;
  status: string;
  /** 当前 `directory_id` 指向节点的 code；NULL 归属时为 null。 */
  directoryCode: string | null;
  directoryName: string | null;
  /** 指向节点的类型；NULL 归属时为 null。 */
  directoryType: string | null;
  /**
   * 为什么进入这个列表。**两种情况的处理方式完全不同**：
   * `unassigned`（`directory_id IS NULL`）要"选一个目录"；
   * `subject_level`（挂在科目/子科上）要"往下再走一层到资料夹"。
   * 混成一个"未归档"标签，管理员会以为 349 条都无处安放。
   */
  reason: 'unassigned' | 'subject_level';
  updatedAt: string;
}

export interface UnderFiledListResponse {
  items: UnderFiledResource[];
  total: number;
  page: number;
  pageSize: number;
  /** 两种原因各有多少条（不受分页影响），供界面上的说明使用。 */
  counts: { unassigned: number; subjectLevel: number };
}

export interface DirectoryTreeResponse {
  /** 固定两根：教育教学、教师成长。调用方无权限的那一支不会出现在数组里。 */
  roots: DirectoryNode[];
  /**
   * 服务端统计的「允许自建文件夹」叶节点数量。
   * 前端**不要**用它做权限判断，它只是给「目录管理」页显示的计数。
   */
  customFolderLeafCount: number;
  /**
   * 本次响应里被权限过滤掉的科目 code —— 便于前端区分「这个科目没有资源」
   * 与「你没有这个科目的权限」，避免把 403 渲染成「暂无数据」。
   */
  hiddenSubjectCodes: string[];
  /**
   * 调用方**当前生效**的权限里有没有 `curriculum.manage`。
   *
   * 由服务端根据生效权限算出来，而不是让前端拿 roles 自己推：权限是可以按账号
   * 单独授予/拒绝的（account_permission_overrides），前端按角色推会两边不一致 ——
   * 那正是"幽灵权限"（界面上有按钮、点了 403）的成因。
   * 服务端算错也不会变成越权：写接口自己有 @RequirePermission。
   */
  canManage: boolean;
}
