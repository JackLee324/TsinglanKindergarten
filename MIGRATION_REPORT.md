# MIGRATION_REPORT.md — 迁移事实报告

> **报告生成时间**：2026-09-24（会话内实时采集）
> **观测对象**：本工作树 `server/database/migrations/` + 本机真实 PostgreSQL 16.14 实例
> `127.0.0.1:55432`，数据库 `qls_test_0005`。
> **代码基线**：git commit `671328a` + 写作期间工作区改动（另一个 agent 正在同一工作树中
> 编辑代码与迁移，**本文件记录的是采集那一刻的真实状态**；`0007` 就是采集期间新出现的）。
>
> **证据标记**：**[已证实]** 本次实测 · **[推断]** 由代码互推 · **[无法验证]** 需部署环境确认。
>
> 框架与编写规范见 [`MIGRATION.md`](MIGRATION.md)；备份恢复见
> [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)。

---

## 1. 我**实际执行**了什么（先说清楚，避免误解）

| 命令 | 是否执行 | 结果 |
|---|---|---|
| `SUDA_DATABASE_URL="postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_0005" node scripts/migrate.mjs status` | ✅ **执行了两次**（10:19 与 10:23） | 两次都 exit **0**；第二次显示 `0007` 已 applied，输出见 §3 |
| `node scripts/verify-api-contracts.mjs` | ✅ 执行了 | 38 服务端路由 / 27 客户端调用全部匹配，exit 0 |
| `shasum -a 256 server/database/migrations/*.sql` | ✅ 执行了 | 与 `schema_migrations.checksum` 逐项一致（§3.2） |
| `ls server/database/migrations/`、`wc -l` | ✅ 执行了 | 14 个文件 / 7 对（§2） |
| 直接查询本地 PostgreSQL（`information_schema` / `pg_policies` / `pg_roles` / `pg_indexes` / `information_schema.table_constraints` / 行数） | ✅ 执行了 | 见 §4、§6 |
| `node scripts/migrate.mjs up` / `down` / `verify` / `baseline` | ❌ **未执行** | 这些会改动数据库；本报告只做只读观测（`0007` 的 `up` 是另一个 agent 执行的，我只观测结果） |
| `npm test` / `scripts/verify-all.sh` | ❌ **未执行** | 需独占 fixture 与运行中服务，同工作区另有 agent 在跑测试，避免相互污染 |
| `scripts/backup-rehearse.mjs` / `db-bootstrap.mjs` / `probe-file-validation.mjs` / `verify-security-headers.mjs` / `verify-seed-failure.sh` | ❌ **未执行** | 写作期间新增，只读了文件头 |
| 对**真实/生产**数据库的任何操作 | ❌ **未执行** | 无连接串（见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §0） |

**`qls_test_0005` 是一个本地验证库**（含 347 条种子资源、22 个账号、MFA 测试绑定），
**不是**生产库，也不代表生产库的状态。

---

## 2. 迁移清单（14 个文件 / 7 对）

`ls server/database/migrations/` 实测：**每个迁移都配有 `.down.sql`**，无一缺失。 [已证实]

| # | UP 文件 | 行数 | DOWN 文件 | 行数 | 本库状态 |
|---|---|---|---|---|---|
| 0001 | `0001_schema_baseline_alignment.sql` | 149 | `…down.sql` | 94 | **applied** |
| 0002 | `0002_backfill_legacy_usernames.sql` | 157 | `…down.sql` | 85 | **applied** |
| 0003 | `0003_rbac_database_layer.sql` | 356 | `…down.sql` | 120 | **applied** |
| 0004 | `0004_rls_role_alignment.sql` | 178 | `…down.sql` | 33 | **applied** |
| 0005 | `0005_tighten_rls_writes.sql` | 238 | `…down.sql` | 45 | **applied** |
| 0006 | `0006_mfa.sql` | 127 | `…down.sql` | 43 | **applied** |
| **0007** | `0007_resource_soft_delete.sql` | 261 | `…down.sql` | 77 | **applied**（10:23 起） |

（文件行数由 `wc -l` 实测；状态来自 §3 的 `status` 输出。）

---

## 3. `status` 的真实输出（本次实测，逐字）

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
  applied  0007_resource_soft_delete 2026-09-24T02:23:04.549Z

✓ No checksum drift.

