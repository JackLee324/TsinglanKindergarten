#!/usr/bin/env node
/**
 * scripts/admin-account-exists.mjs — 某个账号是否已存在（只读，供 entrypoint 判断用）
 * ==============================================================================
 * 为什么需要它
 * ------------
 * `scripts/entrypoint.sh` 每次容器启动都会带着 `INITIAL_ADMIN_PASSWORD` 跑一遍
 * `provision-super-admin.mjs`，而后者会把 `password_hash` 和 `roles` **无条件覆盖**。
 * 结果是：**每一次重新部署都会把管理员密码打回环境变量里的值**，在界面上改过的密码
 * 会被静默丢弃。这不是理论问题 —— 实测证据：
 *
 *     select password_updated_at from teachers where username='TsinglanAdmin';
 *     → 2026-09-26T03:54:11.179Z   （正好是一次重新部署的时刻）
 *     而该密码与部署者以为的密码不一致，登录返回
 *     401 {"message":"用户名或密码错误"}
 *
 * 有了这个只读判断，entrypoint 就能做到"**账号已存在就不动它的密码/角色**"，
 * 同时保留显式重置的入口（`RESET_ADMIN_PASSWORD_ON_BOOT=true`）。
 *
 * 用法：
 *   node scripts/admin-account-exists.mjs --username TsinglanAdmin
 * 退出码：0 = 存在；1 = 不存在；2 = 用法/连接错误（调用方必须把 2 当成"不确定"）。
 *
 * 连接串优先级：QLS_ADMIN_DB / MIGRATION_DATABASE_URL / DATABASE_URL / SUDA_DATABASE_URL。
 */

import postgres from 'postgres';

const args = process.argv.slice(2);
const username = (() => {
  const i = args.indexOf('--username');
  return i >= 0 ? String(args[i + 1] ?? '').trim() : '';
})();

if (!username) {
  process.stderr.write('[admin-account-exists] 缺少 --username\n');
  process.exit(2);
}

const DB_URL =
  process.env.QLS_ADMIN_DB ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.SUDA_DATABASE_URL ||
  '';
if (!DB_URL) {
  process.stderr.write('[admin-account-exists] 缺少连接串（QLS_ADMIN_DB / MIGRATION_DATABASE_URL / DATABASE_URL / SUDA_DATABASE_URL）\n');
  process.exit(2);
}

const sql = postgres(DB_URL, { max: 1, onnotice: () => {}, connect_timeout: 15 });
try {
  const rows = await sql`
    select username, roles, status, (password_hash is not null) as has_password
    from teachers where username = ${username} limit 1
  `;
  if (rows.length === 0) {
    process.stderr.write(`[admin-account-exists] 账号 ${username} 不存在\n`);
    process.exit(1);
  }
  const r = rows[0];
  process.stdout.write(
    `[admin-account-exists] 账号 ${username} 已存在：status=${r.status} ` +
    `has_password=${r.has_password} roles=${JSON.stringify(r.roles)}\n`,
  );
  process.exit(0);
} catch (error) {
  // 连接失败或表不存在 —— 一律当作"不确定"，让调用方退回原来的行为，
  // 绝不能让"查不出来"被当成"不存在"而触发一次覆盖写。
  process.stderr.write(`[admin-account-exists] 查询失败：${error.message}\n`);
  process.exit(2);
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
