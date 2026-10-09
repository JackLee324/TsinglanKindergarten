/**
 * scripts/import-v1.mjs —— V1 → V2 单向数据迁移
 * ============================================================================
 * 规则书在 `docs/V1_MIGRATION.md`。这里只强调三件在代码里必须成立的事：
 *
 * 1. **源库只读。** 连接上第一句就是 `SET default_transaction_read_only = on`。
 *    不是"我保证不写"，是"写了数据库会拒"。迁移最重要的性质是**不可逆的破坏
 *    必须不可能发生**，而不是"我们的脚本很小心"。
 *
 * 2. **绝不猜。** 任何映射不出来的东西（未知状态、对不上的目录、解不开的口令形态、
 *    落不下的用户名冲突）都进 `problems`，进报告，并且按严重程度决定是停止还是
 *    继续。没有"就近放一个"的分支。
 *
 * 3. **幂等靠约束。** 用户/资源保留 V1 的 uuid 并用 `ON CONFLICT DO NOTHING`；
 *    目录/审核/文件/授权靠 `v1_migration_map` 的主键；审计靠
 *    `audit_logs_v1_dedup` 唯一索引。第二次运行必须是空操作，而且**不覆盖**
 *    管理员在 V2 里做过的修改 —— 重新导入不等于回滚别人的工作。
 *
 * 用法见 docs/V1_MIGRATION.md §12。
 */
import {
  buildDirectoryCodeIndex,
  resolveLegacyResourceDirectory,
} from './lib/resolve-legacy-directory.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// ─────────────────────────────────────────────────────────────────────────────
// 映射表（纯数据，单测直接 import 它们）
// ─────────────────────────────────────────────────────────────────────────────

/** V1 资源状态 → V2。小写 → 大写，一一对应；出现别的值就停。 */
export const STATUS_MAP = {
  draft: 'DRAFT',
  pending_review: 'PENDING_REVIEW',
  published: 'PUBLISHED',
  rejected: 'REJECTED',
  recalled: 'RECALLED',
}

/** V1 教师状态 → V2（V2 只有 active / inactive）。 */
export const USER_STATUS_MAP = { active: 'active', inactive: 'inactive' }

/** V1 审核记录动作 → V2 状态机动作。 */
export const REVIEW_ACTION_MAP = {
  approve: 'review.approve',
  reject: 'review.reject',
  recall: 'review.recall',
}

/** V2 状态机动作 → (from, to)。与 shared/resource-status.ts 的六条转换一致（取迁移需要的那几条）。 */
export const REVIEW_TRANSITION = {
  submit: ['DRAFT', 'PENDING_REVIEW'],
  'review.approve': ['PENDING_REVIEW', 'PUBLISHED'],
  'review.reject': ['PENDING_REVIEW', 'REJECTED'],
  'review.recall': ['PUBLISHED', 'RECALLED'],
}

/**
 * V1 审计动作 → V2 审计动作。
 *
 * 没列在这里的 V1 动作**不丢**：原样保留动作名（见 AUDIT_LEGACY_ACTIONS）。
 * V2 没有 MFA，也不该假装有 —— 但"当年有人在 2026-10-05 做过 MFA 挑战"
 * 是真实发生过的事，审计里必须还在。
 */
export const AUDIT_ACTION_MAP = {
  login: 'auth.login',
  logout: 'auth.logout',
  password_changed: 'auth.change_password',
  permission_change: 'user.permissions.update',
  teacher_create: 'user.create',
  teacher_update: 'user.update',
  directory_create: 'directory.create',
  directory_update: 'directory.update',
  directory_rename: 'directory.update',
  directory_delete: 'directory.delete',
  resource_upload: 'resource.create',
  resource_edit: 'resource.update',
  resource_delete: 'resource.delete',
  resource_restore: 'resource.restore',
  resource_purge: 'resource.purge',
  resource_download: 'resource.download',
  resource_submit_review: 'resource.submit_review',
  resource_approve: 'resource.approve',
  resource_recall: 'resource.recall',
  permission_denied: 'authz.denied',
  // V2 把"被拒的访问"统一记成 `authz.denied` + result=denied（见 files.service 的写法），
  // 所以 V1 的"下载被拒"归到同一个动作上，审计页的筛选才有意义。
  // 原始动作名不会丢：所有被翻译过的行都会在 detail.v1Action 里留下 V1 的名字。
  resource_download_denied: 'authz.denied',
}

/** 结果映射：V1 的 success 布尔 + 几个语义上就是"被拒"的动作。 */
export const AUDIT_RESULT_RULES = {
  deniedActions: ['resource_download_denied', 'permission_denied', 'file_validation_rejected'],
}

/** V2 里没有对应概念、因此原样保留动作名的 V1 动作（审计页用中文标签显示）。 */
export const AUDIT_LEGACY_ACTIONS = {
  login_failed: '登录失败（V1 历史）',
  mfa_challenge_issued: 'MFA 挑战（V1 历史）',
  mfa_enrolled: 'MFA 登记（V1 历史）',
  mfa_enabled: 'MFA 启用（V1 历史）',
  mfa_failed: 'MFA 校验失败（V1 历史）',
  mfa_success: 'MFA 校验通过（V1 历史）',
  resource_file_register: '文件登记（V1 历史）',
  file_validation_rejected: '文件校验未通过（V1 历史）',
  resource_directory_assign: '资源目录归属指派（V1 历史）',
  data_export: '数据导出（V1 历史）',
}

/** 审计动作 → V2 的 target_type（V2 有 CHECK，只能是这六个之一）。 */
const TARGET_TYPE_BY_PREFIX = [
  ['teacher_', 'user'],
  ['account_', 'user'],
  ['role_', 'user'],
  ['permission_', 'system'],
  ['mfa_', 'user'],
  ['directory_', 'directory'],
  ['resource_', 'resource'],
  ['file_', 'file'],
  ['session_', 'session'],
  ['auth', 'session'],
  ['login', 'session'],
  ['password_', 'user'],
]

/**
 * V1 权限码 → V2 权限码（只用于 `subject_permissions` 与 allow 覆盖）。
 * 表里没有的 V1 权限**不翻译**：它在 V2 里没有对应能力（MFA / 安全 / 存储运维）。
 */
export const PERMISSION_MAP = {
  'curriculum.view': 'resource.view',
  'resource.view': 'resource.view',
  'resource.create': 'resource.create',
  'storage.upload': 'resource.create',
  'resource.update': 'resource.update.own',
  'resource.delete': 'resource.delete.own',
  'resource.download': 'resource.download',
  'storage.download': 'resource.download',
  'resource.submit_review': 'resource.submit',
  'review.view': 'resource.review',
  'review.approve': 'resource.publish',
  'curriculum.manage': 'directory.manage',
  'storage.delete': 'directory.manage',
  'audit.view': 'audit.view',
  'account.view': 'user.manage',
  'account.create': 'user.manage',
  'account.update': 'user.manage',
  'account.disable': 'user.manage',
  'account.reset_password': 'user.manage',
  'role.view': 'user.manage',
  'role.assign': 'user.manage',
  'permission.view': 'user.manage',
  'permission.grant': 'user.manage',
  'permission.revoke': 'user.manage',
}

/**
 * V1 岗位名 → V2 管理员的集合。**默认为空：迁移不会自动把任何人提升为管理员。**
 *
 * 规则变更记录（业主 Stage 13 §4，2026-10-09）：
 *   原先默认是 `['super_admin', 'principal']`，也就是 V1 里叫"园长"的账号会被**自动**
 *   提升成 V2 的超级管理员。业主复核后明确禁止这种做法：**不得仅凭 V1 的旧角色名称
 *   自动提升账号身份** —— 岗位名是历史数据，不是今天的授权决定；
 *   而"谁是超级管理员"必须由人**指名道姓**地确认。
 *
 * 因此现在有两条**显式**路径（都要操作者主动写出来）：
 *   · `--admin-usernames a,b`（推荐）：直接点名**账号**，这是业主想要的粒度；
 *   · `--admin-roles super_admin,principal`：按 V1 岗位名批量指定（粗一档，仍要显式）。
 * 都不给 → 迁移结果里没有任何管理员，随后用 `scripts/bootstrap-admin.mjs`
 * 以显式凭据初始化第一个超级管理员（那才是"第一个管理员"的正规入口）。
 */
