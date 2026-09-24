/**
 * shared/rbac.ts — SINGLE SOURCE OF TRUTH for roles, permissions and data scope.
 * =============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this file the project had the role list duplicated in at least five
 * places that had already drifted apart:
 *
 *   shared/api.interface.ts        RoleCode        -> 8 roles
 *   server/.../curriculum.data.ts  ROLE_DEFINITIONS-> 7 roles (missing k_assistant)
 *   server/.../teachers.dto.ts     ROLE_CODES      -> 8 roles
 *   client/src/app.tsx             TEACHER_ROLES   -> 7 roles (no visitor)
 *   client/src/components/Layout.tsx  role groups -> 5 different local lists
 *
 * and authorization was expressed as scattered `roles.includes('x')` checks in
 * controllers and services, with no data-scope concept at all.
 *
 * This file is imported by BOTH the NestJS server and the React client, so the
 * frontend can render permission UI from the same catalog the backend enforces.
 * The backend is always the enforcer; the client copy is presentation only.
 *
 * DESIGN PRINCIPLES
 * -----------------
 * 1. The permission CATALOG and the ROLE -> permission DEFAULTS live in code.
 *    Only per-account DELTAS (extra grants / explicit denies) and data scope
 *    live in the database. This keeps a schema change from being needed every
 *    time a permission is added, and removes catalog drift by construction.
 * 2. `super_admin` is not "a role with everything bolted on" — it is a distinct
 *    protected role. It can only be granted or modified by an existing
 *    super_admin (see `canGrantRole` / `isProtectedRole`), and the database
 *    enforces the same rule with a trigger so an application bug cannot bypass it.
 * 3. Effective permissions are:  (role defaults  ∪  grants)  −  denies
 *    Deny always wins. This lets an administrator grant a capability broadly and
 *    then carve out one account or one subject.
 * 4. Scope controls WHICH rows a permission applies to: ALL / PROGRAM / SUBJECT / OWN.
 *
 * This module must stay dependency-free (no Node built-ins, no NestJS, no React)
 * because it is bundled into the browser build.
 */

// =============================================================================
// 1. ROLES
// =============================================================================

export type RoleCode =
  | 'super_admin'
  | 'principal'
  | 'curriculum_director'
  | 'prek_head'
  | 'k_head'
  | 'pe_specialist'
  | 'prek_assistant'
  | 'k_assistant'
  | 'visitor';

/**
 * The system super administrator. Handled specially throughout:
 *  - only an existing super_admin may create/modify/disable another one;
 *  - it always holds every permission at scope ALL;
 *  - its row is protected at the database level.
 */
export const SUPER_ADMIN_ROLE: RoleCode = 'super_admin';

/**
 * Roles whose holder is a "system/administrative" role rather than a teaching
 * role. Used by UI grouping and by the bootstrap flow.
 */
export const SYSTEM_ROLES: RoleCode[] = ['super_admin', 'principal'];

/**
 * Rank is used ONLY for the "an administrator may not grant a role at or above
 * their own level" rule. It is deliberately NOT used to decide whether a
 * permission is allowed — that is what the permission catalog is for. Hard-coding
 * "higher role can do anything" is exactly the anti-pattern this design avoids.
 */
export const ROLE_RANK: Record<RoleCode, number> = {
  super_admin: 100,
  principal: 80,
  curriculum_director: 60,
  prek_head: 40,
  k_head: 40,
  pe_specialist: 40,
  prek_assistant: 20,
  k_assistant: 20,
  visitor: 0,
};