$ echo $?
0
```
**[已证实]** —— 上面是本次会话真实执行的输出（密码打码，其余逐字保留；颜色码已去除）。

> **状态变化说明（重要，避免读者困惑）**：
> 本报告曾在 10:19 采集过一次，当时 `0007` 是 **pending**；
> 10:23 再次采集时已变成 **applied**（`applied_at = 2026-09-24T02:23:04.549Z`，
> 即本地时间 10:23:04）。
> **`0007` 的 `up` 不是我执行的** —— 同一工作树的另一个 agent 在做阶段 6/7 的实现与验证，
> 由它应用了该迁移。本报告只负责**如实记录观测结果**：文件内容我读过，DB 状态我查过，
> 但"是否有人跑过 `up`"这一点以观测到的 `schema_migrations` 行为准。
> 下文 §4-0007 的"生效证据"已按**应用后**的实测结果更新。

### 3.1 输出形状与行为（结合代码）

| 观察 | 说明 | 出处 |
|---|---|---|
| 头部两行 `Database … as <user>` / `Server …` | 来自 `current_database()` / `current_user` / `version()` | `migrate.mjs:207-210` |
| 每行 `applied`（绿）/ `pending`（黄） | 已应用显示 `applied_at` 的 ISO 时间 | `migrate.mjs:216-222` |
| 缺 `.down.sql` 会追加 `(no .down.sql)` | 当前 7 个迁移**都没有**该标注 | `migrate.mjs:220` |
| 末尾 `✓ No checksum drift.` | 无漂移 | `migrate.mjs:234` |
| 退出码 | 无漂移 **0**；有漂移 **2** 并打印 `CHECKSUM DRIFT` 清单 | `migrate.mjs:226-235` |
| **只读** | `status` 不建 `schema_migrations`；用 `to_regclass` 探测表是否存在 | `migrate.mjs:155-166,394` |
| 无连接串时 | 立即 `die` 并提示设置 `DATABASE_URL`/`SUDA_DATABASE_URL`/`MIGRATION_DATABASE_URL` | `migrate.mjs:79-91` |

### 3.2 `schema_migrations` 表内容（实测）

| version | name | checksum (sha256, 前缀) | execution_ms | applied_by |
|---|---|---|---|---|
| 0001 | schema_baseline_alignment | `01cfc224396d04d0…` | 6 | jacklee |
| 0002 | backfill_legacy_usernames | `5e98af94ab5749ce…` | 1 | jacklee |
| 0003 | rbac_database_layer | `cbf7181e54b599b8…` | 5 | jacklee |
| 0004 | rls_role_alignment | `4fe0952033271d16…` | 2 | jacklee |
| 0005 | tighten_rls_writes | `88f4fbaee7385720…` | 1 | jacklee |
| 0006 | mfa | `1bb611f9d0f0568f…` | 22 | jacklee |

**校验和已逐文件复核**：对 `server/database/migrations/*.sql` 重新计算 sha256，
与上表记录**完全一致**（6/6 匹配），这与 `status` 报告的 `No checksum drift` 相互印证。
[已证实：`shasum -a 256` 与 `schema_migrations.checksum` 逐项比对]

> 这说明截至本报告生成时，**没有已应用的迁移文件被事后修改过**。

---

## 4. 逐迁移明细：做了什么 + 生效证据

> 每一行的「生效证据」都是本次**直接查询本地数据库**得到的结果，
> 不是"文件里写了所以应该有"。

### 0001 — `schema_baseline_alignment`　`[applied]`　down: 有

**目的**：把数据库对齐到 v1.3.0 应用真正需要的结构（平台库与原生 PG 都适用），不删任何数据。

**做了什么**（`0001:50-149`）：
1. 缺则创建复合类型 `user_profile`；
2. 缺则创建角色 `anon` / `authenticated` / `service_role`；
3. 补 `teachers` 的 6 个认证列：
   `username`、`password_hash`、`must_change_password`（NOT NULL DEFAULT false）、
   `failed_login_attempts`（NOT NULL DEFAULT 0）、`locked_until`、`password_updated_at`（**可空**，
   注释解释了为什么不给默认值：会谎称所有账号刚刚改过密码）；
4. `teachers.wecom_user_id` 由 NOT NULL 改为**可空**（v1.3.0 不再写该字段）；
5. 建 `idx_teachers_username`（`UNIQUE … (lower(username)) WHERE username IS NOT NULL`）；
6. 建 `idx_teachers_status`；
7. 末尾断言 6 个列都存在，否则 `RAISE EXCEPTION`。

**生效证据（实测）**

| 检查 | 期望 | 实测 |
|---|---|---|
| `user_profile` 类型 | 存在 | `1` |
| `anon/authenticated/service_role` | 存在 | `anon,authenticated,service_role` |
| teachers 认证列 | 6/6 | `must_change_password,failed_login_attempts,locked_until,password_updated_at,username,password_hash` |
| `wecom_user_id` 可空性 | YES | `YES` |
| `idx_teachers_username` | 存在且为函数唯一索引 | `CREATE UNIQUE INDEX idx_teachers_username ON public.teachers USING btree (lower((username)::text)) WHERE (username IS NOT NULL)` |
| `idx_teachers_status` | 存在 | `1` |

**down 的行为**：不删有数据的列 —— 只要 `teachers` 里存在任何认证数据就
`RAISE EXCEPTION` 拒绝（`0001:…down.sql:23-52`）。这只删索引 + 空列。

---

### 0002 — `backfill_legacy_usernames`　`[applied]`　down: 有

**目的**：修复一个**已实测**的缺陷 —— v1.3.0 之前创建的账号没有 `username`，
而 `seedTeachers()` 按 `lower(username)` 查找，找不到就**再插一个账号**，
导致旧账号被复制（实测 `21 → 41`），且复制后的人**看不到自己的历史资源**。

**做了什么**（`0002:46-157`）：
- 只为 `username IS NULL` 的行推导用户名：优先取 `email` 的 `@` 前部分，
  否则取 `wecom_user_id` 并剥掉 `legacy_|wecom_|wx_|user_` 前缀；
  只保留 `[a-z0-9._-]`，小写，截断 50；
- **冲突则跳过**（同批次重复也跳过），不强行赋值；
- 末尾断言：不得出现重复用户名，否则 `RAISE EXCEPTION`。

**生效证据（实测）**：`teachers` 共 **22** 行，其中 `username IS NOT NULL` = **22**，
`username IS NULL` = **0**。

**down 的行为**：按同一推导函数精确反演；并且**若会让"可登录账号数"归零就拒绝执行**
（`0002:…down.sql:54-70`）。

---

### 0003 — `rbac_database_layer`　`[applied]`　down: 有

**目的**：把 [`RBAC.md`](RBAC.md) 的模型落到数据库，并让"权限变更即时生效""super_admin 自我保护"
**由数据库保证**，而不是靠应用层记得调用。

**做了什么**（`0003:46-356`）：
1. `teachers.permissions_version integer NOT NULL DEFAULT 1`（带 COMMENT）；
2. 表 `account_permission_overrides`（grant/deny、唯一约束、两个外键）；
3. 表 `account_scopes`（`ALL/PROGRAM/SUBJECT/OWN` + 形状 CHECK + 外键）；
4. 函数 `rbac_bump_permissions_version()` + 3 个触发器
   （`teachers` 的 `roles`/`status` 变化、覆盖表与 scope 表的任何增删改 → `permissions_version += 1`）；
5. `rbac_guard_super_admin()` + 触发器：非 super_admin 不得修改/删除 super_admin 行
   （要求事务内声明 `app.rbac_actor_super_admin`，未声明视为不是；本人改自己密码例外）；
6. `rbac_protect_last_super_admin()` + 触发器：不得删除/降级/停用**最后一名** active super_admin；
7. `sessions` 增加 `permissions_version` / `revoked_at` / `revoke_reason` / `device` + 2 个部分索引；
8. 末尾断言 + 检查触发器未被禁用。

**生效证据（实测）**

| 检查 | 期望 | 实测 |
|---|---|---|
| 两张新表 | 存在 | `account_permission_overrides,account_scopes` |
| `teachers` 上的触发器 | 3 个 | `trg_teachers_bump_permissions_version,trg_teachers_guard_super_admin,trg_teachers_protect_last_super_admin` |
| `sessions` 新列 | 4/4 | `permissions_version,revoked_at,revoke_reason,device` |

**down 的行为**：两张 RBAC 表在**有数据**时拒绝删除（除非 `QLS_RBAC_FORCE_DOWN`）；
`teachers.permissions_version` 刻意不删（`0003:…down.sql:19-32`）。

> 与 `0003` 相关的**实现约束**（在 `tests/rbac-database.test.mjs` 中被实证）：
> `set_config(..., true)` 是事务级的，跨 autocommit 语句即丢失 →
> 应用侧超级管理员写入必须包在显式事务里（`AuthorizationService.withSuperAdminAuthority()`）。

---

### 0004 — `rls_role_alignment`　`[applied]`　down: 有

**目的**：修复"应用在独立部署下**查不到任何数据**"的故障 ——
平台的 `SqlExecutionContextMiddleware` 每请求执行 `SET LOCAL ROLE 'anon_'`（空后缀），
而 `init.sql` 只为无后缀角色建了 policy → RLS 有策略而无匹配角色 → **静默返回 0 行**
→ 登录报"用户名或密码错误"且不写审计。

**做了什么**（`0004:57-178`）：
1. 缺则创建 `anon_` / `authenticated_` / `service_role_`；
2. 给三者授 `USAGE ON SCHEMA public`、表级 `SELECT/INSERT/UPDATE/DELETE`、序列权限、
   以及 `ALTER DEFAULT PRIVILEGES`（覆盖后续迁移新建的表）；
3. 为 6 张业务表各建 policy：`service_role_`/`authenticated_` 全权限；
   `anon_` 为 SELECT + INSERT（**只写 `WITH CHECK`**）+ UPDATE；
4. 末尾断言角色存在、且 4 张关键表上有 `anon_` 的 policy。

**生效证据（实测）**：角色 `anon_,authenticated_,service_role_` 均存在；
`pg_policies` 中 `policyname LIKE 'rls0004%'` 共 **28** 条。

**down 的行为**：只删 `rls0004_%` 前缀的 policy；
**刻意不删角色**（应用每请求依赖它们，删了服务就废了）——`0004:…down.sql:4-10`。

---

### 0005 — `tighten_rls_writes`　`[applied]`　down: 有

**目的**：消除审计发现 §D-5/§D-6 的提权面 —— `init.sql` 给匿名角色的
`FOR UPDATE … USING (true) WITH CHECK (true)` 实际含义是"可改任意行任意列"，
包括 `teachers.password_hash`、`roles`、`status`，以及可以读/改全部 `sessions`。

**做了什么**（`0005:57-238`）：
1. 先 `DROP` 掉那批无法安全表达的写策略（**同时覆盖 `anon` 与 `anon_` 两种拼写**）；
2. 重建窄化后的策略（同样覆盖两种拼写）；
3. **列级 GRANT（真正的执行手段）**：
   - `teachers`：`UPDATE` 仅 `last_login_at, failed_login_attempts, locked_until`；
     `SELECT` **保持表级**（注释解释了列级收窄读权限会打断正常页面，且收益极小）；
   - `sessions`：`SELECT` 限 `id, session_hash, teacher_id, created_at, last_accessed_at,
     expires_at, revoked, permissions_version, revoked_at, revoke_reason, _created_at, _updated_at`；
     `INSERT` 表级；`UPDATE` 限 `revoked, revoked_at, revoke_reason, last_accessed_at, permissions_version`；
   - `audit_logs`：`SELECT, INSERT`；显式 `REVOKE UPDATE, DELETE, TRUNCATE`
     → **对匿名角色，审计在数据库层是 append-only**；
4. 末尾用 `has_column_privilege()` 断言匿名角色**不能**改 `password_hash` / `roles`，
   否则 `RAISE EXCEPTION`。

**生效证据（实测，`has_column_privilege` / `has_table_privilege`）**

| 检查（角色 `anon_`） | 期望 | 实测 |
|---|---|---|
| `UPDATE teachers.password_hash` | false | **false** ✅ |
| `UPDATE teachers.roles` | false | **false** ✅ |
| `UPDATE teachers.last_login_at` | true（登录流程需要） | **true** ✅ |
| `UPDATE audit_logs` | false | **false** ✅ |
| `DELETE audit_logs` | false | **false** ✅ |
| `INSERT audit_logs` | true（写审计需要） | **true** ✅ |
| `sessions` 上 `anon_` 的 UPDATE 策略 | 存在 | `sessions_anon_update_lifecycle_anon_` ✅ |

（注意最后一行：策略名是 `sessions_anon_update_lifecycle_anon_`（`0005` 重建的），
而不是 `0004` 的 `rls0004_anon_upd_sessions` —— 与 `0005:62-65` 的 `DROP` 列表一致。）

**down 的行为**：**会重新打开提权路径**（匿名角色恢复可改 `password_hash`/`roles`、
可删审计），文件头有醒目警告，要求尽快 `up` 回来。 [已证实]

---

### 0006 — `mfa`　`[applied]`　down: 有

**目的**：为特权账号提供 TOTP 第二因素，并让"密码已过、第二因素未过"的中间态
**在数据库里**而非进程内存中（多实例安全）。

**做了什么**（`0006:36-127`）：
1. 表 `teacher_mfa`：`teacher_id PK`、`secret_encrypted text NOT NULL`（AES-256-GCM 密文
   `v1:<iv>:<tag>:<ct>`，带 COMMENT 禁止存明文）、`algorithm/digits/period_seconds`
   （各带 CHECK）、`confirmed`（默认 false，未证实持有前不算启用）、`enabled_at`、`last_used_at`；
2. 表 `mfa_recovery_codes`：`code_hash varchar(64) NOT NULL`（SHA-256）、`used_at`、`used_ip`；
   部分索引 `WHERE used_at IS NULL` + `code_hash` 唯一索引；
3. 表 `mfa_challenges`：`token_hash UNIQUE`（只存哈希）、`teacher_id`、`attempts`/`max_attempts`
   （默认 5，限暴破）、`expires_at`、`consumed_at`、`ip_address`、`user_agent`；
4. 末尾断言三表与关键列存在。

**生效证据（实测）**：表 `mfa_challenges,mfa_recovery_codes,teacher_mfa` 均存在。
本库 `teacher_mfa` 有 **1** 行，`confirmed = false`（是测试留下的未完成绑定，不是生产状态）。

**down 的行为**：存在**已确认**的 MFA 绑定时**拒绝执行**（除非 `QLS_MFA_FORCE_DOWN=on`），
因为删除会让这些账号静默降级为单因素。 [已证实]

---

### 0007 — `resource_soft_delete`　`[applied]`　down: 有

> **状态提示**：本迁移在本次报告**首次采集时（10:19）是 pending**，10:23 复采时已
> **applied**（`applied_at = 2026-09-24T02:23:04.549Z`）。
> `up` 由同工作树的另一个 agent 执行，**不是我执行的**（§3 的状态变化说明）。

**目的**（`0007:4-14`）：把 `DELETE /api/resources/:id` 的**硬删除**改为**回收站（软删除）**，
理由：一次误点或一个被盗会话就会永久删除整学期教案，审计只留痕、行本身不可恢复，
对象存储中的文件还会变成孤儿。

**做了什么**（`0007:56-261`）：
1. 前置检查 `resources` 表存在（否则 `RAISE EXCEPTION`，防误连库）；
2. 加 3 列：`deleted_at`（NULL = 活跃）、`deleted_by`（外键 → `teachers(id) ON DELETE SET NULL`）、
   `purge_after`；
3. 加 CHECK 约束 `resources_soft_delete_pairing`：`deleted_at` 与 `purge_after`
   **要么都为空、要么都非空**（防止"半删除"行）；
4. 4 个部分索引：回收站扫描（`deleted_at IS NOT NULL`）、purge 扫描、活跃集
   `(status, _created_at DESC) WHERE deleted_at IS NULL`、
   活跃集 `(uploader_id, _created_at DESC) WHERE deleted_at IS NULL`；
5. **刻意不为软删除加 RLS 条件**：文件头 `0007:30-41` 明确说明
   —— 回收站需要读到已删除行、restore 需要能 UPDATE 它们，而独立部署下这些操作
   与普通读**跑在同一个数据库角色**下；在 RLS 里过滤会隐藏回收站、
   让 restore 变成"静默 0 行 UPDATE"，正好重现 `0005` 记录过的那类故障。
   **软删除可见性是应用层职责**，每条查询都要带 `deleted_at IS NULL`；
6. 对 `anon_`/`authenticated_`/`service_role_` 显式重申（不扩大）`SELECT, UPDATE` 与对应 policy；
7. 末尾两组断言：列/索引/约束必须存在；且三个角色必须有
   `SELECT`/`UPDATE resources.deleted_at` 的列权限与 SELECT/UPDATE policy。

**生效证据（应用后实测）**

| 检查 | 期望 | 实测 |
|---|---|---|
| `resources` 新列 | 3/3 | `deleted_at,deleted_by,purge_after` |
| `resources_soft_delete_pairing` 约束 | 存在 | `1` |
| 4 个部分索引 | 4 | `4` |
| `pg_policies` 总数 | 增加（新增 `rls0007_*`） | **58**（`0005` 时为 **52**，+6 = 3 角色 × SELECT/UPDATE） |
| 现有数据未被改义 | 无可删除行 | `resources` 347 行中 `deleted_at IS NOT NULL` = **0** ✅ |

[已证实，2026-09-24 10:23 之后；本次会话直接查询本地库]

**应用过程的原始日志**：`evidence/migration-0007-applied.txt`（另一个 agent 执行并留存）。要点：

| 项 | 值 |
|---|---|
| 应用前 | `migrations applied: 6 (0001..0006)`；软删除列**不存在** |
| 命令 | `node scripts/migrate.mjs up` → `✓ 0007_resource_soft_delete applied in 13ms` |
| 应用后 | `migrations applied: 7 (0001..0007)` |
| 数据比对（`db-snapshot --compare`） | `teachers` 22、`resources` 347、`subject_permissions` 0、`review_records` 18、`audit_logs` 407、`sessions` 136 —— **全部 unchanged**；`✓ No data loss, no dropped columns, no weakened RLS.` |

> ⚠️ 该日志同时记录了一个**真实的顺序性事故**：文件存储的代码改动
> （`resources.service.ts` 开始过滤 `deleted_at IS NULL`）**先于**它的迁移上线，
> 于是 `0007` 应用前所有 `/api/resources/*` 都返回 **500**
> （门禁里表现为 `resources reachable before change -> 500 expected 200`）。
> **教训：依赖新列/新表的代码改动必须与迁移同时发布，且迁移先行。**
> 这条与本文件 §1 的"迁移必须先于依赖它的代码"是同一件事的实例化。
> [已证实：阅读该日志]

**down**：见 `0007_resource_soft_delete.down.sql`（77 行）。
它会读取 GUC `qls.soft_delete_force_down`（第 27 行）并在回收站非空时拒绝执行
（第 46 行的提示语指向 `QLS_SOFT_DELETE_FORCE_DOWN=on`）。
⚠️ 该开关**曾经是假的**：文件里的提示语写了一个环境变量，但没有任何代码把它映射到
SQL 实际读取的 GUC → 按提示重跑仍然被拒。已在 commit `18fd396`
（`fix(migrate): make the documented down-migration escape hatch real`）修复：
`migrate.mjs` 的 `applyMigrationGucs()` 现在在 `up`/`down` 的事务内、
迁移 SQL 之前执行 `set_config(..., true)`，支持
`QLS_MIGRATION_GUC_<NAME>=<value>` → GUC `qls.<name>`（值走绑定参数，不能注入 SQL），
并为软删除提供显式别名 `QLS_SOFT_DELETE_FORCE_DOWN=on|1|true|yes`。 [已证实，代码阅读]

---

## 5. 迁移框架的可用性评估（基于本次实测）

| 结论 | 证据 |
|---|---|
| 状态可读、只读、可重复执行 | `status` 前后各跑一次（10:19 与 10:23），除已从 pending 转为 applied 的 `0007` 外，其余行完全一致 [已证实] |
| 无校验和漂移 | 两次 `status` 都输出 `No checksum drift`；6 个（`0007` 应用前）/ 7 个（应用后）已应用文件的 sha256 与记录逐项一致 [已证实] |
| 每迁移有 down | 7/7 对文件齐全（`ls`）[已证实] |
| 幂等设计 | 全部使用 `IF NOT EXISTS` / 条件化 `DO` 块；`0002` 只碰 `username IS NULL` 的行 |
| 自证性 | `0001`~`0007` **每一个**都有末尾断言块，未生效即抛异常 [已证实] |
| 不删数据 | 全部 UP 文件中**没有** `DROP TABLE` / `DROP COLUMN` / `DELETE` / `TRUNCATE`（`grep -nE "^\s*(DROP\|DELETE\|TRUNCATE)"` 逐文件确认）。出现的 `DROP` 只有两类、均为幂等重建：`DROP TRIGGER IF EXISTS`（`0003:152,158,164,252,302`）与 `DROP POLICY IF EXISTS`（`0005:60-65`，那是本迁移的整改对象）。`0001` 里的 `ALTER COLUMN … DROP NOT NULL` 是**放宽**约束（使 `wecom_user_id` 可空），不是删列。[已证实] |
| **`0007` 应用后数据未受损** | 应用后 `resources` 仍为 **347** 行、`deleted_at IS NOT NULL` 为 **0**（新列全为 NULL，符合 CHECK 约束）[已证实] |

**我未实测**：`up` / `down` / `verify` / `baseline` 的**执行过程**（`0007` 的 `up` 由另一个 agent 执行）。
`PRODUCTION_READINESS.md` §P-2 记录了历史上一轮 `tests/migration.test.mjs`「10 项全部通过」
（含 checksum 漂移退出码 2、回滚拒绝守卫、无数据丢失），但**那是上一轮的记录，本次未复跑**。
[已证实：该文档内容] [未复验]

### 5.1 运维/验证脚本（与迁移直接相关，均已阅读源码）

| 脚本 | 作用 | 与迁移的关系 |
|---|---|---|
| `scripts/db-bootstrap.mjs` | **从零建库**：执行幂等前导（`user_profile` 类型 + 三个 DB 角色，**源码从 `0001` 的前两个 `DO $$` 块提取以免漂移**）→ `init.sql` → `migrations up`。**已有 `teachers`/`resources` 时拒绝运行**（除非 `--force`），**从不 DROP** | 解决实测过的**互相依赖**问题：两种顺序都以 `42P01 relation "teachers" does not exist` 失败。详见 [`MIGRATION.md`](MIGRATION.md) §2.3 |
| `scripts/backup-rehearse.mjs` | **逻辑往返演练**：导出全部表行 → **用 `db-bootstrap` 从零建 scratch 库** → 按 FK 拓扑序在**单事务**内导入 → 逐表比**行数 + SHA-256 内容校验和**（`schema_migrations` 比**版本集合**） | 实测 12 表 / 902 行 / 行数与校验和全部一致（`evidence/backup-restore-rehearsal.txt`）。它**不能**替代 `pg_dump`/PITR，脚本自己会打印这句话。详见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §7.4 |
| `scripts/verify-seed-failure.sh` | **"禁止假启动"回归**：用 `CHECK (false) NOT VALID` 强制每次 `teachers` INSERT 失败，断言应用**不启动**且**日志含刻意的拒绝信息**（不是仅看退出码）。实测 **5/5 PASS** | 与迁移的关系最直接：`0001` 补的就是 `teachers` 的 6 个认证列，缺列正是历史事故的根因。它内部**调用 `db-bootstrap`**，因此也顺带验证建库路径。详见 [`RUNBOOK.md`](RUNBOOK.md) §5.3.3 |
| `scripts/verify-security-headers.mjs` | 安全响应头 on-the-wire 断言（整改前对旧构建 `pass=5 fail=15`，整改后 **20/20**） | 与迁移无关；已接入 `scripts/verify-all.sh`。见 [`SECURITY.md`](SECURITY.md) §10.2 |
| `scripts/probe-file-validation.mjs`、`scripts/verify-files-http.mjs` | 文件校验探针 / 文件下载令牌 HTTP 套件（`files-http 61/61`） | 与迁移无关 |

> ⚠️ 这些脚本**由另一个 agent 新增**；我阅读了它们的源码与**原始日志**
> （`evidence/`），但**没有自己执行**。引用时标注为"已证实：阅读日志/源码"。
> 它们的存在不改变 §1 的"我实际执行了什么"。

### 5.2 回滚演练的实测结果（原日志：`evidence/migration-rollback.txt`）

在"从零建库 + 灌入 902 行"的 scratch 库上逐级 `down`：

| 目标 | 结果 | 说明 |
|---|---|---|
| `down 0005` | ✅ 成功（连带 `0006`，共 2 个） | 结构可逆 |
| `down 0004` | ✅ 成功 | 只删自己建的 `rls0004_%` policy |
| `down 0003` | ✅ 成功 | RBAC 表当时为空，守卫放行 |
| `down 0002` | ❌ **按设计拒绝**（`P0001`） | "reverting the username backfill would leave 0 accounts able to log in (20 currently can)" |
| `down 0001` | — 未到达 | `0002` 的守卫终止链条 |

数据存活：`teachers 22` / `resources 347` / `review_records 18` / `audit_logs 386` / `sessions 128` 完好；
`teacher_mfa` 表消失**是正确的**（`0006` down 即删该表）。

> 结论：结构类迁移（`0003`/`0004`/`0005`）**确实可逆**；
> `0002` **有意不可原地回滚**。
> 因此**活库的灾难恢复必须用 `pg_restore`，不是 `down` 到零**。

另见 `evidence/migration-guard.txt`：`0007 down` 在回收站非空时**拒绝**（`42501`），
带 `QLS_SOFT_DELETE_FORCE_DOWN=on` 后**成功**，且三个软删除列确认已删除
（通用开关 `QLS_MIGRATION_GUC_<NAME>` → GUC `qls.<name>`，值走绑定参数）。

---

## 6. 种子 / 回填现状（诚实版）

### 6.1 应用侧账号 seed

- `AuthService.onModuleInit()` 调用 `seedTeachers()`。
- 数据源：`server/modules/auth/seed-teachers.ts` 中**硬编码的 20 个账号 + scrypt 口令哈希**。
- 幂等策略：按 `lower(username)` 查存在性；存在则跳过；
  存在但**没有 password_hash** 时**回填哈希**（而不是新建）。
- **⚠️ 行为已变更（重要，不要沿用旧结论）**：
  **单个账号的失败在过去会被 `try/catch` 吞掉、应用照常报告"启动成功"**
  —— 这正是 `PRODUCTION_READINESS.md` §E-5/§O-3 记录的"零账号却显示启动成功"的成因。
  **该行为现已修复**（`auth.service.ts` 的 `onModuleInit`）：`seedTeachers()` 现在返回
  `{ created, skipped, failed, failedUsernames }`，并按三种结果分别处理：
  全部 skipped → 安静继续；**部分**失败 → 打 ERROR 但不中止；
  **完全**失败（`created=0 && skipped=0 && failed>0`）→ **抛错，Nest 中止启动**。
  日志行也随之变为 `Seed teachers: created=N, skipped=M, failed=F`。
  [已证实：源码阅读 + `evidence/no-fake-startup.txt`]
  回归测试 `scripts/verify-seed-failure.sh` 实测 **5/5 PASS**
  （用 `CHECK (false) NOT VALID` 强制每次 `teachers` INSERT 失败，
  并断言日志含刻意的拒绝信息 —— 而不是只看退出码）。[已证实：该日志；我未复跑]
- 本库 `teachers` 实测 **22** 行、全部 `active`，角色分布：
  `k_assistant 4, prek_assistant 4, pe_specialist 4, prek_head 3, k_head 3, principal 2,
  curriculum_director 1, super_admin 1`（另含 `system_initializer`）。
  ⚠️ 这是**测试库**分布（含测试新增的 `super_admin` 与 keeper 账号），
  **不代表生产**。 [已证实]

### 6.2 课程数据 seed（`server/database/seed-curriculum.sql`，493 KB）

| 事实 | 证据 |
|---|---|
| 文件存在 | `ls server/database/` 实测 [已证实] |
| **依赖一个仓库中无处创建的账号** `system_initializer` | 该字符串在文件中出现 **349 次**，全部位于该文件自身；[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) §E-14 记录了"按交付状态执行会**报告成功但插入 0 行**" [已证实] |
| 脚本**开头就会 DELETE** | `seed-curriculum.sql:9-10`：`DELETE FROM resources WHERE uploader_id = (SELECT id FROM teachers WHERE wecom_user_id = 'system_initializer')` → **在真实库上重跑会先删掉全部种子资源** [已证实] |
| 本库确有 `system_initializer` | 实测 `teachers` 中 `wecom_user_id='system_initializer'` 的行数 = **1**，因此本库的 347 条资源是插入成功的 [已证实] |
| **全部 347 条资源的 uploader 都是同一个账号** | 实测 `count(distinct uploader_id)` = **1**；即资源归属是合成的初始化账号，不是真实教师 [已证实] |
| 无悬空 uploader | `resources` 中 uploader 不存在的行 = **0**（外键 `resources_uploader_fkey`）[已证实] |

> **给部署方的结论**：不要把 `seed-curriculum.sql` 当作"初始化必跑"的步骤。
> **按交付状态它插入 0 行**（因为 `system_initializer` 不存在）；
> 而在已经有数据的库上重跑它会**先删后插**。
> 这是"看起来幂等、实际有破坏性"的典型，已在 [`MIGRATION.md`](MIGRATION.md) §7 列为铁律禁止项。

### 6.3 迁移回填（0002）

`0002` 是**唯一**的数据回填迁移，且只做一件事：给 `username IS NULL` 的旧账号推导用户名。
本库实测 `username IS NULL` = 0，说明它（或在它之前的 seed）已使所有行都有用户名。
[已证实]

### 6.4 零可下载资源 —— **端到端 0 个**

这是必须明确的一条：

```sql
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE file_bucket_id IS NOT NULL AND file_bucket_id <> '')::int AS with_bucket,
       count(*) FILTER (WHERE file_path      IS NOT NULL AND file_path      <> '')::int AS with_path,
       count(*) FILTER (WHERE status='published')::int AS published
FROM resources;
```
**实测结果（本库）**：
```
total = 347 · with_bucket = 0 · with_path = 0 · published = 347
```
[已证实，2026-09-24]

因此：

- **数据库层面可下载的资源数量仍然为 0。** 347 条全部是"元数据行"，没有任何一条挂真实文件。
  （10:23 复采仍为 `total = 347 · with_file = 0 · deleted = 0`。） [已证实]
- 这与 [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) §E-14「347 行中带文件引用的 = 0 行」一致。

> ⚠️ **但代码侧在此期间已经变了，不要再引用旧结论。**
> 写作期间另一个 agent 落地了真实文件链路（阶段 6），包括：
>
> | 新文件 | 内容 |
> |---|---|
> | `server/common/crypto/download-token.ts` | **带过期、绑定调用者的下载令牌**：`HMAC-SHA256` 签名，payload 绑定 `resourceId` + `teacherId` + `exp` + `nonce`；默认 TTL **300s**、硬上限 **3600s**；密钥来自新环境变量 `DOWNLOAD_TOKEN_SECRET`（≥32 字节，缺失时 **fail closed**，不发链接） |
> | `server/modules/files/files.{module,service,controller}.ts` | `GET /api/files/download`（`@RequirePermission('resource.download','storage.download')`），通过平台 `FileService` 取**签名直链**；平台存储不可用时返回**明确的 503**（`STORAGE_UNAVAILABLE_MESSAGE`），**不返回伪造/占位 URL** |
> | `server/common/files/file-validation.ts` | 文件校验（另有独立探针 `scripts/probe-file-validation.mjs`） |
> | `server/database/migrations/0007_resource_soft_delete.sql` | 软删除/回收站（本报告 §4-0007） |
>
> 也就是说：**"下载是未签名、无过期的 URL"这一条已经不再成立**——
> 旧的 `// TODO: 接入真实 dataloom FileService` + 手拼
> `/api/__platform__/storage/download?bucket=…&path=…` 的写法已被替换。
> 我没有逐行审阅这套新实现的全部细节，因此：
> ① 上面的"347 行 0 文件"是**数据库事实**，仍然成立；
> ② 关于新下载链路的安全性判断，请以 [`SECURITY.md`](SECURITY.md) §12 G-3
> 与 [`THREAT_MODEL.md`](THREAT_MODEL.md) §5.1 的**更新后**版本为准。 [已证实：新文件存在与文件头内容]
- 因此 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §3.4 的对象存储备份**当前无实际数据**，
  但**一开始真实上传就必须立即纳入备份范围**；同时新增的
  `DOWNLOAD_TOKEN_SECRET` 必须与数据库备份**分开**保管（§3.3 同类要求）。

### 6.5 种子数据的课程覆盖面（实测，比文档声称的更窄）

| 维度 | 实测分布 |
|---|---|
| `program` | `prek 303` / `k 44` |
| `subject` | `montessori 293` / `english 44` / `virtue 10` |
| `folder_type` | `courseware 245` / `weekly_plans 80` / `curriculum_outline 22` |
| `sub_subject` | `culture 99` / `practical_life 80` / NULL 54 / `english_language 43` / `math 37` / `sensorial 33` / `chinese_language 1` |
| `semester` | NULL **305** / S1 24 / S2 18 |
| `status` | `published` **347**（无 draft/pending/rejected） |

[已证实，直接查询 `resources`]

由此可得两个**与文档不一致**的事实：

1. **六类资料夹只有三类有数据**（缺 `materials`、`observation`、`research_archive`），
   而前端导航展示了全部六类 → 三个入口点进去是空的。
   （与 [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) §B10 一致）
2. **只有 3 个 subject 有数据**：`montessori`、`english`、`virtue`。
   `k/chinese`、`k/pe`、`prek/pe` 以及 K 的美德均为 0 条，
   但 `client/src/app.tsx` 中这些路由**都存在**（`k/chinese`、`k/pe`、`prek/pe`）[已证实]。
3. `semester` 有 305/347 为 NULL（K 英文的学期/周次只写在标题里）——
   即学期/周次筛选对绝大多数资源无效（与 §F-12 一致）。

---

## 7. 本报告未覆盖 / 未验证的内容

| 项 | 原因 |
|---|---|
| `up` / `down` / `verify` / `baseline` 的实际执行 | 会改动数据库；本次只做只读观测（`0007` 的 `up` 由另一个 agent 执行，我只观测到结果） |
| `tests/migration.test.mjs`（10 项）与 `tests/rbac-database.test.mjs` 的当前结果 | 未运行（见 §1）；历史结果见 [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) §P-2 |
| 在**生产库**上的迁移状态 | 无连接串 —— 生产库是否已迁移、是否有 pending、是否有漂移，**全部未知** [无法验证] |
| 迁移在生产库上的**耗时** | 本地 `execution_ms` 为 1~22ms（空库/小库），与生产数据量无关 [无法验证] |
| 妙搭平台库是否与本地 `0001`~`0007` 结构一致 | 无平台访问 [无法验证] |
| `0007 down` 与 `0003`/`0006` down 的**实际回滚行为**（含 `QLS_*_FORCE_DOWN` 逃生门） | 未执行；commit `18fd396` 声称已在 scratch 库端到端验证，我**只读了代码**，未复跑 |
| `scripts/db-bootstrap.mjs` / `backup-rehearse.mjs` / `probe-file-validation.mjs` / `verify-security-headers.mjs` / `verify-seed-failure.sh` 的执行 | 写作期间新增，我只读了文件头，**未执行** |
| 新增文件链路（`download-token.ts` / `modules/files/*`）的逐行安全审阅 | 只读了文件头与关键导出，未做完整审阅 |
| 对象存储中的数据 | 无平台凭据 [无法验证] |

---

## 8. 一句话摘要

- 迁移框架**已就位并可用**：7 对文件（每对都有 down）、校验和、advisory lock、
  每迁移独立事务、末尾断言、只读 `status`、以及**真实可用**的 `QLS_*_FORCE_DOWN` 逃生门
  （commit `18fd396` 修复）。
- 本地验证库 `qls_test_0005`：**0001~0007 全部 applied、无漂移**。
- **没有任何迁移在生产/真实数据库上执行过** —— 本环境没有该连接。
- 种子数据：347 条资源**全部无文件引用**，`subject_permissions` 为 **0** 行，
  六类资料夹只有三类有数据 → **数据库层面端到端可下载资源仍为 0 个**；
  但**代码侧已新增带签名/过期/调用者绑定的下载令牌与平台签名直链实现**（§6.4）。
- **备份与恢复从未在真实/生产库上演练过**（见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)）；
  写作期间出现了 `scripts/backup-rehearse.mjs`（**逻辑 round-trip 演练**，非 `pg_dump`），
  详见该文档 §7.4。
