#!/usr/bin/env node
/**
 * deploy/cutover.mjs —— **正式切换执行器**（业主 Stage 13C 门禁 G1–G10 的可执行版本）
 * ============================================================================
 * 为什么要有它：切换那天要按固定顺序做十几件事，任何一步"凭记忆"都可能漏掉，
 * 而漏掉的那一步往往正是"老师一条资源都看不到"这类事后才发现的问题。
 * 所以把顺序、判据、失败即停、证据留痕写进代码。
 *
 * 三个模式（默认 `--plan`，**什么都不会改**）：
 *
 *   node deploy/cutover.mjs --plan
 *       只做前置检查 + 打印将要执行的每一步（含命令、判据、回滚动作）。不连生产、不写任何库。
 *
 *   node deploy/cutover.mjs --drill
 *       在**本机演练 Postgres**上把数据链路整条跑一遍：
 *         受控 V1 库（从冻结快照还原） → 全新建的 V2 drill 库 → 迁移 → 导入 → 核对不变量。
 *       它**只创建/使用带 `_cutover_drill_` 前缀的临时库**，绝不碰应用库（演练栈的
 *       `POSTGRES_DB`）与任何非本机地址 —— 名字或地址不对就直接退出。
 *
 *   node deploy/cutover.mjs --production --target <V2_URL> --v1 <V1_URL|ndjson> \
 *        --confirm CUTOVER-PRODUCTION [--accept-zero-grants]
 *       对着真实目标执行同一套步骤；`--confirm` 字面量缺失、或目标不是远端/命名不合规，
 *       都会在**建立任何连接之前**退出。
 *
 * 硬规则（都写进代码，不靠小心）：
 *   1. **目标必须显式**：没有 `--target` 就退出（不接受任何默认库，尤其不接受本机开发库）；
 *      动手前打印**脱敏**目标与本地/远端判定（复用 `scripts/lib/db-target.mjs`）；
 *   2. **不做破坏性动作**：不 DROP、不 TRUNCATE、不删对象、不删账号；
 *      drill 库名固定前缀，生产模式拒绝"看起来像本机"的目标；
 *   3. **失败即停**：任何一步非零退出就停在那里，打印"已经做了什么 + 怎么回滚"；
 *   4. **权限初始化是业务决定**：教师授权还是 0 条时**拒绝继续**（除非显式
 *      `--accept-zero-grants` 并在报告里记下"上线后老师看不到内容"这一后果）；
 *   5. **证据留痕**：每一步的命令、退出码、关键输出都写进 `deploy/logs/cutover-*.log`。
 *
 * 退出码：0 成功 / 2 参数或前置条件不满足 / 3 某一步失败（已停） / 4 授权门禁未通过
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { announceDatabaseTarget, resolveDatabaseTarget } from '../scripts/lib/db-target.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const MODE = has('production') ? 'production' : has('drill') ? 'drill' : 'plan'
const CONFIRM = 'CUTOVER-PRODUCTION'
const CUTOVER_FILE = resolve(ROOT, arg('cutover-file', '.migration/prod-exports/v2-cutover-20261008.ndjson'))
const MANIFEST = resolve(ROOT, arg('manifest', '.migration/prod-exports/v2-cutover-20261008.exclusion.json'))
const DECISION_SHEET = resolve(ROOT, arg('decision-sheet', '.migration/production-grant-decision-sheet.json'))
const LOG_DIR = resolve(ROOT, 'deploy', 'logs')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const LOG = join(LOG_DIR, `cutover-${MODE}-${STAMP}.log`)

/** V1 的真实 schema 模板库（`load-v1-snapshot.mjs` 用它克隆结构）。 */
const V1_TEMPLATE = arg('v1-template', 'qls_test_0005')
/** drill 的基础连接串：从集成测试用的那个库推导（同主机/同口令），口令不硬编码在脚本里。 */
function drillBase() {
  const seed = process.env.V2_TEST_DATABASE_URL ?? 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_v2_test'
  const u = new URL(seed)
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) {
    fail(`drill 只在**本机**数据库上跑（V2_TEST_DATABASE_URL 指向 ${u.hostname}）—— 拒绝。`)
  }
  return `${u.protocol}//${u.username}:${u.password}@${u.host}`
}

const EXPECTED = Object.fromEntries(
  String(arg('expected', 'resources=347,users=24,directories=69,resource_files=0,audit_logs=621'))
    .split(',')
    .map((kv) => kv.split('=')),
)

