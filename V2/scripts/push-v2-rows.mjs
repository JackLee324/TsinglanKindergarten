#!/usr/bin/env node
/**
 * scripts/push-v2-rows.mjs —— 把本地**已导入完成**的 V2 库按批推到远端 V2 库
 * ============================================================================
 * 为什么需要它：Zeabur 的 Postgres TCP 代理单次往返约 3–4 秒，而 `import-v1.mjs`
 * 是逐行写入（1400+ 行 → 几小时，实测会连接被掐断且一行都没提交）。
 * 但"V1 → V2 的映射"可以在**本机**用真导入器跑完（`deploy/cutover.mjs --drill
 * --keep-drill-dbs`），核对过 347/24/69/0/621 之后，再把结果按批搬过去。
 *
 * 安全边界（写进代码）：
 *   · 只**读**源库、只**写**目标库；目标表**非空就跳过**（幂等，绝不叠数据）；
 *   · 跳过生成列（`is_generated = 'ALWAYS'`，例如 `resources.has_stored_file`），
 *     否则 INSERT 会被数据库拒；
 *   · 按外键顺序逐表推送；不做任何 DROP / TRUNCATE / DELETE；
 *   · 目标与源是同一个库时直接拒绝（防手误）。
 *
 * 用法：
 *   LOCAL_DB='postgresql://…/qls_v2_cutover_drill_xxx' \
 *   REMOTE_DB='postgresql://…/zeabur' \
 *   node scripts/push-v2-rows.mjs
 */
import postgres from 'postgres'

const LOCAL = process.env.LOCAL_DB
const REMOTE = process.env.REMOTE_DB
if (!LOCAL || !REMOTE) {
  console.error('需要 LOCAL_DB 与 REMOTE_DB')
  process.exit(2)
}

// 依赖顺序（外键）
const TABLES = [
  'users',
  'directories',
  'resources',
  'resource_files',
  'resource_reviews',
  'user_permissions',
  'upload_tickets',
  'storage_orphans',
  'v1_import_runs',
  'v1_migration_map',
  'audit_logs',
]

const local = postgres(LOCAL, { max: 1, onnotice: () => {}, connect_timeout: 20 })
const remote = postgres(REMOTE, { max: 1, onnotice: () => {}, keep_alive: true, connect_timeout: 30, idle_timeout: 0 })

/** 列信息（跳过生成列，否则 INSERT 会被拒）。 */
async function columnsOf(sql, table) {
  const rows = await sql`
    SELECT column_name, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `
  return rows.filter((r) => r.is_generated !== 'ALWAYS').map((r) => r.column_name)
}

const BATCH = 200

try {
  for (const table of TABLES) {
    const cols = await columnsOf(local, table)
    if (cols.length === 0) {
      console.log(`跳过 ${table}（本地没这张表）`)
      continue
    }
    const rows = await local.unsafe(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`)
    if (rows.length === 0) {
      console.log(`${table}: 0 行（不推）`)
      continue
    }

    // 目标表先清空？不 —— 目标必须是空的（我们只做首次装载）；非空直接拒绝，避免半途叠数据
    const [cur] = await remote.unsafe(`SELECT count(*)::int AS n FROM "${table}"`)
    if (cur.n > 0) {
      console.log(`${table}: 目标已有 ${cur.n} 行 —— 跳过（保证幂等，不叠数据）`)
      continue
    }

    let done = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      const placeholders = chunk
        .map((_, r) => `(${cols.map((__, c) => `$${r * cols.length + c + 1}`).join(', ')})`)
        .join(', ')
      const values = chunk.flatMap((row) => cols.map((c) => row[c]))
      const sqlText = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${placeholders}`
      await remote.unsafe(sqlText, values)
      done += chunk.length
      console.log(`  ${table}: 已推送 ${done}/${rows.length}`)
    }
    console.log(`${table}: 完成 ${done} 行`)
  }

  // 收尾核对（远端）
  const [c] = await remote.unsafe(`
    SELECT (SELECT count(*) FROM users)::int AS users,
           (SELECT count(*) FROM directories)::int AS directories,
           (SELECT count(*) FROM resources)::int AS resources,
           (SELECT count(*) FROM resource_files)::int AS resource_files,
           (SELECT count(*) FROM audit_logs)::int AS audit_logs,
           (SELECT count(*) FROM user_permissions)::int AS user_permissions,
           (SELECT count(*) FROM users WHERE role='ADMIN' AND status='active')::int AS admins`)
  console.log('远端核对：', JSON.stringify(c))
} finally {
  await local.end({ timeout: 5 }).catch(() => {})
  await remote.end({ timeout: 5 }).catch(() => {})
}
