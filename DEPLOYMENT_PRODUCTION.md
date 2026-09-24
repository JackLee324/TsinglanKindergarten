# DEPLOYMENT_PRODUCTION.md — 生产部署手册

> **文档基线**：git commit `671328a` + 写作时工作区未提交改动。
> 验证环境：macOS 26 / Node **v22.23.2** / npm **10.9.8** / PostgreSQL **16.14**（本地验证实例）。
>
> **证据标记**：**[已证实]** 本次实测或源码逐行确证 · **[推断]** 由代码/配置互推，未实机执行 ·
> **[无法验证]** 需要目标部署环境（妙搭平台 / 真实域名 / 反向代理 / Docker）才能确认。
>
> 平台相关说明见 [`DEPLOYMENT.md`](DEPLOYMENT.md)（妙搭 aPaaS 专章）。
> 本文是**通用生产部署**的权威步骤；两者冲突时以本文为准。
> 相关文档： [`SECURITY.md`](SECURITY.md) · [`MIGRATION.md`](MIGRATION.md) ·
> [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) · [`RUNBOOK.md`](RUNBOOK.md) ·
> [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md)

---

## 0. 当前发布状态（先读这一节）

```
PRODUCTION STATUS: NOT READY FOR PUBLIC RELEASE
```
理由与阻塞项见 [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) §M 与 §R-4。
本手册描述的是**正确的部署流程**，不等于"现在就可以上线"。
上线前必须跑通 §13 的发布闸门并完成 §14 的验收清单。

**在本机（macOS）能做到什么 / 不能做到什么**

| 步骤 | 本机能否验证 | 说明 |
|---|---|---|
| `npm ci` / `npm install` | ✅ 已证实（dry-run，见 §7） | 但会产生平台不匹配的依赖树，见 §7.2 |
| `npm run build` | ✅ 已证实（产物已存在于 `dist/`） | 12 MB 语义见 §8 |
| `node scripts/migrate.mjs status/up/down/verify` | ✅ 已证实（真实 PostgreSQL 16.14） | 见 §6 |
| 生产模式启动 + `/api/health` | ✅ 已证实 | 见 §10 |
| **反向代理 / TLS / HSTS / `trust proxy` 实链路** | ❌ **[无法验证]** | 本机无 Nginx/Traefik/云入口 |
| **Docker / K8s / 容器编排** | ❌ **[无法验证]** | 本机无 docker，仓库亦无 Dockerfile |
| **妙搭平台发布管线 / dataloom 存储 / vefaas** | ❌ **[无法验证]** | 无平台凭据 |
| **`pg_dump` / `pg_restore` 备份恢复** | ❌ **[无法验证]** | 本机**没有** `psql`/`pg_dump`/`pg_restore` 客户端（见 §4 与 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §0） |

> ⚠️ 本机确实没有 `psql` / `pg_dump` / `pg_restore` / `createdb`：
> `which psql pg_dump pg_restore createdb` 全部返回空。
> 本地验证用的 PostgreSQL 由 `scripts/dev-postgres.sh` 安装，
> 其二进制目录只有 `initdb` / `pg_ctl` / `postgres` **三个服务端程序**。
> 因此本手册中所有 `pg_dump` / `psql` 命令都是**模板**，
> 必须由部署环境执行并确认（不声称已运行过）。

---

## 1. 前置条件

| 项 | 要求 | 依据 |
|---|---|---|
| Node.js | **>= 22.0.0** | `package.json` `engines.node` [已证实] |
| npm | **>= 10.0.0** | `package.json` `engines.npm` [已证实] |
| PostgreSQL | **>= 13**（实测 16.14） | migration `0003`/`0006` 使用 `gen_random_uuid()`（PG 13+ 内置）；PG<13 需 `pgcrypto` [已证实：SQL 内容] |
| 数据库角色 | 应用连接角色必须是 `anon_` / `authenticated_` / `service_role_` 的**成员** | [`SECURITY.md`](SECURITY.md) §8.4；`0004_rls_role_alignment.sql:48-54` [已证实] |
| 反向代理 + TLS | 必需（生产强制 `Secure` Cookie） | `session.service.ts:47-51` [已证实] |
| 构建/运行平台 | **linux-x64**（aPaaS 目标）；macOS/arm64 见 §7.2 | `package-lock.json` 平台门控条目 [已证实] |
| 源码 | 干净检出（不要用带本地改动的目录发布） | `git status --short` 应为空 |
| 平台凭据 | 妙搭部署需要 `FORCE_AUTHN_INNERAPI_DOMAIN` 等；非平台部署见 §11.3 | `PRODUCTION_READINESS.md` §O-1 [已证实] |

---

## 2. 环境变量总表

> 下表每一行都来自**代码中真实读取**（`grep -rn "process.env" server/ shared/ client/src/`）
> 或 `.env.example`。已在说明中标注哪些是"声明了但代码从不读取"。

### 2.1 必填（缺失会导致功能不可用或进程退出）

| 变量 | 必填 | 用途 | 生成 / 取值 | 示例形状（**非真实值**） |
|---|---|---|---|---|
| `DATABASE_URL` 或 `SUDA_DATABASE_URL` | ✅ | 应用与迁移的运行库连接 | 部署环境提供；妙搭由平台注入 | `postgresql://<user>:<pass>@<host>:5432/<db>` |
| `MFA_ENCRYPTION_KEY` | ✅（若使用 MFA） | AES-256-GCM 加密 TOTP 密钥 | `openssl rand -base64 32` | 44 字符 Base64，解出恰 32 字节 |
| `DOWNLOAD_TOKEN_SECRET` | ✅（若要提供下载） | 下载令牌的 HMAC-SHA256 签名密钥；**≥32 字节** | `openssl rand -base64 32` | Base64 或 64 位 hex；缺失时下载接口按设计 **fail closed**（503），不会发无法签名的链接 |
| `NODE_ENV` | ✅ 生产 | 决定 `Secure` 强制、`abortOnError`、错误脱敏 | 固定 `production` | `production` |
| `HTTPS_ENABLED` | ✅ 生产 | 声明前面有 TLS（影响 Cookie 与 HSTS） | 固定 `true` | `true` |
| `TRUST_PROXY` | ✅（有代理时） | 决定 `req.ip` 是否可信 | `loopback` / CIDR / 跳数；**默认 `false`** | `loopback` |
| `SERVER_HOST` | 建议 | 监听地址；**默认 `localhost` 只监听回环** | 容器内设 `0.0.0.0` | `0.0.0.0` |
| `SERVER_PORT` | 建议 | 监听端口，默认 `3000` | 部署环境分配 | `3000` |
| `APP_VERSION` | 建议 | 健康检查/就绪检查返回的版本 | 发布流水线写入 git describe | `1.3.0-hardening` |

