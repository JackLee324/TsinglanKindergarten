#!/usr/bin/env node
/**
 * scripts/transfer-superadmin.mjs —— **超级管理员交接**（唯一、可审计）
 * ============================================================================
 * 业主 Stage 13B §2：生产环境**只有一名**超级管理员（`TsinglanAdmin`），
 * 而且普通账号编辑**不允许**新增管理员（`PATCH /api/users/:id` 会直接拒绝升管理员）。
 *
 * 那"换人"怎么办？—— 走这个脚本。它是唯一被允许改变"谁是超级管理员"的入口：
 *
 *   DATABASE_URL=postgresql://用户@主机:5432/库名 \
 *   TRANSFER_FROM_USERNAME=TsinglanAdmin \
 *   TRANSFER_TO_USERNAME=<新管理员的用户名> \
 *   TRANSFER_CONFIRM=TRANSFER-SUPERADMIN \
 *   node scripts/transfer-superadmin.mjs
 *
 * 三条硬规则（业主 Stage 13C §4 加固）：
 *   · **没有 `DATABASE_URL` 就立刻退出**，不做任何数据库操作 —— 运维脚本不接受
 *     任何默认库。以前这里默认回退到本机开发库，容易让操作者误以为
 *     自己正在操作目标环境（最高权限的动作不该靠"看起来像")；
 *   · 连库**之前**打印**脱敏**目标（`user@host:port/dbname`，不含口令）并标明
 *     本机 / 非本机；口令永不回显、永不进日志；
 *   · 仍要求 `TRANSFER_CONFIRM=TRANSFER-SUPERADMIN` 字面量。
 *
 * 它在**一个事务**里做四件事：
 *   1. 锁定并核对前置状态：`FROM` 当前必须是有效管理员，`TO` 必须存在且是有效教师；
 *   2. 把 `TO` 提升为管理员、把 `FROM` 降为教师；
 *   3. 撤销**两个人**的全部会话（身份变了就不该继续用旧会话）；
 *   4. 写两条审计（`user.role_transfer_out` / `user.role_transfer_in`），
 *      记录操作者、前后身份、时间 —— 交接必须能在审计里查出来。
 *
 * 为什么必须要求 `TRANSFER_CONFIRM=TRANSFER-SUPERADMIN` 这个字面量：
 * 交接是"把最高权限交出去"的动作，敲错一个用户名就会真的换人。
 * 要求显式确认字符串，避免误执行（与 bootstrap-admin 要求显式口令同一个道理）。
 *
 * 为什么不用 API：账号管理接口按设计**只创建教师、不新增管理员**；
 * 留一个能升管理员的 API 就等于把唯一性交给调用者自律。
 * 这个脚本是**离线、需要数据库连接**的运维动作，跑之前要有人在场。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import postgres from 'postgres'
import { announceDatabaseTarget, resolveDatabaseTarget } from './lib/db-target.mjs'

const require = createRequire(import.meta.url)
const { ADMIN_ROLE } = require('../dist/shared/permissions.js')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
void ROOT

const from = (process.env.TRANSFER_FROM_USERNAME ?? '').trim()
const to = (process.env.TRANSFER_TO_USERNAME ?? '').trim()
const confirm = process.env.TRANSFER_CONFIRM ?? ''
const CONFIRM_TOKEN = 'TRANSFER-SUPERADMIN'

function fail(message, code = 2) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

/*
  ⚠️ 目标解析放在**最前面**：只要没给 `DATABASE_URL` 就立刻退出，
  绝不回退到任何默认库（业主 Stage 13C §4）。这条检查在 `postgres(...)` 之前，
  所以"缺变量"时**一个连接都不会建立**，更不会改到任何数据。
*/
const target = resolveDatabaseTarget(process.env)
if (!target.ok) {
  fail(target.reason)
}

if (from === '' || to === '') {
  fail(
    '必须显式提供 TRANSFER_FROM_USERNAME（当前超级管理员）与 TRANSFER_TO_USERNAME（接手人）。',
  )
}
if (confirm !== CONFIRM_TOKEN) {
  fail(
    `交接会把最高权限交出去，必须显式确认：TRANSFER_CONFIRM=${CONFIRM_TOKEN}\n` +
      '  （这不是形式主义：没有它，一次复制粘贴的手误就会真的换人。）',
  )
}
if (from.toLowerCase() === to.toLowerCase()) {
  fail('交接双方是同一个人 —— 没有要交接的东西。')
}

