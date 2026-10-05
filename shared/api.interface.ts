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
  folderType: FolderType;
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
  folderType: FolderType;
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
  type: DirectoryNodeType;
  /** 所属班型；根/教师成长分支下为 null。 */
  program: ProgramCode | null;
  /**
   * 规范 subject token（`physical_education` 等），仅科目类节点有值。
   * PDF 新增、规范词汇中没有的科目为 null —— 见 directory-vocabulary.ts。
   */
  subject: string | null;
  sortOrder: number;
  /**
   * PDF 里标注「允许自建文件夹」的叶节点。
   * 仅 `type = 'folder'` 且限特定科目，由数据库 CHECK 约束保证。
   */
  allowCustomFolders: boolean;
  /** 该节点（含子树）下的资源条数，供 UI 显示徽标；无权限时为 0 而非猜测值。 */
  resourceCount: number;
  children: DirectoryNode[];
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
}
