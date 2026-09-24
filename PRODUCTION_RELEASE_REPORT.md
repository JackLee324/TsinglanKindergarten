# 生产发布报告 / Production Release Report

**项目**：清澜山幼儿园教师课程资源平台 (QLS Kindergarten Curriculum Resource Platform)
**版本**：v1.3.0 → 生产加固版
**基线**：`baseline-v1.3.0` (原始交付 zip 的只读快照，tree `e99d3df`)
**报告生成**：自动生成，见 `evidence/` 目录中的原始日志

---

## 0. 结论摘要 / Bottom line

> **PRODUCTION STATUS: NOT READY**
>
> 阻塞项见 §10。核心应用层（鉴权、MFA、会话、迁移、契约）已在真实环境中验证通过；
> 但**生产数据库的备份/恢复演练从未执行**（本机没有 `pg_dump`），且**文件私有存储
> 依赖妙搭平台、本地无法验证**。这两项未闭环之前，不允许公网生产上线。

本报告中的所有结论均带证据等级标记：

| 标记 | 含义 |
|------|------|
| `[已证实]` | 有命令与观察到的输出可复现，日志在 `evidence/` |
| `[推断]` | 由代码/配置推断，未端到端执行 |
| `[无法验证]` | 当前环境不具备验证条件，必须由部署环境完成 |

---

## 1. 变更清单 / Change inventory

`[已证实]` 原始日志：`evidence/change-inventory.txt`

```
70 files changed, 9700 insertions(+), 223 deletions(-)
deleted files: 0
```

**删除文件数 = 0**。这一点是刻意验证的：需求明确禁止"为了通过测试而删除测试"、
"删除业务数据"。基线对比证明**没有任何文件被删除**——只做增补与修正。

### 1.1 新增（42 个）

| 分类 | 文件 |
|------|------|
| 审计/设计文档 | `PRODUCTION_READINESS.md`, `RBAC.md`, `BASELINE_INVENTORY.txt` |
| 迁移框架与迁移 | `scripts/migrate.mjs`, `scripts/db-snapshot.mjs`, `scripts/backup-rehearse.mjs`, `scripts/db-bootstrap.mjs` |
| 验证套件 | `scripts/verify-all.sh`, `verify-api-contracts.mjs`, `verify-authz-http.mjs`, `verify-hardening.mjs`, `verify-mfa.mjs`, `verify-security-headers.mjs` |
| 开发/构建工具 | `scripts/dev.sh`, `scripts/dev-postgres.sh`, `scripts/postinstall.mjs` |
| 数据库迁移 | `0001`–`0006`，每个均含成对的 `.down.sql` |
| 鉴权层 | `server/modules/authz/{authorization.service,permission.guard,permission.decorator,authz.module}.ts` |
| 安全原语 | `server/common/crypto/mfa-crypto.ts`, `server/common/http/client-ip.ts`, `server/common/http/security-headers.middleware.ts`, `server/common/middleware/request-id.middleware.ts` |
| 功能模块 | `server/modules/auth/mfa.service.ts`, `server/modules/health/health.module.ts` |
| 单一事实源 | `shared/rbac.ts` |
| 测试 | `tests/{migration,rbac-database}.test.mjs`, `tests/helpers/{legacy-fixture,reset-fixtures}.mjs` |

### 1.2 修改（28 个）

改动集中在：鉴权与会话（`auth.*`, `session.service.ts`, `app.module.ts`）、
权限校验（各 `*.controller.ts` 增加 `@RequirePermission`）、数据模型
（`server/database/schema.ts`）、错误处理（`exception.filter.ts`）、
**API 契约修正**（`client/src/api/{resources,review,teachers}.ts`、
`resource-card.tsx`）、i18n、`.env.example`、`build.sh`。

### 1.3 UI 改动范围

按需求"仅做安全/权限/修错所必需的 UI 改动"，前端改动仅有 5 个文件：

| 文件 | 改动理由 |
|------|----------|
| `client/src/api/review.ts` | 路径/方法错误，审核功能完全不可用 |
| `client/src/api/teachers.ts` | 权限授予用 PATCH，后端为 POST |
| `client/src/api/resources.ts` | `downloadResource` 调用方式错误 |
| `client/src/components/resource-card.tsx` | 下载改为跳转签名 URL |
| `client/src/pages/TeacherAdmin/TeacherFormDialog.tsx` | 展示一次性初始密码（否则新账号无法登录） |
| `client/src/i18n/translations.ts` + `AuditLogPage.tsx` | 新增 MFA 审计动作的中英文文案与徽章色 |