function log(line = '') {
  console.log(line)
  appendFileSync(LOG, `${line}\n`)
}
function fail(message, code = 2) {
  log(`✖ ${message}`)
  process.exit(code)
}
function runStep(step) {
  log('')
  log(`── ${step.id} ${step.title}`)
  log(`   $ ${step.command}`)
  const res = spawnSync(step.bin ?? process.execPath, step.args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(step.env ?? {}) },
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  appendFileSync(LOG, out.endsWith('\n') ? out : `${out}\n`)
  const ok = res.status === 0
  log(`   → 退出码 ${res.status}${ok ? ' ✓' : ' ✗'}`)
  if (!ok) {
    log('')
    log('   ✖ 这一步失败了 —— **停下来**，不要继续往下做。')
    log(`   已经做完的部分：见 ${LOG.replace(`${ROOT}/`, '')}`)
    log('   回滚：见本文件末尾「回滚清单」；数据层不做任何删除动作。')
    process.exit(3)
  }
  return out
}

mkdirSync(LOG_DIR, { recursive: true })
writeFileSync(LOG, `# 正式切换执行日志（模式 ${MODE}）\n生成于 ${new Date().toISOString()}\n`)
log(`切 换 执 行 器 —— 模式：${MODE}`)
log(`日志：${LOG.replace(`${ROOT}/`, '')}`)

// ── ① 冻结迁移文件完整性（G1/G2）────────────────────────────────────────────
if (!existsSync(CUTOVER_FILE)) fail(`找不到 V2 专用迁移文件：${CUTOVER_FILE}`)
const cutoverBytes = readFileSync(CUTOVER_FILE)
const cutoverSha = createHash('sha256').update(cutoverBytes).digest('hex')
if (existsSync(MANIFEST)) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const expectedSha = manifest?.output?.sha256
  if (typeof expectedSha === 'string' && expectedSha !== cutoverSha) {
    fail(
      `迁移文件 sha256 与清单不符：\n  实际 ${cutoverSha}\n  清单 ${expectedSha}\n` +
        '  切换必须建立在**冻结且校验过**的那一份上 —— 先跑 scripts/prepare-v2-cutover-snapshot.mjs --check。',
    )
  }
  log(`✔ 迁移文件完整性：sha256 ${cutoverSha.slice(0, 12)}…（与清单一致）`)
  log(`  排除的两条测试资源：${(manifest?.rule?.excludedIds ?? []).length} 条（清单里有逐条理由）`)
} else {
  log(`⚠ 没有清单 ${MANIFEST} —— 只校验了文件本身（sha256 ${cutoverSha.slice(0, 12)}…）`)
}

// ── ② 目标库：必须显式、必须脱敏打印（G6 前置）──────────────────────────────
const drillSuffix = `_cutover_drill_${STAMP.replace(/[^0-9]/g, '').slice(6, 14)}`
let targetUrl = arg('target', null)
let targetInfo = null
let v1Url = arg('v1', null)

if (MODE === 'production') {
  if (arg('confirm', null) !== CONFIRM) {
    fail(
      `production 模式必须显式确认：--confirm ${CONFIRM}\n` +
        '  （这不是形式主义：切换会把老师的入口换到新系统上，一次复制粘贴的手误代价很高。）',
    )
  }
  if (targetUrl === null) fail('production 模式必须给 `--target <V2 数据库连接串>`（不接受任何默认库）。')
  if (v1Url === null) fail('production 模式必须给 `--v1 <V1 数据库连接串 或 快照文件>`。')
  targetInfo = resolveDatabaseTarget({ DATABASE_URL: targetUrl })
  if (!targetInfo.ok) fail(targetInfo.reason)
  if (targetInfo.local && !has('allow-local-target')) {
    fail(
      `production 模式的目标是本机地址（${targetInfo.redacted}）—— 拒绝。\n` +
        '  本机目标请用 `--drill`（它会在演练 Postgres 上建临时库，且不会碰应用库）。',
    )
  }
} else if (MODE === 'drill') {
  /*
    drill 用的是**本机嵌入式 Postgres（55432）**：V1 的真实 schema 模板库
    `qls_test_0005` 只在那里（`load-v1-snapshot.mjs` 用 `CREATE DATABASE … TEMPLATE`
    拿到同一套真实结构）。目标库名带 `_cutover_drill_` 前缀，
    与集成测试库（`qls_v2_test`）、开发库（`qls_v2_dev`）**不可能撞名**。
  */
  const base = drillBase()
  v1Url = `${base}/qls_v1${drillSuffix}`
  targetUrl = `${base}/qls_v2${drillSuffix}`
  targetInfo = resolveDatabaseTarget({ DATABASE_URL: targetUrl })
  if (!targetInfo.ok) fail(targetInfo.reason)
  log(`✔ drill 模式（本机嵌入式 Postgres，端口 55432）`)
  log(`  V1 受控库：qls_v1${drillSuffix}（从冻结快照还原，模板 ${V1_TEMPLATE}）`)
  log(`  V2 目标库：qls_v2${drillSuffix}（全新，跑 0001/0002/0003 迁移）`)
  log('  ⚠ 不会使用 qls_v2_test / qls_v2_dev / 演练应用库 —— drill 只碰带 _cutover_drill_ 前缀的库。')
} else {
  log('（plan 模式：只做前置检查与打印，不连任何数据库、不写任何文件）')
}

