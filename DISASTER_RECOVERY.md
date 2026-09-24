# DISASTER_RECOVERY.md — 备份与恢复

> **本文档的第一句话必须是事实：**
>
> ## 从未对项目所有者的真实/生产数据库执行过任何备份或恢复演练。
>
> 原因是开发环境**没有该数据库的连接串**，也没有该库的任何凭据。
> 本仓库中**不存在**任何生产数据导出。因此：
> - 本文档**不包含**任何"备份已成功""恢复已验证"的结论；
> - §3 的所有 `pg_dump` / `pg_restore` / `psql` 命令都是**待执行模板**，
>   必须由部署环境执行并回填结果；
> - §8 是一份必须在**上线前**完成的演练清单，未完成即视为不具备灾难恢复能力。
>
> 任何声称"备份已完成/恢复已演练"的说法，在当前证据下都是不成立的。
>
> **证据标记**：**[已证实]** 本次实测或源码逐行确证 · **[推断]** 由代码/配置互推 ·
> **[无法验证]** 需要部署环境（连接串 / `pg_dump` 客户端 / 对象存储凭据）才能确认。
>
> 相关文档：[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) ·
> [`MIGRATION.md`](MIGRATION.md) · [`RUNBOOK.md`](RUNBOOK.md) ·
> [`SECURITY.md`](SECURITY.md) · [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md)

---

## 0. 为什么本机连"演练一次"都做不到

```
$ which psql pg_dump pg_restore createdb
（无输出 —— 四个命令都不存在）

$ ls .devtools/pg/node_modules/@embedded-postgres/darwin-arm64/native/bin/
initdb   pg_ctl   postgres
```
[已证实，2026-09-24]

本机用于验证的 PostgreSQL 16.14 由 `scripts/dev-postgres.sh` 安装，
该嵌入式发行包**只含服务端二进制，不含 `psql` / `pg_dump` / `pg_restore`**。
`dev-postgres.sh` 的 `psql` 子命令（`:96-104`）实际上是用 `postgres.js` 执行的查询，
**不是** `psql`，也**不能**导出备份。 [已证实]

因此在本机：
- 无法生成本地库的 dump（也**没有**值得备份的数据——本地库只是测试 fixture）；
- 无法演练 `pg_restore` 流程；
- 无法验证 §4 的恢复步骤是否真的可执行。

**"无法在本机演练"不等于"部署环境失败"**，但它意味着：
**这套恢复流程在第一次真正需要它之前，从未被执行过一次。**
这正是 §8 清单存在的原因。

---

## 1. 备份什么、为什么（资产清单）

| # | 资产 | 存在哪里 | 丢了会怎样 | 备份方式 |
|---|---|---|---|---|
| **A1** | **业务数据库**（全部业务状态的权威副本） | PostgreSQL | 账号、资源元数据、审核记录、审计、权限、MFA 绑定**全部消失**，不可重建 | `pg_dump`（§3.1） |
| **A2** | **集群级角色与权限** | PostgreSQL 集群（`pg_auth_members` 等） | `pg_dump` **不包含**它们。恢复到新集群时，所有引用 `anon` / `anon_` 的 policy 与 `GRANT` 会失败，应用起不来 | `pg_dumpall --roles-only`（§3.2） |
| **A3** | **MFA 加密密钥 `MFA_ENCRYPTION_KEY`** | 环境变量 / 密钥管理系统 | **所有已绑定 MFA 的账号（含 super_admin）永久无法登录**，恢复码也解不开 —— 密钥与密文一起丢或只丢一个，都是不可逆的 | 密钥管理系统 + 离线副本（§3.3） |
| **A4** | **数据库连接串等运行配置** | 平台注入 / 部署配置 | 无法启动 | 配置管理系统（§3.3） |
| **A4b** | **`DOWNLOAD_TOKEN_SECRET`**（下载令牌签名密钥，写作期间新增） | 环境变量 / 密钥管理系统 | 下载接口按设计返回 **503**（fail closed，不会发无法签名的链接）；已发出的短时链接作废 | 密钥管理系统**即可**，无需与数据库备份配对（与 A3 的语义**不同**，见 §3.3） |
| **A5** | **对象存储（妙搭 dataloom bucket）** | 平台存储 | 已上传的课件、工作单、封面图丢失 | **平台侧快照/版本化**，见 §3.4（**[无法验证]** 平台能力） |
| **A6** | **绘本封面静态资源**（34 张 jpg） | `server/assets/prek-english-covers/`（随仓库与 `dist/` 一起发布） | 已发布资源的封面 404 | 随源码仓库 / 产物镜像一起备份（已在 git 中） |
| **A7** | **审计日志** | 表 `audit_logs`（属 A1） | 无法追溯历史操作；合规缺口 | 随 A1；另建议单独周期导出（§3.5） |
| **A8** | **应用产物与上一版本** | `dist/` 或容器镜像 | 无法快速回滚应用 | 保留最近 N 个产物/镜像（§3.6） |

### 1.1 数据库中共有 12 张表（实测，本机验证库）

```
account_permission_overrides, account_scopes, audit_logs, mfa_challenges,
mfa_recovery_codes, resources, review_records, schema_migrations, sessions,
subject_permissions, teacher_mfa, teachers
```
[已证实：`information_schema.tables` 查询，库 `qls_test_0005`]

其中**不可重建**的是：`teachers`、`resources`、`review_records`、`audit_logs`、
`subject_permissions`、`account_permission_overrides`、`account_scopes`、
`teacher_mfa`、`mfa_recovery_codes`。
`sessions` 与 `mfa_challenges` 是**可再生**的临时状态（丢失只导致所有人重新登录）——
但见 §6，它们在"部分恢复"场景下会造成不一致。

---

## 2. RPO / RTO —— **必须由部署环境确认的目标值，而不是已实现的指标**

> 下表右列**刻意留空**。任何数字在部署方书面确认之前都是**未定义**的。
> 这里给出的是**建议区间**（幼儿园内部系统的常见选择），不是承诺。

| 项 | 含义 | 建议目标（待确认） | 部署环境确认值 | 如何达到 | 如何验证 |
|---|---|---|---|---|---|
| **RPO**（可容忍数据丢失） | 故障时最多丢多少数据 | **≤ 24 小时**（日备份）<br>若可接受更高成本 → **≤ 15 分钟**（WAL 归档 / PITR） | `________` | 定时 `pg_dump`（§3.1）或平台自动备份 + WAL 归档 | 记录最后一次成功备份时间戳，并**演练恢复** |
| **RTO**（恢复耗时） | 从故障到恢复服务 | **≤ 4 小时**（人工流程） | `________` | 演练过的恢复手册 + 可用的目标实例 | 用 §4 流程**计时演练** |
| 备份保留期 | — | 日备 30 天 + 月备 12 个月 | `________` | 保留策略（§3.7） | 抽查任意历史日期备份可恢复 |
| 演练频率 | — | **上线前必做一次**，之后**每季度一次** | `________` | §4 + §8 | 演练记录留档 |