> `SERVER_HOST` 默认值是 `'localhost'`（`server/main.ts:63`）——
> **在容器/多机部署下如果不设 `0.0.0.0`，健康检查会从外部失败**，而进程日志仍然显示
> "Server running on localhost:3000"。这是最容易漏的一步。 [已证实：`main.ts:63-64,71-74`]

> ⚠️ **`MIGRATION_DATABASE_URL`** 是迁移专用覆盖项，优先级**高于** `DATABASE_URL`：
> `MIGRATION_DATABASE_URL || DATABASE_URL || SUDA_DATABASE_URL`
> （`scripts/migrate.mjs:80-83`、`scripts/db-snapshot.mjs:51-54`）[已证实]。
> 若给迁移使用特权角色，务必用这个变量显式指定，避免误用应用连接串。

### 2.2 可选（有安全默认值）

| 变量 | 默认 | 作用 | 证据 |
|---|---|---|---|
| `SESSION_COOKIE_NAME` | `qls_session` | 会话 Cookie 名 | `session.service.ts:8,44-45` |
| `SESSION_TTL_SECONDS` | `86400`（24h） | 会话有效期 | `session.service.ts:31-34` |
| `CSRF_STATE_TTL_SECONDS` | `300` | 遗留 OAuth state 的进程内 TTL | `session.service.ts:36-42` |
| `LOGIN_IP_RATE_LIMIT_MAX` | `30` | 每 IP 每窗口登录尝试上限 | `auth.service.ts:51` |
| `LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS` | `60` | 上述窗口（秒） | `auth.service.ts:50` |
| `CLIENT_BASE_PATH` | `/` | 前端路由基路径（构建期注入） | `client/src/index.tsx:14` |
| `CSP_MODE` | report-only | `enforce` 才真正拦截 CSP；`off` 关闭 | `security-headers.middleware.ts:86-91` |
| `MIGRATION_LOCK_TIMEOUT_MS` | `30000` | 迁移 advisory lock 等待上限 | `scripts/migrate.mjs:169` |
| `MIGRATION_APPLIED_BY` | `$USER` | 写入 `schema_migrations.applied_by` 的操作者标识 | `scripts/migrate.mjs:274` |
| `DOWNLOAD_TOKEN_TTL_SECONDS` | `300`（**硬上限 3600**） | 下载令牌有效期；超上限会被钳到 3600，非正数则报错 | `server/common/crypto/download-token.ts:54,57,63,138-149` |
| `QLS_MIGRATION_GUC_<NAME>` | — | 迁移期间注入事务级 GUC `qls.<name>`（`down` 的强制逃生门）。值走绑定参数，不能注入 SQL | `scripts/migrate.mjs` `applyMigrationGucs()` |
| `QLS_SOFT_DELETE_FORCE_DOWN` | — | `0007 down` 的显式别名（`on`/`1`/`true`/`yes`）；回收站非空时放行回滚 | 同上 + `0007_resource_soft_delete.down.sql:27,46` |
| `QLS_STRICT_PLATFORM_CLI` | `0` | 构建期：`capabilities/` 存在但平台 CLI 不可用时是否硬失败 | `scripts/postinstall.mjs:55`、`scripts/build.sh:40-43` |

> `LOGIN_IP_RATE_LIMIT_*` 在**模块加载时读取一次**（`auth.service.ts:41-51`），
> 改值必须重启进程才生效。 [已证实]

### 2.3 仅构建/测试期使用（不要配到生产运行环境）

`QLS_STRICT_PLATFORM_CLI`（`postinstall.mjs:55`）、`QLS_ALLOW_NO_DB`（`tests/*.test.mjs`）、
`AUTHZ_TEST_DB`、`MFA_BASE`（HTTP 验证套件）、`QLS_DEVTOOLS_DIR` / `QLS_DEV_PGPORT` /
`QLS_DEV_PGUSER` / `QLS_DEV_PGPASSWORD` / `QLS_DEV_PGDATABASE`（`dev-postgres.sh`）。 [已证实]

### 2.4 `.env.example` 与代码的差异（如实记录）

`.env.example` 中**声明了但代码从不读取**的变量：

| 变量 | 实际引用处数量 | 结论 |
|---|---|---|
| `LOG_DIR` | 1（仅 `.env.example` 自身） | **无效配置**，设了也没有任何作用 |
| `LOG_REQUEST_BODY` | 1 | 同上 |
| `LOG_RESPONSE_BODY` | 1 | 同上 |

[已证实：`grep -rn "<VAR>" server/ shared/ client/src/ scripts/ .env.example`]

而代码**实际读取但 `.env.example` 未列出**的：`SERVER_HOST`、`SERVER_PORT`、
`NODE_ENV`、`CSRF_STATE_TTL_SECONDS`、`CLIENT_BASE_PATH`、`DATABASE_URL`、
`SUDA_DATABASE_URL`、`MIGRATION_*`、`DOWNLOAD_TOKEN_SECRET`、
`DOWNLOAD_TOKEN_TTL_SECONDS`、`CSP_MODE`、`QLS_*`。 [已证实]（`PRODUCTION_READINESS.md` §G-12 记录过同类问题）

> 日志采集**不要**依赖 `LOG_DIR`。本应用没有文件日志配置，
> Nest `Logger` 全部写 stdout/stderr。见 §10。

---

## 3. 密钥生成

```bash
# ① MFA TOTP 密钥加密键（AES-256-GCM，必须恰好 32 字节）
openssl rand -base64 32
#   → 44 字符 Base64          ← 丢失后：所有已绑定 MFA 的账号（含 super_admin）永久无法登录

# ② 下载令牌签名密钥（HMAC-SHA256，至少 32 字节）
openssl rand -base64 32
#   → 44 字符 Base64          ← 丢失/更换后：已发出的短时下载链接作废，重新登录下载即可，无长期影响

# 也可以用 hex（两处代码都接受 64 位 hex）
openssl rand -hex 32
```

> ⚠️ **两个密钥的管理语义不同，不要混放、不要一起轮换**：
> `MFA_ENCRYPTION_KEY` 必须与数据库备份**配对且分开**保管（丢一个都不可逆）；
> `DOWNLOAD_TOKEN_SECRET` 可以随时轮换（见 [`RUNBOOK.md`](RUNBOOK.md) §7）。
> 详见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §3.3。