export const DEFAULT_ADMIN_ROLES = []

/**
 * 「这个账号在 V1 里没有口令」的占位值。
 *
 * 刻意**不是**一个合法的 scrypt 串：V2 的 `verifyPassword` 要求 6 段且首段为
 * `scrypt`，这种串结构上就过不了，**任何口令都登录不进去**。
 * 于是"没有口令"这件事在数据库里是显式的，而不是靠一个随机哈希去碰运气。
 */
export const UNUSABLE_PASSWORD_PREFIX = 'v1$no-password$'

export function isUnusablePassword(stored) {
  return typeof stored === 'string' && stored.startsWith(UNUSABLE_PASSWORD_PREFIX)
}

export function makeUnusablePassword() {
  return `${UNUSABLE_PASSWORD_PREFIX}${randomUUID()}`
}

/**
 * V1 口令哈希能在 V2 校验通过吗？
 *
 * V1：`scryptSync(password, salt字符串, 32, {N,r,p})` —— salt 是 base64 **文本**；
 * V2：`scryptSync(plain, saltBuffer, 64, …)` —— salt 是**解码后的字节**。
 * 两者的存储格式一模一样，运行方式却不同，所以"格式相同"**不能**推出"能校验"。
 *
 * 兼容分支放在这里而不是 server/auth/password.ts：迁移脚本要对**老格式**做判断，
 * 而运行时的校验器只该关心"能不能过"。两边的关系由
 * tests/unit/password-v1-compat.test.mjs 钉住（用 V1 的代码原样造串再校验）。
 */
export function isV1PasswordFormat(stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  // V1 的派生长度固定 32 字节（V2 是 64），解码后的长度是最可靠的区分特征。
  const digest = Buffer.from(parts[5], 'base64')
  return digest.length === 32
}

/**
 * V1 的 `folder_type` → V2 资料夹 slug。
 *
 * 这张表**不是迁移脚本发明的**：它就是 V1 自己的
 * `server/modules/directories/legacy-folder-mapping.ts` 里那份映射
 * （业主在 V1 §9 逐条给出过）：
 *
 *   curriculum_outline → 课程大纲       weekly_plans → 教学详案
 *   courseware / materials → 教学资源   observation  → 考核评估
 *   research_archive   → **没有对应目录**（PDF 里没有这一项，V1 自己也拒绝为它写目录）
 *
 * 为什么要用它，而不是直接用 V1 的 `directory_id`：
 *
 *   V1 的 348 条资源**全部挂在科目层**（美德 / 蒙特梭利 / 英文教学），
 *   因为当年 migration 0012 刻意没有编码这张映射表（理由见那个文件：PDF 没规定，
 *   不擅自扩大业务含义），于是只回填到科目。
 *   而 V2 的浏览页只在**资料夹层**（`allowFiles = true`）列资源 ——
 *   照搬科目层归属的结果是：348 条资源迁移之后**在目录浏览里一条都看不到**。
 *   那不是"忠实"，那是把数据搬到老师找不到的地方。
 *
 * 所以规则变成：**用 V1 自己的分类表决定落在哪个资料夹**；
 * 表里没有的值（如 research_archive）→ 保持 V1 的目录归属并**报出来**，不猜。
 */
export const FOLDER_TYPE_TO_FOLDER_SLUG = {
  curriculum_outline: 'outline',
  weekly_plans: 'lesson',
  courseware: 'resources',
  materials: 'resources',
  observation: 'assessment',
  // research_archive 刻意缺席：V1 都没有给它目录，V2 更不该凭空编一个。
}

/**
 * V1 的四个资料夹后缀 → V2 seed 用的 slug。
 *
 * V1 的 code 是单数（`prek:virtue_resource`），V2 的 slug 是复数（`resources`）。
 * 名字对齐时用不到这张表（判据是名字），但**新建**节点时 slug 必须跟 V2 的约定走，
 * 否则同一个资料夹在两个库里会有两个不同的地址。
 */
const FOLDER_SLUG_BY_SUFFIX = {
  outline: 'outline',
  lesson: 'lesson',
  resource: 'resources',
  assessment: 'assessment',
}

/** slug 只能是 [a-z0-9-]。V1 的 code 末段（如 `prek:virtue_outline`）需要规整。 */
/**
 * V1 的哪些目录节点**该能放资源**（对应 V2 的 `allow_files = true`）。
 *
 * ⚠️ 这是一条**必须**有的映射，不是可选项：
 * V2 的目录浏览页只在 `allowFiles = true` 的节点渲染资源列表
 * （`DirectoryBrowsePage`：`{target.node.allowFiles && <ResourceList …/>}`），
 * 上传接口也要求目标目录 `allow_files = true`。
 * 所以如果迁移把节点建成 `allow_files = false`，结果就是
 * **数据搬进来了、接口也查得到，但老师在目录里一条都看不到、也传不上去。**
 *
 * 判定规则与 V1 自己的分类表一致（资料夹 code 的后缀）：
 *   `_outline`   课程大纲      → 能量文件
 *   `_lesson`    教学详案      → 能量文件
 *   `_resource`  教学资源      → 能量文件
 *   `_assessment` 考核评估     → 能量文件
 * 其它（美育这种中间层、Pre-K/美德这种科目层）只做导航，保持 false ——
 * 这与 V2 自己种子树的约定一致：**只有叶节点允许放资源**。
 */
export function isFileBearingDirectory(code, name) {
  const tail = String(code ?? '')
    .split(':')
    .pop()
    .toLowerCase()
  if (/_outline$|_lesson$|_resource$|_assessment$/.test(tail)) return true
  // 有些 V1 节点没有 code（或 code 不带后缀）：用资料夹中文名兜底，绝不漏掉
  const label = String(name ?? '').trim()
  return ['课程大纲', '教学详案', '教学资源', '考核评估'].includes(label)
}

export function slugFromV1Code(code, name) {
  const tail = String(code ?? '')
    .split(':')
    .pop()
    .replace(/^[a-z0-9]+_/, '')
  if (tail in FOLDER_SLUG_BY_SUFFIX) return FOLDER_SLUG_BY_SUFFIX[tail]
  const cleaned = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned !== '') return cleaned
  // 中文名生成不出可读 slug —— 用 hash 保证确定性（同一个 V1 节点永远同一个 slug，
  // 这样重跑不会因为随机值而建出两个节点）。
  return `v1-${createHash('sha256').update(String(name ?? code ?? '')).digest('hex').slice(0, 8)}`
}

/**
 * 把（审核记录 + 提交审计）拼成完整时间线。
 *
 * 为什么 approve/reject/recall **只**取 review_records：
 * V1 的审计里也有 `resource_approve` 这些行，它们是同一件事的日志。
 * 若两边都当事件来源，同一个"通过"会被记两次 —— 而重复的审核记录
 * 在老师那边表现为"这份教案被通过了两次"，没人解释得清。
 * 规则很干脆：**领域记录（review_records）出审核事件，审计出提交事件**；
 * 审计的那些行本身也会照原样搬进 V2 的审计表，一条都不少。
 */
