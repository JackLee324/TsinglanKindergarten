#!/usr/bin/env node
/**
 * scripts/db-setup-app-role.mjs — 为新库准备应用连接角色
 * =====================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * 迁移 `0004_rls_role_alignment.sql` 会创建三个 **NOLOGIN** 角色
 * (`anon_` / `authenticated_` / `service_role_`) 并给它们授权，但**故意不**决定
 * 谁可以切换成它们 —— 文件里写得很清楚：
 *
 *     because `SET LOCAL ROLE x` requires membership:
 *         GRANT anon_           TO <app_db_role>;
 *         GRANT authenticated_  TO <app_db_role>;
 *         GRANT service_role_   TO <app_db_role>;
 *
 * 平台部署时那一步由平台完成；**独立部署时没人做**。不做的话，平台的
 * SqlExecutionContextMiddleware 会对每个请求执行 `SET LOCAL ROLE 'anon_<schema>'`
 * 并因 42501 失败，表现为：**登录报"用户名或密码错误"，且 audit_logs 里查不到
 * 任何一行**——一个极难定位的故障（migration 0004:48-54）。
 *
 * 角色名怎么来的（已实测确认）
 * ---------------------------
 * 角色开关（现在由本仓库自己的 server/database/database-role.middleware.ts 提供）按连接串的
 * `schema` 查询参数拼角色名：`anon_${roleSchema}`、`authenticated_${roleSchema}`、
 * `service_role_${roleSchema}`（dist/index.js:692-702 与 790-798）。
 * 连接串**不带** `?schema=` 时 roleSchema 为空字符串 ⇒ 空后缀角色，
 * 正好是迁移 0004 建的那三个。
 *
 * 本机实测（PostgreSQL 16.14）：
 *     SET LOCAL ROLE "anon_"         -> 成功，current_user = anon_
 *     SET LOCAL ROLE "service_role_" -> 成功，current_user = service_role_
 *
 * 它做什么 / 不做什么
 * ------------------
 *   ✅ 幂等：角色已存在就不建；成员关系已存在就不重复 GRANT；可以反复跑。
 *   ✅ 只做成员关系，不改密码、不动 RLS 策略、不碰任何业务表。
 *   ❌ 不创建数据库、不建表、不跑迁移（那是 db-bootstrap.mjs / migrate.mjs 的活）。
 *   ❌ 不授予 SUPERUSER，不授予 BYPASSRLS。
 *
 * USAGE
 *   # 用特权连接（能建角色 + 能 GRANT）：
 *   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=... \
 *     node scripts/db-setup-app-role.mjs --db-url "postgresql://qls:pw@host:5432/qls_prod"
 *
 *   # 或显式指定两个连接串：
 *   node scripts/db-setup-app-role.mjs \
 *     --admin-url "postgresql://postgres:pw@host:5432/postgres" \
 *     --db-url    "postgresql://qls:pw@host:5432/qls_prod"
 *
 *   --app-role <name>   应用连接角色名（默认从 --db-url 的 user 推导）
 *   --dry-run           只打印将要执行的语句，不执行
 *
 * EXIT: 0 成功；1 失败（失败一定打印原因，绝不静默成功）
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) args[k] = true;
  else {
    args[k] = v;
    i += 1;
  }
}

const DRY_RUN = args['dry-run'] === true;

const dbUrl =
  (typeof args['db-url'] === 'string' ? args['db-url'] : '') ||
  process.env.DATABASE_URL ||
  process.env.SUDA_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  '';

if (!dbUrl) {
  console.error('[db-setup-app-role] 缺少目标库连接串。');
  console.error('  传 --db-url "postgresql://…" 或设 DATABASE_URL / SUDA_DATABASE_URL。');
  process.exit(1);
}

/**
 * 特权连接：优先显式 --admin-url，其次标准 PG* 环境变量。
 * 默认连到 `postgres` 维护库（与 tests/helpers/legacy-fixture.mjs:28-30 同一套约定）。
 */
function resolveAdminUrl() {
  if (typeof args['admin-url'] === 'string' && args['admin-url']) return args['admin-url'];
  const explicit = process.env.PGHOST || process.env.PGPORT || process.env.PGUSER || process.env.PGPASSWORD;
  if (explicit) {
    const host = process.env.PGHOST || '127.0.0.1';
    const port = process.env.PGPORT || '5432';
    const user = process.env.PGUSER || '';
    const pass = process.env.PGPASSWORD || '';
    const db = process.env.PGDATABASE || 'postgres';
    if (!user) return '';
    const auth = pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}` : encodeURIComponent(user);
    return `postgresql://${auth}@${host}:${port}/${db}`;
  }
  return '';
}

