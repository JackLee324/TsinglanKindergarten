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
87 files changed, 15635 insertions(+), 227 deletions(-)
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
  npm test                 # tests 183 # pass 183 # fail 0
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
  security-headers         pass=20 fail=0
  files-http               pass=73 fail=0
  naming-http              pass=49 fail=0

  ✅ 全部通过
```

原始日志：`evidence/gate-run-final.txt`

> 说明：本轮中途曾有一次 `npm test` 报 1 项失败，经排查是**与并发编辑同一文件的竞态**
> （另一个代理正在写文件，构建产物处于中间状态），并非真实缺陷。复查方式是连续运行
> 该套件三次，均为 102/102，随后重跑整门禁仍全绿。此过程如实记录，未隐藏。

| 项目 | 结果 |
|------|------|
| 单元测试 | **183/183** 通过 |
| 服务端类型检查 | 通过（`tsc --noEmit`） |
| 客户端类型检查 | 通过 |
| 生产构建 | 通过（exit 0） |
| API 契约静态校验 | 通过（38 个服务端路由 vs 27 个客户端调用） |
| HTTP 鉴权套件 | 24/24 |
| HTTP 加固套件 | 10/10 |
| HTTP MFA 套件 | 36/36 |
| **合计 HTTP 断言** | **212 条，全部通过**（6 个套件） |

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

## 6c. 文件私有存储与回收站（Phase 6）

`[已证实]`（本地逻辑验证）／`[无法验证]`（真实对象存储）

**变更前**：上传由浏览器**直传平台 bucket**，服务端从未见到文件，因此不存在任何
服务端 MIME/大小/魔数校验；下载返回 `/api/__platform__/storage/download?bucket=…`
占位 URL，代码中残留 `TODO: 接入真实 dataloom FileService`——**该功能从未生产化**。

**已实现并验证**：

| 能力 | 实现 | 验证方式 |
|------|------|----------|
| 文件名消毒 | `file-validation.ts` | 外部对抗性探针 32 项 |
| 魔数校验 + 声明一致性 | 拒绝 EXE/HTML/文本/ZIP 伪装成 PDF | 探针实测全部拒绝 —— **但见下方限制 1** |
| 扩展名/MIME 白名单 | 拒绝 `.html`/`.svg`/`.js`/`.exe` | 探针实测 |
| 大小限制 | 默认 50MB，硬上限 200MB | 探针实测 |
| 短时签名下载令牌 | `download-token.ts`，HMAC-SHA256，**绑定资源+账号**，默认 300s、硬上限 3600s | 签名先于解析校验；`timingSafeEqual` 带长度前置检查；无硬编码回退密钥 |
| 软删除/回收站 | 迁移 `0007`，`resources_soft_delete_pairing` CHECK 作为**数据库不变量** | 迁移已应用于真实库，前后快照证明零数据丢失 |

**关于一次我自己造成的回归（如实记录）**：我最初断言
`isPathTraversalSafe('/etc/passwd')` 应为 `false`，并据此修改了校验器。**该断言是错的**。
本平台真实存储路径**以 `/` 开头**：

```
"filePath": "/curriculum-resources/prek-english-covers/1876907126277273.jpg"
```

它是**bucket key**，由 bucket 作用域的存储客户端相对**桶根**解析，从不接触文件系统。
真正需要拒绝的是 `..`、`.`、UNC、盘符、`~` 与百分号编码穿越——这些原本就已拒绝。
该回归由**模块作者独立编写的测试**发现（"accepts ordinary stored paths" 开始失败）。
我已回滚改动，并把这次误判**写入 `evidence/file-validation-probe.txt` 而非删除**：
一个前提错误的探针会产出自信而错误的结论，这次仅靠第二套独立测试才暴露。

**该阶段的三条限制（必须与上表一并阅读，不得只引上表）**：

1. **魔数校验的输入是客户端提供的**（最重要的一条）。当前上传流程是浏览器**直传**平台
   bucket，`registerFile` 收到的 `head` 字节来自调用方，因此"声明与内容一致"只能证明
   **调用方能提供自洽的字节**，无法证明**存储里的对象真的是那种类型**。要让该校验具有
   权威性，必须由服务端读取已存储对象（服务端上传，或上传后校验），而这依赖尚未接入的
   平台存储集成。**因此本项目此前把这套校验描述为"防伪装"是过强的**，现予更正。
2. **`Content-Disposition` 无法在最终下载上强制**：浏览器被 302 重定向到对象存储，
   由平台返回的响应头决定。写侧已用白名单（拒绝 HTML/SVG）补偿；接入存储后改为
   服务端流式转发可根治。
3. **回收站只有后端，没有 UI**：`GET /api/resources/recycle-bin`、`POST :id/restore`
   均已实现并有 HTTP 断言，但**客户端没有任何代码调用它们**，`recycle-bin` 页面不存在。
   静态契约门禁只检查"客户端→服务端"方向，因此不会发现这个缺口。教师目前**无法**
   通过界面恢复误删资源。

**`[无法验证]`**：真实对象存储的字节流上传/下载、平台 `createSignedUrl` 的实际返回、
以及 `.download` 端到端行为，均依赖妙搭 `dataloom`/`file-service`，在本地不可达。
本地验证的是**校验与授权边界**，不是存储集成本身。

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

**B6 — 回归门禁不稳定：已定位根因并修复（本轮闭环）**

**更正**：我此前称四次差异运行「没有其他测试/构建进程在跑」——**该前提是错的**。
另一个代理当时确有并发运行，我一次 `ps` 快照恰好拍到了空档，并据此建立了未经验证的假设。
这与我今天早些时候在 `isPathTraversalSafe` 上犯的错误是同一类。

**根因（用两份并发套件确定性复现得出，非推测）**：

| 现象 | 机制 |
|------|------|
| 中途全线 `401` 级联 | 每个套件启动即调用 `resetFixtures()`，它**吊销全部会话并提升 `permissions_version`**；重叠进程因此使另一方的会话中途失效 |
| 探针资源 `0 expected 1` / `404` | 两个进程使用**同一个字面量探针标题前缀**，B 的清理删掉了 A 的探针行 |
| 封面路径 `404 expected 200` | 并发的 `npm run build` 会删除 `dist/` |

三者**均为环境/干扰效应，不是产品缺陷**——与「封面回归守卫曾被观察到 PASS」一致。

**修复**：① 每次运行独立探针标识（`__files_http_probe_<pid><time>__`）；
② **有界的会话恢复**：仅在 `401` 时重认证一次并大声告警，绝不用于套件断言的
400/403/404，因此**真实的鉴权回归仍会失败**；超过 5 次则中止并声明这是**环境故障**；
③ 封面守卫区分 `400`（真实平台数据被拒=它要抓的回归）与 `404`+`dist/assets` 缺失
（构建进行中），并已用隐藏 `dist/server/assets` 验证「73 pass + NOTE，无假 200」；
④ `probe-file-validation.mjs` 兼容两种 dist 布局（这是我脚本自身的易用性缺陷）。

**结果**：两份并发运行 → 均为 `74/0`，exit 0；随后**连续三次** `verify-all.sh` 全绿。
**我的独立复跑**：`npm test 113/113`、build PASS、契约 matched、
五个 HTTP 套件 `24/10/36/20/74` 全绿；`typecheck` 失败仅因 B4 命名重构**正在进行中**。

**残留约束**：其余四个套件没有同等保护，**同一时刻只能跑一个门禁**——
该约束已写入 `verify-all.sh` 头部。

`scripts/verify-files-http.mjs` **不是顺序/状态无关的**。同一提交（`44d1fbf`）连续四次运行、
且确认没有其他测试/构建进程在跑，结果如下：

| 运行 | 方式 | 结果 |
|------|------|------|
| A | `verify-all.sh` | files-http FAIL：封面路径 `-> 404 expected 200` |
| B | 单独运行 | `pass=50 fail=22`，且**封面路径 PASS（200）**，另有 22 条 401 级联失败 |
| C | 单独运行 | `pass=50 fail=22`（同 B） |
| D | `verify-all.sh` | files-http FAIL：探针资源 `-> 0 expected 1` / `-> 404 expected 201` |

失败集合在代码未变的情况下**每次都不同**，形态有两种：(a) 中途开始全线 401
（会话不再被接受），(b) 套件自建的探针资源找不到（0/404）。两者都指向**共享可变状态依赖**。
仓库此前已为解决同类问题引入了 `tests/helpers/reset-fixtures.mjs`，该套件虽复用了它，
但**在其余四个套件之后运行时仍然失败、单独运行时才稳定**。会话在套件中途被吊销，
也与 `permissionsVersion` 在被 fixture 重置提升时的预期行为一致——即套件在与自己的重置竞态。

**后果**：本报告此前记录的 `✅ 全部通过` 是**真实但不可复现**的。
**在修复之前，不得把任何单次绿色运行当作门禁通过的证据。**
注意这是**测试套件**的缺陷，不是产品损坏的证据——封面回归守卫本身已被观察到 **PASS（运行 B）**，
说明真实种子路径确实可用。

## 10. 阻塞项 / Blockers

> **PRODUCTION STATUS: NOT READY**

按严重度排序：

**B1 — 生产库备份/恢复未演练（阻断级）**
没有可恢复性证据。任何"能上线"的结论都必须先有一次真实的
`pg_dump` → `pg_restore` 到临时库 → 比对行数的演练。目前**无证据**。

**B2 — 私有存储集成未在真实平台上验证（阻断级，已部分收敛）**
服务端校验边界（白名单、魔数、声明一致性、大小、文件名消毒）与「签名短期 +
绑定调用者」的下载令牌**已实现并通过本地对抗性测试**；软删除/回收站迁移 `0007`
已在真实库应用且零数据丢失。
但**真实对象存储的字节流从未验证**：上传仍由浏览器直传平台 bucket，下载仍需
接入平台 `createSignedUrl`。这些依赖妙搭 `dataloom`/`file-service`，本地不可达，
**必须由部署环境验证**。

**B3 — 限流为进程内实现（高）**
多实例部署下限流形同虚设，暴力破解防护失效。

**B4 — 散落的历史遗留（中）**
`[已证实]` seed 的 347 行资源中 **0 行带文件引用**，即端到端**没有任何可下载资源**；
且前端 kebab-case 与数据库 snake_case 命名漂移，导致约 122 个 Pre-K 资源与
全部 44 个 K 资源在 UI 中不可达。这属于**功能缺口**，不是安全问题，但不修则平台
对教师没有实际价值。

**B5 — 部分解决：4xx 已一致，5xx 仍可能不一致（本轮更正）**

【更正】我此前宣布 B5"已闭环"，**该结论过宽，现予更正**。当时的验证只覆盖了一条分支。

`[已证实]`（实测，4xx/HttpException 分支）：发送可控
`x-request-id: deadbeef-…`，401 响应中 header 与 body 的 requestId **完全一致**，
且调用方提供的值被原样保留。

`[已证实]`（代码阅读，5xx 分支仍有缺陷）：`exception.filter.ts` 中

- 第 33–35 行：`const requestId = res.locals.requestId ?? request.requestId`
  —— header（第 45 行）、日志（第 111 行）与 4xx body（第 60/74/90 行）都用**它**；
- 第 109 行：`const requestId = (request as {...})?.requestId;`
  —— 在未捕获异常分支内**重复声明，遮蔽了上面那个**，而 5xx body（第 120 行）
  用的是**被遮蔽的这个**。

文件自身的注释（第 22–31 行）已说明：平台自带的 request-id 中间件**晚于**我方中间件运行，
并会覆写 `req.requestId`——因此 `req.requestId` 与 `res.locals.requestId` **可能不同**。
header 取前者链路（res.locals 优先），5xx body 取后者，**故 500 响应仍可能不一致**。

修正方式（一行，删除第 109 行的遮蔽声明，让 5xx 分支复用外层权威值）：
`[未执行]` —— 验证它必须制造真实 5xx（需停掉 PostgreSQL），本轮未做，
**因此不声称已修复**。仅凭"应该没问题"就改动并在报告里宣布修好，
正是本项目明令禁止的行为。

`[无法验证]`：真实 5xx 下 header/body 是否实际不一致——需制造未捕获异常或停库复现。

`[已证实]`、与本发现相关的旁证：`x-log-trace-id` 是**平台自身**的日志链路 id，
与应用层 `x-request-id` 是两个不同用途的标识，本就不应相同；二者并存不是缺陷。

```
header: x-request-id: deadbeef-1111-2222-3333-444455556666
body:   {"error":{...,"requestId":"deadbeef-1111-2222-3333-444455556666",...}}
```

两者**完全一致**，且传入值被原样保留（说明中间件确实以调用方提供的 id 为准，
而不是丢弃后另生成）。此前"不一致"的观察源于同时存在的第二个关联 id：
`x-log-trace-id` 是**平台自身**的日志链路 id，与应用层的 `x-request-id` 是
**两个不同用途的标识，本就不应相同**。二者并存不是缺陷。

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

---

## 附录 B3：单实例生产架构前提（业主决定）

**决定**：当前以**单实例**公网部署为准，**不引入 Redis** 或其他共享存储；未来扩容到多实例时再迁移。

**必须同时写入文档、不得含糊的后果**：

| 项 | 状态 |
|----|------|
| 登录限流 | **进程内 Map**（`server/modules/auth/auth.service.ts` 的 `ipRateMap`），**仅在单进程内有效** |
| 第二个实例出现时 | 每个实例各持计数器，**有效限流阈值随实例数成倍放宽**，暴力破解防护**静默失效** |
| 会话吊销 | 基于数据库 `permissionsVersion`，**多实例下仍然正确**（非内存态） |
| 扩容前提 | **必须先把限流迁移到共享存储**，否则不得横向扩容 |

**运维约束（硬性）**：① 只运行一个应用进程；② 不启用横向自动扩缩容/多副本；
③ 滚动重启期间若短暂存在两个进程，需知悉限流在此期间是分裂的；
④ "再加一个实例"必须视为**需要先做限流迁移的变更**，而不是容量调整。

---

# 附录 C：上线状态三段式分类（业主指定）

> 本附录取代正文中较早的分段结论。凡与正文冲突，以本附录为准。

## C1. 已完成并验证（有命令与观察输出为证）

| 能力 | 证据 |
|------|------|
| RBAC 授权层：9 角色 / 44 权限 / 4 范围，`有效权限 = (角色默认 ∪ 追加授权) − 显式禁止` | HTTP 套件 24/24 |
| 越权提权阻断 | 数据库层 `42501` + DTO 白名单 `400` |
| 会话即时吊销（`permissionsVersion`） | 改权限后 `401 权限已变更，请重新登录` |
| MFA：RFC 6238 TOTP、AES-256-GCM 静态加密、SHA-256 恢复码、**数据库承载的一次性 challenge（多实例安全）** | HTTP 套件 36/36；未登记 MFA 的 super_admin 被拒 403 |
| CSRF 双提交令牌 | 四种组合实测 403/403/403/404 |
| 审计日志 append-only | 数据库层强制 |
| 错误响应脱敏（不泄露 stack/cause/路径/SQL） | 制造真实 500 实测 |
| `trust proxy` 加固 | 伪造 `X-Forwarded-For` 不再进入 `audit_logs.ip_address` |
| 安全响应头 | before/after 实测；20/20 断言 |
| 7 个迁移全部应用、校验和一致 | `migrate.mjs status` → `✓ No checksum drift` |
| `0007` 零数据丢失 | 前后快照：teachers 22 / resources 347 / review_records 18 / audit_logs 407 / sessions 136 全不变 |
| 迁移可回滚 | `0005`/`0004`/`0003` 可逆且业务数据完好；`0002` 按设计拒绝（防全园锁死） |
| down 迁移逃生门真实可用 | 实测：无 override 拒绝；有 `QLS_SOFT_DELETE_FORCE_DOWN=on` 成功 |
| 「禁止假启动」 | seed 全失败时**拒绝启动**，探针 5/5 |
| 前后端 API 契约 | 静态门禁（38 路由 vs 27 调用）+ **门禁自测**（故意漂移→退出 1） |
| 备份/恢复逻辑往返 | 12 表 / 902 行，行数与 SHA-256 校验和**完全一致** |
| **B5：5xx `requestId` 遮蔽** | 已修复；新测试 7/7，且**重新引入缺陷即 3 项失败**（非空转） |
| 文件校验边界 | 对抗性探针 32/32，含 EXE/HTML/文本/ZIP 伪装成 PDF 全部拒绝 |
| 授权覆盖审计 | 40 路由，21 条显式权限；其余 19 条为**按设计的仅认证**（全局双 `APP_GUARD` 已确认） |

## C2. 代码已完成，等待真实基础设施验证

| 项 | 为什么现在不能验证 |
|----|--------------------|
| 真实对象存储上传/下载（dataloom / `@lark-apaas/file-service`） | 平台不可达；当前**明确返回 503** 并写明缺失的集成，不伪造成功 |
| `registerFile` 魔数校验的**权威性** | 现流程为浏览器直传 bucket，`head` 字节**由客户端提供**，只能证明"调用方能给出自洽字节"，不能证明存储中的对象真是该类型。需服务端读取对象后才具权威性 |
| 生产库 backup/restore rehearsal（B1） | 本机**没有** `pg_dump`/`pg_restore`/`psql`，也无生产连接串 |
| 反向代理下的 `trust proxy` / HSTS / `Secure` Cookie 实际行为 | 本机无 Nginx/云入口与真实域名证书 |
| CSP 强制模式 | 默认 **report-only**；需先在真实构建设备上收集违规报告 |
| 多实例限流 | 按 B3 决定采用单实例架构；扩容前需迁移到共享存储 |
| B4 命名漂移与零文件引用 | 修复进行中 |

## C3. 仍然存在的生产阻塞项

| # | 阻塞项 | 性质 |
|---|--------|------|
| B1 | 生产库备份/恢复演练**从未执行** | 需真实 PG 集群 |
| B2 | 真实对象存储未接入；魔数校验非权威 | 需平台凭据 |
| B3 | 单实例架构约束（已接受，但**必须写入运维文档**；扩容前必须先迁移限流） | 运维约束 |
| B4 | 命名漂移 + 347 条资源零文件引用 → 端到端无可下载资源 | 修复中 |
| B6 | 回收站**无 UI**（按指示暂缓）；后端 soft delete / restore / purge 的权限与审计须先确保可靠 | 按指示延后 |
| — | 回归门禁**非顺序无关**，任何单次绿色运行都不足以作为证据 | 修复中 |
| — | `scripts/predeploy-check.sh` **不存在**，但被 `package.json` 的 `predeploy` 引用 | 待修 |
| **G-18** | **`POST /api/auth/reset-password` 绕过 RBAC**：无 `@RequirePermission`，仅靠硬编码 `roles.includes('principal')`，可重置**他人**口令，缺 `403`（返回 `404`），且**没有任何测试覆盖** | **未修复**，详见 `evidence/g18-reset-password.txt` |
| — | **未实现优雅退出**；无 Dockerfile / CI 流水线 | 待补 |

---

## 附录 D：B4 命名漂移 —— 已修复并有真实计数

**目标事实（`select … group by … from resources where deleted_at is null`，347 行）**：
subject 为 `montessori` 293 / `english` 44 / `virtue` 11；`sub_subject` **只存 snake_case**
（`practical_life` 80、`english_language` 43、`chinese_language` 1、`culture` 99、`math` 37、
`sensorial` 33、NULL 54）；theme 为中文标签。`server/ client/ shared/ scripts/ tests/`
中**不存在任何转换代码**。

| 分组 | 前端发送 | 列中实际存储 | 行数 | 修复前可达 | 修复后 |
|------|----------|--------------|------|------------|--------|
| `/prek/montessori/practical-life` | `practical-life` | `practical_life` | 80 | **0** | **80** |
| `/prek/montessori/english-language` | `english-language` | `english_language` | 43 | **0** | **43** |
| `/prek/montessori/chinese-language` | `chinese-language` | `chinese_language` | 1 | **0** | **1** |
| 6 × `/k/english/:theme` | `Myself` … `Around the World` | `主题1：我自己` … `主题6：环游世界` | 44 | **0** | **44** |
| `sensorial`/`math`/`culture` 等 | 两边一致 | 两边一致 | 169 | 169 | 169 |

**不可达资源：修复前 167 → 修复后 0。**

**兼容性**：**未改写任何一行数据**。请求在边界被翻译（`theme=myself` → `WHERE theme='主题1：我自己'`），
canonical 拼写仍然可用。别名表**只来源于真实值**，每条别名都标注了来源文件。

**文件缺失情况（从库中确认，非假设）**：**总计 347 · 有文件 0 · 无文件 347**。
**未创建任何占位文件、假行或存储条目。** `has_stored_file` 为
`GENERATED ALWAYS AS (…) STORED` 生成列——两值、不可手写；`coalesce` 是关键（首次运行
没有它时迁移自身的后置断言 347/347 失败，已记录在案）。检测脚本
`scripts/report-missing-files.mjs` 直接读视图、不重新推导谓词，任何失败模式都返回非零。

**新增迁移 `0008_resource_file_presence`**：生成列 + 部分索引 + 两个视图 + 前后置断言；
`up → down 0008 → up` 全流程在独立库上演练通过，`down` 断言文件列存活。

**顺带修复**：`npm run type:check:server` 在该工作开始前是**红的**（`shared/curriculum.ts`
预存重构留下 5 个 `TS2304`），而 `npm run build` 却通过——正是 SWC 不检查类型的陷阱。

**`[无法验证]`**：真实对象存储不可达，"有文件的资源端到端可下载"未经验证；
已验证的是它**通过文件校验并抵达存储调用（302）**，而仅有元数据的资源**停在 404**。

---

# 最终状态：A / B / C / D

> 本附录是最终结论，取代正文与早前附录中的分段结论。冲突时以本附录为准。
> 判定：**本机代码验收通过；公网上线未通过。**

## 本机最终门禁（逐字，`evidence/gate-run-final.txt`）

```
npm test                 # tests 230 # pass 230 # fail 0
typecheck server         PASS
typecheck client         PASS
npm run build            PASS
api-contracts            matched
authz-http               pass=74 fail=0
hardening                pass=10 fail=0
mfa                      pass=55 fail=0
security-headers         pass=20 fail=0
files-http               pass=73 fail=0
naming-http              pass=49 fail=0
                        ✅ 全部通过