export function buildReviewTimeline(reviewRows, submitRows) {
  const events = []
  for (const r of reviewRows) {
    const action = REVIEW_ACTION_MAP[r.action]
    events.push({
      sortKey: new Date(r.created_at).getTime(),
      resourceId: r.resource_id,
      v1Id: r.id,
      source: 'review_records',
      action,
      rawAction: r.action,
      actorId: r.reviewer_id,
      comment: r.comment,
      at: r.created_at,
    })
  }
  for (const a of submitRows) {
    events.push({
      sortKey: new Date(a.created_at).getTime(),
      resourceId: a.resource_id,
      v1Id: a.id,
      source: 'audit_logs',
      action: 'submit',
      rawAction: a.action,
      actorId: a.teacher_id,
      comment: null,
      at: a.created_at,
    })
  }

  const byResource = new Map()
  for (const e of events) {
    const list = byResource.get(e.resourceId) ?? []
    list.push(e)
    byResource.set(e.resourceId, list)
  }

  const out = []
  for (const [resourceId, list] of byResource) {
    list.sort((a, b) => a.sortKey - b.sortKey)
    let current = 'DRAFT'
    for (const e of list) {
      const [from, to] = REVIEW_TRANSITION[e.action] ?? [null, null]
      const row = {
        resourceId,
        v1Id: e.v1Id,
        source: e.source,
        action: e.action,
        rawAction: e.rawAction,
        actorId: e.actorId,
        comment: e.comment,
        at: e.at,
        from,
        to,
        needsReview: false,
        inferredEdit: false,
        note: null,
      }
      if (from === null) {
        row.needsReview = true
        row.note = `V1 的审核动作「${e.rawAction}」在 V2 状态机里没有对应转换`
        row.from = current
        row.to = current
      } else if (from !== current) {
        /*
          时间线和状态对不上。分两种，不能混为一谈：

          · 提交（submit）：V2 的状态机要求提交**必须**从 DRAFT 出发，而"退回后
            老师又编辑了一次"这一步 V1 **从来不记**（它只记提交）。所以
            REJECTED →（编辑，无记录）→ DRAFT → PENDING_REVIEW 是**记录缺口**，
            不是数据异常：按 DRAFT → PENDING_REVIEW 记，并标明这一步是推出来的。
          · 其余动作：真的对不上（例如没有提交记录就直接通过），标记待人工确认，
            **不修改历史**。
        */
        if (e.action === 'submit') {
          row.inferredEdit = true
          row.note = `V1 未记录提交前的编辑（${current} → DRAFT），按 V2 状态机记为 DRAFT → PENDING_REVIEW`
          row.from = 'DRAFT'
          row.to = 'PENDING_REVIEW'
        } else {
          row.needsReview = true
          row.note = `按时间线推导应为 ${current}，V1 的动作「${e.rawAction}」期望 ${from} → ${to}`
          row.from = current
          row.to = to
        }
      }
      current = row.to
      out.push(row)
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 读取 V1（只读）
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalSourceLabel(url) {
  const u = new URL(url)
  return `v1@${u.hostname}:${u.port || '5432'}${u.pathname}`
}

export async function openReadOnly(url) {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  await sql.unsafe('SET default_transaction_read_only = on')
  return sql
}

export async function readV1(sql) {
  const teachers = await sql`
    SELECT id::text, username, name, name_en, email, wecom_user_id, roles::text[] AS roles,
           status, last_login_at, password_hash, must_change_password, _created_at AS created_at
    FROM teachers ORDER BY id`
  const directories = await sql`
    SELECT id::text, parent_id::text, code, name, name_en, type, sort_order, enabled,
           description, allow_custom_folders, is_system
    FROM directories ORDER BY id`
  const resources = await sql`
    SELECT id::text, title, title_en, description, status, version, uploader_id::text,
           directory_id::text, folder_type, program, subject, sub_subject, semester,
           week_number, theme, reviewer_id::text, review_comment, reviewed_at,
           deleted_at, deleted_by::text, purge_after,
           file_bucket_id, file_path, file_name, file_size, file_type,
           _created_at AS created_at, _updated_at AS updated_at
    FROM resources ORDER BY id`
  const reviews = await sql`
    SELECT id::text, resource_id::text, reviewer_id::text, action, comment,
           _created_at AS created_at
    FROM review_records ORDER BY _created_at, id`
  const submitAudits = await sql`
    SELECT id::text, resource_id::text, teacher_id::text, action, _created_at AS created_at
    FROM audit_logs
    WHERE action = 'resource_submit_review' AND resource_id IS NOT NULL
    ORDER BY _created_at, id`
  const audits = await sql`
    SELECT id::text, action, teacher_id::text, teacher_name, ip_address, user_agent,
           resource_id::text, resource_title, program, subject, detail, success, error_message,
           _created_at AS created_at
    FROM audit_logs ORDER BY _created_at, id`
  const subjectPermissions = await sql`
    SELECT id::text, teacher_id::text, program, subject, sub_subject, permission, granted
    FROM subject_permissions ORDER BY id`.catch(() => [])
  const overrides = await sql`
    SELECT id::text, teacher_id::text, permission, effect, reason, expires_at
    FROM account_permission_overrides ORDER BY id`.catch(() => [])
  const scopes = await sql`
    SELECT id::text, teacher_id::text, permission, kind, program, subject, sub_subject
    FROM account_scopes ORDER BY id`.catch(() => [])
  const versionCounts = await sql`
    SELECT r.id::text AS resource_id, count(v.id)::int AS n
    FROM resources r LEFT JOIN resource_versions v ON v.resource_id = r.id
    GROUP BY r.id`.catch(async () => {
    const rows = await sql`SELECT resource_id::text, count(*)::int AS n FROM resource_versions GROUP BY 1`
    return rows
  })

  return {
    teachers, directories, resources, reviews, submitAudits, audits,
    subjectPermissions, overrides, scopes, versionCounts,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 目录对齐
// ─────────────────────────────────────────────────────────────────────────────

function namePaths(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const paths = new Map()
  for (const row of rows) {
    const parts = []
    let cur = row
    while (cur) {
      parts.unshift(cur.name)
      cur = cur.parent_id ? byId.get(cur.parent_id) : null
    }
    paths.set(row.id, parts.join('/'))
  }
  return paths
}

/**
 * V1 目录 ↔ V2 目录：**按名字路径逐级对齐**。
 *
 * 对不上的分两类：V1 有 V2 没有（管理员在 V1 里自建过）→ 需要新建；
 * V1 没有 V2 有（V2 seed 的初始目录）→ 留着不动，只是记一笔。
 */
export function mapDirectories(v1Dirs, v2Dirs) {
  const v1Paths = namePaths(v1Dirs)
  const v2Paths = namePaths(v2Dirs)
  const v2ByPath = new Map()
  for (const row of v2Dirs) {
    for (const [id, path] of v2Paths) {
      if (id === row.id) v2ByPath.set(path, row)
    }
  }

  const matched = new Map() // v1 id → v2 dir
  const toCreate = []
  const unmatchedV1 = []
  for (const row of v1Dirs) {
    const path = v1Paths.get(row.id)
    const hit = v2ByPath.get(path)
    if (hit) matched.set(row.id, hit)
    else unmatchedV1.push({ ...row, path })
  }

  // 待新建的按深度排序，保证父节点先于子节点落地。
  unmatchedV1.sort((a, b) => v1Paths.get(a.id).split('/').length - v1Paths.get(b.id).split('/').length)
  for (const row of unmatchedV1) {
    toCreate.push({ ...row, v1Path: v1Paths.get(row.id) })
  }

  const v1PathSet = new Set([...v1Paths.values()])
  const onlyInV2 = v2Dirs.filter((d) => !v1PathSet.has(v2Paths.get(d.id))).map((d) => v2Paths.get(d.id))

  return { matched, toCreate, v1Paths, v2Paths, onlyInV2 }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next === undefined || next.startsWith('--') ? true : next
}
const has = (name) => process.argv.includes(`--${name}`)

async function main() {
  /** UNRESOLVED_DIRECTORY 清单（要写进报告、也要在终端里说清楚）。 */
  const resolutionFailures = []
  const sourceUrl = arg('source') ?? process.env.V1_SOURCE_DATABASE_URL
  const targetUrl = arg('target') ?? process.env.DATABASE_URL
  if (!sourceUrl || sourceUrl === true || !targetUrl) {
    console.error('用法：node scripts/import-v1.mjs --source <V1_URL> --target <V2_URL> [--dry-run]')
    console.error('      [--v1-storage none|local:DIR|s3] [--admin-roles a,b] [--report 文件] [--unassigned 文件]')
    process.exit(2)
  }

  const dryRun = has('dry-run')
  const allowPartial = has('allow-partial')
  const adminRoles = String(arg('admin-roles') ?? DEFAULT_ADMIN_ROLES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  /*
    按**账号**指定管理员（推荐路径，业主 Stage 13 §4）。
    大小写不敏感：用户名在 V2 里是 `lower(username)` 唯一的。
  */
  const adminUsernames = String(arg('admin-usernames') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const v1Storage = String(arg('v1-storage') ?? 'none')
  const sourceLabel = canonicalSourceLabel(sourceUrl)

  console.log(`源：${sourceLabel}`)
  console.log(`目标：${new URL(targetUrl).pathname.replace('/', '')}  ${dryRun ? '（预演，不提交）' : ''}`)

  if (new URL(sourceUrl).pathname === new URL(targetUrl).pathname) {
    throw new Error('源库与目标库是同一个库 —— 拒绝继续。')
  }

  const source = await openReadOnly(sourceUrl)
  const target = postgres(targetUrl, { max: 1, onnotice: () => {} })

  try {
    // ── 目标库体检 ────────────────────────────────────────────────────────
    const [hasV1Marker] = await target`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_name = 'teachers'`
    if (hasV1Marker.n > 0) throw new Error('目标库里有 teachers 表 —— 这看起来是 V1，拒绝写入。')
    const [hasLedger] = await target`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_name = 'schema_migrations'`
    if (hasLedger.n === 0) throw new Error('目标库没有 schema_migrations —— 先跑 node scripts/migrate.mjs。')
    const pending = await target`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0003_v1_migration.sql'`
    if (pending.n === 0) throw new Error('目标库还没应用 0003_v1_migration.sql —— 先跑 migrate。')

    const v1 = await readV1(source)
    console.log(`V1：教师 ${v1.teachers.length}，目录 ${v1.directories.length}，资源 ${v1.resources.length}，` +
      `审核 ${v1.reviews.length}，审计 ${v1.audits.length}`)

    const v2Dirs = await target`
      SELECT id::text, parent_id::text, slug, name, name_en, type, sort_order, enabled,
             allow_children, allow_files, allow_custom_folders
      FROM directories ORDER BY sort_order, name`
    const dirMap = mapDirectories(v1.directories, v2Dirs)
    console.log(`目录对齐：匹配 ${dirMap.matched.size}，需新建 ${dirMap.toCreate.length}，V2 独有 ${dirMap.onlyInV2.length}`)

    const problems = []
    const counts = {}
    const bump = (key, field) => {
      counts[key] = counts[key] ?? { inserted: 0, skipped: 0, updated: 0 }
      counts[key][field] = (counts[key][field] ?? 0) + 1
    }

    let runId = null
    const apply = async (tx) => {
      const [run] = await tx`
        INSERT INTO v1_import_runs (source_label, note)
        VALUES (${sourceLabel}, ${tx.json({ dryRun, adminRoles, v1Storage })})
        RETURNING id`
      runId = run.id

      // ── 目录 ────────────────────────────────────────────────────────────
      /*
        先给**对齐上的**目录留一条映射。

        V2 的初始目录是 `seed.mjs` 建的，uuid 与 V1 不同，所以"哪个 V1 目录对应
        哪个 V2 目录"这件事只存在于脚本的内存里 —— 一旦不留痕，迁移之后就没有
        任何地方能回答"这条资源原来的目录在 V2 是哪一个"。新建的节点当然也要留，
        但**对齐的这 69 个才是绝大多数**（第一版只记了新建的，于是盘点表上
        "目录映射"显示 0，看着像目录没搬过来）。
      */
      for (const [v1Id, v2Node] of dirMap.matched) {
        const src = v1.directories.find((d) => d.id === v1Id)
        await record(tx, sourceLabel, 'directory', v1Id, v2Node.id, {
          code: src?.code ?? null, type: src?.type ?? null, matched: true,
        }, false, null, runId)
        bump('directories', 'skipped')
      }

      // 再把 V1 独有节点建出来
      for (const node of dirMap.toCreate) {
        const parentV2 = node.parent_id ? dirMap.matched.get(node.parent_id) ?? null : null
        const existing = await tx`
          SELECT id::text, slug FROM directories
          WHERE ${parentV2 ? tx`parent_id = ${parentV2.id}` : tx`parent_id IS NULL`}
            AND slug = ${slugFromV1Code(node.code, node.name)}`
        if (existing.length > 0) {
          dirMap.matched.set(node.id, { ...existing[0], id: existing[0].id })
          bump('directories', 'skipped')
          continue
        }
        const slug = slugFromV1Code(node.code, node.name)
        const type = node.type === 'folder' ? 'FOLDER' : node.parent_id === null ? 'ROOT' : 'SECTION'
        /*
          ⚠️ `allow_files` 由**映射规则**决定，不能写死 false。
          写死 false 的后果是"资源迁进来了但目录页不列、上传也被拒"
          （阶段 9 的预演目标是已有种子树、`匹配 69 需新建 0`，所以没暴露；
          生产的新库要新建全部 69 个节点 —— 一写死就全站看不到资源）。
        */
        const allowFiles = isFileBearingDirectory(node.code, node.name)
        const [created] = await tx`
          INSERT INTO directories (parent_id, slug, name, name_en, description, type, sort_order,
                                   enabled, allow_children, allow_files, allow_custom_folders)
          VALUES (${parentV2?.id ?? null}, ${slug}, ${node.name}, ${node.name_en ?? null},
                  ${node.description ?? null}, ${type}, ${node.sort_order ?? 0},
                  ${node.enabled ?? true}, true, ${allowFiles}, ${node.allow_custom_folders ?? false})
          RETURNING id::text`
        dirMap.matched.set(node.id, { id: created.id })
        await tx`
          INSERT INTO v1_migration_map (source, entity, v1_id, v2_id, legacy, run_id)
          VALUES (${sourceLabel}, 'directory', ${node.id}, ${created.id},
                  ${tx.json({ code: node.code, type: node.type, createdByImport: true })}, ${runId})
          ON CONFLICT DO NOTHING`
        bump('directories', 'inserted')
      }

      /*
        ── 修复自己建过的目录节点（自愈）──────────────────────────────────────
        阶段 9 的导入把新建节点的 `allow_files` 写死成 false，后果是
        "资源迁进来了、接口查得到，但目录页不列、上传也被拒"。
        这里**只修这次导入自己创建的节点**（`v1_migration_map.legacy.createdByImport`），
        不碰任何人后来手工建的目录 —— 迁移对自己留下的痕迹负责。
      */
      const createdNodes = await tx`
        SELECT d.id::text, d.slug, d.name, d.allow_files, m.legacy->>'code' AS v1_code
        FROM directories d
        JOIN v1_migration_map m ON m.v2_id = d.id::text AND m.entity = 'directory'
        WHERE (m.legacy->>'createdByImport')::boolean IS TRUE`
      const allowFix = []
      for (const node of createdNodes) {
        const should = isFileBearingDirectory(node.v1_code, node.name)
        if (node.allow_files !== should) {
          await tx`UPDATE directories SET allow_files = ${should}, updated_at = now() WHERE id = ${node.id}`
          allowFix.push({ slug: node.slug, name: node.name, from: node.allow_files, to: should })
        }
      }
      if (allowFix.length > 0) {
        console.log(`  ↻ 修正了 ${allowFix.length} 个目录的 allow_files（否则资源在目录页不可见）`)
        for (const f of allowFix.slice(0, 5)) console.log(`     ${f.name}（${f.slug}）：${f.from} → ${f.to}`)
      }

      /*
        ── 目录 code 索引（**必须是建完目录之后的新数据**）────────────────────
        历史缺陷就出在这里：落位时用的是**导入前**读到的目录列表，新建的资料夹
        自然查不到 → 找不到资料夹 → 回退到科目层 → 资源落在 allowFiles=false 的节点上
        （库里对、接口对、老师在目录里看不到）。阶段 9 的预演目标是已有种子树的库，
        所以那条分支从没跑过，缺陷一直藏着。

        现在：V2 的 directories 表没有 code 列，code 来自 `v1_migration_map`
        （导入时写进去的 V1 code），这里 join 出 code → {id, path} 的索引，
        并且**重新查一次** V2 目录（含刚建的）。
      */
      const v2DirRows = await tx`
        WITH RECURSIVE t AS (
          SELECT id, parent_id, slug::text AS path FROM directories WHERE parent_id IS NULL
          UNION ALL
          SELECT d.id, d.parent_id, t.path || '/' || d.slug FROM directories d JOIN t ON d.parent_id = t.id
        )
        SELECT DISTINCT d.id::text, m.legacy->>'code' AS code, d.name, t.path
        FROM directories d
        JOIN t ON t.id = d.id
        LEFT JOIN v1_migration_map m
          ON m.v2_id = d.id::text AND m.entity = 'directory' AND m.source = ${sourceLabel}`
      const directoryIndex = buildDirectoryCodeIndex(v2DirRows)

      // ── 用户 ────────────────────────────────────────────────────────────
      const passwordless = []
      const adminConversions = []
      const roleSuggestions = []
      const usernameTaken = []
      const userMap = new Map() // v1 id → v2 id（实际就是同一个 uuid）
      for (const t of v1.teachers) {
        /*
          身份判定：优先看**账号**（--admin-usernames，点名），再看岗位名（--admin-roles，显式指定）。
          两者都没命中 → TEACHER。**没有任何"默认管理员"** —— 见 DEFAULT_ADMIN_ROLES 的说明。
        */
        const byUsername =
          typeof t.username === 'string' && adminUsernames.includes(t.username.trim().toLowerCase())
        const role = byUsername || (t.roles ?? []).some((r) => adminRoles.includes(r)) ? 'ADMIN' : 'TEACHER'
        const status = USER_STATUS_MAP[t.status]
        if (status === undefined) {
          problems.push({ level: 'fatal', entity: 'user', id: t.id, why: `V1 状态「${t.status}」没有对应值` })
          continue
        }
        const alreadyThere = await tx`SELECT 1 FROM users WHERE id = ${t.id}`

        if (t.username === null || String(t.username).trim() === '') {
          // V2 的 username 是 NOT NULL + UNIQUE，而且"编一个用户名"等于给一个
          // 登录不了的人发了一张门票。所以：导入为**停用**账号 + 明确标记，
          // 保留 uuid 让 346 条资源的上传者不断链。
          const placeholder = `v1-no-username-${t.id.slice(0, 8)}`
          await insertUser(tx, t, { role, status: 'inactive', username: placeholder })
          userMap.set(t.id, t.id)
          await record(tx, sourceLabel, 'user', t.id, t.id, {
            ...legacyUser(t), usernameWasNull: true,
          }, true, 'V1 里没有用户名（系统账号），导入为停用且需要人工决定它的归属', runId)
          problems.push({
            level: 'review', entity: 'user', id: t.id,
            why: `V1 没有用户名 → 导入为停用账号 ${placeholder}`,
          })
          bump('users', alreadyThere.length > 0 ? 'skipped' : 'inserted')
          adminConversions.push({ name: t.name, username: placeholder, role, v1Roles: t.roles })
          continue
        }

        /*
          用户名唯一性是 `lower(username)` 上的唯一索引（V2 有意做成大小写不敏感）。
          所以这里必须按 lower() 比 —— 否则 `V1KHead` 与已存在的 `v1khead` 会被判成
          "不冲突"，然后在 INSERT 上撞一个原始的唯一约束错误：
          管理员看到的是一句数据库报错，而不是"这个用户名被占用了"。
        */
        const clash = await tx`
          SELECT id::text FROM users
          WHERE lower(username) = lower(${t.username}) AND id::text <> ${t.id}`
        if (clash.length > 0) {
          usernameTaken.push({ name: t.name, username: t.username, v1Id: t.id, v2Id: clash[0].id })
          problems.push({
            level: 'fatal', entity: 'user', id: t.id,
            why: `用户名「${t.username}」在 V2 里已被另一个账号占用（${clash[0].id}）`,
          })
          continue
        }

        const password = t.password_hash === null || t.password_hash === ''
          ? makeUnusablePassword()
          : t.password_hash
        if (isUnusablePassword(password)) passwordless.push({ name: t.name, username: t.username })

        await insertUser(tx, t, { role, status, username: t.username, password })
        userMap.set(t.id, t.id)
        await record(tx, sourceLabel, 'user', t.id, t.id, legacyUser(t), false, null, runId)
        bump('users', alreadyThere.length > 0 ? 'skipped' : 'inserted')
        adminConversions.push({ name: t.name, username: t.username, role, v1Roles: t.roles })
        if (role === 'TEACHER') {
          roleSuggestions.push({ name: t.name, username: t.username, v1Roles: (t.roles ?? []).join('/') })
        }
      }
      /*
        **不再**因为"没有管理员"就中止整批导入。
        为什么改：现在"第一个超级管理员"的正规入口是 `scripts/bootstrap-admin.mjs`
        （显式凭据、只在没有 ADMIN 时创建），而它要求导入先跑完。
        所以这里把"没有任何管理员"当成**必须被看见的提示**，写进报告与终端，
        而不是一个让人卡死在中间的硬错误。
      */
      const migratedAdmins = adminConversions.filter((u) => u.role === 'ADMIN')
      if (migratedAdmins.length === 0) {
        console.log(
          '⚠ 本次迁移**没有**提升任何账号为管理员（默认不按 V1 岗位名自动提升）。\n' +
            '   请用 `INITIAL_ADMIN_USERNAME=… INITIAL_ADMIN_PASSWORD=… node scripts/bootstrap-admin.mjs`\n' +
            '   初始化第一个超级管理员，或在界面上指名调整身份。',
        )
      }

      // ── 资源 ────────────────────────────────────────────────────────────
      const fileCandidates = []
      /*
        ⚠️ 这里必须是 `resolutionFailures` 这**同一个**数组，不能另起一个空的。

        原先写的是 `const unassigned = []`，而落位失败时往 `resolutionFailures` 里 push ——
        两个数组互不相干。后果正是最要命的那种：导入因为"资源落不下去"整批中止时，
        交给运营的**未归属清单里写着"（本机三个 V1 库里都没有这种资源。）"**，
        报告里也永远写"资源无目录归属：0"。**最需要这份清单的时刻，它恰好是空的。**
      */
      const unassigned = resolutionFailures
      const versionCount = new Map(v1.versionCounts.map((r) => [r.resource_id, r.n]))
      const publishedAtByResource = new Map()

      /*
        V1 的审计里有**指向不存在资源**的提交行（实测 31 条里 29 条如此，
        它们是当年压测/造数据留下的）。这些行本身会被原样搬进 V2 的审计表
        （一条都不丢），但它们**不该**变成审核时间线事件 —— 更不该被报成
        "审核记录丢了"：那会让一次干净的迁移看起来有 29 个问题，
        而人一旦习惯忽略报告，报告就废了。
      */
      const v1ResourceIds = new Set(v1.resources.map((r) => r.id))
      const submitWithResource = v1.submitAudits.filter((a) => v1ResourceIds.has(a.resource_id))
      const auditOnlySubmits = v1.submitAudits.length - submitWithResource.length

      for (const row of buildReviewTimeline(v1.reviews, submitWithResource)) {
        if (row.action === 'review.approve') publishedAtByResource.set(row.resourceId, row.at)
      }

      for (const r of v1.resources) {
        const status = STATUS_MAP[r.status]
        if (status === undefined) {
          problems.push({ level: 'fatal', entity: 'resource', id: r.id, why: `V1 状态「${r.status}」没有对应值` })
          continue
        }
        /*
          **唯一的落位判定**：program + subject + sub_subject + folder_type → 精确 code 匹配。
          见 scripts/lib/resolve-legacy-directory.mjs（导入 / 报告 / 测试共用同一个）。
          ⚠️ 这里**没有**"找不到就退回科目层"这条退路 —— 那会让资源落在
          allowFiles=false 的节点上：库里对、接口对、老师在目录里看不到。
        */
        const resolved = resolveLegacyResourceDirectory(
          {
            program: r.program,
            subject: r.subject,
            sub_subject: r.sub_subject,
            folder_type: r.folder_type,
          },
          directoryIndex,
        )
        if (!resolved.resolved) {
          /*
            无法唯一确定叶目录 → **不写入任何目录**（尤其不写科目层 Section）。
            记成 fatal：宁可整批停下、把清单交给人，也不把资源搬到老师找不到的地方。
          */
          resolutionFailures.push({
            id: r.id,
            title: r.title,
            tuple: `${r.program} / ${r.subject} / ${r.sub_subject ?? '—'} / ${r.folder_type}`,
            reason: resolved.reason,
          })
          problems.push({
            level: 'fatal',
            entity: 'resource',
            id: r.id,
            why: `目录无法唯一确定（UNRESOLVED_DIRECTORY）：${resolved.reason}；` +
              `元组 ${r.program} / ${r.subject} / ${r.sub_subject ?? '—'} / ${r.folder_type}`,
          })
          continue
        }
        const dir = { id: resolved.directoryId }

        const uploadedBy = r.uploader_id && userMap.has(r.uploader_id) ? r.uploader_id : null
        if (r.uploader_id && !uploadedBy) {
          problems.push({ level: 'review', entity: 'resource', id: r.id, why: `上传者 ${r.uploader_id} 没有迁移（账号被跳过）` })
        }
        const publishedAt = status === 'PUBLISHED'
          ? (r.reviewed_at ?? publishedAtByResource.get(r.id) ?? null)
          : null
        const existed = await tx`SELECT 1 FROM resources WHERE id = ${r.id}`
        await tx`
          INSERT INTO resources (id, directory_id, title, title_en, description, status, version,
                                 uploader_id, published_at, deleted_at, created_at, updated_at)
          VALUES (${r.id}, ${dir.id}, ${r.title}, ${r.title_en ?? null}, ${r.description ?? null},
                  ${status}, ${r.version ?? 1}, ${uploadedBy}, ${publishedAt}, ${r.deleted_at ?? null},
                  ${r.created_at}, ${r.updated_at})
          ON CONFLICT (id) DO NOTHING`
        await record(tx, sourceLabel, 'resource', r.id, r.id, {
          folderType: r.folder_type, program: r.program, subject: r.subject,
          subSubject: r.sub_subject, semester: r.semester, weekNumber: r.week_number,
          theme: r.theme, v1Status: r.status, v1DirectoryId: r.directory_id,
          placedIn: `folder:${resolved.code}`,
          placementBasis: `resolver：program+subject+sub_subject+folder_type → ${resolved.code}（${resolved.reason}）`,
          v1Versions: versionCount.get(r.id) ?? 0,
          v1ReviewerId: r.reviewer_id, v1ReviewComment: r.review_comment,
          deletedBy: r.deleted_by, purgeAfter: r.purge_after,
        }, false, null, runId)
        bump('resources', existed.length > 0 ? 'skipped' : 'inserted')
        if (r.file_path !== null || r.file_bucket_id !== null) fileCandidates.push(r)
      }

      // ── 审核时间线 ──────────────────────────────────────────────────────
      // 用**同一份**过滤后的提交行（见上面 v1ResourceIds 的说明），
      // 否则两次调用会得出两套时间线。
      for (const row of buildReviewTimeline(v1.reviews, submitWithResource)) {
        const resourceExists = await tx`SELECT 1 FROM resources WHERE id = ${row.resourceId}`
        if (resourceExists.length === 0) {
          problems.push({ level: 'review', entity: 'review', id: row.v1Id, why: '对应资源没有迁移（资源被跳过）' })
          continue
        }
        const actor = row.actorId && userMap.has(row.actorId) ? row.actorId : null
        const comment = row.action === 'review.reject' && (row.comment === null || String(row.comment).trim() === '')
          ? '（V1 未记录退回原因）'
          : row.comment ?? null
        const id = /^[0-9a-f-]{36}$/.test(row.v1Id) ? row.v1Id : randomUUID()
        const [existing] = await tx`
          SELECT 1 FROM v1_migration_map
          WHERE source = ${sourceLabel} AND entity = 'review' AND v1_id = ${row.v1Id}`
        if (existing) { bump('resource_reviews', 'skipped'); continue }
        await tx`
          INSERT INTO resource_reviews (id, resource_id, actor_id, action, from_status, to_status, comment, created_at)
          VALUES (${id}, ${row.resourceId}, ${actor}, ${row.action}, ${row.from}, ${row.to}, ${comment}, ${row.at})
          ON CONFLICT (id) DO NOTHING`
        await record(tx, sourceLabel, 'review', row.v1Id, id, {
          source: row.source, v1Action: row.rawAction,
          commentMissing: row.action === 'review.reject' && (row.comment === null || String(row.comment).trim() === ''),
        }, row.needsReview, row.note, runId)
        bump('resource_reviews', 'inserted')
      }

      // ── 审计 ────────────────────────────────────────────────────────────
      for (const a of v1.audits) {
        const mapped = AUDIT_ACTION_MAP[a.action]
        const action = mapped ?? a.action
        const denied = AUDIT_RESULT_RULES.deniedActions.includes(a.action)
        const result = denied ? 'denied' : a.success === false ? 'failed' : 'success'
        const actor = a.teacher_id && userMap.has(a.teacher_id) ? a.teacher_id : null
        const name = (a.teacher_name ?? '').trim() === '' ? '（V1 未记录操作者）' : a.teacher_name
        const [inserted] = await tx`
          INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, result, detail, ip, created_at)
          VALUES (${actor}, ${name}, ${action}, ${targetTypeOf(a.action)}, ${a.resource_id ?? null}, ${result},
                  ${tx.json({
                    v1AuditId: a.id,
                    // 只要 V1 的动作名和 V2 的不一样，就把原名留下 —— 事后要能回答
                    // "这条本来叫什么"，而不是只看到翻译后的结果。
                    ...(mapped === a.action ? {} : { v1Action: a.action }),
                    ...(a.program ? { program: a.program } : {}),
                    ...(a.subject ? { subject: a.subject } : {}),
                    ...(a.error_message ? { errorMessage: a.error_message } : {}),
                  })},
                  ${a.ip_address ?? null}, ${a.created_at})
          ON CONFLICT DO NOTHING
          RETURNING id`
        bump('audit_logs', inserted ? 'inserted' : 'skipped')
      }

      // ── 授权（能编码的才编码）──────────────────────────────────────────
      const reportedPermissions = []
      const permissionRows = []
      for (const p of v1.subjectPermissions) {
        const permission = PERMISSION_MAP[p.permission]
        const dir = p.subject ? dirMap.matched.get(findDirectoryIdByCode(v1.directories, p.subject)) : null
        if (!permission || !dir || p.granted === false) {
          reportedPermissions.push({ kind: 'subject_permissions', id: p.id, permission: p.permission, why: !permission ? 'V2 没有这个权限概念' : !dir ? '科目对不上目录' : 'V1 里就是未授予' })
          continue
        }
        permissionRows.push({ v1Id: p.id, userId: p.teacher_id, permission, directoryId: dir.id })
      }
      for (const o of v1.overrides) {
        const permission = PERMISSION_MAP[o.permission]
        if (o.effect !== 'allow' || !permission) {
          reportedPermissions.push({ kind: 'permission_overrides', id: o.id, permission: o.permission, why: o.effect === 'deny' ? 'V2 没有 deny 概念（不转换，交人工）' : 'V2 没有这个权限概念' })
          continue
        }
        problems.push({ level: 'review', entity: 'permission', id: o.id, why: 'V1 的 allow 覆盖没有目录范围，无法确定该授予哪个目录' })
      }
      for (const s of v1.scopes) {
        reportedPermissions.push({ kind: 'account_scopes', id: s.id, permission: s.permission ?? `${s.kind}`, why: 'V2 的"范围"就是授权指向的目录，单独一个 scope 不产生权限' })
      }
      for (const row of permissionRows) {
        if (!userMap.has(row.userId)) {
          problems.push({ level: 'review', entity: 'permission', id: row.v1Id, why: '被授权人没有迁移' })
          continue
        }
        const [existing] = await tx`
          SELECT 1 FROM v1_migration_map WHERE source = ${sourceLabel} AND entity = 'permission' AND v1_id = ${row.v1Id}`
        if (existing) { bump('user_permissions', 'skipped'); continue }
        const [created] = await tx`
          INSERT INTO user_permissions (user_id, permission, directory_id)
          VALUES (${row.userId}, ${row.permission}, ${row.directoryId}) RETURNING id::text`
        await record(tx, sourceLabel, 'permission', row.v1Id, created.id, {}, false, null, runId)
        bump('user_permissions', 'inserted')
      }

      // ── 文件 ────────────────────────────────────────────────────────────
      let fileReports = []
      if (fileCandidates.length > 0) {
        if (v1Storage === 'none' || v1Storage === true) {
          throw new Error(
            `V1 里有 ${fileCandidates.length} 条资源声称有文件，但 --v1-storage none。` +
            '要么给出源存储位置，要么先弄清这些文件在哪 —— 不装作搬成功。')
        }
        fileReports = await copyFiles({ tx, sourceLabel, runId, v1Storage, fileCandidates, problems, bump, record })
      }

      if (problems.some((p) => p.level === 'fatal')) {
        // 先落盘再抛：未归属清单是**给人去处理的产物**，
        // 如果因为整批中止就不写，人就失去了唯一的线索（事务回滚了，界面里也看不到）。
        writeUnassigned(arg('unassigned'), unassigned)
        const list = problems.filter((p) => p.level === 'fatal').map((p) => `  · ${p.entity} ${p.id}：${p.why}`)
        throw new Error(`有 ${list.length} 个无法自动处理的问题：\n${list.join('\n')}`)
      }
      if (problems.some((p) => p.level === 'review') && !allowPartial) {
        console.warn(`⚠ 有 ${problems.filter((p) => p.level === 'review').length} 项需要人工确认（--allow-partial 可继续）`)
      }

      await tx`UPDATE v1_import_runs SET finished_at = now(), counts = ${tx.json(counts)} WHERE id = ${runId}`

      return {
        counts, problems, dirMap, usernameTaken, passwordless, adminConversions,
        roleSuggestions, reportedPermissions, unassigned, fileReports,
        fileCandidates: fileCandidates.length, auditOnlySubmits,
      }
    }

    const result = dryRun
      ? await (async () => {
        // 预演与真跑**同一条路径**，只是最后回滚 —— 否则"预演通过、真跑失败"迟早发生。
        const sentinel = new Error('__DRY_RUN_ROLLBACK__')
        try {
          await target.begin(async (tx) => {
            await apply(tx)
            throw sentinel
          })
        } catch (error) {
          if (error !== sentinel) throw error
        }
        console.log('预演完成：以上计数是"真跑会发生什么"，数据库未改动。')
        return null
      })()
      : await target.begin((tx) => apply(tx))

    // ── 核对（真跑之后）────────────────────────────────────────────────
    if (!dryRun) {
      const verify = await verifyTarget(target)
      console.log(`核对：${JSON.stringify(verify.counts)}`)
      if (verify.dangling.length > 0) {
        throw new Error(`迁移后发现悬空引用：${JSON.stringify(verify.dangling)}`)
      }
      await writeReports(result, { sourceLabel, targetUrl, verify })
      console.log(`迁移完成。${verify.counts.resources} 条资源，${verify.counts.users} 个账号，${verify.counts.audit_logs} 条审计。`)
    }
  } finally {
    await source.end({ timeout: 5 })
    await target.end({ timeout: 5 })
  }
}



function findDirectoryIdByCode(dirs, code) {
  const hit = dirs.find((d) => d.code === code)
  return hit ? hit.id : null
}

function legacyUser(t) {
  return {
    roles: t.roles ?? [],
    wecomUserId: t.wecom_user_id ?? null,
    email: t.email ?? null,
    lastLoginAt: t.last_login_at ?? null,
    mustChangePassword: t.must_change_password === true,
    hasV1Password: Boolean(t.password_hash),
    v1CreatedAt: t.created_at ?? null,
  }
}

async function insertUser(tx, t, { role, status, username, password }) {
  const hash = password ?? t.password_hash ?? makeUnusablePassword()
  await tx`
    INSERT INTO users (id, username, name, name_en, password_hash, role, status, created_at, updated_at)
    VALUES (${t.id}, ${username}, ${t.name}, ${t.name_en ?? null}, ${hash}, ${role}, ${status},
            ${t.created_at ?? new Date()}, ${t.created_at ?? new Date()})
    ON CONFLICT (id) DO NOTHING`
}

async function record(tx, sourceLabel, entity, v1Id, v2Id, legacy, needsReview, note, runId) {
  await tx`
    INSERT INTO v1_migration_map (source, entity, v1_id, v2_id, legacy, needs_review, review_note, run_id)
    VALUES (${sourceLabel}, ${entity}, ${v1Id}, ${v2Id}, ${tx.json(legacy)}, ${needsReview}, ${note}, ${runId})
    ON CONFLICT (source, entity, v1_id) DO NOTHING`
}

function targetTypeOf(action) {
  for (const [prefix, type] of TARGET_TYPE_BY_PREFIX) {
    if (String(action).startsWith(prefix)) return type
  }
  return 'system'
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件搬运
// ─────────────────────────────────────────────────────────────────────────────

async function copyFiles({ tx, sourceLabel, runId, v1Storage, fileCandidates, problems, bump, record }) {
  const reports = []
  let reader
  if (String(v1Storage).startsWith('local:')) {
    const root = resolve(String(v1Storage).slice('local:'.length))
    reader = async (r) => {
      const candidates = [join(root, r.file_path)]
      if (r.file_bucket_id) candidates.push(join(root, r.file_bucket_id, r.file_path))
      for (const path of candidates) if (existsSync(path)) return readFileSync(path)
      return null
    }
  } else if (v1Storage === 's3') {
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
    const client = new S3Client({
      endpoint: process.env.V1_STORAGE_ENDPOINT,
      region: process.env.V1_STORAGE_REGION ?? 'auto',
      forcePathStyle: process.env.V1_STORAGE_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.V1_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: process.env.V1_STORAGE_SECRET_ACCESS_KEY,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    reader = async (r) => {
      try {
        const res = await client.send(new GetObjectCommand({
          Bucket: r.file_bucket_id ?? process.env.V1_STORAGE_BUCKET,
          Key: r.file_path,
        }))
        const chunks = []
        for await (const c of res.Body) chunks.push(c)
        return Buffer.concat(chunks)
      } catch {
        return null
      }
    }
  } else {
    throw new Error(`不认识的 --v1-storage：${v1Storage}`)
  }

  const writer = makeV2Writer()

  for (const r of fileCandidates) {
    const [existing] = await tx`
      SELECT 1 FROM v1_migration_map WHERE source = ${sourceLabel} AND entity = 'resource_file' AND v1_id = ${r.id}`
    if (existing) { bump('resource_files', 'skipped'); continue }

    const bytes = await reader(r)
    if (bytes === null) {
      // V1 说有文件，源里读不到 —— 绝不造一个空文件出来。
      reports.push({ resourceId: r.id, title: r.title, status: 'MISSING_FILE', v1Path: r.file_path, v1Bucket: r.file_bucket_id })
      await record(tx, sourceLabel, 'resource_file', r.id, null,
        { v1Path: r.file_path, v1Bucket: r.file_bucket_id, v1Name: r.file_name, v1Size: r.file_size },
        true, 'V1 声称有文件，源存储里找不到对象', runId)
      problems.push({ level: 'review', entity: 'resource_file', id: r.id, why: `源对象读不到：${r.file_path}` })
      continue
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const fileName = r.file_name ?? r.file_path.split('/').pop() ?? 'file'
    const storageKey = `resources/${r.id}/${randomUUID()}-${fileName.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')}`
    await writer.put(storageKey, bytes, r.file_type ?? 'application/octet-stream')
    const [file] = await tx`
      INSERT INTO resource_files (resource_id, file_name, storage_key, mime_type, size, sha256, created_at)
      VALUES (${r.id}, ${fileName}, ${storageKey}, ${r.file_type ?? 'application/octet-stream'},
              ${bytes.byteLength}, ${sha256}, ${r.created_at})
      RETURNING id::text`
    await record(tx, sourceLabel, 'resource_file', r.id, file.id,
      { storageKey, sha256, v1Path: r.file_path, v1Bucket: r.file_bucket_id }, false, null, runId)
    reports.push({ resourceId: r.id, title: r.title, status: 'COPIED', sha256, size: bytes.byteLength })
    bump('resource_files', 'inserted')
  }
  return reports
}

function makeV2Writer() {
  const { loadConfig } = require(join(ROOT, 'dist/server/config.js'))
  /*
    这里刻意复用**应用自己的配置解析**（`dist/server/config.js`），而不是自己读
    STORAGE_* 环境变量：迁移写进去的对象必须是应用之后能读到的那一份。
    两套解析迟早会分叉，而分叉的表现是"迁移说搬过来了、老师点下载 404"。

    代价是文件迁移要求目标环境具备应用启动所需的变量（生产本来就有）。
    所以只有**确实有文件要搬**时才会走到这里；没有对象时用 `--v1-storage none`，
    一个环境变量都不需要。
  */
  let config
  try {
    config = loadConfig()
  } catch (error) {
    throw new Error(
      `读取目标存储配置失败：${error.message}\n` +
      '  文件迁移需要与应用相同的存储环境变量（STORAGE_PROVIDER / STORAGE_*）。\n' +
      '  若本次确实没有对象要搬，请显式传 `--v1-storage none`。',
    )
  }
  if (config.storage.provider === 'local') {
    const root = resolve(config.storage.localDir)
    return {
      async put(key, bytes) {
        const path = join(root, key)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, bytes)
      },
    }
  }
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
  const client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: { accessKeyId: config.storage.accessKey, secretAccessKey: config.storage.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: config.storage.bucket, Key: key, Body: bytes, ContentType: contentType,
      }))
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 核对与报告
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyTarget(sql) {
  const [counts] = await sql`
    SELECT
      (SELECT count(*)::int FROM users)          AS users,
      (SELECT count(*)::int FROM directories)    AS directories,
      (SELECT count(*)::int FROM resources)      AS resources,
      (SELECT count(*)::int FROM resource_files) AS resource_files,
      (SELECT count(*)::int FROM resource_reviews) AS resource_reviews,
      (SELECT count(*)::int FROM audit_logs)     AS audit_logs,
      (SELECT count(*)::int FROM user_permissions) AS user_permissions`

  const dangling = []
  const checks = [
    ['resources.directory_id', sql`SELECT count(*)::int AS n FROM resources r LEFT JOIN directories d ON d.id = r.directory_id WHERE d.id IS NULL`],
    ['resources.uploader_id', sql`SELECT count(*)::int AS n FROM resources r LEFT JOIN users u ON u.id = r.uploader_id WHERE r.uploader_id IS NOT NULL AND u.id IS NULL`],
    ['resource_files.resource_id', sql`SELECT count(*)::int AS n FROM resource_files f LEFT JOIN resources r ON r.id = f.resource_id WHERE r.id IS NULL`],
    ['resource_reviews.resource_id', sql`SELECT count(*)::int AS n FROM resource_reviews v LEFT JOIN resources r ON r.id = v.resource_id WHERE r.id IS NULL`],
    ['resource_reviews.actor_id', sql`SELECT count(*)::int AS n FROM resource_reviews v LEFT JOIN users u ON u.id = v.actor_id WHERE v.actor_id IS NOT NULL AND u.id IS NULL`],
    ['audit_logs.actor_id', sql`SELECT count(*)::int AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.actor_id IS NOT NULL AND u.id IS NULL`],
    ['user_permissions.user_id', sql`SELECT count(*)::int AS n FROM user_permissions p LEFT JOIN users u ON u.id = p.user_id WHERE u.id IS NULL`],
    ['user_permissions.directory_id', sql`SELECT count(*)::int AS n FROM user_permissions p LEFT JOIN directories d ON d.id = p.directory_id WHERE p.directory_id IS NOT NULL AND d.id IS NULL`],
  ]
  for (const [name, query] of checks) {
    const [row] = await query
    if (row.n > 0) dangling.push({ name, n: row.n })
  }

  const [dupes] = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT resource_id, action, created_at, count(*) AS c
      FROM resource_reviews GROUP BY 1,2,3 HAVING count(*) > 1) x`
  return { counts, dangling, duplicateReviewKeys: dupes.n }
}

async function writeReports(result, { sourceLabel, targetUrl, verify }) {
  if (!result) return
  const reportPath = arg('report')
  const unassignedPath = arg('unassigned')
  const lines = []
  lines.push('# V1 → V2 迁移报告（自动生成）', '')
  lines.push(`- 源：\`${sourceLabel}\``)
  lines.push(`- 目标：\`${new URL(targetUrl).pathname.replace('/', '')}\``)
  lines.push(`- 时间：${new Date().toISOString()}`)
  lines.push('')
  lines.push('## 搬运计数', '')
  lines.push('| 表 | 新增 | 跳过（已存在） |', '|---|---|---|')
  for (const [table, c] of Object.entries(result.counts)) {
    lines.push(`| ${table} | ${c.inserted ?? 0} | ${c.skipped ?? 0} |`)
  }
  lines.push('', '## 目标库核对', '')
  lines.push('```json', JSON.stringify(verify, null, 2), '```')
  lines.push('', '## 目录对齐', '')
  lines.push(`- 匹配：${result.dirMap.matched.size}`)
  lines.push(`- 新建（V1 独有）：${result.dirMap.toCreate.length}`)
  lines.push(`- V2 独有（保留）：${result.dirMap.onlyInV2.length}`)
  lines.push('', '## 需要人工处理', '')
  lines.push(`- 无法登录（V1 没有口令）：${result.passwordless.length}`)
  for (const u of result.passwordless) lines.push(`  - ${u.name}（${u.username}）`)
  lines.push(`- 未能自动映射的授权来源：${result.reportedPermissions.length}`)
  for (const p of result.reportedPermissions) lines.push(`  - ${p.kind} ${p.id}：${p.permission} —— ${p.why}`)
  lines.push(`- 资源无目录归属：${result.unassigned.length}`)
  lines.push(`- 其他需要确认：${result.problems.filter((p) => p.level === 'review').length}`)
  for (const p of result.problems.filter((p) => p.level === 'review')) {
    lines.push(`  - ${p.entity} ${p.id}：${p.why}`)
  }
  lines.push('', '## 身份迁移：**没有自动提升的管理员**', '')
  lines.push(
    '按业主规则，迁移**不会**依据 V1 的岗位名自动把账号变成管理员。',
    '若本次确实提升了账号，那一定是操作者用 `--admin-usernames` / `--admin-roles` 显式指定的：',
    '',
  )
  // 注意作用域：这里在 writeReports(result, …) 里，必须走参数，而不是 apply() 的局部变量。
  const adminsInReport = (result.adminConversions ?? []).filter((u) => u.role === 'ADMIN')
  if (adminsInReport.length === 0) {
    lines.push(
      '- **本次一名管理员都没有**。请在导入完成后用显式凭据初始化第一个超级管理员：',
      '  `INITIAL_ADMIN_USERNAME=… INITIAL_ADMIN_PASSWORD=… node scripts/bootstrap-admin.mjs`',
      '',
    )
  } else {
    for (const a of adminsInReport) lines.push(`- ${a.name}（${a.username}）← V1 岗位 ${(a.v1Roles ?? []).join('/')}`)
    lines.push('')
  }

  lines.push('', '## 角色 → 建议授予（管理员照着点即可）', '')
  lines.push('| 老师 | 用户名 | V1 角色 |', '|---|---|---|')
  for (const s of result.roleSuggestions) lines.push(`| ${s.name} | ${s.username} | ${s.v1Roles} |`)
  lines.push('', '## 只存在于审计里的提交事件', '')
  lines.push(`- ${result.auditOnlySubmits} 条 \`resource_submit_review\` 指向的 V1 资源并不存在（造数据留下的）。`)
  lines.push('  它们照原样搬进了审计表（一条不丢），但**没有**变成审核记录 —— 那是它们的真实身份。')
  lines.push('', '## 文件', '')
  lines.push(`- V1 声称有文件的资源：${result.fileCandidates}`)
  for (const f of result.fileReports) lines.push(`  - ${f.status} ${f.title ?? ''} ${f.sha256 ?? ''}`)

  if (reportPath && reportPath !== true) {
    writeFileSync(reportPath, `${lines.join('\n')}\n`)
    console.log(`报告已写入 ${reportPath}`)
  } else {
    console.log(lines.join('\n'))
  }

  writeUnassigned(unassignedPath, result.unassigned)
}

/** 未归属清单。成功与中止两条路都会写它 —— 它是给人看的行动清单。 */
function writeUnassigned(path, list) {
  if (!path || path === true) return
  const out = ['# 无法确定目录归属的资源（需要人工处理）', '',
    'V2 的资源必须有目录（`resources.directory_id` NOT NULL），而"未归属"在 V2 里**不是一个目录节点**，',
    '所以脚本不会替它们编一个：请决定它们应该进哪个目录，或在 V1 里补齐归属后重跑。', '']
  for (const u of list) out.push(`- \`${u.id}\` ${u.title} —— ${u.why}`)
  if (list.length === 0) out.push('（本机三个 V1 库里都没有这种资源。）')
  writeFileSync(path, `${out.join('\n')}\n`)
  console.log(`未归属清单已写入 ${path}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  await main().catch((error) => {
    console.error(`✖ 迁移失败：${error.message}`)
    process.exitCode = 1
  })
}
