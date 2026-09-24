# RUNBOOK.md — 运维手册

> **文档基线**：git commit `671328a` + 写作时工作区改动。
> 本文所有命令与端点都已核对存在性（脚本名取自 `scripts/`，npm 脚本名取自 `package.json`，
> 端点取自 controller 装饰器，并对照本机运行实例实测）。
>
> **证据标记**：**[已证实]** 本次实测或源码逐行确证 · **[推断]** 由代码/配置互推 ·
> **[无法验证]** 需部署环境确认。
>
> 相关文档：部署 [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) ·
> 迁移 [`MIGRATION.md`](MIGRATION.md) · 备份恢复 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) ·
> 安全 [`SECURITY.md`](SECURITY.md) · 威胁 [`THREAT_MODEL.md`](THREAT_MODEL.md)

---

## 0. 值班速查（先看这张表）

| 症状 | 跳到 | 一句话原因 |
|---|---|---|
| `/api/health/ready` 返回 503 | §5.1 | 数据库不可达 / 缺表 / 迁移框架未跑过 |
| 所有人瞬间掉线，提示"权限已变更" | §5.5 | 有人改了角色/状态/权限 → `permissions_version` 变 → 会话按设计失效 |
| 某人登录报"账号已锁定" | §5.3 | 连续 5 次失败，锁 15 分钟 |
| 密码正确但提示"用户名或密码错误" | §5.3-⚠️ | 账号无 `password_hash`；或 DB 角色不匹配导致**静默 0 行** |
| super_admin 登录后什么都 403 | §5.4 | 未绑定 MFA，`AuthGuard` 默认拒绝一切 |
| 忘记 MFA 且恢复码也没了 | §5.4.3 | 只能由 DBA 删 `teacher_mfa` 行后重新绑定 |
| 迁移报 `CHECKSUM DRIFT` | §5.2 | 已应用的迁移文件被改过 → 还原或新增迁移 |
| 页面白屏 / 静态资源 404 | §6.2 | `dist/dist/client/index.html` 缺失或未重启 |
| 需要回滚 | §6 | 先回滚产物，再考虑 `down`，最后才考虑恢复备份 |

---

## 1. 进程生命周期

### 1.1 生产启动

```bash
cd <部署目录>
NODE_ENV=production \
SERVER_HOST=0.0.0.0 \
SERVER_PORT=3000 \
DATABASE_URL="postgresql://…" \
MFA_ENCRYPTION_KEY="<base64-32B>" \
HTTPS_ENABLED=true \
TRUST_PROXY=loopback \
npm run start
```

- `npm run start` 的实际命令是 `cd dist && NODE_ENV=production node server/main.js`
  （`package.json:20`）[已证实]。
- 等价入口：`cd dist && ./run.sh`（`scripts/run.sh` 内容就是
  `NODE_ENV=production node server/main.js`）[已证实]。
- ⚠️ **`SERVER_HOST` 默认是 `localhost`**（`server/main.ts:63`）→ 不设
  `0.0.0.0` 时只有本机能访问。 [已证实]

启动成功的标志（4 行日志 + 1 行环境）：
```
LOG [Bootstrap] Server running on 0.0.0.0:3000
LOG [Bootstrap] API endpoints ready at http://0.0.0.0:3000/api
LOG [Bootstrap] trust proxy: disabled (req.ip = socket address; X-Forwarded-For ignored)
LOG [Bootstrap] security headers: on (csp=report-only, hsts=…)
LOG [Bootstrap] environment: NODE_ENV=production HTTPS_ENABLED=true
```
来源：`server/main.ts:73-79`。

### 1.2 停止 / 重启

**本应用没有 stop/restart 脚本**（`scripts/` 中只有
`build.sh` `db-snapshot.mjs` `dev-postgres.sh` `dev.sh` `migrate.mjs` `postinstall.mjs`
`run.sh` `verify-*.mjs` `verify-all.sh`）[已证实]。因此：

```bash
# 前台运行时：Ctrl+C
# 后台/systemd/容器：由编排层控制
# 手工排查时：
ps -o pid,command -p <pid>          # 确认是自己的进程再动手
kill -TERM <pid>
```

