/* eslint-disable */
/** auto generated, do not edit */
import { sql } from 'drizzle-orm';
import { bigint, boolean, foreignKey, index, integer, pgTable, smallint, text, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value})::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export type FileAttachment = {
  bucket_id: string;
  file_path: string;
};

export const fileAttachment = customType<{
  data: FileAttachment;
  driverData: string;
}>({
  dataType() {
    return 'file_attachment';
  },
  toDriver(value: FileAttachment) {
    return sql`ROW(${value.bucket_id},${value.file_path})::file_attachment`;
  },
  fromDriver(value: string): FileAttachment {
    const [bucketId, filePath] = value.slice(1, -1).split(',');
    return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
  },
});

export function escapeLiteral(str: string): string {
  return "'" + str.replace(/'/g, "''") + "'";
}

export const userProfileArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType() {
    return 'user_profile[]';
  },
  toDriver(value: string[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::user_profile[]`;
    }
    const elements = value.map(id => `ROW(${escapeLiteral(id)})::user_profile`).join(',');
    return sql.raw(`ARRAY[${elements}]::user_profile[]`);
  },
  fromDriver(value: string): string[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => m.slice(1, -1).split(',')[0].trim());
  },
});

export const fileAttachmentArray = customType<{
  data: FileAttachment[];
  driverData: string;
}>({
  dataType() {
    return 'file_attachment[]';
  },
  toDriver(value: FileAttachment[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::file_attachment[]`;
    }
    const elements = value.map(f =>
      `ROW(${escapeLiteral(f.bucket_id)},${escapeLiteral(f.file_path)})::file_attachment`
    ).join(',');
    return sql.raw(`ARRAY[${elements}]::file_attachment[]`);
  },
  fromDriver(value: string): FileAttachment[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => {
      const [bucketId, filePath] = m.slice(1, -1).split(',');
      return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
    });
  },
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionHash: varchar("session_hash", { length: 64 }).notNull().unique(),
  teacherId: uuid("teacher_id").notNull(),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  lastAccessedAt: customTimestamptz("last_accessed_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  revoked: boolean("revoked").notNull().default(false),
  ipAddress: varchar("ip_address", { length: 50 }),
  userAgent: varchar("user_agent", { length: 500 }),
  // Added by migration 0003 (RBAC + session hardening).
  permissionsVersion: integer("permissions_version").notNull().default(1),
  revokedAt: customTimestamptz("revoked_at", { precision: 3 }),
  revokeReason: varchar("revoke_reason", { length: 100 }),
  device: varchar("device", { length: 200 }),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_sessions_session_hash").on(table.sessionHash),
  index("idx_sessions_teacher").on(table.teacherId),
  index("idx_sessions_expires").on(table.expiresAt),
  foreignKey({
    columns: [table.teacherId],
    foreignColumns: [teachers.id],
    name: "sessions_teacher_fkey",
  }).onDelete("cascade"),
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: varchar("action", { length: 50 }).notNull(),
  wecomUserId: varchar("wecom_user_id", { length: 100 }),
  teacherId: uuid("teacher_id"),
  teacherName: varchar("teacher_name", { length: 100 }),
  ipAddress: varchar("ip_address", { length: 50 }),
  userAgent: varchar("user_agent", { length: 500 }),
  resourceId: uuid("resource_id"),
  resourceTitle: varchar("resource_title", { length: 255 }),
  program: varchar("program", { length: 20 }),
  subject: varchar("subject", { length: 50 }),
  detail: text("detail"),
  success: boolean("success").notNull().default(true),
  errorMessage: varchar("error_message", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_audit_logs_action").on(table.action),
  index("idx_audit_logs_teacher").on(table.teacherId),
  index("idx_audit_logs_created").on(table.createdAt),
  index("idx_audit_logs_wecom").on(table.wecomUserId),
]);

export const reviewRecords = pgTable("review_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  resourceId: uuid("resource_id").notNull(),
  reviewerId: uuid("reviewer_id").notNull(),
  action: varchar("action", { length: 20 }).notNull(),
  comment: text("comment"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_review_records_resource").on(table.resourceId),
  foreignKey({
    columns: [table.resourceId],
    foreignColumns: [resources.id],
    name: "review_records_resource_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.reviewerId],
    foreignColumns: [teachers.id],
    name: "review_records_reviewer_id_fkey",
  }),
]);