**未做任何视觉/布局/交互重设计。**

---

## 2. 迁移清单 / Migrations

`[已证实]` 全部 6 个迁移均已在真实 PostgreSQL 16.14 上应用，且每个都有成对的
`.down.sql`。

| 版本 | 名称 | 作用 | 回滚 |
|------|------|------|------|
| `0001` | `schema_baseline_alignment` | 补齐 `init.sql` 缺失的 `user_profile` 类型、三个数据库角色、`teachers` 的 6 个认证列、`wecom_user_id` 可空、`lower(username)` 函数索引 | ✅ |
| `0002` | `backfill_legacy_usernames` | 回填历史账号用户名。**缺失时 seed 会静默插入 0 行，且重复 seed 会把 21 个账号翻倍成 41 个** | ⛔ 见 §5 |
| `0003` | `rbac_database_layer` | 角色/权限/覆盖/范围的数据库层与 RLS 策略 | ✅ |
| `0004` | `rls_role_alignment` | 修正 `SET LOCAL ROLE anon_` 无匹配策略导致**静默返回 0 行**（正确密码登录报"用户名或密码错误"且不写审计） | ✅ |
| `0005` | `tighten_rls_writes` | 收紧写策略，关闭匿名角色提权路径 | ✅ |
| `0006` | `mfa` | MFA：`teacher_mfa`、`mfa_recovery_codes`、`mfa_challenges` | ✅ |

---

## 3. 验证结果 / Verification results

### 3.1 回归门禁 `[已证实]`

单一入口：`AUTHZ_TEST_DB=... bash scripts/verify-all.sh`

```
=== 自动化测试 ===
  npm test                 # tests 24 # pass 24 # fail 0
=== 类型检查 ===
  typecheck server         PASS
  typecheck client         PASS
=== 构建 ===
  npm run build            PASS
=== 前后端 API 契约（静态检查，无需运行服务） ===
  api-contracts            matched
=== HTTP 验证套件（需要运行中的服务） ===
  authz-http               pass=24 fail=0
  hardening                pass=10 fail=0
  mfa                      pass=36 fail=0

  ✅ 全部通过
```

| 项目 | 结果 |
|------|------|
| 单元测试 | 24/24 通过 |
| 服务端类型检查 | 通过（`tsc --noEmit`） |
| 客户端类型检查 | 通过 |
| 生产构建 | 通过（exit 0） |
| API 契约静态校验 | 通过（38 个服务端路由 vs 27 个客户端调用） |
| HTTP 鉴权套件 | 24/24 |
| HTTP 加固套件 | 10/10 |
| HTTP MFA 套件 | 36/36 |
| **合计 HTTP 断言** | **70 条，全部通过** |

### 3.2 契约门禁不是空转 `[已证实]`

`scripts/verify-api-contracts.mjs` 做了自测：**故意引入错位后退出码为 1，恢复后通过**。
即该门禁确实能捕获契约漂移，而不是永远返回成功。

### 3.3 已修复的 API 契约错位

| # | 契约错位 | 影响 | 状态 |
|---|----------|------|------|
| 1 | 客户端调用 `GET /api/resources/mine`，服务端无此路由，请求被 `:id` 吞掉并以 `id='mine'` 查 UUID → 500 | 「我的资源」页面**永远无法加载** | 已修复（新增路由，且声明顺序在 `:id` 之前） |
| 2 | `review.ts` 审核通过/驳回路径错误 | 审核工作台**不可用** | 已修复 |
| 3 | `review.ts` 审核记录路径错误 | 审核历史不可用 | 已修复 |
| 4 | `teachers.ts` 权限授予用 `PATCH`，后端为 `POST` | 权限管理不可用 | 已修复 |
| 5 | `downloadResource()` 以请求体方式调用下载接口 | 下载不可用 | 已修复为签名 URL 跳转 |
| 6 | 创建教师后一次性初始密码未展示 | 新账号**无法登录** | 已修复 |