`mfa-crypto.ts:198-217` 的校验规则 [已证实]：
- 只接受 Base64 或 **64 位 hex**；
- 解码后**必须恰好 32 字节**（否则抛错，拒绝启动加密）；
- 缺失时不降级：无法开始 MFA 绑定，已启用的账号登录**失败关闭**。

### 3.1 关于"session 密钥"——**本系统不存在**

任务/模板文档常提到"生成 session secret / 下载签名密钥"。本系统**没有**：

| 常见项 | 本系统实际情况 |
|---|---|
| JWT / session 签名密钥 | **不存在**。会话是不透明随机令牌（`randomBytes(32)`），服务端只存 `sha256`。`session.service.ts` 全文无任何签名密钥。 [已证实] |
| 加密的会话 Cookie | **不存在**。Cookie 只有会话 id 本身，无内容。 |
| 下载签名密钥 | **存在**（写作期间新增）。`DOWNLOAD_TOKEN_SECRET`（HMAC-SHA256，≥32 字节）用于签发**带过期、绑定调用者**的下载令牌；实际文件直链由平台 `FileService` 签名。缺失该密钥时下载接口按设计 **fail closed**（503）。见 `server/common/crypto/download-token.ts`。 [已证实：文件头与实现] |

**因此"轮换会话密钥"在本系统的正确对应操作是：**

1. 轮换 `SESSION_COOKIE_NAME`（旧名的 cookie 立即不再被读取）——**或直接失效数据**：
   ```sql
   UPDATE sessions SET revoked = true, revoked_at = now(),
          revoke_reason = 'secret_rotation' WHERE revoked = false;
   ```
   （需由有权限的 DB 角色执行；见 [`RUNBOOK.md`](RUNBOOK.md) §6）
2. 让所有账号重新登录。
3. 其余相关配置（`SESSION_TTL_SECONDS`）不是秘密，无需轮换。

会话类**没有**签名密钥可轮换；下载令牌**有**（`DOWNLOAD_TOKEN_SECRET`），
轮换步骤见 [`RUNBOOK.md`](RUNBOOK.md) §7.4。

---

## 4. 数据库准备

> 本节的命令**本机无法执行**（无 `psql` 客户端），必须由部署环境执行并回填结果。 [无法验证]

### 4.1 创建数据库与角色（模板）

```bash
# 1) 创建应用库与角色（由 DBA 或有权限的部署账号执行）
export PGHOST=<host> PGPORT=5432 PGUSER=<admin_user>
createdb -O <app_owner_role> <db_name>

# 2) 应用连接角色（示例名）
psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE <app_role> LOGIN PASSWORD '<strong-password>';
GRANT CONNECT ON DATABASE <db_name> TO <app_role>;
GRANT USAGE  ON SCHEMA public TO <app_role>;
SQL
```

### 4.2 迁移后必须补的角色成员关系（**否则应用无法工作**）

migration `0004` 创建了空后缀角色 `anon_` / `authenticated_` / `service_role_`，
平台中间件对**每个请求**执行 `SET LOCAL ROLE`，而 `SET ROLE` 要求**成员关系**：

```sql
GRANT anon_           TO <app_role>;
GRANT authenticated_  TO <app_role>;
GRANT service_role_   TO <app_role>;
```

依据：`0004_rls_role_alignment.sql:48-54`（文件注释明确要求）[已证实]。
不执行会出现 `42501 permission denied`，表现为**登录报"用户名或密码错误"但不写审计**
（`0004` 文件头 §4-2 记录的实测现象）。

### 4.3 建库的三种入口

| 场景 | 做法 |
|---|---|
| **全新库（非平台）** | 用 `node scripts/db-bootstrap.mjs`（写作期间新增）。它按唯一可行的顺序执行：**幂等前导（`user_profile` 类型 + 三个 DB 角色，源码取自 `0001` 本身）→ `init.sql` → `migrate up`**。原因是 `init.sql` 需要类型与角色、而 `0001` 需要表，**两者互相依赖**，谁都不能单独先跑。 [已证实：文件头] |
| **平台库**（妙搭已提供类型与角色） | 直接 `node scripts/migrate.mjs up`（见 §5）——平台已把前导做好，**不需要** `db-bootstrap` |
| **已存在的库**（表已由平台/历史 `init.sql` 建好，但无迁移记录） | 先 `snapshot` 留底（§6.2），再 `node scripts/migrate.mjs baseline <version>` 把已有 migration 标记为已应用**而不执行**，然后 `up` 应用剩余项 |

> `baseline` 的使用前提：**该库已经具备被 baseline 的那几个 migration 的效果**。
> 用错会把"没建的表"标记为已建。执行前务必用 [`MIGRATION.md`](MIGRATION.md) §6.2 的核对清单人工确认。
> `migrate.mjs` 会打印醒目警告，但**不会替你判断**。 [已证实]

### 4.4 历史 `init.sql` 不要单独用于新库

- `server/database/init.sql` **单独**在原生 PostgreSQL 上**无法执行**（`42704 type "user_profile" does not exist`），
  重复执行会失败（`42710 policy ... already exists`），且缺少 6 个认证列。
  证据：`PRODUCTION_READINESS.md` §E-1/E-3/E-4 [已证实]。
- **新库一律走 `migrations/`**；`init.sql` 仅作为历史平台库的对照参考。

---

## 5. 执行迁移

```bash
# 0) 强烈建议：先做数据快照（不需要 psql，用 postgres.js）
DATABASE_URL="postgresql://…" node scripts/db-snapshot.mjs --out snapshots/before.json

# 1) 看状态（不修改任何东西）
DATABASE_URL="postgresql://…" node scripts/migrate.mjs status

# 2) 应用全部待执行迁移
DATABASE_URL="postgresql://…" node scripts/migrate.mjs up

# 2b) 只应用到某个版本（含）
DATABASE_URL="postgresql://…" node scripts/migrate.mjs up 0003

# 3) 校验校验和（不修改任何东西）
DATABASE_URL="postgresql://…" node scripts/migrate.mjs verify

# 4) 回滚（见 §5.4，务先读）
DATABASE_URL="postgresql://…" node scripts/migrate.mjs down 0005

# 5) 迁移后比对（自动检测丢表/丢列/丢行/RLS 被削弱）
node scripts/db-snapshot.mjs --out snapshots/after.json
node scripts/db-snapshot.mjs --compare snapshots/before.json --against snapshots/after.json
```

等价的 npm 入口：`npm run migrate`（= `node ./scripts/migrate.mjs`）、
`npm run migrate:status`、`npm run db:snapshot`（`package.json:22-24`）[已证实]。
**没有** `migrate:up` / `migrate:down` 这类脚本名，不要写。

