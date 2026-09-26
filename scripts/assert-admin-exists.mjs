#!/usr/bin/env node
/**
 * scripts/assert-admin-exists.mjs — 启动前断言"存在一个能凭密码登录的 super_admin"
 *
 * 存在的理由（一次真实复现得出的）：
 *   entrypoint 在 INITIAL_ADMIN_PASSWORD 含用户名等弱口令时，建号会被
 *   provision-super-admin.mjs 拒绝，而 entrypoint 只把它当作**警告**继续启动。
 *   结果是：容器 Up、/api/health 200、站点可打开，**但没有任何管理员账号**，
 *   登录永远 401。部署方看到的是"部署成功但进不去"，只能怀疑部署失败。
 *
 * 本脚本把这种"假成功"变成明确失败：没有可登录的 super_admin 就 exit 1。
 *
 * 注意它**刻意不要求 MFA 已绑定** —— MFA_ENFORCE_SUPER_ADMIN 默认关闭，而且绑定
 * MFA 只能通过需要服务先运行的 API，要求"已绑定"会造成启动死锁。
 * 判据只有一条：存在 active 且 password_hash 非空的 super_admin。
 *
 * 用法：SUDA_DATABASE_URL=... node scripts/assert-admin-exists.mjs
 * 退出码：0 = 存在；1 = 不存在或无法确认（绝不把"查不了"当作通过）
 */
import postgres from 'postgres';

const url =
  process.env.SUDA_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  '';

if (!url) {
  console.error('[assert-admin] ✗ 没有数据库连接串，无法确认是否存在管理员 —— 拒绝启动');
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const rows = await sql`
    select username
    from teachers
    where roles @> array['super_admin']::varchar[]
      and status = 'active'
      and coalesce(btrim(password_hash), '') <> ''
    limit 5
  `;
  if (rows.length === 0) {
    console.error('[assert-admin] ✗ 没有任何"能凭密码登录"的 super_admin —— 拒绝启动。');
    console.error('[assert-admin]   容器起来、健康检查全绿，但没有任何人能登录管理平台。');
    console.error('[assert-admin]   常见原因：INITIAL_ADMIN_PASSWORD 是弱口令（例如**包含用户名**），');
    console.error('[assert-admin]   被建号脚本拒绝。请改用不含用户名的强密码，然后重新部署。');
    console.error('[assert-admin]   排查：node scripts/bootstrap-super-admin.mjs   （只读）');
    await sql.end();
    process.exit(1);
  }
  console.log(`[assert-admin] ✓ 存在可登录的 super_admin：${rows.map((r) => r.username).join(', ')}`);
  await sql.end();
  process.exit(0);
} catch (error) {
  // 连不上、表不存在等 —— 都不算"通过"。
  console.error(`[assert-admin] ✗ 无法确认管理员状态：${error?.message ?? error} —— 拒绝启动`);
  await sql.end().catch(() => {});
  process.exit(1);
}
