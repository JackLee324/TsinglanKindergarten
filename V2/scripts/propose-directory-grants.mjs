#!/usr/bin/env node
/**
 * scripts/propose-directory-grants.mjs —— **只读**生成"教师目录授权"决策清单
 * ============================================================================
 * 业主 Stage 13C §1：确认唯一管理员 **不等于** 完成教师权限初始化。
 * 24 个迁移账号当前 **0 条**授权，而 V1 导出里
 * `subject_permissions` / `account_scopes` / `account_permission_overrides` **全是 0 行** ——
 * 也就是说**没有任何可推导的数据**：V1 是角色制，V2 是"权限 × 目录"的显式授权，
 * 这个映射是业务决策，不是数据搬运。
 *
 * 所以这个脚本**不做决定**，它只做三件事（全部只读）：
 *   1. 从**已冻结且校验过 SHA-256** 的迁移文件里读出 24 个账号与 69 个目录；
 *   2. 把目录按 V2 的 slug 路径列出来（复用 `import-v1.mjs` 里**同一个**
 *      `slugFromV1Code()`，不另造一份目录真相）；
 *   3. 生成一张业主可以直接填的决策表（Markdown + JSON），每格默认 `DECISION_REQUIRED`。
 *
 * 三条硬边界：
 *   · **不连数据库**（脚本里没有 `postgres` 导入）——授权初始化只能在界面上做；
 *   · **不猜**：不给"建议授权"当成结论，也不做"按角色批量开放"；
 *   · **不覆盖**已有产物（除非 `--force`）——业主填过的表比什么都重要。
 *
 * 用法：
 *   node scripts/propose-directory-grants.mjs
 *   node scripts/propose-directory-grants.mjs --out-dir .migration --force
 *   node scripts/propose-directory-grants.mjs --snapshot .migration/prod-exports/其他.ndjson
 *
 * 退出码：0 成功 / 2 源文件或哈希不对 / 3 产物已存在（未给 --force） / 4 缺少构建产物（权限清单）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slugFromV1Code } from './import-v1.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

function fail(message, code = 2) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

const SNAPSHOT = resolve(
  ROOT,
  arg('snapshot', '.migration/prod-exports/v2-cutover-20261008.ndjson'),
)
const MANIFEST = resolve(ROOT, arg('manifest', '.migration/prod-exports/v2-cutover-20261008.exclusion.json'))
const OUT_DIR = resolve(ROOT, arg('out-dir', '.migration'))
const OUT_MD = join(OUT_DIR, 'production-grant-decision-sheet.md')
const OUT_JSON = join(OUT_DIR, 'production-grant-decision-sheet.json')

/** 唯一超级管理员（业主 Stage 13B §2 已确认）—— 决策表里不重复问这一条。 */
const SUPERADMIN_USERNAME = 'TsinglanAdmin'

// ── ① 源文件完整性：决策表必须来自**冻结且校验过**的那一份 ────────────────────
if (!existsSync(SNAPSHOT)) fail(`找不到迁移文件：${SNAPSHOT}`)
const bytes = readFileSync(SNAPSHOT)
const sha256 = createHash('sha256').update(bytes).digest('hex')
if (existsSync(MANIFEST)) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const expected = manifest?.output?.sha256
  if (typeof expected === 'string' && expected !== sha256) {
    fail(
      `迁移文件的 sha256 与清单不符：\n  实际 ${sha256}\n  清单 ${expected}\n` +
        '  决策表必须建立在**冻结的那一份**上 —— 先跑 scripts/prepare-v2-cutover-snapshot.mjs --check。',
    )
  }
} else {
  console.warn(`⚠ 没找到清单 ${MANIFEST} —— 只校验了文件本身（sha256 ${sha256.slice(0, 12)}…）`)
}

// ── ② 读取账号与目录（只读解析 NDJSON） ──────────────────────────────────────
const teachers = []
const directories = []
for (const line of bytes.toString('utf8').split('\n')) {
  if (line.trim() === '') continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.kind !== 'row') continue
  if (record.table === 'teachers') teachers.push(record.row)
  if (record.table === 'directories') directories.push(record.row)
}
if (teachers.length === 0 || directories.length === 0) {
  fail(`迁移文件里没有账号或目录（teachers=${teachers.length} directories=${directories.length}）`)
}