export const resources = pgTable("resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  titleEn: varchar("title_en", { length: 255 }),
  program: varchar("program", { length: 20 }).notNull(),
  subject: varchar("subject", { length: 50 }).notNull(),
  subSubject: varchar("sub_subject", { length: 50 }),
  folderType: varchar("folder_type", { length: 30 }).notNull(),
  semester: varchar("semester", { length: 10 }),
  weekNumber: integer("week_number"),
  theme: varchar("theme", { length: 100 }),
  description: text("description"),
  fileBucketId: varchar("file_bucket_id", { length: 100 }),
  filePath: varchar("file_path", { length: 500 }),
  fileName: varchar("file_name", { length: 255 }),
  fileSize: bigint("file_size", { mode: 'number' }),
  fileType: varchar("file_type", { length: 50 }),
  version: integer("version").notNull().default(1),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  uploaderId: uuid("uploader_id").notNull(),
  reviewerId: uuid("reviewer_id"),
  reviewComment: text("review_comment"),
  reviewedAt: customTimestamptz("reviewed_at", { precision: 3 }),
  // Added by migration 0007 (resource recycle bin / soft delete).
  // NOTE: `deleted_at IS NULL` is the ACTIVE-row predicate. Every read path
  // (list / search / review / dashboard / my-resources) must carry it; RLS
  // deliberately does not, because the recycle bin and restore share the same
  // database role as ordinary reads. See 0007_resource_soft_delete.sql.
  // `deletedAt` and `purgeAfter` are paired by the DB check constraint
  // `resources_soft_delete_pairing` — both set, or both NULL.
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
  deletedBy: uuid("deleted_by"),
  purgeAfter: customTimestamptz("purge_after", { precision: 3 }),
  // Added by migration 0008 — GENERATED ALWAYS AS (...) STORED, i.e. computed by
  // PostgreSQL from the file columns and impossible to set or drift by hand.
  //
  // It exists because all 347 seeded rows have NULL file columns, so every one of
  // them rendered an enabled "下载" button that then failed. Before this column the
  // only way to tell a real file from an empty row was to re-derive the predicate
  // in each query — and a hand-maintained boolean (`has_file`) would have been
  // wrong the first time someone cleared `file_path` without clearing the flag.
  //
  // The predicate is deliberately "path AND bucket non-blank" rather than "any
  // file column set": `file_name`/`file_size`/`file_type` can survive an
  // interrupted upload on their own, and treating those as a downloadable file is
  // exactly the misleading state this column removes. No row can be INSERTed or
  // UPDATEd with this column named, so it cannot disagree with them.
  // The `coalesce(..., false)` matters: both file columns are NULL on the 347
  // seeded rows, and a bare `NULL AND NULL` would make this a three-valued flag
  // whose NULL means "unknown" — which `has_stored_file = false` does not match.
  // With the coalesce the column is total: NULL input means "no file".
  hasStoredFile: boolean("has_stored_file").generatedAlwaysAs(
    sql`(coalesce(btrim(file_path), '') <> '' AND coalesce(btrim(file_bucket_id), '') <> '')`,
  ),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_resources_program_subject").on(table.program, table.subject, table.subSubject),
  index("idx_resources_status").on(table.status),
  index("idx_resources_uploader").on(table.uploaderId),
  index("idx_resources_folder").on(table.program, table.subject, table.folderType),
  index("idx_resources_semester_week").on(table.semester, table.weekNumber),
  // Partial indexes from migration 0007. The deleted set is small, so indexing
  // only it keeps the recycle bin and the purge scan cheap; the active set gets
  // its own partial indexes because every ordinary query now filters on
  // `deleted_at IS NULL`.
  index("idx_resources_deleted_at").on(table.deletedAt).where(sql`${table.deletedAt} is not null`),
  index("idx_resources_purge_after").on(table.purgeAfter).where(sql`${table.deletedAt} is not null`),
  index("idx_resources_active_status").on(table.status, table.createdAt).where(sql`${table.deletedAt} is null`),
  index("idx_resources_active_uploader").on(table.uploaderId, table.createdAt).where(sql`${table.deletedAt} is null`),
  foreignKey({
    columns: [table.uploaderId],
    foreignColumns: [teachers.id],
    name: "resources_uploader_id_fkey",
  }),
  foreignKey({
    columns: [table.reviewerId],
    foreignColumns: [teachers.id],
    name: "resources_reviewer_id_fkey",
  }),
  foreignKey({
    columns: [table.deletedBy],
    foreignColumns: [teachers.id],
    name: "resources_deleted_by_fkey",
  }).onDelete("set null"),
]);