### 5.1 运行器保证（逐条对应代码）

| 保证 | 实现 | 证据 |
|---|---|---|
| **校验和** | 每个 `.sql` 的 `sha256` 记入 `schema_migrations.checksum`；已应用文件被改动 → `up` **拒绝执行**（fail closed），退出码 **2** | `migrate.mjs:121,187-197,256-263` |
| **advisory lock** | `pg_try_advisory_lock(918273645)`，轮询获取；超时（默认 30s）即失败退出 | `migrate.mjs:56,168-182` |
| **每迁移独立事务** | `BEGIN → sql → INSERT schema_migrations → COMMIT`；失败 `ROLLBACK` 并 exit 1 | `migrate.mjs:276-302` |
| **绝不删库/清数据** | `up` 不含任何 `DROP DATABASE` / `TRUNCATE` / 数据删除语句 | `migrate.mjs` 文件头 `:28` |
| **失败即非 0 退出** | 所有失败路径都 `return 1` / `return 2` → `process.exit(code)` | `migrate.mjs:386-409` |
| **状态可读** | 用 `to_regclass('public.schema_migrations')` 探测，迁移框架尚未安装的库也能正确报告而不是崩 | `migrate.mjs:155-166` |

### 5.2 `status` 的真实输出（本次实测）

```console
$ SUDA_DATABASE_URL="postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_0005" \
    node scripts/migrate.mjs status
Database  qls_test_0005 as qlsadmin
Server    PostgreSQL 16.14 on x86_64-apple-darwin24.6.0

Migrations
  applied  0001_schema_baseline_alignment 2026-09-24T01:40:39.284Z
  applied  0002_backfill_legacy_usernames 2026-09-24T01:40:39.290Z
  applied  0003_rbac_database_layer 2026-09-24T01:40:39.291Z
  applied  0004_rls_role_alignment 2026-09-24T01:40:39.297Z
  applied  0005_tighten_rls_writes 2026-09-24T01:40:39.300Z
  applied  0006_mfa 2026-09-24T01:55:46.584Z

✓ No checksum drift.
$ echo $?
0
```
**[已证实]** —— 这是本次会话真实执行的输出（密码已打码）。逐迁移明细见 [`MIGRATION_REPORT.md`](MIGRATION_REPORT.md)。

输出约定（读代码得出）：
- `applied`（绿）/ `pending`（黄）；缺少 `.down.sql` 会在行尾标注 `(no .down.sql)`；
- 发现校验和漂移时打印 `CHECKSUM DRIFT` 清单并**返回 2**；
- `status` / `verify` **不建表、不改数据**（只有 `up`/`down`/`baseline` 会 `ensureMigrationsTable`）。

### 5.3 漂移（checksum drift）意味着什么、怎么办

现象：`status` 打印 `CHECKSUM DRIFT — an already-applied migration file has been modified`，退出码 2；
`up` 直接拒绝执行。

原因：**已应用的 migration 文件被编辑过**。数据库里的结构与"记录中执行过的 SQL"不再对应。

正确处理（唯一正确做法）：
1. **不要**为了消除报错去改 `schema_migrations.checksum`。
2. `git checkout -- server/database/migrations/<被改的文件>` 还原，
   或用 `git log -p` 找出改动并评估。
3. 若要变更结构 → **新增一个 `000N_*.sql`**（见 [`MIGRATION.md`](MIGRATION.md)）。
4. 详见 [`MIGRATION.md`](MIGRATION.md) §3。

### 5.4 回滚：**先读这一段再动手**

```bash
node scripts/migrate.mjs down <target_version>
```

语义（`migrate.mjs:309-355`）[已证实]：
- 回滚**所有** `version >= target` 且已应用的迁移，**从新到旧**；
- 逐个执行同名 `.down.sql`，并在同一事务内 `DELETE FROM schema_migrations`；
- 任一 `.down.sql` 缺失 → **整体拒绝**，退出码 2（不会回滚一半）。

**回滚不是"撤销"。** 每个 `down` 都带**拒绝守卫**，这是设计而不是缺陷：

| migration | `down` 的拒绝条件 | 证据 |
|---|---|---|
| `0001` | 只要 `teachers` 里有任何认证数据（`password_hash`/`username`/`locked_until`… 非空）就 `RAISE EXCEPTION`，拒绝删列 | `0001_….down.sql:23-52` |
| `0002` | 若回滚会导致**0 个可登录账号**则拒绝 | `0002_….down.sql:54-70` |
| `0003` | `account_permission_overrides` / `account_scopes` 有数据时拒绝（除非显式设 `QLS_RBAC_FORCE_DOWN`） | `0003_….down.sql:19-32` |
| `0005` | **不拒绝，但会重新打开提权路径**（匿名角色恢复可 `UPDATE teachers.password_hash`/`roles`、可删审计） | `0005_….down.sql:1-13` |
| `0006` | 存在**已确认**的 MFA 绑定时拒绝（除非 `QLS_MFA_FORCE_DOWN=on`） | `0006_mfa.down.sql:18-38` |

> ⚠️ `0005 down` 之后必须尽快 `up` 回来，或按
> [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) 从备份恢复。
> **回滚生产前必须先备份**（§13）。数据安全类回滚的真正手段是**恢复备份**，不是 `down`。

---

## 6. 构建

### 6.1 步骤

```bash
# 1) 安装依赖（使用 lockfile，可复现）
npm ci

# 2) 构建（= scripts/build.sh，6 步）
npm run build

# 体积与内容自检
du -sh dist
ls dist/dist/client/index.html      # 必须存在，否则构建脚本本身会 exit 1
```

可用 `npm run build:server` / `npm run build:client` 单独构建
（`package.json:18-19`）[已证实]。

### 6.2 `scripts/build.sh` 六个步骤（真实名称与行为）

| 步骤 | 内容 | 关键行为 |
|---|---|---|
| `[0/6] 安装插件` | 平台 action-plugin | **仅当存在 `capabilities/` 目录**才执行，且只用 `npx --no-install`（绝不联网拉同名第三方包）；否则跳过。`QLS_STRICT_PLATFORM_CLI=1` 可把跳过变成硬失败。`build.sh:31-45` |
| `[1/6] 更新 openapi 代码` | `npm run gen:openapi` | 实为 `echo 'UNSUPPORTED, SKIP'`（`package.json:15`） |
| `[2/6] 清理 dist` | `rm -rf dist` | — |
| `[3/6] 生成路由定义` | `npx generate-api-routes` / `generate-page-routes` | 失败**仅告警**，不影响构建 |
| `[4/6] 并行构建 server + client` | `npm run build:server` + `build:client` | 任一失败 → exit 1；注入 `--max-old-space-size=8192` 缓解 OOM |
| `[5/6] 准备产物` | 搬 HTML、拷 `run.sh`、拷 `.env` | **入口 HTML 必须落到 `dist/dist/client/index.html`，否则硬失败 exit 1**（`build.sh:194-204`） |
| `[6/6] 智能依赖裁剪` | `scripts/prune-smart.js` | **该脚本不存在** → 跳过并告警（产物含完整 `node_modules` 之外的东西会被跳过），不失败（`build.sh:243-248`） |