const adminUrl = resolveAdminUrl();
if (!adminUrl) {
  console.error('[db-setup-app-role] 缺少特权连接串，无法 CREATE ROLE / GRANT。');
  console.error('  传 --admin-url "postgresql://…"，或设置 PGHOST/PGPORT/PGUSER/PGPASSWORD。');
  console.error('  通常这就是：以数据库超级用户身份连一次，做成员授予，然后就不需要它了。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 目标
// ---------------------------------------------------------------------------
let appRole = typeof args['app-role'] === 'string' ? args['app-role'] : '';
let targetDatabase = '';
try {
  const parsed = new URL(dbUrl);
  targetDatabase = parsed.pathname.replace(/^\//, '');
  if (!appRole) appRole = decodeURIComponent(parsed.username);
  const schema = parsed.searchParams.get('schema') ?? '';
  if (schema) {
    console.error(`[db-setup-app-role] 连接串带 ?schema=${schema}`);
    console.error(`  平台将推导角色名 anon_${schema} / authenticated_${schema} / service_role_${schema}，`);
    console.error('  但迁移 0004 创建的是**空后缀**角色。两者不一致时登录会以 42501 失败。');
    console.error('  本脚本按空后缀角色授权；若你确实要用带后缀的角色，请先自行创建它们。');
  }
} catch {
  console.error('[db-setup-app-role] --db-url 不是可解析的 URL。');
  process.exit(1);
}

if (!appRole) {
  console.error('[db-setup-app-role] 无法确定应用连接角色名：连接串里没有用户名，也没传 --app-role。');
  process.exit(1);
}

/** 迁移 0004 创建并授权的那三个角色（空后缀，与 schema 参数为空对应）。 */
const PLATFORM_ROLES = ['anon_', 'authenticated_', 'service_role_'];

console.log('[db-setup-app-role] 目标');
console.log(`  库        : ${targetDatabase || '(未指定)'}`);
console.log(`  应用角色  : ${appRole}`);
console.log(`  平台角色  : ${PLATFORM_ROLES.join(', ')}`);
console.log(`  模式      : ${DRY_RUN ? 'DRY RUN（不执行任何语句）' : '执行'}`);
console.log('');

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
let failures = 0;

try {
  // -------------------------------------------------------------------------
  // 0. 前置检查：目标库存在吗？三个平台角色存在吗？
  // -------------------------------------------------------------------------
  if (targetDatabase) {
    const [db] = await admin`select 1 as ok from pg_database where datname = ${targetDatabase}`;
    if (!db) {
      console.error(`[db-setup-app-role] 目标库 "${targetDatabase}" 不存在。`);
      console.error('  先建库（或让托管服务创建），再跑本脚本。本脚本不建库。');
      process.exit(1);
    }
    console.log(`✓ 目标库存在: ${targetDatabase}`);
  }

  const existingRoles = await admin`
    select rolname from pg_roles where rolname = any(${PLATFORM_ROLES})
  `;
  const existing = new Set(existingRoles.map((r) => r.rolname));
  const missing = PLATFORM_ROLES.filter((r) => !existing.has(r));

  if (missing.length > 0) {
    console.log(`! 以下平台角色尚不存在: ${missing.join(', ')}`);
    console.log('  它们是 migration 0004 创建的。请**先**应用迁移，再跑本脚本：');
    console.log('    DATABASE_URL=... node scripts/migrate.mjs up');
    console.log('    DATABASE_URL=... node scripts/migrate.mjs status   # 确认无 pending');
    console.log('  本脚本不代劳——迁移必须经 advisory lock 与校验和保护，不能手工 DDL。');
    process.exit(1);
  }
  console.log(`✓ 三个平台角色均已存在（由 migration 0004 创建）`);

  // -------------------------------------------------------------------------
  // 1. 应用角色本身
  // -------------------------------------------------------------------------
  const [appRoleRow] = await admin`
    select rolname, rolsuper, rolcanlogin, rolbypassrls
      from pg_roles where rolname = ${appRole}
  `;
  if (!appRoleRow) {
    console.error(`[db-setup-app-role] 应用角色 "${appRole}" 不存在。`);
    console.error('  本脚本不创建应用角色（它的密码属于你的秘密管理，不该由脚本生成）。');
    console.error(`  先创建：CREATE ROLE "${appRole}" LOGIN PASSWORD '<强密码>';`);
    process.exit(1);
  }
  console.log(`✓ 应用角色存在: ${appRoleRow.rolname} `
    + `(login=${appRoleRow.rolcanlogin} super=${appRoleRow.rolsuper} bypassrls=${appRoleRow.rolbypassrls})`);
  if (appRoleRow.rolbypassrls) {
    console.log('! 该角色带 BYPASSRLS：意味着行级安全对它是**失效**的。');
    console.log('  本应用把 RLS 当作纵深防御的一层（应用层鉴权才是主关卡，SECURITY.md §8.2），');
    console.log('  所以这不是致命问题，但会削弱"即使应用有洞、库层也拦得住"的那一层。');
  }

  // -------------------------------------------------------------------------
  // 2. 库级权限：迁移要能建表，就必须是 owner 或至少有 CREATE
  // -------------------------------------------------------------------------
  const [dbRow] = await admin`
    select pg_get_userbyid(datdba) as owner, has_database_privilege(${appRole}, datname, 'CREATE') as can_create
      from pg_database where datname = ${targetDatabase}
  `;
  if (dbRow) {
    if (!dbRow.can_create) {
      console.error(`[db-setup-app-role] 应用角色 "${appRole}" 在库 "${targetDatabase}" 上没有 CREATE 权限。`);
      console.error('  迁移会失败（它要建表、建策略、建触发器）。');
      console.error(`  授予：GRANT CREATE ON DATABASE "${targetDatabase}" TO "${appRole}";`);
      console.error(`  或把库 owner 改成它：ALTER DATABASE "${targetDatabase}" OWNER TO "${appRole}";`);
      failures += 1;
    } else {
      console.log(`✓ 应用角色在库上有 CREATE 权限（owner=${dbRow.owner}）`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. public schema 的 USAGE/CREATE
  // -------------------------------------------------------------------------
  const [schemaRow] = await admin`
    select has_schema_privilege(${appRole}, 'public', 'USAGE')  as can_use,
           has_schema_privilege(${appRole}, 'public', 'CREATE') as can_create
  `;
  if (!schemaRow?.can_create) {
    console.error(`[db-setup-app-role] 应用角色在 schema public 上没有 CREATE 权限，迁移会失败。`);
    console.error(`  授予：GRANT CREATE, USAGE ON SCHEMA public TO "${appRole}";`);
    failures += 1;
  } else {
    console.log('✓ 应用角色在 schema public 上有 CREATE/USAGE');
  }

  // -------------------------------------------------------------------------
  // 4. 核心目标：三个平台角色的成员关系
  //    没有它，平台每请求的 SET LOCAL ROLE 会以 42501 失败。
  // -------------------------------------------------------------------------
  const membership = await admin`
    select g.rolname as granted
      from pg_auth_members m
      join pg_roles g on g.oid = m.roleid
      join pg_roles r on r.oid = m.member
     where r.rolname = ${appRole}
       and g.rolname = any(${PLATFORM_ROLES})
  `;
  const has = new Set(membership.map((m) => m.granted));
  const need = PLATFORM_ROLES.filter((r) => !has.has(r));

  if (need.length === 0) {
    console.log(`✓ 成员关系已就绪：${appRole} -> ${PLATFORM_ROLES.join(', ')}`);
  } else {
    console.log(`→ 需要授予成员关系: ${need.join(', ')}`);
    for (const role of need) {
      const stmt = `GRANT "${role}" TO "${appRole}"`;
      if (DRY_RUN) {
        console.log(`  [dry-run] ${stmt}`);
        continue;
      }
      try {
        // 角色名来自上面的 PLATFORM_ROLES 白名单、appRole 来自连接串/参数，
        // 两者都经过标识符引号包裹；这里不拼接任何外部输入。
        await admin.unsafe(`GRANT "${role}" TO "${appRole}"`);
        console.log(`  ✓ ${stmt}`);
      } catch (error) {
        console.error(`  ✗ ${stmt} 失败: ${error.message}`);
        if (/must have admin option|permission denied/i.test(error.message)) {
          console.error('    执行 GRANT 的角色需要对该角色有 ADMIN OPTION，'
            + '或本身是超级用户。');
        }
        failures += 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. 验收：真的以应用角色连一次，真的切换一次角色
  //    "GRANT 执行成功"不等于"应用切得过去"。这里实证。
  // -------------------------------------------------------------------------
  if (!DRY_RUN && failures === 0) {
    console.log('');
    console.log('[db-setup-app-role] 验收：以应用角色实连并切换角色');
    const app = postgres(dbUrl, { max: 1, onnotice: () => {} });
    try {
      for (const role of PLATFORM_ROLES) {
        try {
          await app.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL ROLE "${role}"`);
            await tx`select 1`;
          });
          console.log(`  ✓ SET LOCAL ROLE "${role}" 成功`);
        } catch (error) {
          console.error(`  ✗ SET LOCAL ROLE "${role}" 失败: ${error.message}`);
          console.error('    这一条失败就意味着登录会报"用户名或密码错误"且不写审计。');
          failures += 1;
        }
      }
      const [me] = await app`select current_user as u, current_database() as db`;
      console.log(`  · 应用连接身份: user=${me.u} database=${me.db}`);
    } catch (error) {
      console.error(`  ✗ 以应用角色连接失败: ${error.message}`);
      failures += 1;
    } finally {
      await app.end();
    }
  }
} catch (error) {
  console.error(`[db-setup-app-role] 意外失败: ${error.message}`);
  failures += 1;
} finally {
  await admin.end();
}

console.log('');
if (failures === 0) {
  console.log('[db-setup-app-role] ✅ 完成：应用角色可切换全部三个平台角色。');
  process.exit(0);
}
console.error(`[db-setup-app-role] ❌ ${failures} 项未通过，见上面的原因。`);
process.exit(1);