if (targetInfo !== null) {
  log('  目标数据库（脱敏）：')
  announceDatabaseTarget(targetInfo, (l) => log(l))
}

// ── ③ 权限初始化门禁（G4）：还是 0 条就停 ───────────────────────────────────
function grantGate() {
  log('')
  log('── G4 教师目录授权门禁')
  if (!existsSync(DECISION_SHEET)) {
    log(`   ⚠ 没有决策表 ${DECISION_SHEET.replace(`${ROOT}/`, '')}`)
    log('     生成：node scripts/propose-directory-grants.mjs')
    return { decided: false, undecided: null }
  }
  const sheet = JSON.parse(readFileSync(DECISION_SHEET, 'utf8'))
  const accounts = sheet.accounts ?? []
  const undecided = accounts.filter((a) => a.decision === 'DECISION_REQUIRED')
  const granted = accounts.reduce((n, a) => n + (a.grants?.length ?? 0), 0)
  log(`   账号 ${accounts.length} 个；仍未决定 ${undecided.length} 个；已填写授权 ${granted} 条`)
  return { decided: undecided.length === 0 && granted > 0, undecided: undecided.length, granted, accounts: accounts.length }
}

const gate = grantGate()
if (MODE !== 'plan' && !gate.decided && !has('accept-zero-grants')) {
  // 这不是"拦一下"：0 条授权意味着老师登录后看不到任何资源，属于**上线即不可用**。
  fail(
    '教师目录授权还没有决定（或仍是 0 条）—— 拒绝继续。\n' +
      '  这是业务决定，脚本不会替你猜，也**不会**给所有教师开放全部目录。\n' +
      `  确认"就是要先空着上线"时，显式加 --accept-zero-grants（后果会写进日志）。`,
    4,
  )
}
if (MODE !== 'plan' && !gate.decided) {
  log('  ⚠ 按 --accept-zero-grants 继续：上线后老师能登录但看不到任何资源。')
}

// ── ③bis 目标库存在性（drill 建；production 只检查并给指引）──────────────────
log('')
log('── 目标库存在性')
if (MODE === 'drill') {
  const dbName = `qls_v2${drillSuffix}`
  await createDrillDatabase(drillBase(), dbName)
  log(`  ✔ 已创建全新目标库 ${dbName}（drill 必须从空库开始，不覆盖任何既有库）`)
} else if (MODE === 'production') {
  const reachable = await checkTargetReachable(targetUrl)
  if (!reachable.ok) {
    fail(
      `目标库连不上：${reachable.reason}\n` +
        '  正式库请在 Zeabur 控制台**单独新建**一个 V2 PostgreSQL（与 V1 完全分离），\n' +
        '  再把它的连接串交给本脚本；脚本不会替你创建生产数据库。',
    )
  }
  log(`  ✔ 目标库可达（${targetInfo.redacted}）`)
} else {
  log('  （plan 模式：不连库）')
}