`[已证实]` 其中 #1 现在有正向断言：`GET /api/resources/mine` 返回 200
（`verify-hardening.mjs`）。该断言同时修好了一个**测试自身的陈旧假设**：加固套件原本
用这个已损坏的路由当作"必然报错"的样本，路由修好后该假设失效，套件正确地转为失败——
这正是测试有效性的证据。

---

## 4. 备份与恢复测试结果 / Backup & restore results

`[已证实]` 原始日志：`evidence/backup-restore-rehearsal.txt`

### 4.1 ⚠️ 首先必须说明的事实

**生产数据库的备份与恢复演练从未执行过。**

原因是物理性的，不是疏忽：本机**不存在** `pg_dump`、`pg_restore`、`psql`。

```
$ ls .devtools/pg/node_modules/@embedded-postgres/darwin-arm64/native/bin
initdb
pg_ctl
postgres
```

本机没有 Homebrew `postgresql`，也没有 `libpq`。因此**常规逻辑备份在本环境不可能完成**，
本报告**不声称**做过任何这类备份。

> **需要部署环境提供的操作**（详见 `DISASTER_RECOVERY.md`）：
> ```bash
> pg_dump --format=custom --no-owner --no-privileges \
>   --file=qls_$(date +%Y%m%dT%H%M%S).dump "$PRODUCTION_DATABASE_URL"
> # 并且必须验证它真的能恢复，而不是只检查文件存在：
> createdb qls_restore_verify
> pg_restore --no-owner --no-privileges --dbname=qls_restore_verify qls_*.dump
> psql -d qls_restore_verify -c "SELECT count(*) FROM resources;"
> ```
> 上线前必须完成一次真实的恢复演练并保留输出。

### 4.2 已实际完成并验证的部分

`scripts/backup-rehearse.mjs` 执行了一次**真实的逻辑数据往返演练**：
导出 → 从零构建目标库 → 导入 → 逐表比对行数与 SHA-256 内容校验和。

```
=== STEP 2: CREATE SCRATCH + MIGRATE ===
  PASS  scratch database "qls_rehearsal" created (previous copy dropped)
  PASS  scratch database built from zero (prelude -> init.sql -> migrations)

=== STEP 3: IMPORT ===
  PASS  imported 902 rows

=== STEP 4: VERIFY ===
  PASS  schema_migrations             versions match (6): 0001..0006
  PASS  audit_logs                   rows=386 checksum=6da84497841c
  PASS  resources                    rows=347 checksum=a0ffa41973f2
  PASS  review_records               rows=18  checksum=91bd18f651e7
  PASS  sessions                     rows=128 checksum=7d169908f539
  PASS  teacher_mfa                  rows=1   checksum=0bb2db68423b
  PASS  teachers                     rows=22  checksum=1ab02115012f
  (共 12 张表，全部 PASS)

RESULT: logical round trip verified — every table restored with an
        identical row count and an identical content checksum.
```

**范围限制（不得夸大）**：这只证明**数据**能忠实恢复。它**没有**验证
`pg_dump`/`pg_restore`、角色、表空间、扩展、WAL/PITR。生产库**未被触及**，不在覆盖范围内。

### 4.3 演练中发现的一个真实缺陷（已修复）

演练第一次运行就失败了，暴露出一个此前完全隐藏的问题：

```
✗ Migration 0001_schema_baseline_alignment FAILED
✗   code   : 42P01
✗   message: relation "teachers" does not exist
```

**两个显然的构建顺序都无法从零建库**：

| 顺序 | 结果 |
|------|------|
| 先 `init.sql`，再 `migrations up` | `42P01`——`init.sql` 引用的 `user_profile` 类型与三个角色只在 `0001` 中创建 |
| 先 `migrations up`，再 `init.sql` | `0001` 依赖 `init.sql` 建的表 |

两者**互为前提**。妙搭平台预先提供了数据库（含类型与角色），所以这个缺陷在上线前
从未暴露——**这正是它危险的原因**：它只在"换一台机器重建/恢复"时才会咬人。

已通过新增 `scripts/db-bootstrap.mjs` 修复：补上幂等前置步骤（其 DDL **从 `0001`
自身的 `DO $$` 块中提取**，杜绝两处漂移），再依次执行 `init.sql` 与迁移。该脚本
拒绝在已含业务表的库上运行，避免被误用作"重建生产库"。