/** 目录 → V2 slug 路径（复用 import-v1 的 slugFromV1Code，再走一遍父子链）。 */
const byId = new Map(directories.map((d) => [String(d.id), d]))
const pathOf = (row) => {
  const segments = []
  let cur = row
  let guard = 0
  while (cur !== undefined && guard < 64) {
    segments.unshift(slugFromV1Code(cur.code, cur.name))
    cur = cur.parent_id === null || cur.parent_id === undefined ? undefined : byId.get(String(cur.parent_id))
    guard += 1
  }
  return segments.join('/')
}
const directoryRows = directories
  .map((d) => ({
    id: String(d.id),
    path: pathOf(d),
    name: String(d.name ?? ''),
    nameEn: d.name_en === null || d.name_en === undefined ? '' : String(d.name_en),
    type: String(d.type ?? ''),
    v1Code: d.code === null || d.code === undefined ? '' : String(d.code),
    enabled: d.enabled !== false,
  }))
  .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))

// ── ③ 权限清单（唯一真相是 shared/permissions.ts 编译出来的 dist） ────────────
let permissionChecklist
let adminRole
try {
  const shared = require('../dist/shared/permissions.js')
  permissionChecklist = shared.permissionChecklist()
  adminRole = shared.ADMIN_ROLE
} catch (error) {
  fail(
    `读不到权限清单（${error.message}）—— 先跑一次 \`npm run build\`（脚本读的是编译产物，避免再抄一份权限清单）。`,
    4,
  )
}

const accounts = teachers
  .map((t) => {
    const roles = Array.isArray(t.roles) ? t.roles.map(String) : []
    const rawUsername = t.username === null || t.username === undefined ? null : String(t.username)
    /*
      V1 无用户名的账号在迁移时会被写成**停用**占位账号
      （`import-v1.mjs`：`v1-no-username-<id 前 8 位>` + `status: 'inactive'`）。
      决策表要跟**迁移之后**的样子一致，否则业主会看到一条"active 但登不进去"的假信息。
    */
    const username = rawUsername ?? `v1-no-username-${String(t.id).slice(0, 8)}`
    const status = rawUsername === null ? 'inactive（迁移规则：V1 无用户名 → 停用占位）' : String(t.status ?? '')
    const isSuperAdmin = username === SUPERADMIN_USERNAME
    return {
      id: String(t.id),
      username,
      name: String(t.name ?? ''),
      v1Roles: roles,
      status,
      suggestedRole: isSuperAdmin ? adminRole : 'TEACHER',
      /** 迁移刻意不发授权 —— 所以这一栏今天一定是 0。 */
      currentGrants: 0,
      /** 业主在这里填：`[{ permission, directoryId }]`；空数组 = 先不给任何权限。 */
      decision: 'DECISION_REQUIRED',
      grants: [],
      note: isSuperAdmin ? '唯一超级管理员（已确认，不需要再决定身份）' : '',
    }
  })
  .sort((a, b) => a.username.localeCompare(b.username))

// ── ④ 产物 ──────────────────────────────────────────────────────────────────
for (const out of [OUT_MD, OUT_JSON]) {
  if (existsSync(out) && !has('force')) {
    fail(
      `产物已存在，拒绝覆盖：${out}\n` +
        '  （业主在这张表上填过东西 —— 覆盖它等于抹掉一次业务决定。确认要重生成时加 --force。）',
      3,
    )
  }
}
mkdirSync(OUT_DIR, { recursive: true })

const artifact = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  source: { file: SNAPSHOT.replace(`${ROOT}/`, ''), sha256, bytes: bytes.byteLength },
  policy: {
    superAdminUsername: SUPERADMIN_USERNAME,
    adminRole,
    /** 迁移不发授权：初始化必须有人做决定，且**不是**"全开放"。 */
    doNotGrantAllDirectories: true,
    rationale: 'V1 是角色制、V2 是「权限 × 目录」显式授权；导出里没有任何可推导的授权数据（subject_permissions / account_scopes / account_permission_overrides 均为 0 行）。',
  },
  permissionChecklist: permissionChecklist.map((p) => ({ permission: p.permission, label: p.label })),
  directories: directoryRows,
  accounts,
}
writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

