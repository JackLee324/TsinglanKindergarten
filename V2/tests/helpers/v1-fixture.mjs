/**
 * tests/helpers/v1-fixture.mjs —— 一个**合成的 V1 库**，用来钉住迁移规则
 * ============================================================================
 * 为什么要合成：本机的真实 V1 库里，有几条路径**碰不到**——
 * `subject_permissions` 是空的、`account_permission_overrides` 里没有 deny、
 * 没有任何资源声称自己有文件、没有"没有用户名"之外的脏数据。
 * 这些路径不能因为"真实数据没触发"就不测：一旦生产库里有，它们就是数据丢失去处。
 *
 * 表结构照抄 V1 的 `server/database/schema.ts`（列名与类型），只保留**迁移会读**
 * 的列 —— V1 的 RLS、触发器、索引与本迁移无关，省略它们不会让迁移规则变得更容易通过，
 * 因为迁移读的是列而不是约束。
 *
 * 这个库**不是** V2 的测试库：它单独存在（`qls_v1_fixture`），每次重建。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import postgres from 'postgres'

const require = createRequire(import.meta.url)
const { scryptSync, randomBytes } = require('node:crypto')

export const FIXTURE_DB = process.env.V2_V1_FIXTURE_DB ?? 'qls_v1_fixture'
export const ADMIN_URL =
  process.env.V2_TEST_ADMIN_URL ?? 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/postgres'

/**
 * 夹具库的连接串：从管理连接串**换库名**得到。
 *
 * ⚠️ 不能用 `new URL(url).origin` —— `postgresql:` 不是 URL 的特殊协议，
 * origin 会返回字符串 "null"（第一版就是这么写错的，报错是 Invalid URL）。
 */
const ADMIN_PARSED = new URL(ADMIN_URL)
export const FIXTURE_URL =
  `${ADMIN_PARSED.protocol}//${ADMIN_PARSED.username}:${ADMIN_PARSED.password}` +
  `@${ADMIN_PARSED.hostname}:${ADMIN_PARSED.port || '5432'}/${FIXTURE_DB}`

/** 夹具里两个能登录的账号（口令是已知的，这样才能证明"V1 口令确实还能用"）。 */
export const KNOWN = {
  adminUsername: 'v1prin',
  adminPassword: 'V1Principal!2026',
  teacherUsername: 'v1teacher',
  teacherPassword: 'V1Teacher!2026',
}

/** V1 的哈希写法（salt 是 base64 文本、派生 32 字节）—— 与真实 V1 一致。 */
export function v1Hash(password) {
  const salt = randomBytes(16).toString('base64')
  const derived = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt}$${derived.toString('base64')}`
}

const V1_DDL = `
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

CREATE TABLE teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wecom_user_id varchar(100),
  name varchar(100) NOT NULL,
  name_en varchar(100),
  email varchar(200),
  roles varchar(50)[] NOT NULL DEFAULT '{}',
  status varchar(20) NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  username varchar(64),
  password_hash varchar(300),
  must_change_password boolean NOT NULL DEFAULT false,
  permissions_version integer NOT NULL DEFAULT 1
);

CREATE TABLE directories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES directories (id) ON DELETE RESTRICT,
  code varchar(200),
  name varchar(100) NOT NULL,
  name_en varchar(100),
  type varchar(30) NOT NULL,
  program varchar(20),
  subject varchar(50),
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  allow_custom_folders boolean NOT NULL DEFAULT false,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(255) NOT NULL,
  title_en varchar(255),
  program varchar(20) NOT NULL,
  subject varchar(50) NOT NULL,
  sub_subject varchar(50),
  folder_type varchar(30) NOT NULL,
  directory_id uuid REFERENCES directories (id) ON DELETE RESTRICT,
  semester varchar(10),
  week_number integer,
  theme varchar(100),
  description text,
  file_bucket_id varchar(100),
  file_path varchar(500),
  file_name varchar(255),
  file_size bigint,
  file_type varchar(50),
  version integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'draft',
  uploader_id uuid,
  reviewer_id uuid,
  review_comment text,
  reviewed_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  purge_after timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE review_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL,
  action varchar(20) NOT NULL,
  comment text,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action varchar(50) NOT NULL,
  wecom_user_id varchar(100),
  teacher_id uuid,
  teacher_name varchar(100),
  ip_address varchar(50),
  user_agent varchar(500),
  resource_id uuid,
  resource_title varchar(255),
  program varchar(20),
  subject varchar(50),
  detail text,
  success boolean NOT NULL DEFAULT true,
  error_message varchar(500),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subject_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL,
  program varchar(20) NOT NULL,
  subject varchar(50),
  sub_subject varchar(50),
  permission varchar(50) NOT NULL,
  granted boolean NOT NULL DEFAULT true,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE account_permission_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL,
  permission varchar(50) NOT NULL,
  effect varchar(10) NOT NULL,
  reason text,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz
);