---

## 5. 迁移回滚演练 / Migration rollback rehearsal

`[已证实]` 原始日志：`evidence/migration-rollback.txt`
在**装载了全部 902 行数据**的库上逐个回滚（因此每个 `down` 都真的面对数据）：

| 步骤 | 结果 |
|------|------|
| `down 0005` | ✅ 成功 |
| `down 0004` | ✅ 成功 |
| `down 0003` | ✅ 成功 |
| `down 0002` | ⛔ **按设计拒绝** |
| `down 0001` | 未到达（被 0002 的设计性拦截阻断） |

`0002` 的拒绝**是正确行为，不是缺陷**：

```
✗ 0002 down refused: reverting the username backfill would leave 0 accounts
  able to log in (20 currently can). Doing so would lock every user out of
  the system. Create a super_admin account first, or restore from a backup.
```

**回滚后业务数据完好**：`teachers` 22、`resources` 347、`review_records` 18、
`audit_logs` 386、`sessions` 128 全部保留；仅 `teacher_mfa` 消失，而这是**正确的**
（`0006` 正是创建该表的迁移）。

**结论**：改 schema 与鉴权的迁移（0003/0004/0005）确实可逆且不丢业务数据；
`0002` 被刻意设计为不可就地回滚，因为它会把 20 个账号全部锁死。
因此**线上灾难恢复必须用 `pg_restore`，而不是 down-to-zero**。

---

## 6. 安全响应头 before / after

`[已证实]` 原始日志：`evidence/security-headers.txt`

**变更前**（真实运行中的构建）：

```
HTTP/1.1 200 OK
X-Powered-By: Express
x-request-id: cb68e8a3-...
Content-Type: application/json; charset=utf-8
```

**没有任何安全响应头**，并且通过 `X-Powered-By` 主动暴露框架身份。

变更后新增（`server/common/http/security-headers.middleware.ts`）：
`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
`Referrer-Policy: strict-origin-when-cross-origin`、`Cross-Origin-Opener-Policy`、
`Cross-Origin-Resource-Policy`、`Permissions-Policy`、TLS 条件下启用的 HSTS，
以及 **Report-Only 模式的 CSP**，并移除 `X-Powered-By`。

**为什么 CSP 是 Report-Only**：需求明确限制 UI 改动，而错误的强制 CSP 会直接
白屏——对全园教师是生产事故。在无法从本地验证构建产物全部内联脚本/样式面的前提下，
先**观测**而非**阻断**是诚实的选择。这是一个**部分实施**的控制项，已如此标注。

**为什么手写而不装 `helmet`**：`helmet` 并非依赖；而本仓库 `package-lock.json`
只含 linux/x64 的平台可选依赖，任何 `npm install` 都会重新解析依赖树并**剪除**
本项目构建必需的 5 个 darwin/arm64 原生二进制。这是上一轮已经踩过的坑。

**套件自证有效**：`scripts/verify-security-headers.mjs` 对变更前的构建运行结果为
`pass=5 fail=15`——它在缺少响应头的构建上**正确地失败**，证明断言不是空转。

---

## 6b. 「禁止假启动」实测验证

`[已证实]` 原始日志：`evidence/no-fake-startup.txt`

需求明确禁止「把错误 catch 后吞掉导致系统继续假启动」。**代码中确实存在该违规**，
且已修复并实测。

**违规现场**（`server/modules/auth/auth.service.ts`）：

```ts
// onModuleInit()
try { await this.seedTeachers(); }
catch (err) { this.logger.error(`Seed teachers failed: ...`) }   // 吞掉，继续启动