export const subjectPermissions = pgTable("subject_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  program: varchar("program", { length: 20 }).notNull(),
  subject: varchar("subject", { length: 50 }).notNull(),
  subSubject: varchar("sub_subject", { length: 50 }),
  canView: boolean("can_view").notNull().default(true),
  canUpload: boolean("can_upload").notNull().default(false),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("subject_permissions_teacher_id_program_subject_sub_subject_key").on(table.teacherId, table.program, table.subject, table.subSubject),
  index("idx_subject_permissions_teacher").on(table.teacherId),
  index("idx_subject_permissions_program").on(table.program, table.subject),
  uniqueIndex("subject_permissions_teacher_program_subject_sub_subject_key").on(table.teacherId, table.program, table.subject, table.subSubject),
  foreignKey({
    columns: [table.teacherId],
    foreignColumns: [teachers.id],
    name: "subject_permissions_teacher_id_fkey",
  }).onDelete("cascade"),
]);

export const teachers = pgTable("teachers", {
  id: uuid("id").primaryKey().defaultRandom(),
  wecomUserId: varchar("wecom_user_id", { length: 100 }).unique(),
  name: varchar("name", { length: 100 }).notNull(),
  nameEn: varchar("name_en", { length: 100 }),
  email: varchar("email", { length: 255 }),
  roles: varchar("roles", { length: 50 }).array().notNull().default([]),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  lastLoginAt: customTimestamptz("last_login_at", { precision: 3 }),
  username: varchar("username", { length: 50 }),
  passwordHash: varchar("password_hash", { length: 255 }),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: customTimestamptz("locked_until", { precision: 6 }),
  passwordUpdatedAt: customTimestamptz("password_updated_at", { precision: 6 }),
  // Added by migration 0003 (RBAC). NOTE: `npm run gen:db-schema` regenerates this
  // file from the remote platform database and would DROP this line unless the
  // column exists there too — see DEPLOYMENT_PRODUCTION.md "schema regeneration".
  permissionsVersion: integer("permissions_version").notNull().default(1),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("teachers_wecom_user_id_key").on(table.wecomUserId),
  // Complex index: CREATE UNIQUE INDEX idx_teachers_username ON teachers USING btree (lower((username)::text)) WHERE (username IS NOT NULL),
]);

// =============================================================================
// RBAC tables — added by migration 0003, NOT emitted by the schema generator that
// produced the rest of this file (the platform's db-schema-sync; see package.json).
// If you regenerate this file, these definitions must be re-added (see
// DEPLOYMENT_PRODUCTION.md → "schema regeneration").
// =============================================================================

/**
 * Per-account deltas on top of ROLE_PERMISSIONS (shared/rbac.ts).
 * Effective permissions = (role defaults UNION grants) MINUS denies; deny wins.
 */
export const accountPermissionOverrides = pgTable("account_permission_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  permission: varchar("permission", { length: 120 }).notNull(),
  effect: varchar("effect", { length: 10 }).notNull(),
  reason: text("reason"),
  grantedBy: uuid("granted_by"),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }),
}, (table) => [
  uniqueIndex("account_permission_overrides_unique").on(table.teacherId, table.permission),
  index("idx_apo_teacher").on(table.teacherId),
  foreignKey({
    columns: [table.teacherId],
    foreignColumns: [teachers.id],
    name: "account_permission_overrides_teacher_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.grantedBy],
    foreignColumns: [teachers.id],
    name: "account_permission_overrides_granted_by_fkey",
  }).onDelete("set null"),
]);