export interface RoleDefinition {
  code: RoleCode;
  name: string;      // zh-CN
  nameEn: string;    // en-US
  description: string;
  /** Teaching roles belong to a program; system/admin roles do not. */
  program: 'prek' | 'k' | 'both' | 'none';
  /** true = cannot be created/deleted/modified except by a super_admin. */
  protected: boolean;
  /** true = a super_admin can never be permanently deleted while it is the last one. */
  singletonProtected: boolean;
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    code: 'super_admin',
    name: '系统超级管理员',
    nameEn: 'System Super Administrator',
    description: '系统最高权限。可管理所有账号、角色、权限、审计、会话、系统配置与安全设置。只有超级管理员可以管理超级管理员。',
    program: 'none',
    protected: true,
    singletonProtected: true,
  },
  {
    code: 'principal',
    name: '园长/平台管理员',
    nameEn: 'Principal',
    description: '业务侧最高管理者。管理教师账号与业务权限、审核发布、查看审计。不具备系统级安全与配置权限。',
    program: 'none',
    protected: false,
    singletonProtected: false,
  },
  {
    code: 'curriculum_director',
    name: '教学主任/教研主管',
    nameEn: 'Curriculum Director',
    description: '审核发布、全部课程查看、教师业务权限分配。',
    program: 'both',
    protected: false,
    singletonProtected: false,
  },
  {
    code: 'prek_head',
    name: 'Pre-K 主教',
    nameEn: 'Pre-K Head Teacher',
    description: 'Pre-K 全部科目上传、提交审核。',
    program: 'prek',
    protected: false,
    singletonProtected: false,
  },
  {
    code: 'k_head',
    name: 'K 主教',
    nameEn: 'K Head Teacher',
    description: 'K 全部科目上传、提交审核。',
    program: 'k',
    protected: false,
    singletonProtected: false,
  },
  {
    code: 'pe_specialist',
    name: '体能专科教师',
    nameEn: 'PE Specialist',
    description: '体能类科目上传、提交审核（跨班型）。',
    program: 'both',
    protected: false,
    singletonProtected: false,
  },
  {
    code: 'prek_assistant',
    name: 'Pre-K 配班/代课',
    nameEn: 'Pre-K Assistant',
    description: 'Pre-K 只读，可按科目单独授权上传。',
    program: 'prek',
    protected: false,
    singletonProtected: false,
  },
  {
    code: 'k_assistant',
    name: 'K 配班/代课',
    nameEn: 'K Assistant',
    description: 'K 只读，可按科目单独授权上传。',
    program: 'k',
    protected: false,
    singletonProtected: false,
  },
  {
    code: 'visitor',
    name: '普通访客/家长',
    nameEn: 'Visitor',
    description: '不能进入课程内容。仅可登录，不授予任何课程或系统权限。',
    program: 'none',
    protected: false,
    singletonProtected: false,
  },
];

/** Every role code, in canonical order. The ONLY role list in the project. */
export const ROLE_CODES: RoleCode[] = ROLE_DEFINITIONS.map((r) => r.code);

const ROLE_BY_CODE: Record<string, RoleDefinition> = Object.fromEntries(
  ROLE_DEFINITIONS.map((r) => [r.code, r]),
);

export function isKnownRole(value: unknown): value is RoleCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_BY_CODE, value);
}

export function getRoleDefinition(code: RoleCode): RoleDefinition {
  return ROLE_BY_CODE[code];
}

export function isProtectedRole(code: RoleCode): boolean {
  return ROLE_BY_CODE[code]?.protected === true;
}