// seedTeachers() 内部
catch (error) { this.logger.error(`Failed to seed teacher ${seed.username}: ...`) }
// 循环结束后仅打印 created=N, skipped=M
```

**实测后果**：在由随包 `init.sql` 建立的库上，`teachers.wecom_user_id` 为 `NOT NULL`
而 seed 从不写该列 → 所有插入失败 → 每个失败都被吞掉 → 进程打印
`created=0, skipped=0` 并自认为健康启动，**实际可用账号数为 0**。
运维看到的是一个"运行中"的平台和一个永远登不进去的登录页。

**修复**：`seedTeachers()` 改为返回 `{ created, skipped, failed, failedUsernames }`；
`onModuleInit()` 区分三种结果——全部 skipped（账号已存在）静默通过；部分失败大声报错
但**不**中止（系统仍可用）；**全部失败则抛出异常**，使 Nest 中止启动。

**验证方式（关键：不是"退出码非 0"就算通过）**：
给 `teachers` 加 `CHECK (false) NOT VALID` 约束——`NOT VALID` 跳过对既有行的校验但
仍对**新插入**生效，因此 schema 完整、应用正常启动到 seed 步骤才失败，从而**隔离**了
seed 行为，避免因其他启动错误而"因为错误的原因通过"。断言要求日志中出现**特定的、
刻意的拒绝信息**，而不是任何崩溃都满足的非零退出码。

```
=== OBSERVED: bash scripts/verify-seed-failure.sh ===
  PASS  built server present
  PASS  forced every teachers INSERT to fail (CHECK (false) NOT VALID)
  PASS  application did NOT stay up
  PASS  log contains the deliberate refusal message
  PASS  seed reported the failure counts instead of hiding them

  pass=5 fail=0
  PASSED — a total seeding failure now aborts startup instead of faking health.