```

**230 项单元测试 + 281 条 HTTP 断言（6 个套件）全部通过。**

`npm run predeploy`：20 项检查、**6 项失败**、2 项告警、`NOT READY FOR PRODUCTION`、**exit 1**
（原始输出 `evidence/predeploy.txt`）。其内部的门禁检查（第 19 项）**已通过**。

---

## A. 已在本机真实验证

| 能力 | 证据 |
|------|------|
| 统一鉴权体系（9 角色 / 权限目录 / 4 范围） | 门禁 authz 74/74 |
| **G-18 修复**：reset-password 接入 `@RequirePermission('account.reset_password')`，硬编码 `roles.includes('principal')` 已移除 | 源码 + 37 项确定性测试 + HTTP 断言 |
| 新增 `account.reset_privileged_password`，**仅 super_admin 持有**；目录完整性断言会在其他角色获得它时**抛错** | `shared/rbac.ts`；变异测试已验证 |
| 天花板规则 `canManageAccount`：principal 不能重置同级 principal、不能重置 super_admin；只能按模型重置其下角色 | HTTP 断言（403 矩阵） |
| **IDOR 防护**：仅接受 `teacherId`（`accountId`→400、非法 uuid→400）；目标角色从库中读取，并在写事务内 `FOR UPDATE` **重新判定**（无 TOCTOU）；拒绝时**一个字节都不写** | 前后 `password_hash` 逐字节比对 + 对端仍可用原密码登录 |
| 403/404 决策：**授权失败一律 403**，404 仅用于账号确实不存在 | 断言同时覆盖 403 与 404，且说明防枚举理由在此不成立 |
| MFA：未登记 MFA 的 super_admin 被拒（403）；特权账号重置需 **step-up 验证码**（缺失/错误→401，不写入，且记录拒绝审计） | 门禁 mfa 55/55 |
| 重置全程审计；**敏感信息不落日志** | 6 MB 日志中 0 命中密码/TOTP/挑战令牌/临时密码/scrypt 串 |
| **修复了一个真实且严重的既存缺陷**：此前所有密码写入以数据库角色 `anon_` 执行，而 0005 只授予它 `teachers` 的 3 列 UPDATE，导致重置与改密**返回 500 且从未真正改密** | 修复后断言：新密码可用、旧密码失效 |
| **修复了平台级明文日志泄露**：HTTP trace 拦截器**无条件**记录请求体与响应体；修复前同一日志含 28 个明文登录密码、2 个有效 TOTP、14 个挑战令牌、4 个临时密码 | 在 auth 模块内通过「消费即擦除 + 显式发送含凭据响应」闭环 |
| 安全响应头（含 CSP report-only、HSTS 条件启用、移除 `X-Powered-By`） | before/after 实测；20/20 |
| 优雅关闭：SIGTERM/SIGINT、请求 drain、关闭 DB、超时强制退出、幂等 | `scripts/verify-shutdown.sh` 24/24；实测 exit 0（约 440ms）/ 在途请求被应答后 exit 0 / 挂起请求 5083ms 强制退出 exit 1 / 双信号只执行一次 |
| **storybook-cover asset root 已修复**：不再依赖 `__dirname` 猜测；顺序为 `STORYBOOK_COVER_ASSETS_DIR`（权威，无回退）→ 编译产物布局（cwd 无关）→ 源码树；缺失时 readiness 503 + 错误级启动日志 | `tests/cover-asset-root.test.mjs` 10/10，含从空临时 cwd 启动并取真实种子行→200 + 真实 JPEG 字节 |
| 7+1 个迁移全部应用、校验和一致、**0007 零数据丢失**、可回滚（0002 按设计拒绝） | `migrate status/verify`；前后快照 |
| `scripts/predeploy-check.sh` 真实存在、`npm run predeploy` 真实可执行、失败非零、输出 READY/NOT READY；**不可验证项一律不计为通过** | 20 项检查；两次故意失败路径实测 |
| 回归门禁自身的可信度：无 `finally` 内 `process.exit`、崩溃必须非零退出、每次运行独立 fixture、advisory 锁防并发污染 | 静态扫描全清 + 5 次字节一致运行（md5 一致） |

## B. 代码已完成，等待真实基础设施验证

| 项 | 为什么本机无法验证 |
|----|--------------------|
| 真实对象存储 upload / download / private storage / signed URL / expiry / 授权与非授权下载 / ZIP 安全 | 妙搭 dataloom 需每请求平台上下文，独立机器**结构上不可能**具备；当前保持明确 **503 `STORAGE_NOT_CONFIGURED` / `STORAGE_UNAVAILABLE`**，**不伪造任何下载 URL** |
| `registerFile` 魔数校验的**权威性** | 上传为浏览器直传 bucket，`head` 字节由客户端提供；需服务端读取对象后才具权威性 |
| 生产库 backup / restore rehearsal | 本机**没有** `pg_dump` / `pg_restore` / `psql`。逻辑往返演练（12 表 / 902 行、校验和一致）**不等价于**生产备份可用，文档已如此声明 |
| 反向代理下的 `trust proxy` / HSTS / `Secure` Cookie 真实行为 | 无 Nginx / 云入口 / 真实证书 |
| CSP 强制模式 | 需先在真实构建产物上收集 Report-Only 违规 |
| Docker 镜像构建与运行 | **本机没有 Docker**，`docker build` / `docker run` **一次都没执行**；Dockerfile 为「按代码正确」，非实测 |
| CI 流水线执行 | 无 GitHub runner；仅做 YAML 结构校验，**从未执行** |
| npm audit 的稳定性 | 配置的镜像**未实现** advisory 端点（`NOT_IMPLEMENTED`）→ 记为 UNVERIFIED；改用公网 registry 后可运行 |

## C. 仍存在的生产阻塞项

| # | 阻塞项 | 依据 |
|---|--------|------|
| **B1** | 生产库备份/恢复演练**从未执行** | 本机无 `pg_dump`/`pg_restore`/`psql` |
| **B2** | 真实对象存储未接入 | 需平台凭据 |
| **C-1** | **没有任何可用的 super_admin**：唯一持有者是测试夹具 `__rbac_keeper`，它被**刻意设计为没有 `password_hash`**，且 `AuthGuard` 对该角色在 MFA 未绑定前拒绝一切路由 → 最高权限能力**当前完全不可达** | predeploy `FAIL [07]`；`auth.service.ts` + `auth.guard.ts` |
| **C-2** | **教师管理功能不可用**：`PATCH /api/teachers/:id` 与 `DELETE /api/teachers/:id` 因与 G-18 同源的 `anon_` 列权限问题**返回 500**（改名未生效、停用失败） | 由 auth 负责代理实测报告；**未修复**（不在其文件范围） |
| **C-3** | **平台级明文日志泄露仅被部分封堵**：`HTTPTraceInterceptor` 对**所有模块**无条件记录请求/响应体；auth 模块已闭环，但 `POST /api/teachers` 仍会返回 `temporaryPassword` 并被平台写入日志 | 由 auth 代理验证 |
| **C-4** | 依赖漏洞：**16 HIGH / 0 CRITICAL**（含 `drizzle-orm` 直接 SQL 注入公告、`@nestjs/platform-express`、`@lark-apaas/fullstack-nestjs-core`）。门禁**拒绝豁免**此类真实漏洞 | predeploy 依赖检查 |
| **C-5** | 生产环境变量未配置：`NODE_ENV`、`MFA_ENCRYPTION_KEY`、`DOWNLOAD_TOKEN_SECRET`、`HTTPS_ENABLED`/`TRUST_PROXY` | predeploy `FAIL [01][03][10][11]` |
| **C-6** | 单实例架构约束（已接受）：进程内限流，扩容前必须先迁移到共享存储 | `DEPLOYMENT_PRODUCTION.md` 附录 |
| **C-7** | 平台缺陷：`app.close()` 在本应用**无法完成**（`DRIZZLE_DATABASE` Proxy 在池断开后于 Nest 钩子自省时抛错，已用裸 `NestFactory.create` 独立复现）。已定位并在应用侧绕过并降级为 WARN，但 Nest 的关闭钩子不会运行 | shutdown 代理实测 |

## D. 非阻塞的后续优化

1. **回收站 UI** — 按指示保持 deferred；后端 soft delete / restore / 永久删除已有测试覆盖。
2. **多实例限流** — 迁移到 Redis/shared store（C-6 的解除条件）。
3. **`scripts/predeploy-check.sh` 在 CI 中接入公网 registry 的 npm audit**，使 C-4 从 UNVERIFIED 变为稳定可测。
4. **审计覆盖度**：独立复核为 42 路由 / 23 条显式权限；本机早期扫描为 40/21（因 look-ahead 窗口把 `resources GET /:id` 重复计了 3 次）。以复核数字为准，差异已记录。
5. **未实现**：优雅退出的编排层验证（无 k8s）、`rm -rf dist` 与服务并发时的瞬态中断端到端复现、`/assets/*` 由平台 CDN 提供（设计如此，非缺陷）。
6. Dockerfile / CI 待真实环境首次构建后回归。