**当前实际状态（如实）**：

| 指标 | 当前值 |
|---|---|
| RPO（实际） | **未定义** —— 没有任何自动化备份在运行。仓库中**不存在**备份脚本 |
| RTO（实际） | **未测量** —— 从未执行过恢复 |
| 备份存在性 | **未知** —— 生产库是否有平台自动备份、保留多久，**本文档无法验证**（[无法验证]，需向妙搭平台确认） |
| 演练记录 | **无** |

> ⚠️ 如果妙搭平台已提供自动备份，那是**好事但不是答案**：
> 仍需确认 (1) 保留窗口、(2) 是否包含集群级角色、(3) 恢复是否受控于校方、
> (4) 恢复后的 `MFA_ENCRYPTION_KEY` 是否匹配。这四项都要向平台书面确认。

---

## 3. 备份命令（**部署环境必须自行提供并执行**）

> 以下命令全部使用占位符。**请勿把真实口令写进命令行历史**
> （`PGPASSWORD=… pg_dump` 会进 shell history 与进程表），
> 使用 `~/.pgpass`（`chmod 600`）或平台的密钥注入。
>
> 前置：需安装 PostgreSQL **客户端**工具（本机没有，见 §0）。

```bash
# 通用前置（示例；生产请用密钥管理系统注入）
export PGHOST=<db-host>
export PGPORT=5432
export PGUSER=<backup_user>          # 需 CONNECT + SELECT 权限；建议独立只读备份账号
export PGDATABASE=<db_name>
export BACKUP_DIR=/var/backups/qls   # 与数据库不同的物理位置
mkdir -p "$BACKUP_DIR"
```

### 3.1 数据库逻辑备份（**主备份**）

```bash
STAMP=$(date +%Y%m%d_%H%M%S)

# ① 自定义格式（推荐）：支持并行恢复、选择性恢复、压缩
pg_dump -Fc --no-owner --no-privileges -f "$BACKUP_DIR/qls_${STAMP}.dump"

# ② 同时导出纯 SQL（便于人工审阅与灾难时的最后手段）
pg_dump --no-owner -f "$BACKUP_DIR/qls_${STAMP}.sql"

# ③ 只导出 schema（用于快速比对结构是否被意外改动）
pg_dump --schema-only -f "$BACKUP_DIR/qls_schema_${STAMP}.sql"

# ④ 校验文件完整性（必须做，见 §5）
sha256sum "$BACKUP_DIR/qls_${STAMP}.dump" > "$BACKUP_DIR/qls_${STAMP}.dump.sha256"
pg_restore --list "$BACKUP_DIR/qls_${STAMP}.dump" > "$BACKUP_DIR/qls_${STAMP}.toc.txt"
echo "TOC 条目数: $(grep -c ';' "$BACKUP_DIR/qls_${STAMP}.toc.txt")"
```

**关于 `--no-privileges` 的取舍（必须明确决定）**：

- 加 `--no-privileges` → dump 里没有 `GRANT/REVOKE`。
  恢复后**必须重新执行** migration `0005` 的授权收紧（否则匿名角色重新拿到表的默认权限），
  否则 [`SECURITY.md`](SECURITY.md) §8.3 的列级限制会丢失。
  这是"恢复后安全状态悄悄退化"的典型路径。
- 不加 → dump 含 ACL，但恢复到缺少同名角色的集群时会报错（§1 A2）。

**建议**：**不加** `--no-privileges`（保留 ACL 更安全），
并严格按 §4 的顺序**先建角色、再恢复**。

### 3.2 集群级角色（**最容易被漏掉，漏了就恢复不出来**）

```bash
# 仅导出角色（含属性；是否含角色成员关系需人工检查，见下）
pg_dumpall --roles-only -f "$BACKUP_DIR/qls_roles_${STAMP}.sql"

# 【必须人工检查】确认导出内容确实包含应用依赖的角色与成员关系
grep -nE 'CREATE ROLE (anon|anon_|authenticated|authenticated_|service_role|service_role_)' \
     "$BACKUP_DIR/qls_roles_${STAMP}.sql"
grep -n 'GRANT .* TO <app_role>' "$BACKUP_DIR/qls_roles_${STAMP}.sql"   # 成员关系
```

> 应用依赖 `anon_` / `authenticated_` / `service_role_` 这三个角色存在，
> 且应用连接角色是它们的**成员**（否则 `SET LOCAL ROLE` 失败，
> 表现为登录报"用户名或密码错误"）。见 [`SECURITY.md`](SECURITY.md) §8.4、
> migration `0004` 第 48-54 行。 [已证实]
>
> ⚠️ `pg_dumpall --roles-only` 是否包含**角色成员关系**在不同 PostgreSQL 版本间有差异，
> 我**无法在本机验证**（无客户端工具）。**请在部署环境实际检查导出文件**
> （上面的 `grep`），缺什么就手工补 `GRANT <role> TO <app_role>;`。 [无法验证]

### 3.3 密钥与配置（**与数据库分开保存**）

| 项 | 做法 |
|---|---|
| `MFA_ENCRYPTION_KEY` | 存进部署平台的密钥管理（妙搭密钥 / KMS / Vault / K8s Secret），并保留一份**离线**副本（密封信封 / 密码管理器共享库）。**绝不要**只放在和数据库同一台机器上：数据库与密钥同时丢失时，MFA 账号永久锁死。 |
| `DOWNLOAD_TOKEN_SECRET`（写作期间新增） | 下载令牌的 HMAC-SHA256 签名密钥，**≥32 字节**（`openssl rand -base64 32`）。没有它，下载接口按设计 **fail closed**（返回 503），不会发出无法签名的链接。**丢失的后果比 MFA 密钥轻**：已发出的短时链接全部作废（默认 TTL 300s），换一把新密钥即可，**不需要改数据库**。 |
| 数据库连接串 | 配置管理系统 |
| 其余环境变量（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §2） | 配置管理系统 |

**验证密钥可用的唯一方法**：用备份库 + 该密钥实际解一次 MFA 密文（§4.6）。
只"确认文件存在"是没有意义的。