/**
 * Data scope bindings (RBAC.md §7). A NULL `permission` applies the binding to
 * every data-scoped permission. Absence of rows means "unrestricted by this
 * table"; teaching roles remain constrained by `subject_permissions`, so
 * existing accounts keep their current behaviour.
 */
export const accountScopes = pgTable("account_scopes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  permission: varchar("permission", { length: 120 }),
  kind: varchar("kind", { length: 10 }).notNull(),
  program: varchar("program", { length: 20 }),
  subject: varchar("subject", { length: 50 }),
  subSubject: varchar("sub_subject", { length: 50 }),
  createdBy: uuid("created_by"),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_account_scopes_teacher").on(table.teacherId),
  foreignKey({
    columns: [table.teacherId],
    foreignColumns: [teachers.id],
    name: "account_scopes_teacher_fkey",
  }).onDelete("cascade"),
]);

// =============================================================================
// MFA tables — added by migration 0006, NOT emitted by the schema generator that
// produced the rest of this file (the platform's db-schema-sync; see package.json).
// Re-add these if you regenerate this file (see DEPLOYMENT_PRODUCTION.md).
// =============================================================================

/** TOTP enrolment. `secretEncrypted` is AES-256-GCM; the raw secret is never stored. */
export const teacherMfa = pgTable("teacher_mfa", {
  teacherId: uuid("teacher_id").primaryKey(),
  secretEncrypted: text("secret_encrypted").notNull(),
  algorithm: varchar("algorithm", { length: 10 }).notNull().default('SHA1'),
  digits: smallint("digits").notNull().default(6),
  periodSeconds: smallint("period_seconds").notNull().default(30),
  /** false until the user proved possession by submitting a valid code. */
  confirmed: boolean("confirmed").notNull().default(false),
  enabledAt: customTimestamptz("enabled_at", { precision: 3 }),
  lastUsedAt: customTimestamptz("last_used_at", { precision: 3 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  foreignKey({
    columns: [table.teacherId],
    foreignColumns: [teachers.id],
    name: "teacher_mfa_teacher_fkey",
  }).onDelete("cascade"),
]);

/** One-time recovery codes, stored only as SHA-256 hashes. */
export const mfaRecoveryCodes = pgTable("mfa_recovery_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  usedAt: customTimestamptz("used_at", { precision: 3 }),
  usedIp: varchar("used_ip", { length: 50 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_mfa_recovery_hash").on(table.codeHash),
  index("idx_mfa_recovery_teacher").on(table.teacherId),
  foreignKey({
    columns: [table.teacherId],
    foreignColumns: [teachers.id],
    name: "mfa_recovery_codes_teacher_fkey",
  }).onDelete("cascade"),
]);

/** Half-finished logins: password verified, second factor pending. Stored in the
 *  database so the flow works across multiple application instances. */
export const mfaChallenges = pgTable("mfa_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  teacherId: uuid("teacher_id").notNull(),
  attempts: smallint("attempts").notNull().default(0),
  maxAttempts: smallint("max_attempts").notNull().default(5),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  consumedAt: customTimestamptz("consumed_at", { precision: 3 }),
  ipAddress: varchar("ip_address", { length: 50 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_mfa_challenges_teacher").on(table.teacherId),
  index("idx_mfa_challenges_expires").on(table.expiresAt),
  foreignKey({
    columns: [table.teacherId],
    foreignColumns: [teachers.id],
    name: "mfa_challenges_teacher_fkey",
  }).onDelete("cascade"),
]);

// table aliases
export const auditLogsTable = auditLogs;
export const resourcesTable = resources;
export const reviewRecordsTable = reviewRecords;
export const sessionsTable = sessions;
export const subjectPermissionsTable = subjectPermissions;
export const teachersTable = teachers;
export const accountPermissionOverridesTable = accountPermissionOverrides;
export const accountScopesTable = accountScopes;
export const teacherMfaTable = teacherMfa;
export const mfaRecoveryCodesTable = mfaRecoveryCodes;
export const mfaChallengesTable = mfaChallenges;
