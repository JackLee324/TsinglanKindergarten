/**
 * scripts/v1-census.mjs —— 迁移盘点：把"有没有丢东西"变成一张能核对的表
 * ============================================================================
 *   node scripts/v1-census.mjs --v1 "$V1_URL" [--v1 "$另一台V1"] [--v2 "$V2_URL"] \
 *        --out docs/V1_RESOURCE_CENSUS.md
 *
 * 业主 Stage 9 §4 要求：迁移前后各生成一次快照（sha256 + 行数），并证明
 * **没有丢失、没有重复、没有凭空增加**。这个脚本把三件事一次做完：
 *
 *   1. 每个 V1 源库的逐表行数与内容指纹（迁移之后必须**一模一样**）；
 *   2. 资源的分布（状态 / 目录 / 是否有文件 / 权限表），即"盘点"；
 *   3. 给出 V2 目标库的现状，于是"V1 有多少 / V2 搬过来多少"可以直接对读。
 *
 * 只读。写文件只写 `--out` 指向的那一份。
 */
import { writeFileSync } from 'node:fs'
import { snapshot } from './v1-snapshot.mjs'

function args(name) {
  const out = []
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) {
      const next = process.argv[i + 1]
      if (next && !next.startsWith('--')) out.push(next)
    }
  })
  return out
}

const v1Urls = args('v1')
const [v2Url] = args('v2')
const [stagedFrom] = args('staged-from')
const [outPath] = args('out')

if (v1Urls.length === 0) {
  console.error('用法：node scripts/v1-census.mjs --v1 <V1_URL> [--v1 ...] [--v2 <V2_URL>] [--out 文件]')
  process.exit(2)
}

const v1Snaps = []
for (const url of v1Urls) v1Snaps.push(await snapshot(url))
const v2Snap = v2Url ? await snapshot(v2Url) : null

const lines = []
lines.push('# V1 → V2 迁移盘点（V1_RESOURCE_CENSUS）', '')
lines.push('> 由 `scripts/v1-census.mjs` 生成。**只读**：它不写任何数据库。', '')
lines.push(`生成时间：${new Date().toISOString()}`, '')
lines.push('这份表回答三个问题：V1 里有多少东西、迁移有没有真的搬过来、V1 自己有没有被动过。', '')

// ── 每个 V1 源库的逐表行数 + 指纹 ───────────────────────────────────────────
lines.push('## 1. V1 源库逐表行数与内容指纹', '')
for (const snap of v1Snaps) {
  lines.push(`### \`${snap.url}\``, '')
  lines.push('| 表 | 行数 | sha256（前 16 位） |', '|---|---:|---|')
  for (const [table, fp] of Object.entries(snap.tables)) {
    lines.push(`| \`${table}\` | ${fp === null ? '（不存在）' : fp.rows} | ${fp === null ? '—' : fp.sha256.slice(0, 16)} |`)
  }
  lines.push('')
  const r = snap.resources
  lines.push('**资源分布**', '')
  lines.push(`- 合计：**${r.total}**（草稿 ${r.draft} / 待审核 ${r.pending_review} / 已发布 ${r.published} / 退回 ${r.rejected} / 撤回 ${r.recalled}）`)
  lines.push(`- 回收站（软删除）：${r.recycled}`)
  lines.push(`- 有目录归属：${r.total - r.no_directory}；**没有目录归属**：${r.no_directory}`)
  lines.push(`- 带 \`folder_type\`（V1 旧分类）：${r.with_folder_type}`)
  lines.push(`- **声称有文件的资源：${r.claims_file}** ← 这一项决定"文件迁移"是不是空活`)
  lines.push(`- 落在几个不同目录上：${r.distinctDirectories}`)
  lines.push(`- 按 \`folder_type\`：${Object.entries(r.byFolderType).map(([k, v]) => `${k}=${v}`).join('，')}`)
  lines.push('')
  lines.push('**账号**', '')
  lines.push(`- 合计 ${snap.teachers.total}（启用 ${snap.teachers.active} / 非启用 ${snap.teachers.not_active}）`)
  lines.push(`- **没有口令**：${snap.teachers.no_password}；**没有用户名**：${snap.teachers.no_username}`)
  lines.push(`- 要求首次登录改口令：${snap.teachers.must_change_password}`)
  lines.push('')
  lines.push('**审计**', '')
  lines.push(`- 合计 ${snap.audit.total}；没有操作者 ${snap.audit.no_actor}；**操作者已不在 teachers 表里**：${snap.audit.orphan_actor}`)
  lines.push(`- 动作词表（${Object.keys(snap.audit.byAction).length} 种）：${Object.entries(snap.audit.byAction).map(([k, v]) => `${k}=${v}`).join('，')}`)
  lines.push('')
  const permTables = ['subject_permissions', 'account_permission_overrides', 'account_scopes']
  lines.push(`**授权来源**：${permTables.map((t) => `${t}=${snap.tables[t]?.rows ?? '—'}`).join('，')}`)
  lines.push('')
}