> ⚠️ **两类密钥的恢复语义完全不同，备份策略也应不同**：
> - `MFA_ENCRYPTION_KEY`：**必须与数据库备份同时、分开保管**，丢失即不可逆
>   （[`RUNBOOK.md`](RUNBOOK.md) §7.1）；
> - `DOWNLOAD_TOKEN_SECRET`：只有"有效性"意义，**可以随时轮换**
>   （[`RUNBOOK.md`](RUNBOOK.md) §7.4），不需要与备份配对。
> 把两者当成同一类东西保管，会导致"轮换下载令牌"时误动 MFA 密钥 —— 那是**不可逆**的事故。

### 3.4 对象存储（妙搭 dataloom）

**[无法验证]** —— 本机无平台凭据。部署环境必须确认：

1. 平台是否对 bucket 提供版本化 / 快照 / 生命周期备份；
2. 保留窗口；
3. 恢复是否可由校方自助执行；
4. 是否有独立于数据库的导出能力（例如逐对象下载）。

> 请勿把"数据库备份"当作"文件已备份"。数据库里只有**元数据**
> （`resources.file_bucket_id` / `file_path`），文件本体在对象存储里。

**当前事实**：`resources` 表 347 行中，`file_bucket_id` / `file_path` 非空的行为 **0 行**
（实测，见 [`MIGRATION_REPORT.md`](MIGRATION_REPORT.md) §6）。
即**目前没有实际文件需要备份** —— 这降低了当前风险，
但**一旦开始真实上传就必须立即把对象存储纳入备份范围**。

### 3.5 审计日志的额外导出（建议）

审计表属 A1，随主备份一起走。若校方有合规留存要求，另做周期导出：

```bash
# ⚠️ 时间列是系统列 `_created_at`，**不是** `created_at`
psql -Atc "\copy (SELECT * FROM audit_logs WHERE _created_at >= now() - interval '1 day') \
           TO '$BACKUP_DIR/audit_${STAMP}.csv' WITH CSV HEADER"
```
[已证实] `audit_logs` 的真实列为：
`id, action, wecom_user_id, teacher_id, teacher_name, ip_address, user_agent,
resource_id, resource_title, program, subject, detail, success, error_message, _created_at`
（本次直接查询 `information_schema.columns`）。
该表**没有任何外键**（`teacher_id` / `resource_id` 是裸 uuid），
这是有意为之的留痕设计（`PRODUCTION_READINESS.md` §E-12）。

> 注意：对**匿名角色**而言 `audit_logs` 是 append-only（`REVOKE UPDATE, DELETE, TRUNCATE`），
> 但 `pg_dump` 用的是备份账号的权限，不受此限制。 [已证实]

### 3.6 应用产物

- 保留最近 **≥3** 个可回滚的产物（`dist/` 目录 tar 包或容器镜像 tag + digest）。
- 记录每个产物对应的 git commit（`git rev-parse HEAD` 写入镜像 label 或旁边放一个 `VERSION.txt`）。
- 回滚应用**不需要**动数据库 —— 这是最快的恢复手段（见 §5.4）。

### 3.7 建议的 cron / 定时任务

```cron
# /etc/cron.d/qls-backup   —— 示例，需按部署环境调整；未在本机执行过
# 每日 02:10 全量逻辑备份 + 校验 + 角色导出
10 2 * * *  <backup_user>  /usr/local/bin/qls-backup.sh daily  >> /var/log/qls-backup.log 2>&1
# 每周日 03:10 额外保留一份月备（脚本内做硬链接或改名）
10 3 * * 0  <backup_user>  /usr/local/bin/qls-backup.sh weekly >> /var/log/qls-backup.log 2>&1
# 每日 06:00 自动"可恢复性抽检"：恢复到临时库并比对行数（见 §5）
0  6 * * *  <backup_user>  /usr/local/bin/qls-backup-verify.sh    >> /var/log/qls-backup.log 2>&1
```

`qls-backup.sh` 必须做到（**这是要求，不是现成脚本；仓库中不存在该脚本**）：

1. `set -euo pipefail`；任一步失败即非 0 退出；
2. 备份完成后立即 `sha256sum -c`；
3. **写一个状态文件/监控打点**（最后一次成功备份时间），并对"连续 2 次失败"告警；
4. 备份失败**不得**静默（禁止 `|| true`）；
5. 备份文件写到**与数据库不同的故障域**（不同磁盘/不同区域/对象存储）。

> 仓库中**没有** `scripts/backup.sh`。
> 唯一与本主题相关的脚本是 `scripts/db-snapshot.mjs`，但它是**比对工具，不是备份**
> —— 它**不复制任何数据**（§7.1）。不要把它当作备份。

---

## 4. 恢复流程（**把备份恢复到一个 scratch 库**）

> 目的：**先证明备份能恢复，再谈恢复生产**。
> 绝不要直接在库上试。

### 4.1 准备

```bash
export SRC_DUMP=/var/backups/qls/qls_20260924_021000.dump
export ROLES_SQL=/var/backups/qls/qls_roles_20260924_021000.sql
export SCRATCH_DB=qls_restore_drill_$(date +%Y%m%d)
export SCRATCH_HOST=<scratch-host>      # 建议与生产不同实例，避免误连
```

### 4.2 校验备份文件本身

```bash
sha256sum -c "$SRC_DUMP.sha256"                 # 必须 OK
pg_restore --list "$SRC_DUMP" | head -40        # 能列出 TOC 才说明文件结构完好
```
**"文件存在"不是证据，"能列出 TOC + 校验和通过"才是最低门槛。**

### 4.3 建 scratch 库与角色（顺序不可颠倒）

```bash
# ① 空库
createdb -h "$SCRATCH_HOST" "$SCRATCH_DB"

# ② 先建角色（pg_dump 不含集群级角色；ACL 恢复时会用到它们）
psql -h "$SCRATCH_HOST" -d postgres -v ON_ERROR_STOP=1 -f "$ROLES_SQL"

# ③ 确认应用依赖的三个角色存在
psql -h "$SCRATCH_HOST" -d postgres -Atc \
  "SELECT rolname FROM pg_roles WHERE rolname IN
   ('anon','anon_','authenticated','authenticated_','service_role','service_role_')
   ORDER BY 1;"
# 期望至少出现 anon_ / authenticated_ / service_role_（migration 0004 创建的三者）
```

### 4.4 恢复