/** Highest-ranked role a set of roles contains (used for the grant-ceiling rule). */
export function highestRole(roles: readonly RoleCode[]): RoleCode | null {
  let best: RoleCode | null = null;
  for (const r of roles) {
    if (!isKnownRole(r)) continue;
    if (best === null || ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  }
  return best;
}

/**
 * Can `actorRoles` grant/revoke `targetRole`?
 *
 * Rules (all enforced server-side, and mirrored by a DB trigger for super_admin):
 *  - super_admin may grant any role, including super_admin.
 *  - a non-super_admin may NEVER grant super_admin (privilege-escalation guard).
 *  - nobody may grant a role ranked at or above their own highest role
 *    (prevents lateral escalation such as curriculum_director creating a peer
 *     and thereby gaining a second set of permissions).
 *  - unknown roles are rejected.
 */
export function canGrantRole(actorRoles: readonly RoleCode[], targetRole: RoleCode): boolean {
  if (!isKnownRole(targetRole)) return false;
  if (targetRole === SUPER_ADMIN_ROLE) return actorRoles.includes(SUPER_ADMIN_ROLE);
  const actorHighest = highestRole(actorRoles);
  if (actorHighest === null) return false;
  return ROLE_RANK[actorHighest] > ROLE_RANK[targetRole];
}

/**
 * Can `actorRoles` modify (update/disable/reset password of) a target account
 * that currently holds `targetRoles`?
 *
 *  - super_admin targets require the actor to be a super_admin.
 *  - otherwise the actor's highest role must outrank the target's highest role.
 */
export function canManageAccount(
  actorRoles: readonly RoleCode[],
  targetRoles: readonly RoleCode[],
): boolean {
  if (targetRoles.includes(SUPER_ADMIN_ROLE)) return actorRoles.includes(SUPER_ADMIN_ROLE);
  const actorHighest = highestRole(actorRoles);
  const targetHighest = highestRole(targetRoles);
  if (actorHighest === null) return false;
  if (targetHighest === null) return true; // target has no roles: a teacher-manager may fix it
  return ROLE_RANK[actorHighest] > ROLE_RANK[targetHighest];
}

// =============================================================================
// 2. PERMISSIONS
// =============================================================================

/**
 * Permission groups are for UI presentation (the permission matrix renders one
 * section per group) and for bulk operations. They carry no authorization meaning.
 */
export type PermissionGroup =
  | 'system'
  | 'account'
  | 'role'
  | 'permission'
  | 'session'
  | 'audit'
  | 'curriculum'
  | 'resource'
  | 'review'
  | 'storage'
  | 'security';

export interface PermissionDefinition {
  code: string;
  group: PermissionGroup;
  name: string;
  nameEn: string;
  description: string;
  /**
   * true when this permission acts on data rows and therefore respects the
   * account's data scope. System/administrative permissions are scope-insensitive
   * (scope is always ALL) and are only ever held by super_admin / principal.
   */
  dataScoped: boolean;
  /** true when granting it to a non-super_admin should require re-authentication. */
  highRisk: boolean;
}

/**
 * The permission catalog. Adding a permission here makes it immediately
 * available to the matrix UI, the API and the guards — no migration required.
 */
export const PERMISSIONS: PermissionDefinition[] = [
  // ---- system -----------------------------------------------------------
  { code: 'system.manage', group: 'system', name: '系统管理', nameEn: 'Manage System', description: '修改系统级配置与运行模式', dataScoped: false, highRisk: true },
  { code: 'system.health', group: 'system', name: '查看系统健康', nameEn: 'View System Health', description: '查看数据库/存储/迁移/运行状态', dataScoped: false, highRisk: false },
  { code: 'system.config', group: 'system', name: '修改系统配置', nameEn: 'Change System Config', description: '修改存储、安全、限流等配置', dataScoped: false, highRisk: true },
  { code: 'system.maintenance', group: 'system', name: '维护模式', nameEn: 'Maintenance Mode', description: '开启/关闭系统维护模式', dataScoped: false, highRisk: true },
  { code: 'system.backup', group: 'system', name: '备份', nameEn: 'Backup', description: '执行数据库与文件备份', dataScoped: false, highRisk: true },
  { code: 'system.restore', group: 'system', name: '恢复', nameEn: 'Restore', description: '从备份恢复数据（高危）', dataScoped: false, highRisk: true },
  { code: 'system.migration', group: 'system', name: '迁移管理', nameEn: 'Manage Migrations', description: '查看与执行数据库迁移', dataScoped: false, highRisk: true },
  { code: 'system.error_log', group: 'system', name: '查看错误日志', nameEn: 'View Error Logs', description: '查看服务端错误与异常日志', dataScoped: false, highRisk: false },
  { code: 'security.manage', group: 'security', name: '安全设置', nameEn: 'Manage Security', description: '修改密码策略、会话策略、MFA 策略等安全配置', dataScoped: false, highRisk: true },
  { code: 'security.events', group: 'security', name: '查看安全事件', nameEn: 'View Security Events', description: '查看提权、大量失败登录、异常 IP 等安全事件', dataScoped: false, highRisk: false },

  // ---- account ----------------------------------------------------------
  { code: 'account.view', group: 'account', name: '查看账号', nameEn: 'View Accounts', description: '查看账号列表与详情', dataScoped: false, highRisk: false },
  { code: 'account.create', group: 'account', name: '创建账号', nameEn: 'Create Account', description: '创建子账号', dataScoped: false, highRisk: true },
  { code: 'account.update', group: 'account', name: '修改账号', nameEn: 'Update Account', description: '修改姓名、邮箱、状态等资料', dataScoped: false, highRisk: true },
  { code: 'account.disable', group: 'account', name: '停用账号', nameEn: 'Disable Account', description: '停用/启用账号（停用后会话立即失效）', dataScoped: false, highRisk: true },
  { code: 'account.reset_password', group: 'account', name: '重置密码', nameEn: 'Reset Password', description: '为其他账号重置密码', dataScoped: false, highRisk: true },
  { code: 'account.force_logout', group: 'account', name: '强制下线', nameEn: 'Force Logout', description: '强制撤销指定账号的全部会话', dataScoped: false, highRisk: true },

  // ---- role / permission ------------------------------------------------
  { code: 'role.view', group: 'role', name: '查看角色', nameEn: 'View Roles', description: '查看角色定义与默认权限', dataScoped: false, highRisk: false },
  { code: 'role.assign', group: 'role', name: '分配角色', nameEn: 'Assign Roles', description: '修改账号的角色（受授予上限约束）', dataScoped: false, highRisk: true },
  { code: 'permission.view', group: 'permission', name: '查看权限', nameEn: 'View Permissions', description: '查看账号的有效权限与数据范围', dataScoped: false, highRisk: false },
  { code: 'permission.grant', group: 'permission', name: '授予权限', nameEn: 'Grant Permissions', description: '为账号追加权限', dataScoped: false, highRisk: true },
  { code: 'permission.revoke', group: 'permission', name: '撤销权限', nameEn: 'Revoke Permissions', description: '为账号追加禁止项', dataScoped: false, highRisk: true },

  // ---- session ----------------------------------------------------------
  { code: 'session.view', group: 'session', name: '查看会话', nameEn: 'View Sessions', description: '查看账号的登录会话与设备信息', dataScoped: false, highRisk: false },
  { code: 'session.revoke', group: 'session', name: '撤销会话', nameEn: 'Revoke Sessions', description: '撤销指定会话', dataScoped: false, highRisk: true },

  // ---- audit ------------------------------------------------------------
  { code: 'audit.view', group: 'audit', name: '查看审计', nameEn: 'View Audit Log', description: '查询审计日志', dataScoped: false, highRisk: false },
  { code: 'audit.export', group: 'audit', name: '导出审计', nameEn: 'Export Audit Log', description: '导出审计日志（可能含敏感信息）', dataScoped: false, highRisk: true },

  // ---- curriculum -------------------------------------------------------
  { code: 'curriculum.view', group: 'curriculum', name: '查看课程目录', nameEn: 'View Curriculum', description: '查看班型/科目/资料夹结构', dataScoped: true, highRisk: false },
  { code: 'curriculum.manage', group: 'curriculum', name: '管理课程目录', nameEn: 'Manage Curriculum', description: '维护班型、科目、资料夹结构', dataScoped: true, highRisk: true },

  // ---- resource ---------------------------------------------------------
  { code: 'resource.view', group: 'resource', name: '查看资源', nameEn: 'View Resources', description: '查看已发布资源', dataScoped: true, highRisk: false },
  { code: 'resource.create', group: 'resource', name: '创建资源', nameEn: 'Create Resource', description: '上传/新建资源', dataScoped: true, highRisk: false },
  { code: 'resource.update', group: 'resource', name: '编辑资源', nameEn: 'Update Resource', description: '编辑资源元数据', dataScoped: true, highRisk: false },
  { code: 'resource.delete', group: 'resource', name: '删除资源', nameEn: 'Delete Resource', description: '将资源移入回收站（软删除）', dataScoped: true, highRisk: true },
  { code: 'resource.download', group: 'resource', name: '下载资源', nameEn: 'Download Resource', description: '获取资源文件的临时下载链接', dataScoped: true, highRisk: false },
  { code: 'resource.submit_review', group: 'resource', name: '提交审核', nameEn: 'Submit For Review', description: '将草稿提交审核', dataScoped: true, highRisk: false },
  { code: 'resource.publish_without_review', group: 'resource', name: '免审核发布', nameEn: 'Publish Without Review', description: '绕过审核直接发布（默认仅超级管理员持有）', dataScoped: true, highRisk: true },
  { code: 'resource.restore', group: 'resource', name: '恢复资源', nameEn: 'Restore Resource', description: '从回收站恢复资源', dataScoped: true, highRisk: true },
  { code: 'resource.purge', group: 'resource', name: '永久删除资源', nameEn: 'Permanently Delete Resource', description: '彻底删除资源与文件（不可恢复）', dataScoped: true, highRisk: true },

  // ---- review -----------------------------------------------------------
  { code: 'review.view', group: 'review', name: '查看待审核', nameEn: 'View Review Queue', description: '查看待审核队列与审核历史', dataScoped: true, highRisk: false },
  { code: 'review.approve', group: 'review', name: '审核通过', nameEn: 'Approve Resource', description: '审核通过并发布', dataScoped: true, highRisk: true },
  { code: 'review.reject', group: 'review', name: '审核退回', nameEn: 'Reject Resource', description: '退回资源并填写意见', dataScoped: true, highRisk: true },

  // ---- storage ----------------------------------------------------------
  { code: 'storage.upload', group: 'storage', name: '上传文件', nameEn: 'Upload File', description: '上传文件到私有存储', dataScoped: true, highRisk: false },
  { code: 'storage.download', group: 'storage', name: '下载文件', nameEn: 'Download File', description: '通过签名链接下载文件', dataScoped: true, highRisk: false },
  { code: 'storage.delete', group: 'storage', name: '删除文件', nameEn: 'Delete File', description: '删除存储中的文件', dataScoped: true, highRisk: true },

  // ---- self-service (always available to the account itself) -------------
  { code: 'mfa.manage_self', group: 'security', name: '管理自己的 MFA', nameEn: 'Manage Own MFA', description: '绑定/解绑本人 MFA 与恢复码', dataScoped: false, highRisk: false },
  { code: 'mfa.reset_other', group: 'security', name: '重置他人 MFA', nameEn: 'Reset Other MFA', description: '为其他账号解除 MFA（账号丢失设备时使用）', dataScoped: false, highRisk: true },
];

export type PermissionCode = string;

export const PERMISSION_CODES: PermissionCode[] = PERMISSIONS.map((p) => p.code);

const PERMISSION_BY_CODE: Record<string, PermissionDefinition> = Object.fromEntries(
  PERMISSIONS.map((p) => [p.code, p]),
);

export function isKnownPermission(value: unknown): value is PermissionCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_BY_CODE, value);
}

