/**
 * scripts/migrate.mjs —— V2 迁移执行器
 * ============================================================================
 *   node scripts/migrate.mjs           应用未执行的迁移
 *   node scripts/migrate.mjs status    只看状态
 *   node scripts/migrate.mjs verify    只校验已应用迁移的校验和（不写库）
 *   node scripts/migrate.mjs down      回滚最后一个迁移（仅开发用）
 *
 * WHY 校验和：迁移文件一旦被应用就**永不修改**。如果有人事后改了它，
 * 不同环境（本机 / CI / 生产）的 schema 会静默分叉，而那种分叉只在
 * 最不方便的时候暴露。所以每次启动前都比对 SHA-256，不一致就拒绝继续。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(ROOT, 'database', 'migrations')

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_v2_dev'

const command = process.argv[2] ?? 'up'

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
}

function checksum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })

async function ensureLedger() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `
}

async function applied() {
  const rows = await sql`SELECT name, checksum FROM schema_migrations`
  return new Map(rows.map((r) => [r.name, r.checksum]))
}

async function verifyOnly() {
  await ensureLedger()
  const done = await applied()
  const drift = []
  for (const [name, sum] of done) {
    const path = join(MIGRATIONS_DIR, name)
    let actual
    try {
      actual = checksum(path)
    } catch {
      drift.push(`${name}: 文件已不存在（已应用但被删除）`)
      continue
    }
    if (actual !== sum) drift.push(`${name}: 内容与已应用时不一致`)
  }
  if (drift.length) {
    console.error('迁移校验失败：')
    for (const d of drift) console.error('  ✗ ' + d)
    console.error('\n已应用的迁移永不修改。要改 schema 请新增一个迁移文件。')
    process.exit(1)
  }
  const files = migrationFiles()
  const pending = files.filter((f) => !done.has(f))
  console.log(`  校验和一致（${done.size} 个已应用，${pending.length} 个待执行）`)
}

async function up() {
  await ensureLedger()
  const done = await applied()
  const files = migrationFiles()
  const pending = files.filter((f) => !done.has(f))

  // 先校验历史，避免"在一个已经漂移的库上继续往前滚"。
  for (const [name, sum] of done) {
    if (checksum(join(MIGRATIONS_DIR, name)) !== sum) {
      console.error(`迁移校验失败：${name} 在应用之后被修改过。拒绝继续。`)
      process.exit(1)
    }
  }

  if (pending.length === 0) {
    console.log(`  没有待执行的迁移（共 ${done.size} 个已应用）`)
    return
  }

  for (const name of pending) {
    const body = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
    const sum = checksum(join(MIGRATIONS_DIR, name))
    process.stdout.write(`  应用 ${name} … `)
    // 整个迁移在一个事务里：失败就完全不生效，不会留下半截 schema。
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${sum})`
    })
    console.log('OK')
  }
  console.log(`  完成（本次执行 ${pending.length} 个）`)
}

async function status() {
  await ensureLedger()
  const done = await applied()
  for (const f of migrationFiles()) {
    console.log(`  ${done.has(f) ? '[已应用]' : '[待执行]'} ${f}`)
  }
}

async function down() {
  await ensureLedger()
  const done = await applied()
  const files = migrationFiles().filter((f) => done.has(f))
  const last = files[files.length - 1]
  if (!last) {
    console.log('  没有可回滚的迁移')
    return
  }
  const downPath = join(MIGRATIONS_DIR, last.replace(/\.sql$/, '.down.sql'))
  const body = readFileSync(downPath, 'utf8')
  await sql.begin(async (tx) => {
    await tx.unsafe(body)
    await tx`DELETE FROM schema_migrations WHERE name = ${last}`
  })
  console.log(`  已回滚 ${last}`)
}

try {
  if (command === 'up') await up()
  else if (command === 'status') await status()
  else if (command === 'verify') await verifyOnly()
  else if (command === 'down') await down()
  else {
    console.error(`未知命令：${command}`)
    process.exit(2)
  }
} catch (error) {
  console.error('迁移失败：' + (error?.message ?? error))
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