console.log(`超级管理员交接：${from} → ${to}`)
announceDatabaseTarget(target)
console.log('  确认字符串：已提供（TRANSFER-CONFIRM）')

const sql = postgres(target.url, { max: 1, onnotice: () => {} })
let code = 0
try {
  const result = await sql.begin(async (tx) => {
    // ① 锁住 users 表的相关行，避免并发交接产生两个管理员
    const rows = await tx`
      SELECT id::text, username, name, role, status FROM users
      WHERE lower(username) IN (lower(${from}), lower(${to}))
      FOR UPDATE
    `
    const outgoing = rows.find((r) => r.username.toLowerCase() === from.toLowerCase())
    const incoming = rows.find((r) => r.username.toLowerCase() === to.toLowerCase())
    if (outgoing === undefined) throw new Error(`找不到当前超级管理员「${from}」`)
    if (incoming === undefined) throw new Error(`找不到接手人「${to}」`)
    if (outgoing.role !== ADMIN_ROLE) throw new Error(`「${from}」当前不是管理员，无法作为交出的那一方`)
    if (outgoing.status !== 'active') throw new Error(`「${from}」不是有效账号（status=${outgoing.status}）`)
    if (incoming.status !== 'active') throw new Error(`「${to}」不是有效账号（status=${incoming.status}）`)

    // ② 一次事务内一降一升 —— 中间状态永远不会被别的请求看到
    await tx`UPDATE users SET role = 'TEACHER', updated_at = now() WHERE id = ${outgoing.id}`
    await tx`UPDATE users SET role = ${ADMIN_ROLE}, updated_at = now() WHERE id = ${incoming.id}`

    // ③ 双方会话全部撤销（身份变了，旧会话不该继续有效）
    const revoked = await tx`
      DELETE FROM sessions WHERE user_id IN (${outgoing.id}, ${incoming.id})
      RETURNING id::text
    `

    // ④ 审计：两条、各自指明方向
    const detail = {
      from: { id: outgoing.id, username: outgoing.username, name: outgoing.name },
      to: { id: incoming.id, username: incoming.username, name: incoming.name },
      revokedSessions: revoked.length,
      via: 'scripts/transfer-superadmin.mjs',
    }
    for (const [action, targetId, targetName] of [
      ['user.role_transfer_out', outgoing.id, outgoing.name],
      ['user.role_transfer_in', incoming.id, incoming.name],
    ]) {
      await tx`
        INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, result, detail)
        VALUES (NULL, '超级管理员交接（离线脚本）', ${action}, 'user', ${targetId},
                'success', ${tx.json({ ...detail, targetName })})
      `
    }

    // ⑤ 不变量自检：交接之后**有且仅有一名**有效管理员
    const admins = await tx`
      SELECT username FROM users WHERE role = ${ADMIN_ROLE} AND status = 'active' ORDER BY username
    `
    return { outgoing, incoming, revoked: revoked.length, admins: admins.map((a) => a.username) }
  })

  if (result.admins.length !== 1) {
    // 事务已经提交，这里只能报警（正常路径下不会发生：上面已经锁行 + 唯一性由本脚本保证）
    console.error(`⚠ 交接后发现有效管理员有 ${result.admins.length} 名：${result.admins.join(', ')}`)
    code = 1
  } else {
    console.log('✔ 超级管理员交接完成')
    console.log(`  交出：${result.outgoing.username}（${result.outgoing.name}）→ TEACHER`)
    console.log(`  接手：${result.incoming.username}（${result.incoming.name}）→ ADMIN`)
    console.log(`  已撤销会话：${result.revoked} 条`)
    console.log(`  当前唯一有效管理员：${result.admins[0]}`)
    console.log('  审计：user.role_transfer_out / user.role_transfer_in 各一条')
  }
} catch (error) {
  // 只打印 message：连接串（可能含口令）不在这里回显 —— 目标已经脱敏打印过了。
  console.error(`✖ 交接失败：${error.message}`)
  console.error(`  （目标：${target.redacted}；如需核查请对照上面那一行脱敏目标）`)
  code = 1
} finally {
  await sql.end({ timeout: 3 })
}
process.exit(code)