```

另经全仓扫描：`server/` 下**不存在任何空 `catch {}`**。

---

## 7. 鉴权与安全模型（摘要）

完整设计见 `RBAC.md` 与 `PRODUCTION_READINESS.md`；此处仅列已验证结论。

- **RBAC** `[已证实]`：`有效权限 = (角色默认 ∪ 追加授权) − 显式禁止`；
  9 个角色、44 个权限/11 组、4 种范围（ALL/PROGRAM/SUBJECT/OWN）。
- **越权提权被阻断** `[已证实]`：数据库层 `42501`；DTO 白名单层 `400`。
- **即时吊销生效** `[已证实]`：改权限后返回 `401 权限已变更，请重新登录`。
- **审计日志 append-only** `[已证实]`：数据库层强制。
- **MFA** `[已证实]`：RFC 6238 TOTP、AES-256-GCM 静态加密、
  SHA-256 恢复码、**数据库承载的一次性 challenge（多实例安全）**；
  36 条 HTTP 断言通过。未登记 MFA 的 `super_admin` 被 API 层拒绝（403）。
- **客户端 IP 不可伪造** `[已证实]`：平台 `configureApp()` 硬编码
  `app.set('trust proxy', true)`，导致 `X-Forwarded-For: 203.0.113.99, 10.0.0.1`
  被写入 `audit_logs.ip_address`。改为在其**之后**设置 trust proxy 后，
  实际记录为 `127.0.0.1`。
- **错误响应不泄露内部信息** `[已证实]`：停掉 PostgreSQL 制造真实 500，
  确认响应体不再含 `stack`/`cause`/文件路径/SQL。

---

## 8. 本地验证环境（真实性说明）

本报告中的"已证实"均来自以下**真实**环境，而非模拟：

- PostgreSQL 16.14 @ `127.0.0.1:55432`（embedded postgres，用户 `qlsadmin`）
- 905+ npm 依赖已安装；5 个原生绑定已补装
- NestJS 10 + Express，Drizzle ORM 0.44.6 + postgres-js
- 服务以 `NODE_ENV=production` 独立启动在 `127.0.0.1:3200`

**独立启动是本次调查的产物**：原版**根本无法独立启动**（`平台模式需要基础域名`）。
`FORCE_FRAMEWORK_DISABLE_DATAPASS=true` **不是**修复方案（会移除 `DataPaasModule`
导致 `DRIZZLE_DATABASE` 无法解析）。

---

## 9. 当前环境无法验证的项目

`[无法验证]` 以下项目**没有**被验证，且**不得**被当作已完成：

| # | 项目 | 原因 | 必须由谁完成 |
|---|------|------|--------------|
| 1 | 生产库备份/恢复演练 | 无 `pg_dump`/`pg_restore`/`psql`，无生产连接串 | 部署环境 |
| 2 | 真实对象存储上传/下载字节流 | 依赖妙搭 `dataloom`/`file-service`，本地不可达 | 部署环境 |
| 3 | 分布式限流 | 现为**进程内 Map**，多实例下**不生效** | 开发（需 Redis 等共享存储） |
| 4 | Docker / CI 流水线 | 本机无 docker | 部署环境 |
| 5 | CSP 强制模式 | 需先收集 Report-Only 违规报告 | 部署环境 |
| 6 | 反向代理/TLS 终止配置 | 取决于实际拓扑 | 部署环境 |
| 7 | 跨实例会话一致性 | 单实例验证 | 部署环境 |

---

## 10. 阻塞项 / Blockers

> **PRODUCTION STATUS: NOT READY**

按严重度排序：

**B1 — 生产库备份/恢复未演练（阻断级）**
没有可恢复性证据。任何"能上线"的结论都必须先有一次真实的
`pg_dump` → `pg_restore` 到临时库 → 比对行数的演练。目前**无证据**。

**B2 — 私有存储与上传校验未闭环（阻断级）**
上传目前由浏览器**直传平台 bucket**，服务端**从未见到文件**，因此不存在
服务端 MIME/大小/魔数校验。下载返回的是形如
`/api/__platform__/storage/download?bucket=...&path=...` 的占位 URL，
代码中残留 `TODO: 接入真实 dataloom FileService`——即该功能**从未生产化**。
本环境无法验证平台存储集成。

**B3 — 限流为进程内实现（高）**
多实例部署下限流形同虚设，暴力破解防护失效。

**B4 — 散落的历史遗留（中）**
`[已证实]` seed 的 347 行资源中 **0 行带文件引用**，即端到端**没有任何可下载资源**；
且前端 kebab-case 与数据库 snake_case 命名漂移，导致约 122 个 Pre-K 资源与
全部 44 个 K 资源在 UI 中不可达。这属于**功能缺口**，不是安全问题，但不修则平台
对教师没有实际价值。

**B5 — 会话/关联 ID 一致性未完全解释（低）**
`[已证实]` 响应同时含 `x-request-id` 与平台自己的 `x-log-trace-id`；两者并存
很可能是审计发现 **Q-5**（响应头 requestId 与响应体 requestId 不一致）的根因。
未修复，已记录。

---

## 11. 需求合规性自查

| 需求约束 | 状态 |
|----------|------|
| 禁止直接删除数据库重建 | ✅ 未执行任何重建 |
| 禁止用重建代替迁移 | ✅ 迁移为版本化 + 校验和 + 事务 |
| 禁止重置 seed | ✅ 未重置；并修复了 seed 静默插 0 行/重复翻倍 |
| 禁止假装功能已实现 | ✅ 本报告 §9/§10 明确列出未完成项 |
| 禁止只改前端不改后端 | ✅ 契约错位均在后端补路由/方法 |
| 禁止只改 README 不改代码 | ✅ 代码改动 9700 行 |
| 禁止删除测试以求通过 | ✅ **删除文件数 = 0**，且为门禁加了自测 |
| 禁止 catch 吞错继续假启动 | ✅ **已发现违规并修复+实测**（§6b，5/5 通过）；全仓无空 `catch {}` |
| 禁止大规模改 UI | ✅ 前端仅 6 个文件，无视觉重设计 |
| 无备份能力必须明说 | ✅ §4.1 明确声明未做，并给出部署环境所需命令 |
| 无法验证必须标注 | ✅ §9 |

---

## 12. 发布闸门 / Release gate

上线前必须全部满足：

- [ ] **B1** 在生产库完成一次 `pg_dump`/`pg_restore` 演练并保留输出
- [ ] **B2** 接入真实文件存储，服务端强制 MIME/大小/魔数校验，下载改为
      短期签名 URL 且与调用者绑定
- [ ] **B3** 限流改为共享存储（Redis）实现，或明确接受单实例部署约束并写入运维文档
- [ ] 在部署拓扑下配置正确的 `TRUST_PROXY`，并复跑
      `scripts/verify-security-headers.mjs`
- [ ] 以 `CSP_MODE=report-only` 收集违规报告后再决定是否强制
- [ ] **B4** 修复命名漂移并补齐文件引用，否则平台无实际可用资源
- [ ] 全量回归门禁在**生产配置**的实例上通过

---

*本报告由自动加固流程生成。所有 `[已证实]` 结论的原始日志位于 `evidence/`：
`change-inventory.txt`、`backup-restore-rehearsal.txt`、`migration-rollback.txt`、
`security-headers.txt`、`authorization-coverage.txt`、`no-fake-startup.txt`。*