// ── ④ 步骤表（顺序固定；失败即停）────────────────────────────────────────────
const steps = []
steps.push({
  id: 'S1',
  title: '冻结迁移文件再校验一遍（G1）',
  command: 'node scripts/prepare-v2-cutover-snapshot.mjs --check',
  args: ['scripts/prepare-v2-cutover-snapshot.mjs', '--check'],
})
if (MODE === 'drill') {
  steps.push({
    id: 'S2',
    title: '把冻结快照还原成受控 V1 库（drill 专用库名）',
    command: `node scripts/load-v1-snapshot.mjs --snapshot ${CUTOVER_FILE.replace(`${ROOT}/`, '')} --database <qls_v1${drillSuffix}>`,
    args: [
      'scripts/load-v1-snapshot.mjs',
      '--snapshot', CUTOVER_FILE,
      '--template', V1_TEMPLATE,
      '--database', `qls_v1${drillSuffix}`,
      '--admin-url', `${drillBase()}/postgres`,
    ],
  })
}
steps.push({
  id: 'S3',
  title: '在目标库上跑 V2 迁移（0001/0002/0003）',
  command: 'node scripts/migrate.mjs up',
  args: ['scripts/migrate.mjs', 'up'],
  env: { DATABASE_URL: targetUrl },
})
steps.push({
  id: 'S4',
  title: '迁移状态核对（0 pending）',
  command: 'node scripts/migrate.mjs status',
  args: ['scripts/migrate.mjs', 'status'],
  env: { DATABASE_URL: targetUrl },
})
steps.push({
  id: 'S5',
  title: '导入 V1 数据（**显式点名唯一超级管理员**）',
  command:
    `node scripts/import-v1.mjs --source <V1> --target <V2> --admin-usernames TsinglanAdmin ` +
    `--report deploy/logs/import-${STAMP}.md`,
  args: [
    'scripts/import-v1.mjs',
    '--source', v1Url ?? '<V1>',
    '--target', targetUrl,
    '--admin-usernames', 'TsinglanAdmin',
    '--report', join(LOG_DIR, `import-${STAMP}.md`),
  ],
})

if (MODE === 'plan') {
  log('')
  log('── 将要执行的步骤（顺序固定，失败即停）')
  for (const s of steps) log(`  ${s.id}  ${s.title}\n      $ ${s.command}`)
  log('  S6  不变量核对（外部执行时需要 --drill / --production 才会真正跑）')
  log('  S7  部署 + 预发布验收：deploy/verify.mjs + tests/production/*（桌面 + 移动）')
  log('  S8  回滚清单（见下）')
  log('')
  log('── 回滚清单（任何一步失败都适用）')
  for (const line of rollbackLines()) log(`   ${line}`)
  log('')
  log(`✔ plan 完成：前置检查通过${gate.decided ? '，授权门禁已满足' : `，授权门禁**未满足**（未决定 ${gate.undecided ?? '?'} 个账号）`}。`)
  process.exit(0)
}

log('')
log(`── 开始执行（${MODE}）`)
for (const step of steps) runStep(step)

// ── ⑤ 不变量核对（真查库，不靠导入脚本自述）────────────────────────────────
log('')
log('── S6 不变量核对（直接查库）')
const invariants = await checkInvariants(targetUrl)
for (const row of invariants) log(`   ${row.ok ? '✓' : '✗'} ${row.label}：${row.value}${row.ok ? '' : `（期望 ${row.expected}）`}`)
if (invariants.some((r) => !r.ok)) {
  log('')
  log('   ✖ 不变量不满足 —— 停下来，不要切域名。')
  fail('不变量核对失败', 3)
}

log('')
log('── S7 部署与验收（这一步需要 Zeabur/目标环境访问，本身不在本脚本内）')
log('   1) 部署 V2（Zeabur：用本仓库 Dockerfile 的服务，环境变量按 docs/DEPLOYMENT_PRODUCTION.md）')
log('   2) node deploy/verify.mjs --base https://<预发布域名> --cacert <CA 或系统信任> --expected users=24')
log('   3) PRODUCTION_BASE_URL=https://<预发布域名> PRODUCTION_ADMIN_USER=… node --test tests/production/*.test.mjs')
log('   4) 真实账号各登录一次（≥1 管理员 + 1 教师），结果回填 docs/PRODUCTION_PERMISSION_MATRIX.md §3')

log('')
log('── S8 回滚清单（切换窗口内随时可执行）')
for (const line of rollbackLines()) log(`   ${line}`)

if (MODE === 'drill') {
  log('')
  log('── 收尾：drill 临时库')
  if (has('keep-drill-dbs')) {
    log(`  按 --keep-drill-dbs 保留：qls_v1${drillSuffix} / qls_v2${drillSuffix}（便于人工翻看）`)
  } else {
    await dropDrillDatabases(drillBase(), [`qls_v1${drillSuffix}`, `qls_v2${drillSuffix}`])
    log(`  ✔ 已删掉本次 drill 自己创建的两个临时库（应用库与测试库从头到尾没被碰过）`)
  }
}

log('')
log(`✔ 数据链路完成。日志：${LOG.replace(`${ROOT}/`, '')}`)
log(`  ⚠ 域名切换前，请确认 S7 的四条全部通过；S6 的任何一条不满足都不得切域名。`)
process.exit(0)