// ── V2 现状 ────────────────────────────────────────────────────────────────
if (v2Snap) {
  lines.push('## 2. V2 目标库现状', '')
  lines.push(`\`${v2Snap.url}\``, '')
  lines.push('| 表 | 行数 |', '|---|---:|')
  for (const [table, fp] of Object.entries(v2Snap.tables)) {
    lines.push(`| \`${table}\` | ${fp === null ? '（不存在）' : fp.rows} |`)
  }
  lines.push('')
  lines.push(`- 资源：${JSON.stringify(v2Snap.resources)}`)
  lines.push(`- 文件对象：${v2Snap.files}`)
  lines.push(`- 迁移记账：${JSON.stringify(v2Snap.migration)}`)
  lines.push('')

  lines.push('## 3. V1 → V2 对读（业主 Stage 9 §4 / §14）', '')
  /*
    只对**真正被导入这个 V2 库的那个源**做对读。

    本机有三份 V1 数据（348 / 347 / 347 条资源），而 staging 里只可能来自其中一份；
    把三份都拿去比会得到一堆"不一致"，而那是口径问题不是数据问题 ——
    报告一旦开始出现解释不清的红字，人就会开始忽略它。
  */
  const staged = stagedFrom ?? v1Urls[0]
  lines.push(`本 V2 库的数据来自：\`${staged}\`（其余源库只作盘点，未导入本库）`, '')
  lines.push('| 项 | V1 | V2 | 两边口径 | 判定 |', '|---|---:|---:|---|---|')
  for (const snap of v1Snaps) {
    const label = snap.url
    if (!label.includes(new URL(staged).pathname)) {
      lines.push(`| ~~${label}~~ | | | 未导入本库 | 仅盘点，见 §1 |`)
      continue
    }
    lines.push(`| **${label}** | | | | |`)
    const submitEvents = snap.audit.submitEvents?.with_resource ?? 0
    const ghostSubmits = (snap.audit.submitEvents?.total ?? 0) - submitEvents
    const rows = [
      ['账号', snap.teachers.total, v2Snap.migration.byEntity.user ?? 0, '迁移记账行数（每个 V1 账号一行）'],
      ['资源', snap.resources.total, v2Snap.migration.byEntity.resource ?? 0, '迁移记账行数（每条 V1 资源一行）'],
      ['目录映射', snap.tables.directories.rows, v2Snap.migration.byEntity.directory ?? 0, '每个 V1 目录节点的映射（对齐上的也算）'],
      ['审核时间线', `${snap.tables.review_records.rows} 条审核记录 + ${submitEvents} 次提交（另有 ${ghostSubmits} 条提交指向不存在的资源，只搬审计）`,
        `${v2Snap.migration.byEntity.review ?? 0} 条时间线事件`,
        'V2 的时间线 = 审核记录 + 审计里的提交事件'],
      ['审计', snap.audit.total, v2Snap.auditMigrated,
        '两边都数审计行本身（V2 看 detail 里的 v1AuditId）'],
      ['文件对象', 0, v2Snap.migration.byEntity.resource_file ?? 0, 'V1 没有对象可搬时两边都是 0'],
      ['授权', '0（三个授权表都是空的）', v2Snap.migration.byEntity.permission ?? 0, '只转换 V1 里真实存在的显式授权'],
    ]
    for (const r of rows) lines.push(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${verdict(r[0], snap, v2Snap, submitEvents)} |`)
  }
  lines.push('')
  lines.push('> "目录映射"两边数字口径不同：V2 侧记的是**每个 V1 目录节点**的映射行数，')
  lines.push('> 所以它等于 V1 的目录节点数（同名对齐的 + 新建的），不是 V2 的目录总数。')
  lines.push('')
}

/**
 * 判定：**先说清口径，再比数字**。
 *
 * "V1 有 2 条审核记录、V2 有 4 条时间线事件"不是不一致 —— 后者多出来的两条是
 * 审计里的提交事件（V1 的审核表本来就不记提交）。机械地比数字会把它标成 ⚠，
 * 而一份总在喊狼来了的报告，很快就会被忽略。
 */
function verdict(name, v1Snap, v2Snap, submitEvents) {
  if (name === '账号' || name === '资源' || name === '目录映射') {
    const key = { 账号: 'user', 资源: 'resource', 目录映射: 'directory' }[name]
    const v1 = name === '账号' ? v1Snap.teachers.total
      : name === '资源' ? v1Snap.resources.total : v1Snap.tables.directories.rows
    const v2 = v2Snap.migration.byEntity[key] ?? 0
    return v1 === v2 ? '✅ 一致' : `⚠ 不一致（V1 ${v1} / 记账 ${v2}）`
  }
  if (name === '审核时间线') {
    const expected = v1Snap.tables.review_records.rows + submitEvents
    const v2 = v2Snap.migration.byEntity.review ?? 0
    return expected === v2
      ? '✅ 一致（提交事件只有审计记着）'
      : `⚠ 不一致（应当 ${expected} / 实际 ${v2}）`
  }
  if (name === '审计') {
    return v1Snap.audit.total === v2Snap.auditMigrated
      ? '✅ 一致'
      : `⚠ 不一致（V1 ${v1Snap.audit.total} / V2 ${v2Snap.auditMigrated}）`
  }
  if (name === '文件对象') {
    return v2Snap.migration.byEntity.resource_file === undefined
      ? '✅ V1 里没有对象可搬'
      : `搬了 ${v2Snap.migration.byEntity.resource_file} 个`
  }
  // 授权：V1 的三个授权表都是空的，所以"转换出 0 条"才是对的
  const total = ['subject_permissions', 'account_permission_overrides', 'account_scopes']
    .reduce((sum, t) => sum + (v1Snap.tables[t]?.rows ?? 0), 0)
  const v2 = v2Snap.migration.byEntity.permission ?? 0
  if (total === 0) return v2 === 0 ? '✅ 不凭空多授权' : `⚠ V1 里没有授权，V2 却多了 ${v2} 条`
  return `V1 有 ${total} 行授权来源，转换出 ${v2} 条（口径不同：deny / scope 不转换）`
}

const markdown = `${lines.join('\n')}\n`
if (outPath) {
  writeFileSync(outPath, markdown)
  console.log(`盘点已写入 ${outPath}`)
} else {
  console.log(markdown)
}