### 6.3 `dist/` 真实布局（本机 `npm run build` 产物，已实测）

```
dist/                              (总计 11 MB)
├── run.sh                          ← 从 scripts/run.sh 拷入：NODE_ENV=production node server/main.js
├── client/                         ← 静态资源（可交给 CDN/静态服务）
│   ├── assets/                     ← index-*.js / index-*.css / polyfills.js / radix-*.js / *.map
│   ├── client/                     ← 空目录（HTML 已被移走）
│   ├── favicon.svg
│   └── routes.json
├── dist/
│   └── client/
│       ├── index.html              ← ★ 视图引擎实际渲染的入口文档（约 5.7 KB）
│       ├── client/                 ← 空目录
│       └── favicon.svg
├── server/                         ← 编译后的 NestJS 应用
│   ├── main.js                     ← 入口
│   ├── app.module.js
│   ├── common/ database/ modules/ shared 不存在于此层
│   └── assets/prek-english-covers/ ← 34 张绘本封面（nest-cli.json assets 规则）
└── shared/                         ← api.interface.js, rbac.js
```

依据：`ls -R dist`（本次实测）、`nest-cli.json:16-24`、`tsconfig.node.json:5`（`outDir: ./dist`）、
`scripts/run.sh`。 [已证实]

- **`dist/node_modules` 不存在** —— 因为 `scripts/prune-smart.js` 不存在，裁剪被跳过，
  依赖直接来自运行环境的 `node_modules`（构建目录本身）[已证实]。
- **入口 HTML 在 `dist/dist/client/`（两层 `dist`）不是笔误**：
  服务端 `app.setBaseViewsDir(join(process.cwd(), 'dist/client'))`（`server/main.ts:67`），
  而生产从 `dist/` 作为 cwd 启动（`package.json:20` 的 `cd dist && …`），
  于是解析为 `dist/dist/client`。产物必须放在那里。 [已证实]

### 6.4 ⚠️ 构建会把仓库根的 `.env` 复制进产物

`build.sh:214-218`：
```bash
if [ -f "$ROOT_DIR/.env" ]; then cp "$ROOT_DIR/.env" "$DIST_DIR/"; fi
```
若构建机上存在 `.env`，**密钥会进入发布产物**。 [已证实]

发布前必做：
```bash
# 确认产物里没有 .env
find dist -maxdepth 1 -name '.env*' -print
# 或干脆不在构建机上放 .env，改用运行环境的注入
```
该行为**未修复**（[`SECURITY.md`](SECURITY.md) §12 G-16）。

### 6.5 平台/架构限制

```
$ node -e "const l=require('./package-lock.json'); …"
lockfileVersion 3 · 1513 packages · 平台门控条目 12 条 —— 全部为 "linux / x64"
darwin-* 条目：0
```
[已证实]

后果（`npm ci --dry-run` 实测，**未真正修改 node_modules**）：
```
added 12 packages, and removed 6 packages
remove lightningcss-darwin-arm64 …
remove @tailwindcss/oxide-darwin-arm64 …
remove @swc/core-darwin-arm64 …
remove @rolldown/binding-darwin-arm64 …
remove @napi-rs/nice-darwin-arm64 …
```
[已证实] —— 在 **macOS/arm64** 上执行 `npm ci` 会**移除本机构建所需的 5 个原生绑定**，
之后 `build:server` / `build:client` 会 `MODULE_NOT_FOUND`。

| 结论 | 说明 |
|---|---|
| **linux-x64（aPaaS 目标）**：lockfile 正确，`npm ci` 可用 | 不要"顺手重新生成" lockfile，那会反过来丢掉 linux 条目 |
| **macOS/arm64 开发者**：`npm ci` 会破坏本地依赖树 | 用 `npm install`（保留本机平台绑定），或先在 arm64 上重建 lockfile —— 但**不要把这个 lockfile 提交为发布用** |
| `npm ci` 与 `package.json` 是否同步 | ✅ 本次 `npm ci --dry-run` 退出 0，未报 "not in sync"；`dependencies` / `devDependencies` / `engines` 与 lockfile 根节点逐项一致（`overrides` 未记录在 lockfile 中）[已证实] |

---

## 7. 启动

```bash
# 推荐：使用 npm 脚本（内部会 cd dist）
NODE_ENV=production \
SERVER_HOST=0.0.0.0 \
SERVER_PORT=3000 \
DATABASE_URL="postgresql://…" \
MFA_ENCRYPTION_KEY="<base64-32B>" \
HTTPS_ENABLED=true \
TRUST_PROXY=loopback \
npm run start

# 等价写法（产物内自带 run.sh）
cd dist && ./run.sh
```

`package.json:20` 定义：`"start": "cd dist && NODE_ENV=production node server/main.js"`。 [已证实]

启动成功日志（`server/main.ts:73-79`）：
```
LOG [Bootstrap] Server running on 0.0.0.0:3000
LOG [Bootstrap] API endpoints ready at http://0.0.0.0:3000/api
LOG [Bootstrap] trust proxy: <描述>
LOG [Bootstrap] security headers: on (csp=report-only, hsts=…)
LOG [Bootstrap] environment: NODE_ENV=production HTTPS_ENABLED=true
```

### 7.1 非平台部署必须先解决的两件事

1. **`FORCE_AUTHN_INNERAPI_DOMAIN`**：只要引入 `PlatformModule`，
   平台 HTTP 客户端在构造时就要求该变量，否则**进程直接退出**：
   ```
   ERROR [ExceptionHandler] 平台模式需要基础域名，请设置环境变量 FORCE_AUTHN_INNERAPI_DOMAIN
   ```
   [已证实，`PRODUCTION_READINESS.md` §O-1]
   两种解法（均已记录实测）：
   - 设一个占位值（如 `FORCE_AUTHN_INNERAPI_DOMAIN="https://127.0.0.1:1"`）→ 应用可独立运行
     （§O-2 实测：`Nest application successfully started` + `GET /api/auth/config` → 200）；
   - 或改用 `PlatformModule.forRoot({ httpClient: { enabled: false } })`（更干净，源码已确认该路径不读域名）。
