#!/usr/bin/env node
/**
 * scripts/check-sequences.mjs —— 检查（并按需修复）自增序列有没有落后
 * ============================================================================
 * 为什么值得单独一个脚本：**序列落后不会报错，只会静默丢数据**。
 * 2026-10-11 线上就是这样：`audit_logs` 序列停在 5、表里最大 621，
 * 于是每一次审计写入都主键冲突，而审计服务刻意"不让业务失败"——只写 error 日志。
 * 结果：登录/上传照常成功，审计里却没有记录。这个缺陷最后是靠"离线重置口令时
 * 事务回滚"才暴露的，不能指望每次都这么走运。
 *
 * 用法：
 *   DATABASE_URL='postgresql://…/库名' node scripts/check-sequences.mjs          # 只读检查
 *   DATABASE_URL='postgresql://…/库名' node scripts/check-sequences.mjs --fix    # 修复（setval）
 *
 * 退出码：0 全部正常 / 2 缺 DATABASE_URL 或参数不合法 / 4 发现落后的序列（未 --fix）
 */
import postgres from 'postgres'
import { compareSequenceLag, listSequenceState, repairSequenceLag } from './lib/sequences.mjs'
import { announceDatabaseTarget, resolveDatabaseTarget } from './lib/db-target.mjs'

const target = resolveDatabaseTarget(process.env)
if (!target.ok) {
  console.error(`✖ ${target.reason}`)
  process.exit(2)
}
announceDatabaseTarget(target)
const fix = process.argv.includes('--fix')

const sql = postgres(target.url, { max: 1, onnotice: () => {}, connect_timeout: 20 })
try {
  const before = await listSequenceState(sql)
  const behind = compareSequenceLag(before)

  console.log('  序列状态：')
  for (const row of before) {
    const isBehind = behind.some((b) => b.table === row.table && b.column === row.column)
    console.log(
      `   ${isBehind ? '✖' : '·'} ${row.table}.${row.column}：序列 ${row.lastValue ?? '(未用过)'} / 表内最大 ${row.maxValue}` +
        (isBehind ? ' ← 落后：下一次插入必然主键冲突' : ''),
    )
  }

  if (behind.length === 0) {
    console.log('✔ 所有序列都不落后')
    process.exit(0)
  }

  if (!fix) {
    console.error(`\n✖ ${behind.length} 个序列落后（这正是"审计写不进去"的成因）。`)
    console.error('  修复：在上面同一条命令后加 --fix（只做 setval 到表内最大值，不删改任何数据）')
    process.exit(4)
  }

  const fixed = await repairSequenceLag(sql, before)
  for (const row of fixed) console.log(`   ✔ 已把 ${row.table}.${row.column} 推到 ${row.maxValue}`)
  // 修完再读一遍，确认真的修好了（不靠"我以为 setval 成功了"）
  const after = await listSequenceState(sql)
  const stillBehind = compareSequenceLag(after)
  if (stillBehind.length > 0) {
    console.error(`✖ 修复后仍有 ${stillBehind.length} 个序列落后`)
    process.exit(4)
  }
  console.log('✔ 修复完成，复核通过（再读一遍确认）')
} catch (error) {
  console.error(`✖ 执行失败：${error.message}`)
  process.exit(3)
} finally {
  await sql.end()
}