> ⚠️ **本应用未实现优雅退出**：`server/` 中没有 `enableShutdownHooks()`、
> 没有 `SIGTERM`/`SIGINT` 处理、没有 `onModuleDestroy`（见
> [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §7.3）。
> `SIGTERM` 会让进程**立即退出**，在途请求被中断；`auth.service.ts:91-93` 的
> 每小时会话清理 `setInterval` 也不会被清理。
> **正确做法：先从负载均衡摘除流量（等 `/api/health/ready` 不再被路由），再发信号。**

### 1.3 本地开发

```bash
# 本地验证用 PostgreSQL（不需要 Docker/Homebrew）
bash scripts/dev-postgres.sh start      # 首次会下载并初始化 PG 16
bash scripts/dev-postgres.sh status
bash scripts/dev-postgres.sh psql "select current_database(), current_user"
bash scripts/dev-postgres.sh stop
bash scripts/dev-postgres.sh destroy    # 删除本地验证数据（不可恢复）

# 同时起 server(watch) + client(vite)
npm run dev            # = ./scripts/dev.sh（concurrently）
npm run dev:server     # nest start --watch
npm run dev:client     # vite
```
均为实测存在的脚本与 npm 脚本（`package.json:11-13`）。 [已证实]

> ⚠️ **本地开发的两个坑**（都已记录在脚本注释里）：
> 1. 平台 CSRF cookie 被硬编码为 `Secure; SameSite=None; Partitioned`
>    → **纯 HTTP 下浏览器拒收** → 本地写操作全 403。
>    解决：通过服务端口访问（服务端会渲染已构建的 client），或走本地 HTTPS。
>    (`scripts/dev.sh:14-17`)
> 2. 本机 **3000 端口可能被其他进程占用**（本次实测：一个无关项目的
>    `node server/index.js` 已占用 `*:3000`）→ `npm run dev` 会 `EADDRINUSE`。
>    用 `lsof -nP -iTCP:3000 -sTCP:LISTEN` 先确认。 [已证实，本机环境]

---

## 2. 健康检查

| 端点 | 类型 | 依赖 | 期望 |
|---|---|---|---|
| `GET /api/health` | 存活 | **无** | `200` |
| `GET /api/health/ready` | 就绪 | DB + 关键表 + `schema_migrations` | `200` / `503` |

两者均 `@Public()`，**且刻意不返回任何配置**（无 DSN/主机/库名/用户）。
实现：`server/modules/health/health.module.ts:8-33,64-191`。 [已证实]

**实测（本机运行实例）**
```console
$ curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:3200/api/health
{"status":"ok","version":"1.3.0-hardening","uptimeSeconds":392,"timestamp":"2026-09-24T02:13:56.667Z"}
HTTP 200

$ curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:3200/api/health/ready
{"status":"ready","version":"1.3.0-hardening","uptimeSeconds":392,
 "timestamp":"2026-09-24T02:13:56.684Z",
 "checks":{"database":{"ok":true,"latencyMs":9},"schema":{"ok":true},
           "migrations":{"ok":true,"applied":6}}}
HTTP 200
```
[已证实，2026-09-24]

**版本号来源**：`APP_VERSION` → `npm_package_version` → `'unknown'`
（`health.module.ts:72-78`）。所以 `"1.3.0-hardening"` 是部署时注入的，
**不是从 `package.json` 的 `version` 字段读的**（该字段实际是模板版本 `2.3.0`）。

### 2.1 一键健康巡检脚本（可直接使用）

```bash
#!/usr/bin/env bash
# qls-check.sh —— 值班巡检（只读，不改任何状态）
set -uo pipefail
BASE="${1:-http://127.0.0.1:3000}"
DB="${DATABASE_URL:-}"

echo "== 1. 存活 =="
curl -s -o /dev/null -w '  /api/health       HTTP %{http_code}\n' "$BASE/api/health"

echo "== 2. 就绪（含 checks 明细）=="
curl -s -w '\n  HTTP %{http_code}\n' "$BASE/api/health/ready"

echo "== 3. 登录端点可用（不应是 500）=="
curl -s -o /dev/null -w '  /api/auth/config  HTTP %{http_code}\n' "$BASE/api/auth/config"

echo "== 4. 全局认证守卫生效（应为 401）=="
curl -s -o /dev/null -w '  /api/curriculum/structure  HTTP %{http_code}\n' \
     "$BASE/api/curriculum/structure"

echo "== 5. CSRF 中间件生效（应为 403）=="
curl -s -o /dev/null -w '  POST /api/__probe__  HTTP %{http_code}\n' \
     -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/__probe__"

echo "== 6. 迁移状态 =="
if [ -n "$DB" ]; then DATABASE_URL="$DB" node scripts/migrate.mjs status; fi
```
（第 5 项打的是不存在的路由，**不产生任何业务写入**；该探测方式已在
[`SECURITY.md`](SECURITY.md) §6 实测验证过。）

> ⚠️ **`/api/health/ready` 的 `checks.migrations` 不告诉你"有没有 pending"**：
> 它实际执行的是同一个 `count(*) FROM schema_migrations` 子查询写了两遍，
> `ReadinessReport.pending` **从未被赋值**（`health.module.ts:144-160`）。
> 判断 pending 必须用 `node scripts/migrate.mjs status`。 [已证实]

---

## 3. 日志：怎么读、怎么关联

### 3.1 日志去哪了

- Nest `Logger` 全部写 **stdout/stderr**；**没有文件日志配置**。 [已证实]
- `.env.example` 里的 `LOG_DIR` / `LOG_REQUEST_BODY` / `LOG_RESPONSE_BODY`
  **代码从不读取**，设了没有作用（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §2.4）。 [已证实]
- 采集方式：容器/编排采集 stdout（journald / 平台日志服务 / Loki / ELK）。

### 3.2 关联一次请求（最常用的排查动作）

1. 用户报错 → 让他提供界面上的 **requestId**（或浏览器 Network 里的 `x-request-id` 响应头）。
2. 用该 id 检索日志。5xx 的日志行格式（`exception.filter.ts:110-114`）：
   ```
   Unhandled exception [requestId=<id>] <ErrorName>: <message>
   ```
   紧接着是 stack（**只在服务端日志里，不返回给客户端**）。
3. 相关审计行可用 requestId 无关字段关联（`ip_address` + `action` + 时间）。

```bash
# 按 requestId 找日志（journald 示例）
journalctl -u qls-app --since '2 hours ago' | grep -F '<requestId>'

# 在响应头里确认 requestId
curl -sI "$BASE/api/health" | grep -i x-request-id
```

> ⚠️ **已知缺陷**：5xx 响应的 **header 与 body 里的 requestId 可能不一致**
> （[`SECURITY.md`](SECURITY.md) §12 G-9；`PRODUCTION_READINESS.md` §Q-5）。
> 排查时**以 header 为准**，并在日志里同时搜两个值。

### 3.3 该重点关注的日志关键字

| 关键字 | 含义 | 处置 |
|---|---|---|
| `Unhandled exception [requestId=` | 5xx | 按 §5 分类排查 |
| `Failed to seed teacher <user>: …` | 初始账号 seed 失败 | **严重**。见 §5.3-⚠️；注意这条**不会阻止进程启动** |
| `Seed teachers: created=N, skipped=M` | seed 结果 | N=0 且 M=0 → 没有任何账号可用 |
| `Session invalidated by permission change:` | 权限变更导致会话失效 | 正常（设计意图）；若大面积出现见 §5.5 |
| `Blocked request from an MFA-required account that has not enrolled:` | 未绑定 MFA 被拦 | 见 §5.4 |
| `MFA disabled for teacher <id>`（WARN） | 有账号解绑了 MFA | **需人工确认是否为本人操作**，并查 `audit_logs.action='mfa_disabled'` |
| `Password reset by admin for: <username>` | 管理员重置口令 | 正常审计点 |
| `Readiness: database check failed:` | 就绪检查的 DB 失败 | 见 §5.1（注意：就绪失败**不会**杀进程，存活检查才是编排依据） |

### 3.4 审计日志（权威记录，优先于应用日志）

```sql
-- 最近 50 条（注意时间列是 _created_at）
SELECT _created_at, action, success, teacher_name, ip_address, detail, error_message
FROM audit_logs ORDER BY _created_at DESC LIMIT 50;

-- 某人的全部动作
SELECT _created_at, action, success, ip_address, detail
FROM audit_logs WHERE teacher_name = '<姓名>' ORDER BY _created_at DESC LIMIT 200;

-- 失败与拒绝（排查爆破/越权）
SELECT _created_at, action, teacher_name, ip_address, error_message
FROM audit_logs WHERE success = false ORDER BY _created_at DESC LIMIT 100;

-- IP 维度（配合 §5.3 的限流分析）
SELECT ip_address, action, count(*) FROM audit_logs
WHERE _created_at > now() - interval '1 hour'
GROUP BY 1,2 ORDER BY 3 DESC;
```
[已证实：列名来自 `information_schema.columns` 实测；
`audit_logs` **无外键**、`teacher_id` 为裸 uuid，属有意设计]

> 对匿名 DB 角色而言 `audit_logs` 是 **append-only**（`UPDATE`/`DELETE` 均被 REVOKE，
> `0005:185-187`，实测 `has_table_privilege('anon_','audit_logs','DELETE') = false`）。
> 因此**审计记录不能也不必"修正"** —— 发现错误时请在运维日志里另作说明。

---

## 4. 常规运维动作

### 4.1 数据库备份（**上线前必须先在部署环境落地**）

见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §3。
**本仓库没有任何备份脚本**，且本机**没有** `pg_dump`/`psql` 客户端。 [已证实]

### 4.2 迁移前后的一致性留痕（仓库自带，无需 psql）

```bash
node scripts/db-snapshot.mjs --out snapshots/before.json
# … 执行迁移 …
node scripts/db-snapshot.mjs --out snapshots/after.json
node scripts/db-snapshot.mjs --compare snapshots/before.json --against snapshots/after.json
# 退出码 1 = 检测到丢表/丢行/丢列/RLS 被削弱
```
`db-snapshot.mjs` 是**比对器**，不复制数据（[`MIGRATION_REPORT.md`](MIGRATION_REPORT.md) §7.1）。

### 4.3 全量回归门禁

```bash
# 前置：PostgreSQL 可用、迁移已应用、应用以生产模式监听 $MFA_BASE（默认 127.0.0.1:3200）、
#       且已设 AUTHZ_TEST_DB
export AUTHZ_TEST_DB="postgres://<user>:<pass>@127.0.0.1:55432/qls_test_0005"
bash scripts/verify-all.sh
```
它会依次运行（`scripts/verify-all.sh`，写作期间新增了 `security-headers` 一项）[已证实]：
`npm test` → `type:check:server` → `type:check:client` → `npm run build`
→ `node scripts/verify-api-contracts.mjs` → `verify-authz-http.mjs` →
`verify-hardening.mjs` → `verify-mfa.mjs` → `verify-security-headers.mjs`；
任一失败整体非 0。

> 仓库中另有 `scripts/probe-file-validation.mjs`、`scripts/verify-seed-failure.sh`、
> `scripts/backup-rehearse.mjs`、`scripts/db-bootstrap.mjs`（均为写作期间新增），
> **它们没有被 `verify-all.sh` 调用**，需要时单独执行。 [已证实]

单独运行：
```bash
npm test                                  # node --test tests/*.test.mjs
npm run type:check                        # server + client 并行
npm run build
node scripts/verify-api-contracts.mjs     # 纯静态，无需 DB/服务
node scripts/verify-authz-http.mjs        # 需服务 + AUTHZ_TEST_DB
node scripts/verify-hardening.mjs         # 需服务 + AUTHZ_TEST_DB
node scripts/verify-mfa.mjs               # 需服务 + AUTHZ_TEST_DB（BASE 可用 MFA_BASE 覆盖）
node scripts/verify-security-headers.mjs  # 需服务；验证 §5.7 的响应头
node scripts/verify-files-http.mjs        # 需服务 + AUTHZ_TEST_DB；文件下载/令牌链路
node scripts/probe-file-validation.mjs    # 文件校验探针（未执行过）
ADMIN_DB="postgresql://…/postgres" bash scripts/verify-seed-failure.sh   # §5.3.3，需先 npm run build
npm run predeploy                         # bash ./scripts/predeploy-check.sh
npm run lint                              # eslint + stylelint + type:check
```
> ⚠️ `npm run predeploy` 指向 `scripts/predeploy-check.sh`。
> **本次两次 `ls scripts/` 都没有看到该文件**（`package.json:32` 却引用了它），
> 执行前请先 `ls scripts/predeploy-check.sh` 确认；不存在则不要把它写进流水线。
> [无法验证 —— 本次两次 `ls` 输出中均未见该文件]

> ⚠️ `npm run lint` 依赖 `eslint` / `stylelint`。
> `PRODUCTION_READINESS.md` §G-5 记录过"`lint`/`precommit` 指向不存在文件"的历史问题；
> 本次未运行 `npm run lint` 验证。 [无法验证]

### 4.4 三个运维脚本（`verify-all.sh` 不调用，但运维一定会用到）

| 脚本 | 何时用 | 关键点 |
|---|---|---|
| `scripts/db-bootstrap.mjs` | **搭全新库**；**为恢复演练准备验证目标库** | 唯一可行的建库顺序：前导（类型+角色，取自 `0001`）→ `init.sql` → `migrate up`。**库里已有 `teachers`/`resources` 就拒绝运行**（除非 `--force`），**从不 DROP**。**不是**重建生产库/DR 的手段。见 [`MIGRATION.md`](MIGRATION.md) §2.3 |
| `scripts/backup-rehearse.mjs` | 想验证"**数据搬出去还能搬回来**"时 | 逻辑往返：逐表导出 → 用 `db-bootstrap` 从零建 scratch → 按 **FK 拓扑序**单事务导入 → 逐表比**行数 + SHA-256 内容校验和**。**不涉及 `pg_dump`/`pg_restore`**，**不覆盖生产库**。见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §7.4 |
| `scripts/verify-seed-failure.sh` | **发布前**，以及改动 `teachers` 结构/seed 逻辑之后 | 断言"seed 全失败时**拒绝启动**"，且断言的是**日志里的拒绝信息**而不是退出码。见 §5.3.3 |

```bash
# 三个脚本的最小用法
node scripts/db-bootstrap.mjs --url "$NEW_DB_URL"
node scripts/backup-rehearse.mjs --source "$SRC" --scratch "$SCRATCH" --out backups/rehearsal.ndjson
ADMIN_DB="postgresql://…/postgres" bash scripts/verify-seed-failure.sh
```
> `backup-rehearse.mjs` 的安全护栏：scratch 库名必须含 `scratch|rehearsal|restore_test|tmp|temp`
> 且必须与 source 不同库，否则 **exit 2**（它会对该库执行 `DROP DATABASE`）。
> 演练结束时默认**删掉** scratch 库，`--keep-scratch` 可保留以便排查。
> ⚠️ `source` 与 `scratch` 必须处于**同一迁移版本**，否则会（正确地）报 FAIL。

---

## 5. 故障诊断手册（逐个故障模式）

### 5.1 就绪检查返回 503

**先看响应体**，它会告诉你哪一项失败（`health.module.ts:93-168`）：

| `checks` 内容 | 含义 | 处置 |
|---|---|---|
| `database.ok = false, error: "database_unreachable"` | 连不上数据库 | ① `nc -vz <db-host> 5432`；② 确认 `DATABASE_URL` / 平台注入的连接串；③ 确认 DB 未在维护；④ 确认密码/角色未过期；⑤ 应用不会因此崩溃（实测：停 PG 只返回 500） |
| `schema.ok = false, missingTables: [...]` | 缺业务表 | 表未建 → 见 §5.2（迁移未跑） |
| `migrations.ok = false` | `schema_migrations` 查不到 | 该库**从未跑过迁移框架** → 见 §5.2 |
| 只有 `migrations.applied` 数字 | ⚠️ 注意：它**不表示**"无 pending" | 用 `node scripts/migrate.mjs status` 判断 |

```bash
# 定位到底哪一步断
curl -s "$BASE/api/health/ready" | python3 -m json.tool 2>/dev/null || curl -s "$BASE/api/health/ready"

DATABASE_URL="…" node scripts/migrate.mjs status         # 只读，先跑这个
DATABASE_URL="…" node -e "
const Pg=require('postgres');const s=Pg(process.env.DATABASE_URL,{onnotice:()=>{}});
s\`select current_database() db, current_user usr, version() v\`.then(r=>{console.log(r[0]);return s.end()});
".catch(e=>console.error(e.message));
```

> ⚠️ 存活 vs 就绪**必须分开用**：存活探针打 `/api/health`（不碰依赖），
> 就绪探针打 `/api/health/ready` 用于**摘流量**。
> 把存活探针打到 `/ready` 会在数据库短暂抖动时**杀掉健康进程**（设计意图见
> `health.module.ts:12-26`）。

### 5.2 迁移不同步 / 漂移

```bash
DATABASE_URL="…" node scripts/migrate.mjs status    # 看 applied / pending / drift
DATABASE_URL="…" node scripts/migrate.mjs verify    # 只校验 checksum
```

| 现象 | 原因 | 处置 |
|---|---|---|
| 有 `pending` | 新迁移未应用 | 先备份 + 快照，再 `node scripts/migrate.mjs up`（[`MIGRATION.md`](MIGRATION.md) §6） |
| `CHECKSUM DRIFT — an already-applied migration file has been modified` | 有人改了**已应用**的迁移文件 | **还原文件**（`git checkout -- <file>`），要变更就**新增**迁移。**绝不要**去改 `schema_migrations.checksum`（[`MIGRATION.md`](MIGRATION.md) §3.4） |
| `up` 报 `Could not acquire migration lock within timeout` | 另一个运行器正在迁移 | 等它结束；确认没有残留的 migrate 进程（`ps aux \| grep migrate.mjs`）。锁是 session 级的，进程退出即释放 |
| `up` 报某个迁移失败并打印 `code/message/at line` | 该迁移的 SQL 有问题 | **数据库未被这个迁移改动**（已 ROLLBACK）。修 `.sql` 后重跑。⚠️ 但被改动的文件如果**已经应用过**，就会变成漂移 —— 先确认它是否 applied |
| `down` 报 `Cannot roll back — missing .down.sql` | 缺回滚脚本 | 补 `.down.sql`，或**从备份恢复**（[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §4） |
| `down` 被 `RAISE EXCEPTION` 拒绝 | 该迁移有数据依赖（`0001`/`0002`/`0003`/`0006` 都有守卫） | **这是保护，不是 bug**（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §5.4）。确实要回滚 → 先备份，再按各迁移的 `QLS_*_FORCE_DOWN` / `qls.*_force_down` 显式开关执行 |
| 数据库"看起来已迁移"但应用报缺列 | 可能误用了 `baseline` | 逐项核对 [`MIGRATION.md`](MIGRATION.md) §6.2 的清单；必要时手工补建缺的对象 |

**永远不要**用"删库重建""重跑 `init.sql`""重置 seed"来"修"迁移问题
（[`MIGRATION.md`](MIGRATION.md) §7）。

### 5.3 账号锁定 / 无法登录

#### 5.3.1 "账号已锁定，请稍后再试"

原因：连续 **5** 次密码错误 → `locked_until = now + 15 分钟`
（`auth.service.ts:27-28,330-332`）。 [已证实]

```sql
-- 查状态
SELECT id, username, name, status, failed_login_attempts, locked_until
FROM teachers WHERE lower(username) = lower('<username>');

-- 只解锁（不清失败计数也行，登录成功会自己清零）
UPDATE teachers SET locked_until = NULL, failed_login_attempts = 0
WHERE lower(username) = lower('<username>');
```
⚠️ 对 `teachers` 的 `UPDATE`：匿名 DB 角色**只被授权**改
`last_login_at, failed_login_attempts, locked_until` 三列（`0005:130-133`）→ 上面的语句是允许的。
用更宽的权限账号执行也可以。 [已证实]

> **推荐做法（有审计）**：让 `principal` 用
> `POST /api/auth/reset-password` 重置该账号口令 —— 它会同时
> `failed_login_attempts = 0, locked_until = NULL` 并撤销该账号全部会话，
> 且写 `password_reset` 审计（`auth.service.ts:544-570`）。
> 临时口令**只在响应里返回一次**，务必当场转交。
> ⚠️ 该接口的门槛是**硬编码的 `roles.includes('principal')`**
> （`auth.controller.ts:279-281`）→ **只有 `principal` 能用**；
> 若运维账号只有 `super_admin`，会被返回 **404**（不是 403）。

#### 5.3.2 "用户名或密码错误"但口令确认无误

按可能性排序排查：

1. **账号没有 `password_hash`**（例如 seed 失败留下的空账号）：
   ```sql
   SELECT username, name, status, (password_hash IS NULL) AS no_hash
   FROM teachers WHERE lower(username) = lower('<username>');
   ```
   若 `no_hash = true`：应用启动时 seed 会回填（`auth.service.ts:203-208`，
   条件是**用户名匹配且 username 非空**）；否则请管理员重置口令。

2. **账号不是 `active`**：`AuthGuard` 和登录流程都会拒绝
   （登录分支报"账号已停用"，`auth.service.ts:296-308`）。
   ```sql
   SELECT username, status FROM teachers WHERE lower(username)=lower('<username>');
   ```

3. **数据库角色不匹配导致"静默 0 行"**（本项目实际踩过）：
   RLS 已启用而当前角色没有匹配的 policy 时，PostgreSQL **不报错、返回 0 行**
   → 查不到用户 → 报"用户名或密码错误"，**且不写审计**。
   ```sql
   SELECT current_user, current_role;                     -- 当前连接角色
   SELECT rolname FROM pg_roles WHERE rolname IN
     ('anon','anon_','authenticated','authenticated_','service_role','service_role_');
   SELECT tablename, policyname, roles FROM pg_policies
   WHERE schemaname='public' AND tablename='teachers';
   ```
   处置：确认应用连接角色是 `anon_` / `authenticated_` / `service_role_` 的**成员**
   （[`SECURITY.md`](SECURITY.md) §8.4），并已应用 migration `0004`。
   排查方法：`SET LOCAL ROLE "anon_"; SELECT count(*) FROM teachers;` —— 若为 0 就是这个原因。
   （详细背景：`0004_rls_role_alignment.sql:4-34`）

4. **IP 被限流**：报"请求过于频繁，请稍后再试"（`403`），
   阈值 `LOGIN_IP_RATE_LIMIT_MAX`（默认 30）/ `LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS`（默认 60）。
   ⚠️ 计数在**进程内**，重启进程即清空；多实例时每副本独立计数。

#### 5.3.3 种子失败：**现在会拒绝启动**（历史"假启动"已修复）

**先看日志行**（格式已更新，多了 `failed=`）：
```
Seed teachers: created=N, skipped=M, failed=F
```

| 日志 | 含义 | 处置 |
|---|---|---|
| `created=20, skipped=0, failed=0` | 正常 | — |
| `created=0, skipped=20, failed=0` | 账号已存在，无需处理 | — |
| `Partial teacher seeding failure: …`（ERROR） | **部分**失败 | 系统可用，但列出的账号缺失；按提示修好结构后重启补齐 |
| **`Teacher seeding failed completely …`** | **完全**失败 → **进程已拒绝启动**（`abortOnError`） | **这是正确行为**，不是新的故障。见下 |

**"完全失败导致拒绝启动"是设计意图。** 历史事故是：`teachers` 表缺列（缺
`password_hash` 等 6 列）→ 20 条 insert 全部 `42703` 失败 → **失败被逐个 catch 吞掉** →
进程打印"启动成功"、**可用账号为 0**、运维看到一个健康但无法登录的平台
（`PRODUCTION_READINESS.md` §E-5/§O-3 的实测日志）。
现在 `AuthService.onModuleInit()` 在
`created=0 && skipped=0 && failed>0` 时**抛错中止启动**。 [已证实：源码 + `evidence/no-fake-startup.txt`]

**处置流程**
```bash
# 1) 看结构是否齐全（0001 补齐 teachers 的 6 个认证列并带末尾断言）
DATABASE_URL="…" node scripts/migrate.mjs status     # 0001 是否 applied？有无 pending？
DATABASE_URL="…" node scripts/migrate.mjs up         # 若是新库/缺列，先应用迁移
# 若是全新的非平台库，用建库脚本（它按唯一可行顺序跑：前导 → init.sql → 迁移）
node scripts/db-bootstrap.mjs --url "$DATABASE_URL"

# 2) 重启进程，确认日志出现 created=20
```

**若要在发布前主动验证这条规则仍然成立**（推荐加进发布检查）：
```bash
npm run build
ADMIN_DB="postgresql://user:pw@127.0.0.1:55432/postgres" bash scripts/verify-seed-failure.sh
# 期望：pass=5 fail=0
```
它用 `CHECK (false) NOT VALID` 让**每一次** `teachers` INSERT 都失败
（`NOT VALID` 不校验既有行、但约束新插入 → schema 不变、启动路径正常，
从而**隔离出 seed 行为**，而不是被无关的启动错误带偏），然后断言两件事：
① 应用**没有**继续存活；② **日志里出现那句刻意的拒绝信息** ——
**而不是仅仅"退出码非 0"**（任何原因的崩溃都能满足后者，那会让测试为了错误的原因通过）。
它内部会调用 `db-bootstrap.mjs` 建 scratch 库 `qls_seedfail_probe` 并在结束时清理。
[已证实：脚本全文 + `evidence/no-fake-startup.txt`（5/5 PASS，我未复跑）]

### 5.4 MFA 相关问题

#### 5.4.1 super_admin 登录后所有接口 403

现象：`403 该账号角色强制要求 MFA，请先完成绑定后再使用系统`。
原因：`AuthGuard` 对"要求 MFA 但**尚未绑定**"的账号**默认拒绝一切路由**，
只放行 `@MfaExempt()` 的路由（`auth.guard.ts:155-182`）。 [已证实]

可用的路由（`@MfaExempt`）：
`GET /api/auth/me`、`GET /api/auth/me/permissions`、`GET /api/auth/mfa/status`、
`POST /api/auth/mfa/enroll`、`POST /api/auth/mfa/confirm`、
`POST /api/auth/mfa/recovery-codes`、`POST /api/auth/mfa/disable`、
`POST /api/auth/logout`。
（`auth.controller.ts` 中各装饰器；健康检查为 `@Public()`）

处置：登录后进入绑定流程即可（这是**自助**的，不需要 DBA 介入）：
```
POST /api/auth/mfa/enroll    → 返回 { secret, otpauthUri }（只此一次）
   → 用认证器 App 扫码/导入
POST /api/auth/mfa/confirm   { code }      → 返回 { recoveryCodes: [...10 个] }（只此一次）
```
⚠️ **恢复码只显示一次，必须当场保存。**

#### 5.4.2 MFA 状态自查

```bash
curl -s "$BASE/api/auth/mfa/status" -b "qls_session=<session>"
# → { pending, enabled, enabledAt, lastUsedAt, recoveryCodesRemaining, required }
```
（`mfa.service.ts:110-137`）

#### 5.4.3 丢失 MFA 设备

**自助恢复（有恢复码）**
1. 正常输入用户名 + 口令 → 进入第二因素页面。
2. 输入任意一个**恢复码**（格式 `XXXX-XXXX-XXXX-XXXX`）代替 6 位验证码。
   → 该码被标记 `used_at`，**立即失效**（一次性）。
3. 登录后用 `POST /api/auth/mfa/recovery-codes`（**需提供一枚当前有效验证码**）
   重新生成一批，并妥善保存。
   （`auth.controller.ts` mfaRecoveryCodes；`mfa.service.ts:253-264,325-343`）

**恢复码也用完 / super_admin 完全进不去**
⚠️ **系统没有"管理员重置他人 MFA"的接口**（`mfa.reset_other` 权限在目录里存在，
但**没有对应路由**；`POST /api/auth/mfa/disable` 只能操作**自己**且需要有效验证码，
并且 super_admin 会被 `assertMayDisable()` 拒绝）。 [已证实]

因此只能由 **DBA 直接改库**（属于破坏性操作，必须两人复核 + 先备份）：

```sql
-- 0) 先确认要操作的对象与当前状态
SELECT t.username, t.name, t.roles, m.confirmed, m.enabled_at
FROM teachers t LEFT JOIN teacher_mfa m ON m.teacher_id = t.id
WHERE lower(t.username) = lower('<username>');

-- 1) 备份这两张表（或做整库备份，见 DISASTER_RECOVERY.md）
-- 2) 删除绑定与恢复码（challenge 一并清）
BEGIN;
DELETE FROM mfa_challenges      WHERE teacher_id = (SELECT id FROM teachers WHERE lower(username)=lower('<username>'));
DELETE FROM mfa_recovery_codes  WHERE teacher_id = (SELECT id FROM teachers WHERE lower(username)=lower('<username>'));
DELETE FROM teacher_mfa         WHERE teacher_id = (SELECT id FROM teachers WHERE lower(username)=lower('<username>'));
COMMIT;

-- 3) 校验审计留痕（这是人工操作，审计表里不会有记录，请在运维日志中登记）
SELECT _created_at, action FROM audit_logs
WHERE teacher_id = (SELECT id FROM teachers WHERE lower(username)=lower('<username>'))
ORDER BY _created_at DESC LIMIT 10;
```

删除后的行为（**必须提前告知用户**）：
- 该账号立刻可用**口令单独登录**（回到单因素）；
- **若该账号是 super_admin**：登录成功但**任何业务接口都 403**，
  必须**先完成 `mfa/enroll` + `mfa/confirm` 重新绑定**才能使用系统
  （`auth.guard.ts:166-182`）。这正是"不能长期留空"的原因。
- 恢复码全部作废，需要重新生成。

> ⚠️ 安全提醒：本次实测发现**匿名数据库角色对 `teacher_mfa` / `mfa_recovery_codes` /
> `mfa_challenges` 仍有完整 `SELECT/INSERT/UPDATE/DELETE`**
> （`0004` 的 `ALTER DEFAULT PRIVILEGES` 作用到了 `0006` 新建的表，
> 而 `0005` 只收紧了 `teachers`/`sessions`/`audit_logs`）。
> 所以"删 MFA 行"这个恢复手段对**拿到应用连接级写权限的人**也是可用的
> —— 即它既是恢复手段，也是一个未收紧的降级路径。
> 见 [`SECURITY.md`](SECURITY.md) §12 G-17。 [已证实]

### 5.5 会话 / `permissionsVersion` 不同步

**现象**：大量用户同时掉线，提示 `401 权限已变更，请重新登录`。

**这不是故障，是设计。** 机制（`auth.guard.ts:121-134`）： [已证实]
```
任意授权变更（改角色 / 改状态 / 增删 account_permission_overrides / 改 account_scopes）
   → DB 触发器把 teachers.permissions_version += 1        （0003:122-168）
   → 该账号所有会话的 sessions.permissions_version 不再匹配
   → 该用户下一次请求被 destroySession(..., 'permissions_changed') + 401
```

**排查**
```sql
-- 会话版本 vs 账号版本
SELECT s.id, s.teacher_id, s.permissions_version AS sess_ver,
       t.permissions_version AS teacher_ver, s.revoked, s.revoke_reason, s.expires_at
FROM sessions s JOIN teachers t ON t.id = s.teacher_id
WHERE s.revoked = false AND s.permissions_version <> t.permissions_version
ORDER BY s.expires_at DESC LIMIT 50;

-- 谁刚刚改过权限（找触发源）
SELECT _created_at, action, teacher_name, detail FROM audit_logs
WHERE action IN ('permission_update','role_update','teacher_update','teacher_status_update')
ORDER BY _created_at DESC LIMIT 20;
```

**处置**
- **正常情况**：什么都不做。用户重新登录即可（这是权限变更"即时生效"的代价）。
- 若**不该发生**（没人改权限却集体掉线）：检查是不是有脚本/迁移批量写了
  `teachers.roles` / `status`，或批量改了 `account_permission_overrides`。
  注意 `0003` 的触发器对 `teachers` **只在 `roles` 或 `status` 变化时**才 bump
  （`0003:132-135`），所以其它字段更新不会引发掉线。
- **需要主动让某人/所有人重新登录**（例如怀疑会话泄露）：
  ```sql
  -- 单个账号全部会话失效
  UPDATE sessions SET revoked = true, revoked_at = now(), revoke_reason = 'admin_force_logout'
  WHERE teacher_id = '<uuid>' AND revoked = false;

  -- 全站失效（密钥/会话轮换，见 §7）
  UPDATE sessions SET revoked = true, revoked_at = now(), revoke_reason = 'secret_rotation'
  WHERE revoked = false;
  ```
  ⚠️ 反向生效：**不要**手工去改 `sessions.permissions_version` 或
  `teachers.permissions_version` 去"对齐"—— 那会削弱即时失效保证。
  若确实要让某账号的会话作废，**bump 账号版本**：
  ```sql
  -- 用 SQL 强制 bump：写一个等价的 roles 值即可触发 BEFORE UPDATE 触发器
  UPDATE teachers SET roles = roles WHERE id = '<uuid>';
  ```
  （触发器逻辑见 `0003:126-139`：`NEW.roles IS NOT DISTINCT FROM OLD.roles` 时会 return，
  **因此单纯 `SET roles = roles` 不会 bump**。可靠做法是直接在应用层用
  `AuthorizationService` 的相应方法，或显式 `SET permissions_version = permissions_version + 1`。）
  [已证实：触发器逻辑] [推断：显式 +1 是可靠手段 —— 因为 `permissions_version`
  在触发器的豁免列表中（`0003:31-39`）]

**会话表健康检查**
```sql
SELECT count(*) FILTER (WHERE revoked) AS revoked,
       count(*) FILTER (WHERE NOT revoked AND expires_at > now()) AS active,
       count(*) FILTER (WHERE NOT revoked AND expires_at <= now()) AS expired_but_kept
FROM sessions;
```
⚠️ 已知：`cleanup()` 只删 `expires_at < now`，**不删已撤销行**
（`session.service.ts:228-240`）→ `revoked = true` 的行会一直留着。可按需人工清理：
```sql
DELETE FROM sessions WHERE revoked = true AND revoked_at < now() - interval '90 days';
```

### 5.6 页面白屏 / 静态资源 404

1. 确认入口 HTML 存在（这是最容易被构建/搬迁搞坏的一环）：
   ```bash
   ls -la dist/dist/client/index.html      # 必须存在
   ```
   服务端视图目录是 `join(process.cwd(), 'dist/client')`，而生产从 `dist/` 启动
   → 实际是 `dist/dist/client/`（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §6.3）。 [已证实]
2. 确认 HTML 里的 HBS 占位符已被替换（否则 CSRF / 用户上下文全废）：
   ```bash
   grep -o '{{[a-zA-Z]*}}' dist/dist/client/index.html | sort -u
   # 期望：无输出（占位符应已被渲染替换）
   ```
   若仍有 `{{csrfToken}}` 之类，说明没有走本应用的 Handlebars 渲染链路
   （`server/main.ts:24,67-69`）[已证实] → 前端写操作会全部 403。
3. 静态资源 404：确认 `dist/client/assets/` 存在且部署到了静态目录；
   带内容哈希的文件可长缓存，但 `index.html` **不要**长缓存。
4. `curl -sI "$BASE/" | head` 应见 `Content-Type: text/html`。

### 5.7 安全响应头：现在应当**全部存在**（缺失=构建陈旧）

```bash
curl -sI "$BASE/api/health" | grep -iE 'x-content-type|x-frame|referrer-policy|content-security|strict-transport|x-powered-by'
# 或者直接用套件判定（它会读本进程的 TRUST_PROXY/HTTPS_ENABLED 来推断 HSTS 期望值，
# 因此请在同一 shell / 同一环境里启动服务与套件）
node scripts/verify-security-headers.mjs        # 期望全部 PASS
```

**期望看到（本会话实测原样）**：`X-Content-Type-Options: nosniff`、
`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、
`Cross-Origin-Opener-Policy`、`Cross-Origin-Resource-Policy`、`Permissions-Policy`、
**`Content-Security-Policy-Report-Only`**（默认 report-only）；
**不应**再看到 `X-Powered-By`。

| 症状 | 原因 | 处置 |
|---|---|---|
| 一条都没有 | 运行的是**旧产物**（中间件没编进去） | `npm run build` → 重启 → 复验。**判据**：`grep -c securityHeaders dist/server/main.js` 应为非 0；`ls dist/server/common/http/` 应包含 `security-headers.middleware.js` |
| 仍有 `X-Powered-By` | 同上（中间件会移除它） | 同上 |
| 缺 `Strict-Transport-Security` | **正常**：HSTS 只在 `HTTPS_ENABLED`/`TRUST_PROXY` 表明前面有 TLS 时才发 | 反代后设 `HTTPS_ENABLED=true` 或正确的 `TRUST_PROXY`，重启 |
| 只有 `Content-Security-Policy-Report-Only` 而没有强制的 CSP | **正常**：默认即 report-only（`CSP_MODE=enforce` 才拦截） | 想启用：先观察 violation 上报，再设 `CSP_MODE=enforce` |
| 服务返回 403 且页面白屏（启用 enforce 之后） | 强制 CSP 与真实产物不兼容 | 回退 `CSP_MODE=report-only` 或 `off` —— **强制 CSP 配错会导致整站白屏**，所以默认不启用 |

> 历史对照：整改前应用**一个安全头都没有**且主动暴露 `X-Powered-By: Express`，
> 套件评分 `pass=5 fail=15`（`evidence/security-headers.txt`）；
> 整改后同一构建 **20/20**（`evidence/gate-run-final.txt`）。
> **这个"失败基线"是套件不空转的证据**，不要删掉那段对照记录。

### 5.8 上传/下载"点了没反应"

**先分清「数据现状」与「代码现状」——写作期间两者已经不一致了。**

**数据现状（未变，实测）**：347 条资源中**没有任何一条**带 `file_bucket_id` / `file_path`。
```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE file_bucket_id IS NOT NULL AND file_bucket_id <> '') AS with_file
FROM resources;
-- 期望与实测一致：347 / 0
```

**代码现状（已变化）**：旧的
`// TODO: 接入真实 dataloom FileService` + 手拼未签名 URL 的实现已被替换为：
- `GET /api/files/download`（`@RequirePermission('resource.download','storage.download')`），
  校验**HMAC 签名的下载令牌**（`DOWNLOAD_TOKEN_SECRET`，默认 TTL 300s、上限 3600s，
  payload 绑定 `resourceId` + `teacherId`）；
- 实际直链由平台 `FileService` 签名取得；
- **平台存储不可用 → 明确 503**（`STORAGE_UNAVAILABLE_MESSAGE`），**不返回伪造 URL**；
- **`DOWNLOAD_TOKEN_SECRET` 未配置 → 同样 503**（fail closed）。

因此现在"下载点了没反应"的可能原因按顺序排查：

| # | 检查 | 命令 / 期望 |
|---|---|---|
| 1 | 资源**有没有文件**（最可能） | 上面的 SQL：期望 `347 / 0` → 没有文件，**没有任何东西可下载**。这是**数据问题**，不是故障 |
| 2 | `DOWNLOAD_TOKEN_SECRET` 是否配置 | 未配置时下载接口返回 **503** 并说明原因。检查部署环境变量（≥32 字节） |
| 3 | 平台文件服务是否可用 | 503 且 body 含"文件存储后端不可用…" → **独立部署的正常表现**（平台未接入）；妙搭部署则说明文件服务配置/网络有问题 |
| 4 | 权限 | 需要 `resource.download` + `storage.download`；缺权限是 403 并写审计 |
| 5 | 上传仍是未实现的 | 前端仍是 `placeholder-bucket` 伪造坐标（`UploadPage.tsx:157-160`）→ **上传功能尚未可用** |

> 排查时请用响应里的 `requestId` 关联服务端日志 —— 存储失败的真实原因只写在日志里，
> 不会回显给客户端（这是有意的，见 `files.service.ts` 文件头）。

见 [`SECURITY.md`](SECURITY.md) §11.1.1 与 §12 G-3、
[`THREAT_MODEL.md`](THREAT_MODEL.md) §5.1。

---

## 6. 回滚

### 6.1 优先级（从快到慢、从安全到危险）

```
① 回滚应用产物（切回上一个 dist / 镜像）         ← 首选，不动数据库
② 前向修复（新增一个 migration 修结构）           ← 结构类问题首选
③ 用 down 回滚数据库结构                         ← 有拒绝守卫，可能被拒
④ 从备份恢复（见 DISASTER_RECOVERY.md §4）        ← 数据损坏时的唯一手段
```

### 6.2 ① 回滚应用产物

```bash
# 保留过至少 3 个产物的情况下
ls -la releases/                                  # 找到上一个版本
# 停旧 → 切目录/镜像 → 启动 → 验证
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/health"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/health/ready"     # 期望 200
```
**应用回滚不需要动数据库**：新增列/表/触发器对旧版本代码是**向后兼容**的
（`0001`~`0007` 都是加对象，不删不改语义）。
唯一例外：旧的 `teachers.wecom_user_id NOT NULL` 这类**约束收紧**在新版本里被放宽，
旧代码同样能跑。 [已证实：迁移内容]

### 6.3 ③ 用 `down` 回滚数据库

```bash
# 0) 必须先备份（DISASTER_RECOVERY.md §3.1）
# 1) 看当前状态
DATABASE_URL="…" node scripts/migrate.mjs status
# 2) 明确目标版本（回滚 >= 该版本的所有已应用迁移，新→旧）
DATABASE_URL="…" node scripts/migrate.mjs down 0005
# 3) 复验
DATABASE_URL="…" node scripts/migrate.mjs status
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/health/ready"
```

**会被拒绝的情况（正常）**：[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §5.4
- `0001 down`：`teachers` 里有认证数据 → 拒绝；
- `0002 down`：会让可登录账号归零 → 拒绝；
- `0003 down`：RBAC 表有数据 → 拒绝，除非 `QLS_MIGRATION_GUC_RBAC_FORCE_DOWN=on`；
- `0006 down`：有已确认的 MFA 绑定 → 拒绝，除非 `QLS_MIGRATION_GUC_MFA_FORCE_DOWN=on`；
- `0007 down`：回收站非空 → 拒绝，除非 **`QLS_SOFT_DELETE_FORCE_DOWN=on`**；
- **`0005 down` 不拒绝，但会重新打开提权路径**（匿名角色恢复可改
  `password_hash`/`roles`、可删审计）→ **执行后必须尽快 `up` 回来**，
  或认定为一次安全事件并按 [`SECURITY.md`](SECURITY.md) §13 处理。

**满数据库上的实测结果**（`evidence/migration-rollback.txt`；900+ 行数据、逐级 `down`）：

| 目标 | 结果 |
|---|---|
| `down 0005` | ✅ 成功（连带 `0006` 一起，共 2 个） |
| `down 0004` | ✅ 成功 |
| `down 0003` | ✅ 成功 |
| `down 0002` | ❌ **按设计拒绝**（`P0001`）——原文：`reverting the username backfill would leave 0 accounts able to log in (20 currently can)` |
| `down 0001` | — 未到达（`0002` 的守卫终止链条） |

回滚后数据完好：`teachers 22` / `resources 347` / `review_records 18` / `audit_logs 386` / `sessions 128`；
`teacher_mfa` 表消失是**正确的**（`0006` 的 down 就是删它）。

> ⛔ **由此得到一条必须遵守的运维结论**：
> **"`down` 到零"在活库上走不通**（`0002` 会挡），而且 `down` 是"改回结构"、**不是**
> "恢复数据"。**活库的灾难恢复用 `pg_restore`**，见
> [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §5.4。

### 6.4 回滚后必做

```bash
node scripts/db-snapshot.mjs --compare snapshots/before.json --against snapshots/after.json
DATABASE_URL="…" node scripts/migrate.mjs verify
curl -s -o /dev/null -w '/health %{http_code}\n' "$BASE/api/health"
curl -s -o /dev/null -w '/ready  %{http_code}\n' "$BASE/api/health/ready"
bash scripts/verify-all.sh          # 条件允许时跑完整门禁
```
并在运维日志中记录：回滚原因、目标版本、执行人、复核人、验证结果。

---

## 7. 密钥轮换

| 密钥 | 是否可在线轮换 | 步骤 |
|---|---|---|
| `MFA_ENCRYPTION_KEY` | ❌ **需要停机窗口**（当前实现无双密钥读取） | §7.1 |
| 会话失效（"session secret"） | ✅ | §7.2 |
| 数据库口令 | ✅（有连接池，需重启） | §7.3 |
| **`DOWNLOAD_TOKEN_SECRET`**（写作期间新增） | ✅ **可在线**，影响仅限默认 300s 的短时链接 | §7.4 |
| `SESSION_COOKIE_NAME` / TTL | ✅ | §7.2 |
| 平台凭据（`FORCE_AUTHN_INNERAPI_DOMAIN` 等） | 视平台 | §7.5 |

> ⚠️ **注意命名混淆风险**：本系统**没有**"session 签名密钥"（会话是不透明随机令牌），
> 但**有**"下载令牌签名密钥"。历史上模板文档里的 "session secret" 在本项目对应的是
> **失效全部会话**，不是轮换某把密钥。见 §7.2 与
> [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §3.1。

### 7.1 轮换 `MFA_ENCRYPTION_KEY`（高危，必须演练）

**为什么需要停机**：`teacher_mfa.secret_encrypted` 只带一个 `v1:` 前缀，
**没有"用旧密钥解密、用新密钥加密"的双密钥读取路径**
（`mfa-crypto.ts:187,245-260`：`resolveKey()` 只读 `MFA_ENCRYPTION_KEY` 一个变量）。
因此不存在"两把密钥并存"的过渡期。

**影响**：密钥换错/丢失 = **所有已绑定 MFA 的账号（含 super_admin）无法登录**，
且由 `auth.service.ts:372-377` 的设计会**失败关闭**（不会静默降级为单因素）。
[已证实]

**步骤**

```bash
# ---- 准备（不改动生产）----
# 1) 生成新密钥
NEW_KEY=$(openssl rand -base64 32); echo "$NEW_KEY"

# 2) 备份数据库（DISASTER_RECOVERY.md §3.1）。这是回退的唯一手段。
# 3) 单独导出 MFA 表，便于比对
pg_dump -Fc -t teacher_mfa -t mfa_recovery_codes -t mfa_challenges \
        -f /var/backups/qls/mfa_before_rotation.dump
```

```bash
# ---- 停机窗口内 ----
# 4) 停应用（先从 LB 摘流量）
#    ⚠️ 停机期间**无人能通过 MFA 登录** —— 这是计划内的。

# 5) 用**旧**密钥解、**新**密钥加密，就地重写密文
OLD_KEY="<旧密钥>" NEW_KEY="<新密钥>" \
DATABASE_URL="postgresql://…" \
node --input-type=module -e "
import Pg from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const enc = (pt, key) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(pt,'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'),
          ct.toString('base64')].join(':');
};
const dec = (stored, key) => {
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1') throw new Error('unexpected version ' + v);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv,'base64'));
  d.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([d.update(Buffer.from(ct,'base64')), d.final()]).toString('utf8');
};
const key = (s) => /^[0-9a-fA-F]{64}\$/.test(s) ? Buffer.from(s,'hex') : Buffer.from(s,'base64');
const oldK = key(process.env.OLD_KEY), newK = key(process.env.NEW_KEY);
if (oldK.length !== 32 || newK.length !== 32) throw new Error('key must be 32 bytes');
const sql = Pg(process.env.DATABASE_URL, { onnotice: () => {} });
const rows = await sql\`select teacher_id, secret_encrypted from teacher_mfa\`;
let ok = 0, bad = 0;
for (const r of rows) {
  try {
    const plain = dec(r.secret_encrypted, oldK);
    await sql\`update teacher_mfa set secret_encrypted = \${enc(plain, newK)}, updated_at = now()
              where teacher_id = \${r.teacher_id}\`;
    ok++;
  } catch (e) { bad++; console.error('FAILED', r.teacher_id, e.message); }
}
console.log('rotated', ok, 'failed', bad);
if (bad) { console.error('存在解不开的行：立即回退备份，不要继续'); process.exit(1); }
await sql.end();
"
# 该脚本等价于 mfa-crypto.ts:230-260 的加解密逻辑（在 dist 不可用时自带实现）。
# 若 dist 已构建，也可改用 import('./dist/server/common/crypto/mfa-crypto.js') 复用同一实现。
```

```bash
# 6) 更新部署环境的 MFA_ENCRYPTION_KEY = 新密钥
# 7) 启动应用，验证：
curl -s "$BASE/api/health/ready"                       # 200
# 让一个已绑定 MFA 的账号登录一次（这是唯一可靠的验证）
#   - 成功 → 轮换完成
#   - 失败 → 立即回退：恢复 mfa 表的 dump + 恢复旧密钥 + 重启
# 8) 逐条核对审计：
#    SELECT _created_at, action, teacher_id FROM audit_logs
#    WHERE action LIKE 'mfa_%' ORDER BY _created_at DESC LIMIT 20;
# 9) 旧密钥销毁前，先确认新密钥已写入密钥管理系统并有离线副本
```

**轮换前的必备清单**
- [ ] 数据库整库备份已完成**并验证可恢复**（[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §4）
- [ ] 已导出 `teacher_mfa` 单表 dump（回退用）
- [ ] 新密钥已生成、已存入密钥管理系统、已有离线副本
- [ ] 已通知：窗口内 MFA 用户无法登录（计划内）
- [ ] 已确认**至少一名 super_admin 的账号可用**（否则轮换失败时无人能修）
- [ ] 已在**预发环境完整演练过一遍**（含失败回退）
- [ ] 回退责任人 + 决策人已指定

> **更根本的建议**：实现双密钥读取（`MFA_ENCRYPTION_KEY` + `MFA_ENCRYPTION_KEY_PREVIOUS`），
> 让轮换可以**在线**进行。这属代码改造，尚未实现。

### 7.2 轮换会话（本系统没有"session secret"）

**重要概念澄清**：本系统**没有** JWT / 签名密钥 / 加密 Cookie。
会话是**不透明随机令牌**，服务端只存 `sha256(sessionId)`
（`session.service.ts:16-18,64-65`）。因此"轮换会话密钥"在这里 = **让全部会话失效**。
[已证实]

**方式 A：失效数据（推荐，立即生效）**
```sql
UPDATE sessions SET revoked = true, revoked_at = now(),
       revoke_reason = 'secret_rotation'
WHERE revoked = false;
```
效果：所有用户下次请求得到 `401 会话已过期，请重新登录`
（`session.service.ts:109-118`：`revoked` 为真即视为无效）。 [已证实]

**方式 B：换 Cookie 名（更彻底，旧 cookie 直接不被读取）**
```bash
# 部署环境改 SESSION_COOKIE_NAME（例如 qls_session_2026q4）并重启
```
代价：旧 cookie 留在浏览器里但不再被读取；用户需重新登录。可两者同时做。

**可选：缩短 TTL**：`SESSION_TTL_SECONDS`（默认 86400）。改小只影响**新建**会话。

**轮换后**
```bash
curl -s -o /dev/null -w '/ready %{http_code}\n' "$BASE/api/health/ready"   # 200
# 用一个账号登录一次确认链路正常；检查审计里有新的 login 行
```

> 对 `sessions` 的 `UPDATE`：匿名角色被授权的可写列包含
> `revoked, revoked_at, revoke_reason`（`0005:168`）→ 上述语句在应用连接角色下即可执行。 [已证实]

### 7.3 轮换数据库口令

```sql
ALTER ROLE <app_role> WITH PASSWORD '<新口令>';
-- 若迁移使用独立角色：
ALTER ROLE <migration_role> WITH PASSWORD '<新口令>';
```
然后：更新部署环境配置 → **重启应用**（连接池不会自动改用新口令）
→ `curl /api/health/ready` 应 200。
⚠️ 若同时轮换，注意 `MIGRATION_DATABASE_URL` 的优先级高于 `DATABASE_URL`
（`migrate.mjs:80-83`）。

### 7.4 轮换 `DOWNLOAD_TOKEN_SECRET`（**可在线，低风险**）

含义：下载令牌的 HMAC-SHA256 签名密钥（`server/common/crypto/download-token.ts`）。
[已证实]

| 项 | 说明 |
|---|---|
| 影响面 | 已发出的下载令牌全部作废。但令牌默认只活 **300 秒**，因此用户**重新点一次下载**即可 |
| 是否需要改数据库 | ❌ **不需要** |
| 是否需要停机 | ❌ 不需要；但**多副本时所有副本必须同时用同一把密钥**，否则会随机出现"链接无效" |
| 失败模式 | 若新密钥 <32 字节或缺失 → 下载接口一律 **503**（fail closed），不会发出无法签名的链接 |

```bash
# 1) 生成新密钥
NEW=$(openssl rand -base64 32); echo "$NEW"

# 2) 更新部署环境变量 DOWNLOAD_TOKEN_SECRET（所有副本）→ 滚动重启
#    ⚠️ 滚动期间新旧副本并存 → 短时窗口内可能"链接无效"，让用户重试即可

# 3) 验证
curl -s -o /dev/null -w '/api/health %{http_code}\n' "$BASE/api/health"
#   然后实际点一次下载（需已有带文件的资源）：
#   期望 302 到平台签名直链；若为 503 则看日志里的具体原因
```

可选：把 `DOWNLOAD_TOKEN_TTL_SECONDS` 调小（例如 120）以进一步缩短泄漏窗口 ——
但要考虑大文件下载耗时，**太短会导致下载中途失效**。

> ⚠️ **不要把这条流程套用到 `MFA_ENCRYPTION_KEY` 上。** 两者语义完全不同：
> MFA 密钥丢失/换错 = **所有 MFA 账号（含 super_admin）永久无法登录**，必须停机 + 逐行重加密（§7.1）。
> 相关区别见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §3.3。

### 7.5 平台凭据

**[无法验证]**：`FORCE_AUTHN_INNERAPI_DOMAIN` 等由妙搭平台控制。
参考平台文档；本仓库只能确认"缺它进程会直接退出"
（`PRODUCTION_READINESS.md` §O-1）。 [已证实]

---

## 8. 应急联系与升级（模板，需填写）

| 角色 | 姓名 | 联系方式 | 何时联系 |
|---|---|---|---|
| 一线值班 | `______` | `______` | 收到告警 |
| 应用负责人 | `______` | `______` | 就绪检查 503 超过 15 分钟 / 大面积掉线 |
| 数据库/DBA | `______` | `______` | 迁移失败、需改库、需恢复备份 |
| 平台对接（妙搭） | `______` | `______` | 平台侧存储/发布/角色异常 |
| 安全事件决策人 | `______` | `______` | 疑似入侵、会话泄露、密钥泄露 |
| 校方业务负责人 | `______` | `______` | 需停机窗口 / 用户通告 |

> ⚠️ 仓库中**不存在**任何联系人信息（[`SECURITY.md`](SECURITY.md) §13 同样为占位）。
> 上线前必须填写，否则这个 Runbook 在真实事故中无法使用。

### 8.1 需要按"安全事件"处理的信号

- `audit_logs` 出现非预期的 `login_failed` 聚集、或从异常 IP 段登录成功；
- `MFA disabled for teacher` / `mfa_disabled` 出现但本人否认；
- 审计出现 `permission_denied` / `resource_download_denied` 的密集记录；
- `teacher_mfa` / `mfa_recovery_codes` / `sessions` 被非应用路径修改
  （这些表**没有** DB 触发器，需靠外部核查）；
- 会话出现 `revoke_reason = 'permissions_changed'` 的**大面积**异常聚集；
- 发现 `sessions` 中有 `revoked = false` 但 `permissions_version` 与
  `teachers.permissions_version` 不一致的存活行（§5.5 的查询）。

处置顺序：**先保留证据（备份 + 导出审计）→ 再止血（失效会话/停用账号）→ 再修复 → 最后复盘**。
止血动作：
```sql
-- 停用可疑账号（会立刻使其全部会话失效，AuthGuard 每请求校验 status）
UPDATE teachers SET status = 'inactive' WHERE id = '<uuid>';
-- 全站会话失效
UPDATE sessions SET revoked = true, revoked_at = now(), revoke_reason = 'incident'
WHERE revoked = false;
```
⚠️ 停用 `super_admin` 会被 `rbac_protect_last_super_admin` 触发器阻止
（如果它是在职的最后一名）。 [已证实，`0003:261-306`]

---

## 9. 本手册中**未能验证**的项

| 项 | 原因 |
|---|---|
| `scripts/predeploy-check.sh` 是否存在 | `ls scripts/` 输出中未见该文件；`package.json:32` 却引用了它。执行前必须确认 |
| `npm run lint` 是否能通过 | 本次未运行 |
| `npm test` / `scripts/verify-all.sh` 当前结果 | 本次未运行（同工作区另有 agent 在跑测试与改代码） |
| 容器/编排下的启动、探针、信号行为 | 本机无 docker，仓库无 Dockerfile |
| 真实反向代理/TLS 下的行为 | 本机无该环境 |
| 备份/恢复命令的实际执行 | 本机**没有** `pg_dump`/`psql`/`pg_restore`（[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §0） |
| 妙搭平台侧存储、发布、角色切换 | 无平台凭据 |

**本次实测确认可用的**（可作为基线）：
`/api/health` 200、`/api/health/ready` 200（含 checks 明细）、`/api/auth/config` 200、
未认证访问受保护资源 401、CSRF 四态 403/403/403/404、
`node scripts/migrate.mjs status` 输出与退出码、`node scripts/verify-api-contracts.mjs` 通过。