2. **文件存储**：平台 dataloom 不可用时，上传/下载必须替换为自有实现（当前上传/下载本身也未生产化，
   见 [`SECURITY.md`](SECURITY.md) §12 G-3）。

### 7.2 启动时的自检日志（要会看）

| 日志 | 含义 | 处理 |
|---|---|---|
| `Seed teachers: created=N, skipped=M` | 初始账号 seed 结果 | N=0 且 M=0 表示一个账号都没建 → 见 [`RUNBOOK.md`](RUNBOOK.md) §5.3 |
| `Failed to seed teacher <user>: …` | 单个账号失败 | **会被逐条 catch 并继续启动**（`auth.service.ts:223-229`）。这是已知缺陷（§J-3），必须当故障处理 |
| `trust proxy: …` | 客户端 IP 是否可信 | 必须与部署拓扑一致，见 §9 |
| `TRUST_PROXY=true in production: …`（WARN） | 信任了所有跳 | 按 §9 改成 `loopback`/CIDR |
| `cache-service: failed to read token file /var/run/secrets/zti/credential` | 平台遥测不可用 | 非平台部署可忽略（仅一条警告）[已证实，§O-2] |

### 7.3 优雅退出：**当前未实现**

`server/` 全目录搜索：**没有** `app.enableShutdownHooks()`、
**没有** `SIGTERM`/`SIGINT` 处理、**没有** `onModuleDestroy` / `beforeApplicationShutdown`。 [已证实]

后果：
- `SIGTERM` 会使进程**立即退出**，不排空在途请求、不关闭数据库连接池；
- `auth.service.ts:91-93` 的每小时会话清理 `setInterval` **没有清理函数**，会悬挂到进程结束。

发布建议（缓解，不是修复）：
1. 编排层 `terminationGracePeriodSeconds` 给足，并在发 SIGTERM 前**先从负载均衡摘除**
   （依赖 `/api/health/ready` 返回 503 或直接摘节点）。
2. 长事务/长请求窗口内不要滚动重启。
3. 若要真正实现优雅退出，需在 `main.ts` 加 `app.enableShutdownHooks()` 并给
   `AuthService` 加 `onModuleDestroy` 清理定时器 —— **这是代码改动，不在文档职责内**。

---

## 8. 健康检查与就绪检查

| 端点 | 语义 | 依赖 | 返回 |
|---|---|---|---|
| `GET /api/health` | **存活**（liveness） | **不碰任何依赖** | `200 {"status":"ok","version":…,"uptimeSeconds":…,"timestamp":…}` |
| `GET /api/health/ready` | **就绪**（readiness） | 数据库 + 关键表 + `schema_migrations` | `200` 就绪 / **`503`** 不就绪 |

两者都 `@Public()`，且**刻意不返回任何配置**（无 DSN/主机/库名/用户/迁移文件路径）。
证据：`server/modules/health/health.module.ts:8-33,172-197` [已证实]

**实测输出（运行中的实例，本次会话）：**
```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/api/health
200
$ curl -s http://127.0.0.1:3200/api/health
{"status":"ok","version":"1.3.0-hardening","uptimeSeconds":392,"timestamp":"2026-09-24T02:13:56.667Z"}

$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/api/health/ready
200
$ curl -s http://127.0.0.1:3200/api/health/ready
{"status":"ready","version":"1.3.0-hardening","uptimeSeconds":392,
 "timestamp":"2026-09-24T02:13:56.684Z",
 "checks":{"database":{"ok":true,"latencyMs":9},"schema":{"ok":true},
           "migrations":{"ok":true,"applied":6}}}
```
**[已证实，2026-09-24]**

### 8.1 编排配置建议

```yaml
# 概念示例（仓库中没有现成的编排文件，见 §0）
livenessProbe:   { httpGet: { path: /api/health,       port: 3000 }, periodSeconds: 10, failureThreshold: 3 }
readinessProbe:  { httpGet: { path: /api/health/ready, port: 3000 }, periodSeconds: 10, failureThreshold: 2 }
startupProbe:    { httpGet: { path: /api/health,       port: 3000 }, failureThreshold: 30, periodSeconds: 2 }
```
- 存活探针**不要**打 `/ready`：数据库短暂不可用会让编排器杀掉本来健康的进程
  （该设计意图写在 `health.module.ts:12-26`）。
- 滚动更新时把 `/ready` 作为**摘流量**依据。

### 8.2 一个必须知道的实现细节

`readiness()` 的 migrations 检查实际执行的是
```sql
SELECT (SELECT count(*)::int FROM schema_migrations) AS applied,
       (SELECT count(*)::int FROM schema_migrations) AS applied_only
```
即**同一个子查询写了两遍**，`ReadinessReport` 类型里声明的 `pending?` **从未被赋值**。
它只回答"迁移框架是否已在本库运行过"，**不回答"是否有 pending 迁移"**。
要判断 pending，请用 `node scripts/migrate.mjs status`。 [已证实，`health.module.ts:144-160`]

### 8.3 `/api/health` 的路由顺序约束（改代码时会踩）

`HealthModule` **必须**注册在 `ViewModule` 之前：`ViewModule` 的 `@Get(['/', '*'])` 兜底路由
会吞掉 `/api/health` 并返回 SPA。`server/app.module.ts:31-39` 有注释与顺序。 [已证实]

---

## 9. 反向代理要求（**本节是安全关键**）

### 9.1 `trust proxy` —— 设错就等于没有 IP 限流、没有可信审计

**风险（已实测过的真实后果）**：修复前，请求带
`X-Forwarded-For: 203.0.113.99, 10.0.0.1` 时，`audit_logs.ip_address` 被记成
**`203.0.113.99`（攻击者自选值）** → 按 IP 的登录限流可用轮换 header 绕过，审计无法归因。
[已证实，`PRODUCTION_READINESS.md` §Q-2]

**根因**：`configureApp()`（平台包）末尾执行 `app.set("trust proxy", true)`，
**在此之前设置的值被静默丢弃**。因此本应用在 `configureApp()` **之后**重新设置
（`server/main.ts:34-61`）。 [已证实]

**正确设置（按拓扑二选一）**：

| 拓扑 | `TRUST_PROXY` | 效果 |
|---|---|---|
| 应用直接暴露（无代理） | **不设** 或 `false` | `req.ip` = socket 地址，不可伪造（**安全默认**） |
| 代理与应用同机（典型 Nginx） | `loopback` | 只信任回环来源追加的 `X-Forwarded-For` |
| 恰好一跳可信代理 | `1` | 信任最右 1 跳 |
| 可信网段 | `10.0.0.0/8,192.168.0.0/16` | 逗号分隔 CIDR/地址/关键字（`loopback`/`linklocal`/`uniquelocal`） |
| 单一全权代理且必然覆写 XFF | `true`（**不推荐**） | 信任所有跳；生产环境会打 WARN |