```bash
# 目标角色与备份时不同时用 --no-owner；同名时去掉该参数以保留属主
pg_restore -h "$SCRATCH_HOST" -d "$SCRATCH_DB" \
           --no-owner --single-transaction \
           --exit-on-error \
           -v "$SRC_DUMP" 2> /tmp/pg_restore.err

echo "exit=$?"; tail -30 /tmp/pg_restore.err
# 期望：exit=0，无 error 行
```

> `--single-transaction` + `--exit-on-error`：要么整体成功、要么整体回滚，
> 不会留下半个库（半个库比没有库更危险）。
> 若因权限/角色问题失败，先修角色再重试，**不要**改成 `--no-acl` 绕过 ——
> 那会丢掉 §8.3 的授权收紧。

### 4.5 恢复后必须通过的验证查询

```bash
Q() { psql -h "$SCRATCH_HOST" -d "$SCRATCH_DB" -Atc "$1"; }

# ---- ① 表是否齐全（期望 12 张，或与备份时一致） ----
Q "SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE';"

# ---- ② 行数（与备份前的快照逐项比对，见 §5） ----
Q "SELECT 'teachers', count(*) FROM teachers
   UNION ALL SELECT 'resources', count(*) FROM resources
   UNION ALL SELECT 'subject_permissions', count(*) FROM subject_permissions
   UNION ALL SELECT 'review_records', count(*) FROM review_records
   UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
   UNION ALL SELECT 'sessions', count(*) FROM sessions
   UNION ALL SELECT 'account_permission_overrides', count(*) FROM account_permission_overrides
   UNION ALL SELECT 'account_scopes', count(*) FROM account_scopes
   UNION ALL SELECT 'teacher_mfa', count(*) FROM teacher_mfa
   UNION ALL SELECT 'mfa_recovery_codes', count(*) FROM mfa_recovery_codes
   ORDER BY 1;"

# ---- ③ 迁移状态（必须与备份时一致，且无缺行） ----
Q "SELECT version || '_' || name FROM schema_migrations ORDER BY version;"

# ---- ④ 必须至少有一个可登录的账号，否则恢复等于锁定全站 ----
Q "SELECT count(*) FROM teachers WHERE username IS NOT NULL AND password_hash IS NOT NULL;"
#   期望 >= 1；为 0 时不要切换生产，先排查

# ---- ⑤ super_admin 至少一名 active，否则无人能管理超级管理员 ----
Q "SELECT count(*) FROM teachers WHERE status='active' AND 'super_admin' = ANY(roles);"
#   期望 >= 1

# ---- ⑥ RLS 与策略仍存在（安全状态没有悄悄退化） ----
Q "SELECT count(*) FROM pg_policies WHERE schemaname='public';"
Q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relrowsecurity;"

# ---- ⑦ 匿名角色**不能**改凭据（migration 0005 的核心断言） ----
Q "SELECT has_column_privilege('anon_','teachers','password_hash','UPDATE');"   # 期望 f
Q "SELECT has_column_privilege('anon_','teachers','roles','UPDATE');"           # 期望 f
Q "SELECT has_table_privilege('anon_','audit_logs','DELETE');"                  # 期望 f
Q "SELECT has_table_privilege('anon_','audit_logs','UPDATE');"                  # 期望 f
#   若任一项为 t → 立即重新执行 migration 0005 的授权部分，不要上线

# ---- ⑧ MFA 密文格式仍是加密态（不是明文/被截断） ----
Q "SELECT count(*) FROM teacher_mfa WHERE secret_encrypted LIKE 'v1:%';"
Q "SELECT count(*) FROM teacher_mfa;"     # 两数应相等

# ---- ⑨ 业务完整性：每个资源的上传者仍存在 ----
Q "SELECT count(*) FROM resources r
    WHERE NOT EXISTS (SELECT 1 FROM teachers t WHERE t.id = r.uploader_id);"
#   期望 0。resources.uploader_id 有外键 resources_uploader_fkey -> teachers（[已证实]，
#   本次直接查询 information_schema.table_constraints），因此数据库本身会拦；
#   这条查询用于确认恢复过程没有破坏约束或灌入脏数据。

# ---- ⑩ 审计表允许悬空引用（设计如此），但要确认没有被"顺手补外键" ----
Q "SELECT count(*) FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='audit_logs' AND constraint_type='FOREIGN KEY';"
#   期望 0 —— audit_logs 的 teacher_id/resource_id 是裸 uuid，无外键
```

> ⑦ 与 ⑩ 是**本系统特有的**检查：⑦ 对应 [`SECURITY.md`](SECURITY.md) §8.3 的授权收紧；
> ⑩ 对应"审计留痕不得因外键而删除/阻塞"的设计决定
> （`PRODUCTION_READINESS.md` §E-12）。

### 4.6 用该备份验证 MFA 密钥是否匹配

```bash
# 用**生产同一把** MFA_ENCRYPTION_KEY，在 scratch 库上解一条密文
MFA_ENCRYPTION_KEY='<与生产一致>' \
DATABASE_URL="postgresql://…/$SCRATCH_DB" \
node -e "
const Pg=require('postgres');
const {decryptSecret}=require('./dist/server/common/crypto/mfa-crypto.js');
(async()=>{
  const sql=Pg(process.env.DATABASE_URL,{onnotice:()=>{}});
  const r=await sql\`select teacher_id, secret_encrypted from teacher_mfa limit 1\`;
  if(!r.length){console.log('库中无 MFA 绑定，无法验证密钥');process.exit(0);}
  try{ const s=decryptSecret(r[0].secret_encrypted);
       console.log('OK 密钥匹配，解开长度=',s.length); }
  catch(e){ console.log('FAIL 密钥不匹配或密文损坏:', e.message); }
  await sql.end();
})();
"
```
[推断：`dist/server/common/crypto/mfa-crypto.js` 是编译产物的路径 —— 已实测该目录存在，
但该文件本身要看构建结果；若路径不同，改用源码 `server/common/crypto/mfa-crypto.ts` 编译后的实际位置]

**这一步是唯一能证明"密钥备份可用"的方法。** 只检查密钥文件是否存在毫无意义。

---

## 5. 如何证明"备份真的可恢复"（不是"文件存在"）

**核心原则：恢复 + 比对，而不是 `ls`。**

### 5.1 恢复演练的判定标准

一次演练**通过**，必须同时满足：