export function getPermissionDefinition(code: PermissionCode): PermissionDefinition | undefined {
  return PERMISSION_BY_CODE[code];
}

/** Permissions that operate on rows and therefore honour data scope. */
export const DATA_SCOPED_PERMISSIONS: PermissionCode[] = PERMISSIONS
  .filter((p) => p.dataScoped)
  .map((p) => p.code);

// =============================================================================
// 3. ROLE -> DEFAULT PERMISSIONS
// =============================================================================

/**
 * Permissions implied by each role. An account's defaults are the UNION of the
 * defaults of all its roles.
 *
 * Every account implicitly holds `mfa.manage_self`; it is included explicitly
 * here so the effective-permission API and the UI stay consistent.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, PermissionCode[]> = {
  // super_admin holds EVERY permission. Computed from the catalog rather than
  // hand-listed so a newly added permission cannot be accidentally omitted.
  super_admin: PERMISSION_CODES,

  principal: [
    'mfa.manage_self',
    'account.view',
    'account.create',
    'account.update',
    'account.disable',
    'account.reset_password',
    'account.force_logout',
    'role.view',
    'role.assign',
    'permission.view',
    'permission.grant',
    'permission.revoke',
    'session.view',
    'session.revoke',
    'audit.view',
    'audit.export',
    'security.events',
    'system.health',
    'curriculum.view',
    'curriculum.manage',
    'resource.view',
    'resource.create',
    'resource.update',
    'resource.delete',
    'resource.download',
    'resource.submit_review',
    'resource.restore',
    'review.view',
    'review.approve',
    'review.reject',
    'storage.upload',
    'storage.download',
    'storage.delete',
  ],

  curriculum_director: [
    'mfa.manage_self',
    'account.view',
    'role.view',
    'permission.view',
    'audit.view',
    'curriculum.view',
    'resource.view',
    'resource.create',
    'resource.update',
    'resource.delete',
    'resource.download',
    'resource.submit_review',
    'resource.restore',
    'review.view',
    'review.approve',
    'review.reject',
    'storage.upload',
    'storage.download',
  ],

  // Head teachers: full create/update/submit within their program, but no
  // review rights (separation of duties: reviewers must be able to be a
  // different person) and no delete.
  prek_head: [
    'mfa.manage_self',
    'curriculum.view',
    'resource.view',
    'resource.create',
    'resource.update',
    'resource.download',
    'resource.submit_review',
    'storage.upload',
    'storage.download',
  ],

  k_head: [
    'mfa.manage_self',
    'curriculum.view',
    'resource.view',
    'resource.create',
    'resource.update',
    'resource.download',
    'resource.submit_review',
    'storage.upload',
    'storage.download',
  ],

  pe_specialist: [
    'mfa.manage_self',
    'curriculum.view',
    'resource.view',
    'resource.create',
    'resource.update',
    'resource.download',
    'resource.submit_review',
    'storage.upload',
    'storage.download',
  ],

  // Assistants are read-only by default. Upload is granted per subject through
  // subject_permissions / account_permission_overrides, which is exactly the
  // "配班可按科目单独授权上传" requirement.
  prek_assistant: [
    'mfa.manage_self',
    'curriculum.view',
    'resource.view',
    'resource.download',
    'storage.download',
  ],

  k_assistant: [
    'mfa.manage_self',
    'curriculum.view',
    'resource.view',
    'resource.download',
    'storage.download',
  ],

  // Visitor: can authenticate but reaches no course content and no system area.
  visitor: ['mfa.manage_self'],
};

export function roleDefaults(roles: readonly RoleCode[]): Set<PermissionCode> {
  const out = new Set<PermissionCode>();
  for (const r of roles) {
    if (!isKnownRole(r)) continue;
    for (const p of ROLE_PERMISSIONS[r]) out.add(p);
  }
  return out;
}

// =============================================================================
// 4. DATA SCOPE
// =============================================================================

export type ScopeKind = 'ALL' | 'PROGRAM' | 'SUBJECT' | 'OWN';

// ProgramCode is declared in ./curriculum.ts, next to the subject / sub-subject /
// folder vocabulary it belongs with, and re-exported here so every existing
// `import type { ProgramCode } from '@shared/rbac'` call site keeps working.
// It used to be an independent `'prek' | 'k'` union in this file — a second copy
// of the same two tokens, i.e. exactly the drift shape ./curriculum.ts removes.
export type { ProgramCode } from './curriculum';

/**
 * A scope restriction attached to an account.
 *
 * Semantics of scope k in `scopeSatisfies(actorScope, target)`:
 *   ALL      -> always satisfied
 *   PROGRAM  -> target.program equals the bound program
 *   SUBJECT  -> target.program+subject(+subSubject) matches the binding
 *   OWN      -> target.ownerId equals the actor's id
 *
 * An account with NO scope rows has scope ALL for permissions granted by its
 * role combos, EXCEPT that teaching roles are additionally constrained by
 * `subject_permissions` (the existing table), which is applied by the service
 * layer exactly as before. This preserves existing behaviour for the 20 seeded
 * accounts and for any data already in the database.
 */
