/**
 * scripts/v1-snapshot.mjs —— 迁移前后快照（只读）
 * ============================================================================
 *   node scripts/v1-snapshot.mjs --url "$DB_URL" --out .migration/v1-before.json
 *   node scripts/v1-snapshot.mjs --url "$DB_URL" --out v1-after.json --markdown
 *
 * 它回答的问题是"到底有没有丢东西"，而这个问题只有**能对上的数字**才算回答：
 *
 *   · 每张表的行数；
 *   · 每张表的**内容指纹**（按主键排序后逐行规范化再 sha256）——
 *     行数一样但内容被改过，是行数发现不了的；
 *   · V1 特有的分布：资源状态 / 目录归属 / 是否有文件 / 权限表 / 审计动作词表。
 *
 * 只读：整个脚本没有任何写语句，连接上还会设置 `default_transaction_read_only`。
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import postgres from 'postgres'

/** V1 的 13 张表（阶段 0 盘点过；多出来的是别人加的）。 */
export const V1_TABLES = [
  'teachers',
  'sessions',
  'audit_logs',
  'review_records',
  'resources',
  'subject_permissions',
  'account_permission_overrides',
  'account_scopes',
  'teacher_mfa',
  'mfa_recovery_codes',
  'mfa_challenges',
  'directories',
  'resource_versions',
]

/** V2 的业务表（记账表在最后，它们的存在本身就是证据）。 */
export const V2_TABLES = [
  'users',
  'sessions',
  'directories',
  'user_permissions',
  'resources',
  'resource_files',
  'resource_reviews',
  'audit_logs',
  'upload_tickets',
  'storage_orphans',
  'v1_import_runs',
  'v1_migration_map',
]

/**
 * 一行的规范化文本。
 *
 * 键排序 + 值转字符串：PostgreSQL 返回的顺序不稳定（尤其是 `SELECT *`），
 * 不排序会让"内容没变"的两行算出不同的指纹。
 */
export function canonicalRow(row) {
  const keys = Object.keys(row).sort()
  return keys
    .map((k) => {
      const v = row[k]
      if (v === null || v === undefined) return `${k}=\u0000`
      if (v instanceof Date) return `${k}=${v.toISOString()}`
      if (Buffer.isBuffer(v)) return `${k}=${v.toString('base64')}`
      if (typeof v === 'object') return `${k}=${stableJson(v)}`
      return `${k}=${String(v)}`
    })
    .join('\u0001')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function hashRows(rows) {
  const h = createHash('sha256')
  for (const row of rows) h.update(canonicalRow(row)).update('\n')
  return h.digest('hex')
}

async function primaryKeyOf(sql, table) {
  const rows = await sql`
    SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = ${table}::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`
  return rows.map((r) => r.name)
}

/**
 * 一张表的行数与内容指纹。没有主键的表按全部列排序（少见，但绝不静默跳过）。
 */
export async function tableFingerprint(sql, table) {
  const [exists] = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}`
  if (exists.n === 0) return null

  const pk = await primaryKeyOf(sql, table)
  const order = pk.length > 0 ? sql(pk) : null
  const rows = order
    ? await sql`SELECT * FROM ${sql(table)} ORDER BY ${order}`
    : await sql`SELECT * FROM ${sql(table)} ORDER BY 1`
  return { rows: rows.length, sha256: hashRows(rows) }
}

export async function snapshotV1(sql) {
  const tables = {}
  for (const table of V1_TABLES) tables[table] = await tableFingerprint(sql, table)

  const [resources] = await sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'draft')::int          AS draft,
      count(*) FILTER (WHERE status = 'pending_review')::int AS pending_review,
      count(*) FILTER (WHERE status = 'published')::int      AS published,
      count(*) FILTER (WHERE status = 'rejected')::int       AS rejected,
      count(*) FILTER (WHERE status = 'recalled')::int       AS recalled,
      count(*) FILTER (WHERE deleted_at IS NOT NULL)::int    AS recycled,
      count(*) FILTER (WHERE directory_id IS NULL)::int      AS no_directory,
      count(*) FILTER (WHERE folder_type IS NOT NULL)::int   AS with_folder_type,
      count(*) FILTER (WHERE file_path IS NOT NULL OR file_bucket_id IS NOT NULL
                        OR file_name IS NOT NULL OR coalesce(file_size, 0) > 0)::int AS claims_file
    FROM resources`

  const statuses = {}
  for (const r of await sql`SELECT status, count(*)::int AS n FROM resources GROUP BY 1 ORDER BY 1`) {
    statuses[r.status] = r.n
  }
  const folderTypes = {}
  for (const r of await sql`SELECT folder_type, count(*)::int AS n FROM resources GROUP BY 1 ORDER BY 1`) {
    folderTypes[r.folder_type] = r.n
  }
  const auditActions = {}
  for (const r of await sql`SELECT action, count(*)::int AS n FROM audit_logs GROUP BY 1 ORDER BY 1`) {
    auditActions[r.action] = r.n
  }
  const [audit] = await sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE teacher_id IS NULL)::int AS no_actor,
      count(*) FILTER (WHERE teacher_id IS NOT NULL
                        AND teacher_id NOT IN (SELECT id FROM teachers))::int AS orphan_actor
    FROM audit_logs`
  /*
    提交事件有两种：**真的指向一条存在的资源**，以及当年造数据留下的、
    指向不存在资源的行。后者照原样搬进审计（一条不丢），但不会成为审核时间线，
    所以盘点上必须把两者分开数 —— 否则"应当 33 条、实际 4 条"会看着像丢了 29 条审核。
  */
  const [submits] = await sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE resource_id IS NOT NULL
                        AND resource_id IN (SELECT id FROM resources))::int AS with_resource
    FROM audit_logs WHERE action = 'resource_submit_review'`

  const [teachers] = await sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'active')::int AS active,
      count(*) FILTER (WHERE status <> 'active')::int AS not_active,
      count(*) FILTER (WHERE password_hash IS NULL)::int AS no_password,
      count(*) FILTER (WHERE username IS NULL OR btrim(username) = '')::int AS no_username,
      count(*) FILTER (WHERE must_change_password IS TRUE)::int AS must_change_password
    FROM teachers`

  const [byDirectory] = await sql`
    SELECT count(DISTINCT directory_id)::int AS directories FROM resources WHERE directory_id IS NOT NULL`

  return {
    kind: 'v1',
    tables,
    resources: { ...resources, byStatus: statuses, byFolderType: folderTypes, distinctDirectories: byDirectory.directories },
    teachers,
    audit: { ...audit, byAction: auditActions, submitEvents: submits },
  }
}

export async function snapshotV2(sql) {
  const tables = {}
  for (const table of V2_TABLES) tables[table] = await tableFingerprint(sql, table)

  const [resources] = await sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'DRAFT')::int          AS draft,
      count(*) FILTER (WHERE status = 'PENDING_REVIEW')::int AS pending_review,
      count(*) FILTER (WHERE status = 'PUBLISHED')::int      AS published,
      count(*) FILTER (WHERE status = 'REJECTED')::int       AS rejected,
      count(*) FILTER (WHERE status = 'RECALLED')::int       AS recalled,
      count(*) FILTER (WHERE deleted_at IS NOT NULL)::int    AS recycled,
      count(*) FILTER (WHERE uploader_id IS NULL)::int       AS no_uploader
    FROM resources`
  const [files] = await sql`SELECT count(*)::int AS total FROM resource_files`
  const [migrated] = await sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE needs_review)::int AS needs_review
    FROM v1_migration_map`
  /*
    审计的幂等键在 detail 里（`v1AuditId`），不在记账表里 —— 所以"搬过来多少条审计"
    必须从**审计表本身**数，而不是数记账行。否则盘点表会显示"审计 7651 → 0"，
    看着像全丢了（其实一条不少，只是口径取错了）。
  */
  const [auditMigrated] = await sql`
    SELECT count(*)::int AS n FROM audit_logs WHERE detail ? 'v1AuditId'`
  const byEntity = {}
  for (const r of await sql`SELECT entity, count(*)::int AS n FROM v1_migration_map GROUP BY 1 ORDER BY 1`) {
    byEntity[r.entity] = r.n
  }

  return {
    kind: 'v2',
    tables,
    resources,
    files: files.total,
    auditMigrated: auditMigrated.n,
    migration: { ...migrated, byEntity },
  }
}

export async function snapshot(url) {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe('SET default_transaction_read_only = on')
    const [v1] = await sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'teachers'`
    const found = v1.n > 0 ? await snapshotV1(sql) : await snapshotV2(sql)
    return { url: redact(url), takenAt: new Date().toISOString(), ...found }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** 连接串里可能带口令 —— 打印与落盘之前一律先脱敏。 */