| # | 判定 | 证据形式 |
|---|---|---|
| 1 | dump 校验和通过、TOC 可列出 | `sha256sum -c` OK + `pg_restore --list` 有输出 |
| 2 | 恢复到 scratch 库 **exit 0**，无 error | `pg_restore --exit-on-error` 返回 0 |
| 3 | 表数量与备份前一致 | §4.5 ① 与快照比对 |
| 4 | **关键表行数与备份前一致** | §4.5 ② 与快照逐项比对 |
| 5 | `schema_migrations` 内容与备份时一致 | §4.5 ③ |
| 6 | 至少 1 个可登录账号且 ≥1 名 active super_admin | §4.5 ④⑤ |
| 7 | RLS/policy 与授权收紧仍在 | §4.5 ⑥⑦ |
| 8 | MFA 密文可用生产密钥解开 | §4.6 |
| 9 | **应用连上 scratch 库能启动并通过就绪检查** | `NODE_ENV=production DATABASE_URL=… npm run start` + `GET /api/health/ready` → 200 |
| 10 | 应用层冒烟：登录 1 次 + 读取 1 个资源列表 | HTTP 2xx + 审计表新增一行 |
| 11 | 演练**计时**并记录，用于填写 §2 的 RTO | 演练记录 |

第 9/10 项是最容易被跳过、也最能暴露问题的一步：
**能 `pg_restore` 成功 ≠ 应用能跑**（角色成员关系、权限、迁移状态都可能不对）。

### 5.2 用仓库自带工具做"恢复前后一致性比对"

`scripts/db-snapshot.mjs` 正是为此设计的（它是**比对器**，不是备份器）：

```bash
# 备份前：对生产库取快照
DATABASE_URL="postgresql://…生产…" node scripts/db-snapshot.mjs --out /tmp/prod_before.json

# 恢复后：对 scratch 库取快照
DATABASE_URL="postgresql://…scratch…" node scripts/db-snapshot.mjs --out /tmp/restored.json

# 比对：自动检测丢表 / 丢行 / 丢列 / RLS 被削弱
node scripts/db-snapshot.mjs --compare /tmp/prod_before.json --against /tmp/restored.json
```

它会检查（`db-snapshot.mjs:192-238`）[已证实]：
1. 6 张关键表的行数**不得减少**（`teachers`/`resources`/`subject_permissions`/
   `review_records`/`audit_logs`/`sessions`）；
2. 教师账号总数不得减少；
3. 已有表的**列不得丢失**；
4. **RLS 不得被关闭、FORCE RLS 不得被移除**。

退出码：有问题 → **1**；无问题 → 0。可直接接进自动抽检任务（§3.7）。

### 5.3 建议的抽检频率

- **上线前**：完整演练一次（§8）。
- **上线后**：每月至少一次"恢复到 scratch 库 + §5.1 判定 1~8 项"。
- 每次**数据库结构变更（migration）之后**额外做一次。

### 5.4 真正的"回滚"优先级

```
1) 回滚应用产物          ← 最快，不动数据库，覆盖绝大多数故障
2) 前向修复（新 migration） ← 结构类问题的首选，见 MIGRATION.md
3) 从备份恢复到新实例并切换  ← 数据损坏时的唯一手段（本节流程）
4) 对生产库原地 in-place 恢复 ← 最后手段，必须停机 + 二次确认
```
**绝不允许**：`DROP DATABASE` 重建、重跑 `init.sql`、重置 seed 数据来"修复"。
见 [`MIGRATION.md`](MIGRATION.md) §7。

> ⚠️ **注意 `down` 不属于上面任何一档。** `down` 是"改回结构"，**不是**"恢复数据"。
> 满数据库上的实测（`evidence/migration-rollback.txt`，详见 [`MIGRATION.md`](MIGRATION.md) §6.4）：
> `0005` / `0004` / `0003` 可干净回滚且业务数据完好，
> 但 **`0002` 按设计拒绝**（`P0001`：反演会让 **20 个账号全部无法登录**），
> 因此 **"`down` 到零"在活库上根本走不通**。
> **活库的灾难恢复必须用 `pg_restore`。** 这条结论已由一次真实的回滚演练确立，不是推断。

---

## 6. 应用侧一致性：**部分恢复必然导致状态错位**

**这是本文档最容易造成事故的一节，请完整读完。**

本系统把**认证与授权的全部状态都存在数据库里**，没有缓存、没有外部会话存储：

| 状态 | 表 | 丢失/回退的后果 |
|---|---|---|
| 会话 | `sessions`（含 `permissions_version`、`revoked`、`revoked_at`） | 回退到旧快照会让**已撤销的会话复活**（攻击者若持有旧 cookie 可继续用）；反过来丢失则所有人被登出 |
| MFA 绑定 | `teacher_mfa`（密文 + `confirmed`） | 回退到"尚未绑定"→ super_admin 被 `AuthGuard` **拒绝一切**（`403 该账号角色强制要求 MFA…`），而本人以为自己已绑定 |
| MFA 恢复码 | `mfa_recovery_codes`（使用状态 `used_at`） | 回退会让**已用过的恢复码重新可用** —— 一次性保证被破坏 |
| MFA challenge | `mfa_challenges`（`consumed_at`） | 回退可能复活已消费的 challenge（TTL 5 分钟，影响有限） |
| 权限覆盖 | `account_permission_overrides` / `account_scopes` | 回退 → 权限悄悄变宽或变窄 |
| 权限版本 | `teachers.permissions_version` | 回退 → 在线的旧会话版本号**碰巧又匹配**，绕过"权限变更即时生效"；或反之把所有人踢下线 |
| 审计 | `audit_logs`（append-only） | 回退会**抹掉已记录的操作**，审计链断裂、不可发现 |

### 6.1 三条硬规则

1. **要么整体恢复，要么不恢复。** 只恢复 `resources` 或只恢复 `teachers`
   = 让数据库进入一个**从未存在过**的状态。
   唯一的例外是明确知道自己在做什么的**单表误删修复**，且必须：
   恢复到 scratch → 只 `COPY` 那一张表 → 逐行核对 → 记录到运维日志。