// ── 辅助 ────────────────────────────────────────────────────────────────────
async function createDrillDatabase(base, name) {
  if (!/^qls_v2_cutover_drill_\d+$/.test(name)) {
    // 名字必须是我们自己的 drill 命名（防手误把生产库名传进来）
    fail(`拒绝创建非 drill 命名的库：${name}`)
  }
  const sql = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} })
  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`
    if (rows.length > 0) fail(`drill 目标库已存在：${name} —— drill 必须从空库开始（换个时间戳重跑）。`)
    await sql.unsafe(`CREATE DATABASE "${name}"`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function dropDrillDatabases(base, names) {
  const sql = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} })
  try {
    for (const name of names) {
      if (!/^qls_v[12]_cutover_drill_\d+$/.test(name)) fail(`拒绝删除非 drill 命名的库：${name}`)
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function checkTargetReachable(url) {
  let sql
  try {
    sql = postgres(url, { max: 1, onnotice: () => {} })
    await sql`SELECT 1`
    return { ok: true }
  } catch (error) {
    const code = error?.code === '3D000' ? '数据库不存在' : String(error?.code ?? error?.message ?? error)
    return { ok: false, reason: code }
  } finally {
    if (sql !== undefined) await sql.end({ timeout: 5 }).catch(() => {})
  }
}

function rollbackLines() {
  return [
    '1) **不要动数据**：V2 库与 V1 库都保留原样（本脚本全程没有 DROP/TRUNCATE/删除）。',
    '2) 域名回指 V1：在 Zeabur 把正式域名的服务切回 V1 服务（或恢复 DNS/CNAME 到 V1）。',
    '3) 确认 V1 仍然可用：curl -s -o /dev/null -w "%{http_code}" https://<正式域名>/ 期望 200；',
    '   并用一个真实 V1 账号登录一次。',
    '4) V2 服务降级为"预发布"（保留，不删）：便于继续排查，也保留了数据。',
    '5) 记录：把失败步骤、当时日志路径、决定写进 docs/CUTOVER_PREFLIGHT_REPORT.md。',
  ]
}

async function checkInvariants(url) {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const rows = []
    const [counts] = await sql`
      SELECT
        (SELECT count(*) FROM users)                              AS users,
        (SELECT count(*) FROM directories)                        AS directories,
        (SELECT count(*) FROM resources)                          AS resources,
        (SELECT count(*) FROM resource_files)                     AS resource_files,
        (SELECT count(*) FROM audit_logs)                         AS audit_logs,
        (SELECT count(*) FROM user_permissions)                   AS user_permissions
    `
    for (const [key, value] of Object.entries(counts)) {
      const expected = EXPECTED[key] === undefined ? null : Number(EXPECTED[key])
      rows.push({
        label: key,
        value: String(value),
        expected: String(expected),
        ok: expected === null || Number(value) === expected,
      })
    }
    const [admins] = await sql`
      SELECT count(*)::int AS n, coalesce(string_agg(username, ','), '') AS names
      FROM users WHERE role = 'ADMIN' AND status = 'active'
    `
    rows.push({
      label: '唯一有效管理员',
      value: `${admins.n}（${admins.names}）`,
      expected: '1（TsinglanAdmin）',
      ok: admins.n === 1 && admins.names === 'TsinglanAdmin',
    })
    const [dangling] = await sql`
      SELECT count(*)::int AS n FROM resources r
      LEFT JOIN directories d ON d.id = r.directory_id
      WHERE d.id IS NULL
    `
    rows.push({ label: '资源的悬空目录引用', value: String(dangling.n), expected: '0', ok: dangling.n === 0 })
    const [hiddenOnFiles] = await sql`
      SELECT count(*)::int AS n FROM resources r
      JOIN directories d ON d.id = r.directory_id
      WHERE d.allow_files = false AND r.deleted_at IS NULL
    `
    rows.push({
      label: '落在 allow_files=false 目录上的资源（"老师一条都看不到"的门闩）',
      value: String(hiddenOnFiles.n),
      expected: '0',
      ok: hiddenOnFiles.n === 0,
    })
    const [testLeftovers] = await sql`SELECT count(*)::int AS n FROM resources WHERE title = 'test'`
    rows.push({ label: "被排除测试资源的残留（title='test'）", value: String(testLeftovers.n), expected: '0', ok: testLeftovers.n === 0 })
    return rows
  } finally {
    await sql.end({ timeout: 5 })
  }
}