export function redact(url) {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '(unparseable url)'
  }
}

/** 两份快照的差异（只比行数与指纹，不猜业务含义）。 */
export function compareSnapshots(before, after) {
  const diffs = []
  for (const table of Object.keys({ ...before.tables, ...after.tables })) {
    const b = before.tables[table]
    const a = after.tables[table]
    if (!b && !a) continue
    if (!b) { diffs.push({ table, change: 'added', rows: a.rows }); continue }
    if (!a) { diffs.push({ table, change: 'removed', rows: b.rows }); continue }
    if (b.rows !== a.rows) diffs.push({ table, change: 'rows', before: b.rows, after: a.rows })
    if (b.sha256 !== a.sha256) diffs.push({ table, change: 'content' })
  }
  return diffs
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const url = arg('url') ?? process.env.V1_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url || url === true) {
    console.error('用法：node scripts/v1-snapshot.mjs --url <DB_URL> [--out 文件] [--markdown]')
    process.exit(2)
  }
  const snap = await snapshot(url)
  const out = arg('out')
  if (out && out !== true) {
    writeFileSync(out, `${JSON.stringify(snap, null, 2)}\n`)
    console.log(`快照已写入 ${out}`)
  }
  console.log(`类型：${snap.kind}  地址：${snap.url}`)
  for (const [table, fp] of Object.entries(snap.tables)) {
    console.log(`  ${table.padEnd(30)} ${fp === null ? '（不存在）' : `${String(fp.rows).padStart(6)}  ${fp.sha256.slice(0, 16)}`}`)
  }
  if (snap.kind === 'v1') {
    console.log(`  资源：${JSON.stringify(snap.resources)}`)
    console.log(`  教师：${JSON.stringify(snap.teachers)}`)
    console.log(`  审计：${JSON.stringify(snap.audit)}`)
  } else {
    console.log(`  资源：${JSON.stringify(snap.resources)}  文件：${snap.files}  迁移：${JSON.stringify(snap.migration)}`)
  }
}
