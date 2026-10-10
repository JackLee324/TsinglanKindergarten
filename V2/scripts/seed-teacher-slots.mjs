#!/usr/bin/env node
/**
 * scripts/seed-teacher-slots.mjs —— 幂等地种下 39 个教师账号**名额**
 * ============================================================================
 * 业主 Stage 14A §2：39 个岗位名额先建好，但**不创建可登录账号** ——
 * 状态一律 UNASSIGNED（无口令、无授权、不能登录），真实人员由超级管理员后续绑定。
 *
 * 幂等：按 `code` 唯一键插入，已存在的跳过（重跑不会重复建名额，也不会改动
 * 已经绑定/启用的名额 —— 那些是业务数据，不许被种子覆盖）。
 *
 * 用法：
 *   DATABASE_URL='postgresql://…/zeabur' node scripts/seed-teacher-slots.mjs
 *   … --dry-run     只打印将要插入哪些编号，不写库
 */
import postgres from 'postgres'
import { buildSlots } from './report-teacher-slots.mjs'

const DRY = process.argv.includes('--dry-run')
const url = process.env.DATABASE_URL
if (!url) {
  console.error('✖ 必须显式提供 DATABASE_URL（脚本不接受任何默认库）。')
  process.exit(2)
}

const slots = buildSlots()
if (slots.length !== 39) {
  console.error(`✖ 名额规格不对：期望 39，实际 ${slots.length}`)
  process.exit(2)
}

const sql = postgres(url, { max: 1, onnotice: () => {}, keep_alive: true, connect_timeout: 30, idle_timeout: 0 })
try {
  const [{ n: hasTable }] = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'teacher_slots'`
  if (hasTable === 0) {
    console.error('✖ 目标库没有 teacher_slots 表 —— 先跑 node scripts/migrate.mjs up（0004）。')
    process.exit(2)
  }

  const existing = await sql`SELECT code FROM teacher_slots`
  const have = new Set(existing.map((r) => r.code))
  const missing = slots.filter((s) => !have.has(s.code))

  console.log(`名额规格 ${slots.length} 个；库里已有 ${have.size} 个；本次将插入 ${missing.length} 个`)
  if (DRY) {
    for (const s of missing) console.log(`  ${s.code}  ${s.track}/${s.position}`)
    process.exit(0)
  }

  for (const s of missing) {
    await sql`
      INSERT INTO teacher_slots (code, track, class_no, position, status)
      VALUES (${s.code}, ${s.track}, ${s.classNo}, ${s.position}, 'UNASSIGNED')
      ON CONFLICT (code) DO NOTHING`
  }

  const [{ n: total }] = await sql`SELECT count(*)::int AS n FROM teacher_slots`
  const dist = await sql`
    SELECT track, position, count(*)::int AS n FROM teacher_slots
    GROUP BY track, position ORDER BY track, position`
  const [{ n: logins }] = await sql`SELECT count(*)::int AS n FROM teacher_slots WHERE bound_user_id IS NOT NULL`
  console.log(`✔ 库里现有名额 ${total} 个（本次新增 ${missing.length}）`)
  for (const d of dist) console.log(`  ${d.track}/${d.position}: ${d.n}`)
  console.log(`  已绑定账号的名额：${logins}（应为 0 —— 绑定是管理员的动作）`)
} finally {
  await sql.end({ timeout: 5 }).catch(() => {})
}
