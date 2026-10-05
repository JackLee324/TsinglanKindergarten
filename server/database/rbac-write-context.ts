import type { PostgresJsDatabase } from '@server/database/database.module';

/**
 * 以 `authenticated_` 角色执行一次特权写入。
 * =============================================================================
 *
 * WHY THIS EXISTS（这不是"顺手抽个工具函数"，是一次真实故障的直接产物）
 * -----------------------------------------------------------------------------
 * `AuthorizationService.setPermissionOverride()` / `clearPermissionOverride()` /
 * `setScopes()` 这三张表的写入**曾经全部 500**，而原因很隐蔽：
 *
 *   * `account_permission_overrides` 上有一个 AFTER INSERT/DELETE/UPDATE 触发器
 *     `trg_apo_bump_permissions_version`，它会 `UPDATE teachers.permissions_version`
 *     （这正是"改权限后会话立刻失效"的实现）；
 *   * 而 migration 0005 **REVOKE 了 `anon_` 在 teachers 上的 UPDATE**，
 *     只重新授予了三列 `(last_login_at, failed_login_attempts, locked_until)`；
 *   * 每个 HTTP 请求默认以 `anon_` 身份执行 SQL。
 *
 * 于是一次看似普通的 INSERT 会被触发器带出 `42501 permission denied for table teachers`，
 * 而错误信息指向的是 **teachers**，不是本次要写的那张表 —— 排查方向很容易被带偏。
 *
 * 这解释了为什么"这套机制定义了却完全无法使用"：它不只是没人调用，
 * **它是被调用也跑不起来**。修法就是在写入前显式切到 `authenticated_`，
 * 与密码重置（auth.service 的 writePasswordReset）用的是同一套机制。
 *
 * WHY THE RAW CLIENT
 *   Drizzle 的 postgres-js 驱动把底层 client 挂在 `$client` 上。本应用自己的
 *   按请求角色前导（`request-database-role.ts`）hook 的是 drizzle 的查询对象，
 *   所以在 `$client` 上发出的语句是**唯一不会**被自动加上
 *   `SET LOCAL ROLE 'anon_'` 的那一类 —— 这正是能做显式角色切换的前提。
 *
 * FAIL LOUDLY
 *   拿不到 client 就抛错，绝不在"角色不对"的情况下把写入做下去 ——
 *   那会得到一串与真实原因无关的 42501。
 */
export interface RawSqlTransaction {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

export interface RawSqlClient {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  begin<T>(fn: (tx: RawSqlTransaction) => Promise<T>): Promise<T>;
}

export function rawPostgresClient(db: PostgresJsDatabase): RawSqlClient {
  const client = (db as unknown as { $client?: RawSqlClient }).$client;
  if (!client || typeof client.begin !== 'function' || typeof client.unsafe !== 'function') {
    throw new Error(
      'rbac-write-context: the drizzle instance does not expose a usable postgres.js client ' +
        '($client), so the privileged write cannot run under the authenticated_ role. ' +
        'Refusing to attempt it instead of failing later with a confusing 42501.',
    );
  }
  return client;
}

/**
 * 在 `authenticated_` 角色 + `app.rbac_actor_id` 上下文中执行 `fn`。
 *
 * 单事务：角色设置用 `SET LOCAL`，只在本次事务内有效。
 * `app.rbac_actor_id` 是数据库层守卫（migration 0003）判断"谁在改"的依据，
 * 不设它的话，即便角色对了，行级守卫也可能拒绝 —— 而且同样只会给出 42501。
 */
export async function withRbacWriteContext<T>(
  db: PostgresJsDatabase,
  actorId: string,
  fn: (tx: RawSqlTransaction) => Promise<T>,
): Promise<T> {
  const client = rawPostgresClient(db);
  return client.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE 'authenticated_'");
    await tx.unsafe("SELECT set_config('app.rbac_actor_id', $1, true)", [actorId]);
    return fn(tx);
  });
}