export interface ScopeBinding {
  kind: ScopeKind;
  program?: ProgramCode;
  subject?: string;
  subSubject?: string | null;
}

/** The concrete data a permission is being evaluated against. */
export interface ScopeTarget {
  program?: ProgramCode | string | null;
  subject?: string | null;
  subSubject?: string | null;
  /** teachers.id of the row owner, when the target is owned by someone. */
  ownerId?: string | null;
}

export function scopeSatisfies(
  binding: ScopeBinding,
  target: ScopeTarget,
  actorId: string,
): boolean {
  switch (binding.kind) {
    case 'ALL':
      return true;
    case 'OWN':
      return Boolean(target.ownerId) && target.ownerId === actorId;
    case 'PROGRAM':
      return Boolean(target.program) && target.program === binding.program;
    case 'SUBJECT': {
      if (!target.program || target.program !== binding.program) return false;
      if (!target.subject || target.subject !== binding.subject) return false;
      if (binding.subSubject) return target.subSubject === binding.subSubject;
      return true;
    }
    default:
      return false;
  }
}

// =============================================================================
// 5. TYPES SHARED WITH THE API
// =============================================================================

export interface EffectivePermissions {
  /** teacherId the snapshot belongs to. */
  teacherId: string;
  roles: RoleCode[];
  /** Final permission set after grants and denies. */
  permissions: PermissionCode[];
  /** Where each permission came from — needed by the admin "权限摘要" UI. */
  sources: {
    fromRoles: PermissionCode[];
    granted: PermissionCode[];
    denied: PermissionCode[];
  };
  /** Scope bindings; empty array means unrestricted (role default). */
  scopes: ScopeBinding[];
  /**
   * Monotonic version of this account's authorization state. A session is only
   * valid while the version matches, which is what makes "revoke permission ->
   * takes effect immediately" true without scanning sessions.
   */
  permissionsVersion: number;
}