const md = []
md.push('# 教师目录授权决策清单（Stage 13C — 业主填写）')
md.push('')
md.push('> **这是一张要人来填的表，不是一次授权动作。** 脚本只读：没有连数据库、没有写 `user_permissions`。')
md.push('> 源文件：`' + artifact.source.file + '`（sha256 `' + sha256.slice(0, 12) + '…`）—— 冻结且校验过的正式迁移文件。')
md.push('')
md.push('## 0. 填之前请先读这三条')
md.push('')
md.push('1. **唯一超级管理员已确认**：`' + SUPERADMIN_USERNAME + '`。这一条不用再决定。')
md.push('2. **不能"为了页面能用"就给所有教师开放全部目录** —— 那等于把 V1 的角色制换成"人人全站可见"，是权限降级。')
md.push('3. **今天所有账号的授权都是 0 条**：迁移刻意不发授权（V2 的授权只有 `user_permissions` 一个真相）。')
md.push('   导出里 `subject_permissions` / `account_scopes` / `account_permission_overrides` 都是 **0 行**，所以没有任何可推导的映射。')
md.push('')
md.push('## 1. 账号（' + accounts.length + ' 个）—— 请在「开放目录」一栏填写')
md.push('')
md.push('| 账号 | 姓名 | V1 角色 | 建议身份 | 状态 | 现有授权 | 开放目录（**请填写**） |')
md.push('|---|---|---|---|---|---|---|')
for (const a of accounts) {
  const roles = a.v1Roles.length === 0 ? '(无)' : a.v1Roles.join('、')
  const decision = a.suggestedRole === adminRole ? '—（唯一的超级管理员）' : '**DECISION_REQUIRED**'
  md.push(`| ${a.username} | ${a.name} | ${roles} | ${a.suggestedRole} | ${a.status} | ${a.currentGrants} 条 | ${decision} |`)
}
md.push('')
md.push('> 填写方式建议：写**目录中文名**（或第 2 节的路径），例如 `教育教学 / Pre-K / 美德 / 教学资源`；')
md.push('> 一行多个目录用 `；` 分隔。若某位老师暂时不给任何权限，请明确写「暂不开放」。')
md.push('')
md.push('## 2. 目录（' + directoryRows.length + ' 个，V2 路径 = 正式环境侧边栏里的位置）')
md.push('')
md.push('| V2 路径 | 中文名 | 英文名 | 类型 | V1 code |')
md.push('|---|---|---|---|---|')
for (const d of directoryRows) {
  md.push(`| \`${d.path}\` | ${d.name} | ${d.nameEn} | ${d.type} | \`${d.v1Code}\` |`)
}
md.push('')
md.push('## 3. 可授予的权限码（' + permissionChecklist.length + ' 个）')
md.push('')
md.push('| 权限码 | 中文 |')
md.push('|---|---|')
for (const p of permissionChecklist) md.push(`| \`${p.permission}\` | ${p.label} |`)
md.push('')
md.push('> 「管理教师」（`user.manage`）**不在**这张表里：它由身份自带，不对外授予。')
md.push('')
md.push('## 4. 填完之后怎么执行（只在界面上做）')
md.push('')
md.push('1. 业主把这张表填好（或直接在 `production-grant-decision-sheet.json` 的每个账号里填 `grants`）；')
md.push('2. 管理员登录**正式环境** → 「权限管理」（`/admin/permissions`）→ 按账号勾选「权限 + 目录」；')
md.push('3. 初始化后，用**真实账号**各登录一次（至少 1 个管理员 + 1 个教师），把结果记回 `docs/PRODUCTION_PERMISSION_MATRIX.md` §3；')
md.push('4. 全部完成前，`docs/PRODUCTION_PERMISSION_MATRIX.md` 里"教师目录授权"保持 `BLOCKED`。')
md.push('')
writeFileSync(OUT_MD, `${md.join('\n')}\n`, 'utf8')

console.log('只读决策清单已生成（**没有连数据库、没有写任何授权**）')
console.log(`  源：${artifact.source.file}  sha256 ${sha256.slice(0, 12)}…`)
console.log(`  账号：${accounts.length} 个（当前授权合计 0 条）`)
console.log(`  目录：${directoryRows.length} 个`)
console.log(`  可授予权限：${permissionChecklist.length} 个`)
console.log(`  已写入：${OUT_MD.replace(`${ROOT}/`, '')}`)
console.log(`  已写入：${OUT_JSON.replace(`${ROOT}/`, '')}`)
console.log('  ⚠ 未决定之前，矩阵里的"教师目录授权"保持 BLOCKED；不要给所有教师开放全部目录。')