2. **恢复后必须让全部会话失效。** 因为"回退后的 `permissions_version` 组合"
   可能让某些旧 cookie 重新有效：
   ```sql
   UPDATE sessions SET revoked = true, revoked_at = now(),
          revoke_reason = 'restore' WHERE revoked = false;
   ```
   （这是**唯一**能让"所有会话立即失效"的手段；本系统没有会话签名密钥可轮换，
   见 [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §3.1）
3. **恢复后必须重新验证 MFA 与密钥的匹配**（§4.6），
   因为"数据库回退 + 密钥未回退"（或反之）会让 super_admin **进不去**
   —— 那是比数据丢失更紧急的故障。

### 6.2 时间点不一致的典型事故剧本（务必避免）

```
T0  管理员 A 撤销了教师 B 的资源下载权限（permissions_version 从 7 → 8，B 被踢下线）
T1  教师 B 绑定 MFA（teacher_mfa 新增一行，恢复码 10 个）
T2  管理员 A 误删了 20 条资源
T3  运维从 T0 之前的备份"只恢复 resources 表"
    → 20 条资源回来了 ✅
    → 但 B 的权限撤销被回退（version 回到 7）
      → B 持有的旧 cookie 的 version 恰好又是 7 → **B 重新获得已撤销的权限**
    → B 的 MFA 绑定"消失" → B 可以只用密码登录
    → B 的恢复码"未使用"状态回退 → 一次性保证失效
```
**正确做法**：整体恢复 + 失效全部会话 + 重新核对 MFA，或**只回填被误删的那 20 行**
（从 scratch 库 `INSERT ... SELECT`），而不是整表替换。

---

## 7. 本仓库现有脚本到底做了什么（**别把它们当备份**）

### 7.1 `scripts/db-snapshot.mjs` —— **比对器，不复制数据**

| 事实 | 证据 |
|---|---|
| 导出内容：库名/用户/版本、表清单、**行数**、列结构、索引、RLS 状态、policy、`schema_migrations`、角色分布、结构指纹（sha256） | `db-snapshot.mjs:71-190` [已证实] |
| **不含任何行数据**（只有 count 与结构） | 全文无 `COPY`/数据查询导出 [已证实] |
| `--compare/--against`：检测行数下降、账号减少、列丢失、RLS 被削弱 | `db-snapshot.mjs:192-238` |
| 无连接串时：**明确报错并 exit 2**，绝不假装成功 | `db-snapshot.mjs:50-63` [已证实] |
| 用法 | `--out <file>` / `--compare A --against B` |
| npm 入口 | `npm run db:snapshot`（= `node ./scripts/db-snapshot.mjs`） |

**用途**：migration 前后一致性证明、恢复演练比对（§5.2）。
**不能**用于：灾难恢复。它无法重建任何一行数据。

### 7.2 `scripts/migrate.mjs` —— 迁移运行器

| 事实 | 证据 |
|---|---|
| 命令 | `status` / `up` / `down <ver>` / `verify` / `baseline <ver>` |
| 记录表 | 自建 `schema_migrations`（`version, name, checksum, applied_at, execution_ms, applied_by`） | `migrate.mjs:142-153` |
| 校验和 | 每个 `.sql` 的 sha256；已应用文件被改动 → 拒绝执行、exit 2 | `migrate.mjs:121,187-197` |
| 并发 | session 级 advisory lock，key `918273645`；超时默认 30s | `migrate.mjs:56,168-182` |
| 事务 | 每个迁移独立事务，失败回滚并 exit 1 | `migrate.mjs:276-302` |
| **不做的事** | 不备份、不建库、不删数据、不 seed | 文件头 `:28` [已证实] |

**在灾难恢复中的正确用法**：

```bash
# 恢复完成后，确认没有 pending / drift
DATABASE_URL="postgresql://…恢复库…" node scripts/migrate.mjs verify
DATABASE_URL="postgresql://…恢复库…" node scripts/migrate.mjs status
```

⚠️ **`baseline` 是危险命令，恢复场景下不要随手用**：它把 migration 标记为"已应用"
但**不执行**其中的 SQL。用错会把"没建的表/触发器"记为已建，之后 `up` 再也不会补上。
仅用于"库已经具备这些效果"的既有平台库（[`MIGRATION.md`](MIGRATION.md) §6）。

### 7.3 仓库中**不存在**的备份相关资产（如实列出）

| 不存在的东西 | 影响 |
|---|---|
| `scripts/backup.sh` / `scripts/backup*.sh` | 备份必须由部署环境自行实现（§3.7）。**注意语义差别**：`backup-rehearse.mjs`（§7.4）是**演练器**，不是备份器 |
| 恢复脚本 | §4 全靠手工执行（这是**有意的**：恢复应有人工确认） |
| Dockerfile / docker-compose | 无容器化快照能力 |
| CI / IaC / 定时任务 | 无自动备份流水线 |
| 对象存储备份脚本 | 平台侧能力未确认 |
[已证实：`ls scripts/` 与仓库根目录检查]

### 7.4 `scripts/backup-rehearse.mjs` —— **本机唯一可做的演练**（但**不是备份器**）

**它是什么**：一次**真实的逻辑导出 / 恢复往返演练**，用本项目自己的 schema 与迁移工具驱动。

**它是怎么做的（逐步，均已读源码确证）**：

| 步骤 | 内容 | 关键细节 |
|---|---|---|
| **PREFLIGHT** | 逐个查找 `pg_dump` / `pg_restore` / `psql` | 查找顺序：`PATH` → `$PG_BIN` → Homebrew libpq 目录 → 项目自己的 `.devtools/pg/.../bin`。**实测全部 NOT FOUND** → 脚本**大声打印**"NO `pg_dump` BACKUP WAS TAKEN"，并**打印生产环境必须执行的 `pg_dump`/`pg_restore`/`psql` 命令**，然后继续做逻辑演练 |
| **安全护栏** | scratch 库名必须匹配 `/(scratch\|rehearsal\|restore_test\|tmp\|temp)/i`，且**必须与 source 不同库** | 不匹配直接 **exit 2**（"This script DROPs that database"） |
| **STEP 1 导出** | 逐表 `SELECT *`，写入 `.ndjson`（`header` / `table` / `row` / `footer`） | 逐表算 **SHA-256 内容校验和**（按行的规范化 JSON 排序后哈希 → 与物理行序无关），并记录行数 |
| **STEP 2 建 scratch** | `DROP DATABASE IF EXISTS … WITH (FORCE)` → `CREATE DATABASE` → **调用 `scripts/db-bootstrap.mjs`** | ★ 因此它演练的是**真实的从零建库路径**（前导 → `init.sql` → 迁移），而不是"只跑迁移"。脚本注释记录了实测：**只跑迁移会 `42P01 relation "teachers" does not exist`** |
| **STEP 3 导入** | 按**外键拓扑序**（父表先）逐行 `INSERT`，**全部包在单个事务里** | 实测：按表名顺序导入会 `23503 … violates foreign key constraint "resources_uploader_fkey"`。脚本**不用**禁用约束来绕过（那需要超级用户且会掩盖真实的引用断裂）。`schema_migrations` **刻意跳过导入**（它是派生状态，scratch 的账本已由迁移写好） |
| **STEP 4 校验** | 逐表比对**行数**与**内容校验和**；`schema_migrations` 比对**版本集合** | 版本集合比对比"复制账本"更强：它证明恢复后的库与源库**处于同一迁移版本** |
| **SUMMARY** | 打印**明确的边界声明**，并写 `<out>.sha256` | 见下 |

**实测结果（`evidence/migration-rollback.txt` 的 STEP 1）**：
```
12 张表 · 902 行 · 逐表行数与 SHA-256 内容校验和**完全一致**
PASS  schema_migrations versions match (6): 0001, 0002, 0003, 0004, 0005, 0006
PASS  teachers rows=22 · resources rows=347 · audit_logs rows=386 · sessions rows=128 …
RESULT: logical round trip verified — every table restored with an
        identical row count and an identical content checksum.
```
[已证实：原始日志 `evidence/backup-restore-rehearsal.txt` 与 `evidence/migration-rollback.txt`；
日志由另一个 agent 执行并留存，**我阅读了日志，未复跑**]

```bash
# 用法（照脚本参数解析；我未执行）
node scripts/backup-rehearse.mjs \
  --source  "postgresql://user:pw@127.0.0.1:55432/qls_test_0005" \
  --scratch "postgresql://user:pw@127.0.0.1:55432/qls_rehearsal" \
  --out     backups/backup-rehearsal.ndjson      # 默认值
  # --keep-scratch   保留 scratch 库以便排查（默认演练结束即 DROP）
# exit: 0 = 往返通过；1 = 失败；2 = 前提缺失/护栏拒绝
# 也接受环境变量：BACKUP_SOURCE_DB / DATABASE_URL / SUDA_DATABASE_URL / MIGRATION_DATABASE_URL
```

**它的显式范围边界（脚本自己打印的 `SCOPE LIMITS`，逐字要点）**：

| ✅ 它证明了 | ❌ 它**没有**证明 |
|---|---|
| **数据**能往返：逐表行数 + 内容校验和一致 | 不涉及 `pg_dump` / `pg_restore` |
| scratch 库能沿**真实建库路径**从零建起来 | 不涉及**角色**、表空间、扩展、库级设置 |
| 恢复后的库与源库**迁移版本一致** | 不涉及**序列状态**（`serial` 计数器） |
| 导入是**原子**的（单事务） | 不涉及迁移之外的 RLS 定义、大对象 |
| — | 不涉及 **WAL / PITR**（时间点恢复） |

> **最重要的一条**：脚本在输出里明确声明
> **"The production database was NOT touched by this run and is NOT covered."**
> 以及（当 `pg_dump` 缺失时）**"The production rehearsal is still outstanding"**。

**一个必须知道的使用约束**：`source` 与 `scratch` 必须处于**同一迁移版本**。
实测反例见 `evidence/migration-guard.txt` STEP 1：源库停在 `0006`、而 scratch 由当时的迁移集建到 `0007`，
于是 `schema_migrations` 版本集合不一致、`resources` 的内容校验和也不同
（新列 `deleted_at`/`deleted_by`/`purge_after` 的有无）→ 演练**正确地报了 FAIL**。
**这不是脚本缺陷，而是"先把两边版本对齐"的操作要求。**

**这改变了什么、没改变什么（重要）**

| | 变化 |
|---|---|
| ✅ 新增能力 | 现在**存在**一个可重复执行的、把数据搬出去再搬回来的演练工具，且它**顺带演练了从零建库路径**。对本项目特有的一类事故（**迁移链 + 数据**能否共同重建成可用库）有真实价值 |
| ✅ 新增证据 | 有原始日志：12 表 / 902 行 / 行数与校验和全部一致（`evidence/backup-restore-rehearsal.txt`、`evidence/migration-rollback.txt`）[已证实：阅读日志] |
| ✅ 一个真实缺陷因此暴露并修复 | 演练第一次运行就失败，暴露出此前隐藏的问题（见 `PRODUCTION_RELEASE_REPORT.md` §4.3） |
| ❌ **没有**改变 | 生产库**仍然没有被备份过**，`pg_dump`/`pg_restore` **仍然没有被执行过**（本机连客户端都没有）。§0 的结论不变 |
| ❌ **没有**改变 | §2 的 RPO/RTO 仍是**未定义**；§8 的清单仍然全部未勾选 |

> ⚠️ **不要因为"有一个 rehearsal 脚本 + 一次绿色演练"就认为备份问题解决了。**
> 真正的判据仍然是 §5.1 的 11 项，且**必须用 `pg_dump` 对真实集群做**。
> 逻辑往返证明的是"数据搬得回去"，**不是**"生产备份可用"。

### 7.5 `scripts/db-bootstrap.mjs` —— 恢复**验证目标库**的建设方式

它解决一个**实测过的互相依赖缺陷**：`init.sql` 与迁移 `0001` 谁都不能单独先跑
（两种顺序都以 `42P01 relation "teachers" does not exist` 失败），
而妙搭平台预先提供数据库，因此该缺陷只在**换机器重建 / 恢复验证**时暴露。
它按 `前导（类型 + 三个 DB 角色，源码取自 0001）→ init.sql → migrate up` 执行，
**拒绝**在已有 `teachers`/`resources` 的库上运行（除非 `--force`），且**从不 DROP 任何东西**。
[已证实：`scripts/db-bootstrap.mjs` 全文]

**为什么恢复文档必须提到它** —— 它是**恢复验证目标库的标准建法**：

1. **§5.1 的判定第 9/10 项**要求"应用能连上恢复出来的库并跑起来"。
   在**同一个 scratch 库**里先建空库、再 `pg_restore`，是正常做法；
   但若你要做"对照验证"（例如对比 dump 恢复 vs 从零重建），
   第二个对照库就应该用 `db-bootstrap.mjs` 建 ——
   这样两条路径的结果才可比。`backup-rehearse.mjs` 走的就是这条路（§7.4）。
2. **它能证明 dump 的结构完整性**：若一个 dump 恢复后 `migrate.mjs verify` 不通过，
   说明 dump 内的结构与迁移记录不一致 —— 这是"备份不完整"的直接信号。
3. ⚠️ **它不能用来恢复**：恢复是 `pg_restore`，不是从零跑 DDL。
   它**不是**"重建生产库"的手段，脚本文件头对此有明确声明。

```bash
# 只用它建一个空的可迁移库（作为恢复验证目标）
node scripts/db-bootstrap.mjs --url "$SCRATCH_URL"
DATABASE_URL="$SCRATCH_URL" node scripts/migrate.mjs status   # 期望：全部 applied、无漂移
```

详见 [`MIGRATION.md`](MIGRATION.md) §2.3。

---

## 8. 未验证清单 —— **上线前必须由部署团队演练**

> 下面每一项在完成前都**不得**在验收报告里写成"已完成"。
> 建议直接把本节复制成工单，逐项签字。

### 8.1 演练前置（一次性）

- [ ] 已获得生产数据库的**只读备份专用账号**（不复用应用账号）
- [ ] 已获得/搭建**独立的 scratch PostgreSQL 实例**（与生产不同机器）
- [ ] 备份客户端工具（`psql` / `pg_dump` / `pg_restore`）版本 ≥ 服务器主版本
- [ ] 备份落盘位置与数据库**不在同一故障域**，且容量足够（含保留策略）
- [ ] `MFA_ENCRYPTION_KEY` 已存入密钥管理系统，且有**离线副本**
- [ ] `DOWNLOAD_TOKEN_SECRET` 已配置（≥32 字节）且**与 MFA 密钥分开管理**（§3.3）
- [ ] 已向妙搭平台书面确认对象存储的备份/版本化能力与恢复流程
- [ ] 已确认平台是否有自动数据库备份；若有，确认保留窗口与恢复责任人
- [ ] §2 的 **RPO / RTO 目标值已由校方书面确认**并填表

### 8.2 必须完成的演练（每一项都要有输出证据）

- [ ] **D1** 执行一次完整 `pg_dump -Fc` 并生成校验和与 TOC（§3.1）
- [ ] **D2** 执行 `pg_dumpall --roles-only`，并 `grep` 确认三个角色存在、
      且**角色成员关系**是否包含在内（§3.2）
- [ ] **D3** 按 §4 把该 dump 恢复到 **scratch 库**，`pg_restore` **exit 0**
- [ ] **D4** §4.5 的 ①~⑩ 验证查询**全部**通过（把输出存档）
- [ ] **D4b** 用 `node scripts/db-bootstrap.mjs --url "$SCRATCH_URL"` 建一个**对照库**，
      确认它能从零走到"全部迁移 applied、无漂移"；若 dump 恢复出的库在这一步不成立，
      说明 dump 的结构与迁移记录不一致（§7.5）
- [ ] **D4c** 先做一次**本机可做的逻辑往返演练**并留档：
      `node scripts/backup-rehearse.mjs --source "$SRC" --scratch "$SCRATCH" --out backups/rehearsal.ndjson`
      → 期望逐表行数与 SHA-256 内容校验和一致（§7.4）。
      ⚠️ 这**不等于** D1–D3 已完成，只是把"数据能否搬回去"这一层先证明掉
- [ ] **D5** §4.6 用生产密钥**成功解开一条 MFA 密文**
- [ ] **D6** 应用指向 scratch 库启动，`/api/health/ready` 返回 **200**
- [ ] **D7** 在 scratch 上完成登录 + 读列表的冒烟，且 `audit_logs` 新增一行
- [ ] **D8** `node scripts/db-snapshot.mjs --compare` 生产前后快照 → **无 integrity problem**
- [ ] **D9** 记录本次演练的**耗时**，据此填写 §2 的 RTO 实测值
- [ ] **D10** 演练记录归档（时间、执行人、使用的备份文件、结论、发现的问题）
- [ ] **D11** 明确"**恢复决策人**"与"**执行人**"（不可同一人在无复核下操作生产）
- [ ] **D12** 演练**恢复过程中**发现的脚本/文档缺陷已回写本文档

### 8.3 周期化（上线后）

- [ ] 备份定时任务已上线，且**有失败告警**（连续 2 次失败必须告警）
- [ ] 每月至少一次"恢复抽检"（§5.1 判定 1~8）并留档
- [ ] **每次 migration 之后**额外做一次快照比对（§5.2）
- [ ] 每季度一次完整演练（含 D6/D7 应用级验证）
- [ ] 密钥轮换演练（见 [`RUNBOOK.md`](RUNBOOK.md) §7）

### 8.4 明确"当前不具备"的能力（不要误解）

| 能力 | 现状 |
|---|---|
| 自动备份 | ❌ 仓库无备份脚本；平台是否自动备份**未知** |
| 时间点恢复（PITR） | ❌ 未确认平台是否提供；无 WAL 归档 |
| 数据库备份已演练 | ❌ **从未执行过**（本环境无生产连接串） |
| 对象存储备份 | ❓ **无法验证**（无平台凭据） |
| 已在生产发生过的真实恢复 | ❌ 无记录 |
| RPO / RTO 实测值 | ❌ 未定义、未测量 |

---

## 9. 一页速查

```bash
# ── 备份（部署环境执行；本机无客户端工具） ─────────────────────────
STAMP=$(date +%Y%m%d_%H%M%S)
pg_dump -Fc -f /var/backups/qls/qls_${STAMP}.dump        # 主备份
pg_dumpall --roles-only -f /var/backups/qls/roles_${STAMP}.sql   # 角色（必做）
sha256sum /var/backups/qls/qls_${STAMP}.dump > /var/backups/qls/qls_${STAMP}.dump.sha256

# ── 一致性留痕（可用仓库脚本，无需 psql） ──────────────────────────
DATABASE_URL="…" node scripts/db-snapshot.mjs --out snapshots/prod_${STAMP}.json
DATABASE_URL="…" node scripts/migrate.mjs status

# ── 恢复演练（scratch 库） ────────────────────────────────────────
createdb -h <scratch> "$SCRATCH_DB"
psql -h <scratch> -d postgres -f /var/backups/qls/roles_${STAMP}.sql
pg_restore -h <scratch> -d "$SCRATCH_DB" --no-owner --single-transaction \
           --exit-on-error -v /var/backups/qls/qls_${STAMP}.dump
# 然后跑 §4.5 的验证查询 + §4.6 的密钥验证 + §5.1 的 11 项判定

# ── 恢复后（生产）─────────────────────────────────────────────────
UPDATE sessions SET revoked = true, revoked_at = now(),
       revoke_reason = 'restore' WHERE revoked = false;   -- 失效全部会话
DATABASE_URL="…" node scripts/migrate.mjs verify
curl -s -o /dev/null -w '%{http_code}\n' http://<host>/api/health/ready   # 期望 200
```

---

*本文档不包含任何"备份已完成""恢复已演练"的陈述，因为二者都尚未发生。
在 §8 全部勾选之前，本系统的灾难恢复能力为**未验证**。*