// =============================================================================
// 6. SYSTEM INVARIANTS (asserted at build/test time and at boot)
// =============================================================================

/**
 * Hard limits and guarantees. Kept here so server and tests share one definition.
 */
export const RBAC_INVARIANTS = {
  /** At most this many super_admin accounts may exist. */
  maxSuperAdmins: 2,
  /** super_admin must hold every permission in the catalog. */
  superAdminHoldsAll: true,
} as const;

/**
 * Structural self-checks. Called by the server at boot and by the test suite so
 * a malformed catalog fails loudly instead of silently granting nothing.
 * Throws on violation (never silently repairs).
 */
export function assertRbacCatalogIntegrity(): void {
  const seen = new Set<string>();
  for (const p of PERMISSIONS) {
    if (seen.has(p.code)) throw new Error(`rbac: duplicate permission code "${p.code}"`);
    seen.add(p.code);
  }
  for (const code of ROLE_CODES) {
    const perms = ROLE_PERMISSIONS[code];
    if (!perms) throw new Error(`rbac: role "${code}" has no permission defaults`);
    for (const p of perms) {
      if (!isKnownPermission(p)) {
        throw new Error(`rbac: role "${code}" references unknown permission "${p}"`);
      }
    }
  }
  const superPerms = new Set(ROLE_PERMISSIONS[SUPER_ADMIN_ROLE]);
  for (const p of PERMISSION_CODES) {
    if (!superPerms.has(p)) {
      throw new Error(`rbac: super_admin is missing permission "${p}"`);
    }
  }
  for (const r of ROLE_DEFINITIONS) {
    if (ROLE_RANK[r.code] === undefined) throw new Error(`rbac: role "${r.code}" has no rank`);
  }
  if (ROLE_RANK[SUPER_ADMIN_ROLE] <= ROLE_RANK.principal) {
    throw new Error('rbac: super_admin must outrank principal');
  }
}