依据：`server/common/http/client-ip.ts:47-80`、`server/main.ts:81-87` [已证实]

> **必须同时满足的两个条件，缺一不可：**
> 1. `TRUST_PROXY` 与真实跳数/CIDR 一致；
> 2. 反向代理**覆写**（不是追加）入站 `X-Forwarded-For` 与 `X-Real-IP`。
>
> 只做第 1 条而代理是"追加"语义时，最右一跳仍是攻击者可影响的值。
> 例：Nginx 用 `proxy_set_header X-Forwarded-For $remote_addr;`（覆写），
> **不要**用 `$proxy_add_x_forwarded_for`（追加）。

**验证方法（部署后必做）**：
```bash
# 从外部发一个伪造 XFF 的请求，然后看审计里的 IP 是否是自己真实出口 IP
curl -s -o /dev/null -X POST https://<域名>/api/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.99' \
  -d '{"username":"__nonexistent__","password":"x"}'
# 然后（有 DB 权限时）：
#   SELECT ip_address, action, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 1;
# 期望：你的真实 IP，而不是 203.0.113.99
```
（仓库自带 `scripts/verify-hardening.mjs` 的第 A 项就是这个断言，需运行中的服务 + `AUTHZ_TEST_DB`。）

### 9.2 HTTPS / CSP / Cookie 的联动

- 生产 `NODE_ENV=production` 时 `Secure` **强制开启**，`HTTPS_ENABLED=false` 关不掉
  （`session.service.ts:47-51`）[已证实] → **没有 TLS 就没有登录**。
- HSTS 只在 `HTTPS_ENABLED=true` 或 `TRUST_PROXY` 非 false 时才输出
  （`security-headers.middleware.ts:94-103`）——即在纯 HTTP 下**故意不发** HSTS，避免锁死。
- 平台下发的 CSRF cookie 被硬编码为 `Secure; SameSite=None; Partitioned`
  （本次 curl 实测确认）→ **必须在 HTTPS 下访问**，且它带 `Partitioned`（CHIPS），
  说明平台预期页面可能被 iframe 嵌入。

> ⚠️ **需要在启用之前解决的设计冲突（重要）**
> 工作区新增的安全响应头设置了 `X-Frame-Options: DENY` 与 CSP `frame-ancestors 'none'`，
> 而平台把 CSRF cookie 标成 `Partitioned`（只在第三方 iframe 场景下才有意义），
> 且旧 `DEPLOYMENT.md:299-301` 声称需要嵌入企业微信/飞书/学校门户 iframe。
> 两者**不能同时成立**。上线前必须确认本平台是否被 iframe 嵌入：
> - 不嵌入 → 保持 `DENY` + `frame-ancestors 'none'`（推荐，防点击劫持）；
> - 需要嵌入 → 必须改为 `SAMEORIGIN` 或指定的 `frame-ancestors` 白名单。
> [已证实：两处代码事实] [推断：二者互斥]
> 另外，**当前运行中的实例还没有输出这些头**（见 §9.4），所以这个冲突尚未在生产显现。

### 9.3 代理层建议

| 项 | 要求 |
|---|---|
| TLS | 1.2+；关闭 SSLv3/TLS1.0/1.1；证书自动续期 |
| HTTP → HTTPS | 301 跳转；**注意**纯 HTTP 下的登录一定失败（`Secure` cookie） |
| 请求体上限 | 至少覆盖文件上传需求；当前服务端**没有**独立的上传接口（[`SECURITY.md`](SECURITY.md) §12 G-3），上限按平台直传策略设定 |
| 超时 | 后端默认无长连接需求；`proxy_read_timeout` ≥ 60s 足够 |
| 真实 IP | 见 §9.1，覆写 `X-Forwarded-For` |
| 登录限流 | **强烈建议在此再加一层按 IP 的限流**，因为应用内限流是进程内的（[`SECURITY.md`](SECURITY.md) §2.4） |
| 静态资源 | `dist/client/assets/*` 带内容哈希，可长缓存；`index.html` **不要**长缓存 |

### 9.4 安全响应头的当前状态（不要让验收误判）

代码已存在（`server/common/http/security-headers.middleware.ts` + `main.ts` 接入），
**但运行中的实例不输出任何这些头**，且**原因已查明**：

```
$ curl -sI http://127.0.0.1:3200/api/health
X-Powered-By: Express
x-request-id: 9df81526-…
（无 nosniff / X-Frame-Options / Referrer-Policy / CSP / HSTS）

$ ls dist/server/common/http/
client-ip.js                       ← 只有这一个；security-headers.middleware.js 不存在
$ grep -c securityHeaders dist/server/main.js
0
$ stat -f '%Sm %N' server/main.ts dist/server/main.js
server/main.ts        2026-09-24 10:11:58
dist/server/main.js   2026-09-24 10:10:23     ← 产物比源码旧
```
[已证实] 即：**`dist/` 是陈旧的**，必须重新 `npm run build` 并重启，
之后再用 `curl -sI` 复验。在此之前，`PRODUCTION_READINESS.md` §G-9「无安全响应头」仍然成立。

---

## 10. 日志采集

| 事实 | 说明 | 证据 |
|---|---|---|
| 全部日志走 **stdout/stderr** | Nest `Logger` 默认输出；代码中**没有任何文件日志配置** | `server/main.ts:15,73-87` 等 |
| **`LOG_DIR` / `LOG_REQUEST_BODY` / `LOG_RESPONSE_BODY` 是无效变量** | 代码从不读取（§2.4） | grep 结果 |
| 关联 ID | 每个响应带 `x-request-id`；500 响应体也带 `requestId` | `request-id.middleware.ts:37-50` [已证实] |
| 上游 ID | 合法（≤128 字符、字符集受限）的入站 `x-request-id` 会被沿用，畸形则重新生成（防日志注入） | `request-id.middleware.ts:7-19` [已证实] |
| 客户端 IP | 由 `req.ip` 决定，取决于 §9.1 | 同上 |
| **日志脱敏白名单** | ❌ **未实现**。password / cookie / sessionId / MFA secret / recovery code / DSN 等没有过滤器 | [`SECURITY.md`](SECURITY.md) §12 G-10 |

