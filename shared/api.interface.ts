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

// === 资源状态 ===
export type ResourceStatus = 'draft' | 'pending_review' | 'published' | 'rejected';

// === 资料夹类型 ===
export type FolderType =
  | 'curriculum_outline'
  | 'weekly_plans'
  | 'courseware'
  | 'materials'
  | 'observation'
  | 'research_archive';

export const FOLDER_TYPES: FolderType[] = [
  'curriculum_outline',
  'weekly_plans',
  'courseware',
  'materials',
  'observation',
  'research_archive',
];

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
  | 'mfa_challenge_issued';

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
  action: 'approve' | 'reject';
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