CREATE TABLE account_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL,
  permission varchar(50),
  kind varchar(20) NOT NULL,
  program varchar(20),
  subject varchar(50),
  sub_subject varchar(50),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE resource_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  version integer NOT NULL,
  file_path varchar(500),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid,
  token varchar(200),
  expires_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teacher_mfa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL
);
CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL
);
CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL
);
`

/** 夹具的固定时间点（断言"迁移保留的是 V1 的时间，不是导入时间"）。 */
export const T = {
  base: '2026-09-01T08:00:00.000Z',
  submit1: '2026-09-02T08:00:00.000Z',
  reject: '2026-09-03T08:00:00.000Z',
  submit2: '2026-09-04T08:00:00.000Z',
  approve: '2026-09-05T08:00:00.000Z',
}

export const FIXTURE_IDS = {
  dirEdu: '11111111-0000-4000-8000-000000000001',
  dirPreK: '11111111-0000-4000-8000-000000000002',
  dirVirtue: '11111111-0000-4000-8000-000000000003',
  dirVirtueOutline: '11111111-0000-4000-8000-000000000004',
  dirVirtueResources: '11111111-0000-4000-8000-000000000005',
  dirGrowth: '11111111-0000-4000-8000-000000000006',
  dirL1: '11111111-0000-4000-8000-000000000007',
  dirCustom: '11111111-0000-4000-8000-000000000008',
  admin: '22222222-0000-4000-8000-000000000001',
  teacher: '22222222-0000-4000-8000-000000000002',
  noPassword: '22222222-0000-4000-8000-000000000003',
  noUsername: '22222222-0000-4000-8000-000000000004',
  kHead: '22222222-0000-4000-8000-000000000005',
  resPublished: '33333333-0000-4000-8000-000000000001',
  resTimeline: '33333333-0000-4000-8000-000000000002',
  resDraft: '33333333-0000-4000-8000-000000000003',
  resRejectNoComment: '33333333-0000-4000-8000-000000000004',
  resVersioned: '33333333-0000-4000-8000-000000000005',
  resMissingFile: '33333333-0000-4000-8000-000000000006',
  resUnassigned: '33333333-0000-4000-8000-000000000007',
}

/** 真实文件内容（迁移后要按 sha256 核对的就是它）。 */
export const REAL_FILE = {
  name: '美德课程纲要.pdf',
  content: Buffer.from('%PDF-1.4\n% V1 fixture 真实文件\n美德课程纲要\n%%EOF\n', 'utf8'),
  path: 'uploads/virtue-outline.pdf',
  bucket: 'v1-bucket',
}

export function fixtureStorageDir() {
  const dir = mkdtempSync(join(tmpdir(), 'v1-storage-'))
  /*
    对象放在 `<根>/<bucket>/<file_path>`。
    迁移脚本按"先试 <根>/<file_path>、再试 <根>/<bucket>/<file_path>"的顺序找 ——
    两种布局在真实 V1 部署里都出现过（取决于对象存储挂在哪一层），
    所以夹具必须真的落在其中一种上，否则测出来的是"找不到文件"，而不是"搬成功"。
  */
  const target = join(dir, REAL_FILE.bucket, REAL_FILE.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, REAL_FILE.content)
  return dir
}

/**
 * 建出夹具库并灌入数据。
 *
 * 返回 `{ url, storageDir }` —— 迁移脚本用 `--v1-storage local:<storageDir>`。
 */
export async function buildV1Fixture() {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FIXTURE_DB} WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE ${FIXTURE_DB}`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const sql = postgres(FIXTURE_URL, { max: 1, onnotice: () => {} })
  const storageDir = fixtureStorageDir()
  try {
    await sql.unsafe(V1_DDL)

    // ── 目录：与 V2 seed 同名的部分走"对齐"，`活动` 是 V1 独有 → 需要新建 ──
    const dirs = [
      [FIXTURE_IDS.dirEdu, null, 'root:edu', '教育教学', 'Teaching & Curriculum', 'root'],
      [FIXTURE_IDS.dirPreK, FIXTURE_IDS.dirEdu, 'prek', 'Pre-K', 'Pre-K', 'program'],
      [FIXTURE_IDS.dirVirtue, FIXTURE_IDS.dirPreK, 'prek:virtue', '美德', 'Virtue', 'subject'],
      [FIXTURE_IDS.dirVirtueOutline, FIXTURE_IDS.dirVirtue, 'prek:virtue_outline', '课程大纲', 'Curriculum Outline', 'folder'],
      [FIXTURE_IDS.dirVirtueResources, FIXTURE_IDS.dirVirtue, 'prek:virtue_resource', '教学资源', 'Teaching Resources', 'folder'],
      [FIXTURE_IDS.dirGrowth, null, 'root:growth', '教师成长', 'Teacher Growth', 'root'],
      [FIXTURE_IDS.dirL1, FIXTURE_IDS.dirGrowth, 'growth:l1', 'L1 基础规范', 'L1 Foundations', 'growth_level'],
      [FIXTURE_IDS.dirCustom, FIXTURE_IDS.dirEdu, 'custom:activity', '活动', 'Activities', 'folder'],
    ]
    for (const [id, parent, code, name, nameEn, type] of dirs) {
      await sql`
        INSERT INTO directories (id, parent_id, code, name, name_en, type, sort_order, enabled)
        VALUES (${id}, ${parent}, ${code}, ${name}, ${nameEn}, ${type}, 10, true)`
    }

    // ── 账号：管理员 / 能登录的老师 / 没口令的 / 没用户名的 / K 主教 ──
    const teachers = [
      [FIXTURE_IDS.admin, 'v1prin', '园长', ['principal'], 'active', v1Hash(KNOWN.adminPassword), true],
      [FIXTURE_IDS.teacher, KNOWN.teacherUsername, '张老师', ['prek_head'], 'active', v1Hash(KNOWN.teacherPassword), true],
      [FIXTURE_IDS.noPassword, 'v1nopass', '没口令的老师', ['k_assistant'], 'active', null, true],
      [FIXTURE_IDS.noUsername, null, '系统初始化', ['principal'], 'inactive', null, true],
      [FIXTURE_IDS.kHead, 'v1khead', 'K 主教', ['k_head'], 'inactive', v1Hash('KHead!2026pass'), true],
    ]
    for (const [id, username, name, roles, status, hash, hasUser] of teachers) {
      await sql`
        INSERT INTO teachers (id, username, name, roles, status, password_hash, must_change_password, last_login_at)
        VALUES (${id}, ${hasUser ? username : null}, ${name}, ${roles}, ${status}, ${hash}, false,
                ${status === 'active' ? T.base : null})`
    }

    // ── 资源 ──
    const resources = [
      // 有真实文件 + 一套 V1 独有的分类字段（legacy 要留住它们）
      [FIXTURE_IDS.resPublished, '美德课程纲要', FIXTURE_IDS.dirVirtueOutline, 'curriculum_outline',
        'published', FIXTURE_IDS.admin, 'S1', 3, '主题一', REAL_FILE.bucket, REAL_FILE.path, REAL_FILE.name,
        REAL_FILE.content.byteLength],
      // 完整时间线：提交 → 退回 → 再提交 → 通过
      [FIXTURE_IDS.resTimeline, '美德周计划 W3', FIXTURE_IDS.dirVirtueResources, 'weekly_plans',
        'published', FIXTURE_IDS.teacher, 'S1', 3, null, null, null, null, null],
      // 草稿 + 软删除（回收站）
      [FIXTURE_IDS.resDraft, '还没写完的教案', FIXTURE_IDS.dirVirtueResources, 'weekly_plans',
        'draft', FIXTURE_IDS.teacher, 'S2', 7, null, null, null, null, null],
      // 退回但 V1 没写原因（要标出来，不许编）
      [FIXTURE_IDS.resRejectNoComment, '被退回的课件', FIXTURE_IDS.dirVirtueResources, 'courseware',
        'rejected', FIXTURE_IDS.teacher, 'S1', 4, null, null, null, null, null],
      // 有版本行的资源
      [FIXTURE_IDS.resVersioned, '多版本的美德课件', FIXTURE_IDS.dirVirtueOutline, 'courseware',
        'published', FIXTURE_IDS.admin, null, null, null, null, null, null, null],
      // 声称有文件但源里没有 → MISSING_FILE（不许造文件）
      [FIXTURE_IDS.resMissingFile, '文件丢了的教案', FIXTURE_IDS.dirVirtueResources, 'weekly_plans',
        'published', FIXTURE_IDS.teacher, null, null, null, REAL_FILE.bucket, 'uploads/gone.pdf', 'gone.pdf', 123],
    ]
    for (const [id, title, dir, folderType, status, uploader, semester, week, theme,
      bucket, path, fileName, size] of resources) {
      await sql`
        INSERT INTO resources (id, title, program, subject, folder_type, directory_id, semester,
          week_number, theme, status, uploader_id, file_bucket_id, file_path, file_name, file_size,
          reviewer_id, reviewed_at, _created_at, _updated_at)
        VALUES (${id}, ${title}, 'prek', 'prek:virtue', ${folderType}, ${dir}, ${semester},
          ${week}, ${theme}, ${status}, ${uploader}, ${bucket}, ${path}, ${fileName}, ${size},
          ${status === 'published' ? FIXTURE_IDS.admin : null},
          ${status === 'published' ? T.approve : null}, ${T.base}, ${T.base})`
    }
    // 没有目录归属的资源（只有测"必须停下"时才插进去）
    await sql`DELETE FROM resources WHERE id = ${FIXTURE_IDS.resUnassigned}`

    // ── 审核记录：时间线三行 + 一行没有原因的退回 ──
    await sql`
      INSERT INTO review_records (resource_id, reviewer_id, action, comment, _created_at) VALUES
        (${FIXTURE_IDS.resTimeline}, ${FIXTURE_IDS.admin}, 'reject', '周次写错了，请改', ${T.reject}),
        (${FIXTURE_IDS.resTimeline}, ${FIXTURE_IDS.admin}, 'approve', NULL, ${T.approve}),
        (${FIXTURE_IDS.resRejectNoComment}, ${FIXTURE_IDS.admin}, 'reject', NULL, ${T.reject})`

    // ── 审计：提交事件 + 孤儿操作者 + MFA 历史动作 + 被拒 + 失败 ──
    await sql`
      INSERT INTO audit_logs (id, action, teacher_id, teacher_name, resource_id, success, error_message, _created_at) VALUES
        (gen_random_uuid(), 'resource_submit_review', ${FIXTURE_IDS.teacher}, '张老师', ${FIXTURE_IDS.resTimeline}, true, NULL, ${T.submit1}),
        (gen_random_uuid(), 'resource_submit_review', ${FIXTURE_IDS.teacher}, '张老师', ${FIXTURE_IDS.resTimeline}, true, NULL, ${T.submit2}),
        (gen_random_uuid(), 'login', '99999999-0000-4000-8000-000000000009', '早就删掉的测试账号', NULL, true, NULL, ${T.base}),
        (gen_random_uuid(), 'mfa_challenge_issued', ${FIXTURE_IDS.admin}, '园长', NULL, true, NULL, ${T.base}),
        (gen_random_uuid(), 'resource_download_denied', ${FIXTURE_IDS.teacher}, '张老师', ${FIXTURE_IDS.resPublished}, true, NULL, ${T.base}),
        (gen_random_uuid(), 'login_failed', NULL, NULL, NULL, false, '口令不正确', ${T.base})`

    // ── 授权：一条能转的 + 一条 V2 没这个能力的 + deny + scope ──
    await sql`
      INSERT INTO subject_permissions (teacher_id, program, subject, permission, granted) VALUES
        (${FIXTURE_IDS.teacher}, 'prek', 'prek:virtue', 'resource.view', true),
        (${FIXTURE_IDS.teacher}, 'prek', 'prek:virtue', 'mfa.manage_self', true)`
    await sql`
      INSERT INTO account_permission_overrides (teacher_id, permission, effect, reason) VALUES
        (${FIXTURE_IDS.teacher}, 'resource.download', 'allow', '临时需要'),
        (${FIXTURE_IDS.kHead}, 'resource.view', 'deny', '离职前收回')`
    await sql`
      INSERT INTO account_scopes (teacher_id, kind, program) VALUES (${FIXTURE_IDS.kHead}, 'PROGRAM', 'prek')`

    // ── 版本行：V2 没有版本表，条数要进 legacy ──
    await sql`
      INSERT INTO resource_versions (resource_id, version) VALUES
        (${FIXTURE_IDS.resVersioned}, 1), (${FIXTURE_IDS.resVersioned}, 2), (${FIXTURE_IDS.resVersioned}, 3)`
  } finally {
    await sql.end({ timeout: 5 })
  }

  return { url: FIXTURE_URL, storageDir }
}

/** 夹具的"数据指纹"，用来证明迁移没有改到 V1（源库必须逐字节不变）。 */
export async function fixtureFingerprint() {
  const { snapshot } = await import('../../scripts/v1-snapshot.mjs')
  return snapshot(FIXTURE_URL)
}

/** 插一个"没有目录归属"的资源（只有测拒绝路径时才用）。 */
export async function insertUnassignedResource() {
  const sql = postgres(FIXTURE_URL, { max: 1, onnotice: () => {} })
  try {
    await sql`
      INSERT INTO resources (id, title, program, subject, folder_type, directory_id, status, uploader_id)
      VALUES (${FIXTURE_IDS.resUnassigned}, '不知道放哪的资源', 'prek', 'prek:virtue',
              'courseware', NULL, 'draft', ${FIXTURE_IDS.teacher})`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function deleteUnassignedResource() {
  const sql = postgres(FIXTURE_URL, { max: 1, onnotice: () => {} })
  try {
    await sql`DELETE FROM resources WHERE id = ${FIXTURE_IDS.resUnassigned}`
  } finally {
    await sql.end({ timeout: 5 })
  }
}