采集建议：
1. 由编排/平台采集容器 stdout（journald / 平台日志服务 / Loki / ELK），不要往容器内写文件。
2. **检索关键字**（运维最常用）：
   - `Unhandled exception [requestId=` —— 5xx 全量日志（`exception.filter.ts:110-114`）
   - `Failed to seed teacher` —— 初始账号 seed 失败（**严重**）
   - `Session invalidated by permission change` —— 权限变更导致的强制重登（正常）
   - `Blocked request from an MFA-required account that has not enrolled` —— 未绑定 MFA 被拦
   - `MFA disabled for teacher` （WARN）—— 有账号解绑了 MFA，需人工确认
   - `Password reset by admin for:` —— 管理员重置口令
3. 保留期与访问控制由部署方定义（审计的权威记录在 `audit_logs` 表，不在日志里）。
4. 上报缺陷时请附 `x-request-id`，它是日志与响应对应的唯一凭据。

---

## 11. 滚动更新 / 零停机

> 仓库中**没有** Dockerfile / docker-compose / CI / IaC（§0 已证），
> 因此下面是**流程要求**，不是"已配置好的能力"。 [已证实]

### 11.1 顺序

```
1. 备份数据库（DISASTER_RECOVERY.md §3）+ 记录 schema_migrations 版本
2. 迁移（在旧版本仍在服务时执行）：node scripts/migrate.mjs status → up
   - 迁移是"向前兼容"的：0001~0006 都是加列/加表/加触发器，不删列不删数据
   - advisory lock 保证多个实例同时启动时不会交错执行
3. 构建新产物：npm ci && npm run build
4. 逐台滚动：新实例起来 → /api/health/ready 返回 200 → 加入负载均衡
             → 旧实例从负载均衡摘除 → 停止
5. 复验：/api/health/ready、登录、关键页面、审计是否有写入
```

### 11.2 这次滚动更新会**踢人下线**（提前告知用户）

migration `0003` 引入 `permissions_version` 并装上自增触发器，
`0001` 修订 `teachers` 结构。对**已经在线的旧会话**：

- 旧会话没有 `permissions_version` 或值不匹配 → `AuthGuard` 会
  `destroySession(…, 'permissions_changed')` 并返回 `401 权限已变更，请重新登录`
  （`auth.guard.ts:121-134`）。 [已证实]

**结论：升级窗口内所有教师需要重新登录。** 请安排在非上课时段，并提前通知。

### 11.3 多实例的已知限制（务必据此决策）

| 限制 | 影响 | 缓解 |
|---|---|---|
| **登录限流是进程内的** | N 副本 → 有效上限 ×N | 在代理层加一层按 IP 限流（§9.3） |
| MFA challenge 已落库 | ✅ 多实例安全，无此问题 | — |
| 会话在数据库 | ✅ 多实例安全，重启不掉线 | — |
| `CSRF_STATE_TTL_SECONDS` 的 state Map 在进程内 | 该 state 是 v1.3.0 之前 WeCom OAuth 的遗留路径，当前登录流程不使用 | 无需处理 |
| 无优雅退出 | 停止实例会中断在途请求 | 先摘流量再停（§7.3） |
| 无分布式锁用于业务操作 | — | 目前不需要 |

### 11.4 回滚发布

```bash
# 1) 回滚应用：切回上一个产物目录/镜像（应用层回滚是首选，不动数据库）
# 2) 若必须回滚数据库结构：
node scripts/migrate.mjs down <上一个版本>     # 先读 §5.4 的拒绝守卫
# 3) 若 down 被拒绝（有数据依赖），正确做法是恢复备份：
#    见 DISASTER_RECOVERY.md §5
```
**不要**用"重建数据库"或"重置 seed"来充当回滚。见 [`MIGRATION.md`](MIGRATION.md) §7。

---

## 12. 发布前检查清单

### 12.1 必须通过（阻塞发布）

- [ ] `git status --short` 为空（没有未提交改动进入发布）
- [ ] `npm ci` 在 **linux-x64** 构建机上 exit 0
- [ ] `npm run build` exit 0，且 `dist/dist/client/index.html` 存在
- [ ] `find dist -maxdepth 1 -name '.env*'` 无输出（§6.4）
- [ ] `DATABASE_URL=… node scripts/migrate.mjs status` → 无 pending、无 drift
- [ ] `node scripts/db-snapshot.mjs --compare before.json --against after.json` → 无 integrity problem
- [ ] `NODE_ENV=production` 下 `GET /api/health` → 200
- [ ] `NODE_ENV=production` 下 `GET /api/health/ready` → 200（拿到 503 就是没就绪，不要当成"起来了"）
- [ ] 未登录访问受保护 API → 401；无权限 → 403（含审计写入）
- [ ] CSRF 四态验证通过（[`SECURITY.md`](SECURITY.md) §6）
- [ ] **伪造 `X-Forwarded-For` 后审计记录的是真实 IP**（§9.1）
- [ ] `MFA_ENCRYPTION_KEY` 已配置且**已与数据库备份分开备份**
- [ ] 超级管理员已完成 MFA 绑定并能成功登录（含恢复码验证一次）
- [ ] 回滚方案已写明：**上一个产物版本 + 备份文件位置 + 恢复责任人**

### 12.2 必须在部署环境复核（本机无法验证）

- [ ] 反向代理下 `trust proxy` 行为（§9.1）：伪造 XFF 不影响 `req.ip`
- [ ] TLS 下 Cookie 属性含 `Secure`；`SameSite` 与是否 iframe 嵌入一致（§9.2）
- [ ] HSTS 在 HTTPS 下出现、在纯 HTTP 下不出现
- [ ] 安全响应头实际出现（需**重新构建+重启**，见 §9.4）
- [ ] requestId 的响应头与 500 响应体一致（[`SECURITY.md`](SECURITY.md) §12 G-9）
- [ ] 备份/恢复演练通过（[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §8）
- [ ] 平台侧：dataloom 存储、`{{...}}` HBS 占位符替换、vefaas 发布行为
- [ ] 容器/编排（若使用）与探针配置

### 12.3 已知缺口（不阻塞"内部可用"，但阻塞"公网安全发布"）

完整清单见 [`SECURITY.md`](SECURITY.md) §12 与 [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) §R-4。
其中与部署直接相关的三条：

1. 限流进程内 → 多副本必须在代理层补限流；
2. 文件上传/下载未生产化（下载是**未签名、无过期**的 URL）；
3. 安全响应头尚未生效（需重新构建）。

---

*本手册中的所有命令都已核对存在性（脚本名 / npm 脚本名取自 `package.json` 与 `scripts/`）。
未在本机执行的步骤一律标注 [无法验证]，不做"已通过"的陈述。*
