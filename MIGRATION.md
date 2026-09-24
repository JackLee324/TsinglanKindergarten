# MIGRATION.md — 数据库迁移框架与编写规范

> **文档基线**：git commit `671328a` + 写作时工作区改动。
> 验证环境：PostgreSQL **16.14**（本地真实实例，`127.0.0.1:55432`）。
>
> **证据标记**：**[已证实]** 本次实测或源码逐行确证 · **[推断]** 由代码/配置互推 ·
> **[无法验证]** 需部署环境确认。
>
> 逐迁移的事实清单见 [`MIGRATION_REPORT.md`](MIGRATION_REPORT.md)。
> 备份与恢复见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)。
> 生产部署中的迁移步骤见 [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §5。

---

## 1. 为什么会有这套框架（背景，决定了它的设计）

改造前本项目**完全没有迁移机制**：[已证实，`PRODUCTION_READINESS.md` §E-7]

- 无 `drizzle.config.*`、无 `migrations/`、无 `schema_migrations`；
- `drizzle-kit` **不在依赖中**（lockfile 零命中）；
- 变更方式 = "再跑一遍 `init.sql`"，而它**不是幂等的**：
  实测第二次执行报 `42710 policy "service_role_bypass_policy_teachers" already exists`；
- `server/database/schema.ts` 是**由线上平台库反向生成**的（`npm run gen:db-schema`），
  因此它和手工维护的 `init.sql` **已经双向漂移**（teachers 差 6 列等）。

结论：`server/database/migrations/` 下的有序 SQL 文件是**结构与数据变更的唯一权威来源**。
`init.sql` 仅作历史对照，**新库不要用它**（在原生 PG 上它根本执行不了，
`42704 type "user_profile" does not exist`）。 [已证实，§E-1]

---

## 2. 目录与命名规范

```
server/database/migrations/
├── 0001_schema_baseline_alignment.sql
├── 0001_schema_baseline_alignment.down.sql
├── 0002_backfill_legacy_usernames.sql
├── 0002_backfill_legacy_usernames.down.sql
├── 0003_rbac_database_layer.sql
├── 0003_rbac_database_layer.down.sql
├── 0004_rls_role_alignment.sql
├── 0004_rls_role_alignment.down.sql
├── 0005_tighten_rls_writes.sql
├── 0005_tighten_rls_writes.down.sql
├── 0006_mfa.sql
└── 0006_mfa.down.sql
```
（本次 `ls` 实测，共 6 对 12 个文件） [已证实]

### 2.1 命名规则（由运行器正则强制）

| 规则 | 正则 | 出处 |
|---|---|---|
| UP 文件 | `^(\d{4})_([a-z0-9_]+)\.sql$` | `scripts/migrate.mjs:96` |
| DOWN 文件 | `^(\d{4})_([a-z0-9_]+)\.down\.sql$` | `scripts/migrate.mjs:108` |

**因此**：

- 版本号必须是**恰好 4 位数字**（`0007` 对，`7`/`00007` 错）；
- 名字必须是**小写**字母/数字/下划线；
- ⚠️ **不匹配的文件会被静默忽略，不报错。**
  `0007_AddResourceTable.sql`（含大写）**不会被执行**，而 `status` 显示"没有 pending"。
  这是最容易踩的坑：写完 migration 后**必须确认它出现在 `status` 列表里**。

### 2.2 其他运行器行为（都要知道）

| 行为 | 说明 | 出处 |
|---|---|---|
| 排序 | 按 4 位版本号字符串升序（补零使其等价于数字序） | `migrate.mjs:127` |
| 重复版本号 | 两个文件同版本 → 直接 `die`，拒绝运行 | `migrate.mjs:129-134` |
| 同一版本只能有一对 | `downs` 以版本号为 key，同名版本后者覆盖前者 | `migrate.mjs:104-110` |
| 缺 `.down.sql` | 允许（`status` 标注 `(no .down.sql)`），但**回滚时会整体拒绝** | `migrate.mjs:220,325-331` |
| 目录不存在 | `die`（exit 1） | `migrate.mjs:99-101` |

> 当前 **7 个**迁移（`0001`~`0007`）**全部**配有 `.down.sql`。 [已证实]

### 2.3 从零建库：`scripts/db-bootstrap.mjs`（**实测过的互相依赖缺陷**）

新库**不能**简单地"先 `init.sql` 再 `migrate up`"，也**不能**反过来 —— 两种顺序都被实测证伪：

| 顺序 | 实测结果 |
|---|---|
| A: `init.sql` → `migrate up` | `0001` 失败：**`42P01 relation "teachers" does not exist`**。`init.sql` 是基线 DDL，但它**不创建**自己引用的 `user_profile` 复合类型与 `anon`/`authenticated`/`service_role` 三个角色 → 在干净的集群上根本跑不起来 |
| B: `migrate up` → `init.sql` | **同样的 `42P01`** —— `0001` 是对基线 DDL 的**对齐层**，不是自足 schema；没有表可 `ALTER` |

两者**互为前提**：`init.sql` 需要类型与角色（只有迁移 `0001` 会创建），`0001` 需要表（只有 `init.sql` 会创建）。
**妙搭平台预先提供好数据库**（含类型与角色），所以这个缺陷在平台上从未暴露 —— 它只在**换机器重建 / 恢复验证**时才浮现。

**`scripts/db-bootstrap.mjs` 就是补上缺失前导的那个脚本**：

```
1/3  幂等前导  —— 创建 user_profile 类型 + 三个 DB 角色
      ★ 这两段 DDL 不是复制粘贴，而是**从 0001 文件本身提取**其前两个
        `DO $$ ... $$;` 块（脚本断言至少找到 2 个块，否则拒绝运行），
        因此前导与 0001 不可能漂移
2/3  init.sql  —— 基线表、索引、RLS policy
3/3  migrate up —— 版本化、带校验和的演进（子进程调用 scripts/migrate.mjs up，
                  并把 DATABASE_URL/SUDA_DATABASE_URL/MIGRATION_DATABASE_URL 三者都指向同一库）
```
[已证实：`scripts/db-bootstrap.mjs` 全文]

用法与行为（**我未执行该脚本，以下为源码确证**）：
```bash
# 两种等价传参
node scripts/db-bootstrap.mjs --url "postgresql://user:pw@host:5432/dbname"
DATABASE_URL="postgresql://…" node scripts/db-bootstrap.mjs
```

| 行为 | 细节 |
|---|---|
| **拒绝改已建好的库** | 若 `public` 下已存在 `teachers` **或** `resources`，直接 `REFUSING` 并 **exit 1**（除非 `--force`）。它**从不 DROP 任何东西** |
| 无连接串 | 打印 `no database URL`，**exit 2** |
| 缺 `0001` 或 `init.sql` | **exit 2** |
| `0001` 结构变了（`DO $$` 块少于 2） | **exit 1** 并明确说"拒绝猜哪些块可以提前跑" |
| `init.sql` 失败 | **精确报错**（`[SQLSTATE] message` + `hint`）并 exit 1，提示"数据库可能已部分建好，请改用迁移"——**绝不吞错** |
| 迁移失败 | `[bootstrap] migrations failed — database is NOT ready.` 并 exit 1 |

> **它不是什么**（脚本文件头明确声明，务必照此使用）：
> - ❌ **不是重建生产库的手段**；
> - ❌ 不是"演进既有数据库"的手段 —— 那是 `node scripts/migrate.mjs up`；
> - ❌ 不是灾难恢复手段 —— 那是 `pg_restore`（见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)）。
> 它的用途只有两个：**搭建全新环境**，以及**为恢复演练准备验证目标库**。

> 平台库（妙搭）**不需要**它 —— 平台已提供类型与角色，直接 `migrate.mjs up` 即可。

---

## 3. 校验和（checksum）：为什么**已应用的迁移绝不能改**

### 3.1 机制

- `up` 执行前，对每个 `.sql` 全文算 `sha256`（`migrate.mjs:121`）；
- 执行成功后把 `checksum` 写入 `schema_migrations`（`migrate.mjs:283-286`）；
- `status` / `verify` / `up` 都会把"文件当前 sha256"与"记录中的 sha256"比对
  （`detectDrift()`，`migrate.mjs:187-197`）。

### 3.2 如果改了已应用的文件会发生什么

| 命令 | 结果 |
|---|---|
| `status` | 打印 `CHECKSUM DRIFT — an already-applied migration file has been modified:` + 文件清单 + 提示"新增一个迁移而不是改旧的"，**返回 2** |
| `verify` | `Checksum drift detected in N migration(s).`，**返回 2** |
| `up` | `Refusing to migrate: checksum drift on already-applied migration(s):`，**返回 2，不执行任何 pending 迁移**（fail closed） |
| `down` | 不受漂移检查影响（它按 `.down.sql` 执行） |

证据：`migrate.mjs:226-233,242-245,256-263`。 [已证实]

### 3.3 为什么必须 fail closed

因为**漂移意味着数据库里的结构不再对应"记录中执行过的那份 SQL"**：

- 别的环境按新文件执行 → 两个环境结构不同（"我这儿能跑"的经典来源）；
- 回滚脚本（`.down.sql`）是配旧文件写的 → 可能撤不掉实际存在的对象；
- `schema_migrations` 从此**不再是一份可信的结构历史**，而它是灾难恢复时唯一的结构依据。

### 3.4 出现漂移时**唯一正确**的处置

```bash
# 1) 看清是哪个文件、差在哪
node scripts/migrate.mjs status
git log -p -- server/database/migrations/<文件>

# 2) 还原文件（不要改数据库里的 checksum！）
git checkout -- server/database/migrations/<文件>

# 3) 如果那个改动确实是需要的 → 写成新的迁移
#    cp server/database/migrations/0006_mfa.sql ... 参考格式
#    新建 0007_xxx.sql + 0007_xxx.down.sql

# 4) 复验
node scripts/migrate.mjs verify && node scripts/migrate.mjs status
```

> ⛔ **绝对不要**：`UPDATE schema_migrations SET checksum = '<新值>'`。
> 那不是"修复漂移"，而是**销毁唯一的证据**。

---

## 4. Advisory lock：并发安全

```js
const LOCK_KEY = 918273645;                       // migrate.mjs:56
SELECT pg_try_advisory_lock(918273645)            // migrate.mjs:172
SELECT pg_advisory_unlock(918273645)              // migrate.mjs:180
```

- 采用**轮询式**获取（每 250ms 重试），而不是阻塞等待；
- 等待上限由 `MIGRATION_LOCK_TIMEOUT_MS` 控制，**默认 30000ms**；
- 超时 → `Could not acquire migration lock within timeout; another runner is active.` 并退出；
- 解锁在 `finally` 中，**异常路径也会释放**；
- 这是 **session 级** advisory lock：连接断开时 PostgreSQL 自动释放，不会留下死锁。

证据：`migrate.mjs:168-182`。 [已证实]

**为什么重要**：多实例滚动发布时，两个新副本可能同时启动并各自尝试 `up`。
没有锁会交错执行 DDL（在事务里更糟：可能互相等锁形成长事务）。
有了锁，第二个运行器要么等到第一个完成后再判断"没有 pending"，
要么超时退出并明确报错 —— **两种都是安全结果**。

> 注意：锁只保护**本运行器**。手工 `psql` 执行的 DDL 不受它保护。
> 因此**禁止**在部署窗口内手工改结构。

---

## 5. 事务语义

```
每个迁移：
  BEGIN
    <整个 .sql 文件的内容，通过 sql.unsafe() 一次性发送>
    INSERT INTO schema_migrations (...)
  COMMIT
  失败 → ROLLBACK → 打印 code / message / 出错行号与源码行 → return 1
```
证据：`migrate.mjs:276-302`。 [已证实]

含义与限制：

| 项 | 说明 |
|---|---|
| **原子性** | 单个迁移要么全应用、要么完全不留痕（`schema_migrations` 也不会写） |
| `schema_migrations` 记录与结构变更**同一事务** | 不会出现"结构改了但没记录"或反之 |
| 失败时**不改动数据库** | 日志明确打印 `Database left unchanged by this migration. Fix the file and re-run.` |
| **错误定位** | 若有 `err.position`，会算出 SQL 第几行并打印该行内容（截断 160 字符） |
| ⚠️ 限制 1 | `CREATE INDEX CONCURRENTLY`、`ALTER TYPE ... ADD VALUE`（旧版本 PG）、
`VACUUM` 等**不能在事务块内**执行 → 这类操作需另行设计（拆成"预创建 + 切换"两个迁移，或人工执行） |
| ⚠️ 限制 2 | 一个迁移是一个事务 → **大表长时间 DDL 会持有锁很久**，`up` 期间业务写入可能排队。大表改造要评估锁窗口 |
| ⚠️ 限制 3 | 整个文件用 `sql.unsafe()` 发送，因此**文件内不能使用 PostgreSQL 客户端元命令**（`\i`、`\copy`、`\echo`） |

> ⚠️ 限制 3 是一个真实陷阱：`psql` 能跑的脚本在迁移运行器里会**直接报语法错误**。
> 本项目现有迁移都只用标准 SQL（`DO $$ … $$` 块），因此可移植。新增迁移请沿用。 [已证实]

---

## 6. 运行方式

```bash
# 连接串优先级：MIGRATION_DATABASE_URL > DATABASE_URL > SUDA_DATABASE_URL
export DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/<db>"

node scripts/migrate.mjs status          # 已应用/待执行 + 漂移检查（不改任何东西）
node scripts/migrate.mjs verify          # 只校验 checksum（不改任何东西）
node scripts/migrate.mjs up              # 应用全部待执行迁移（默认命令）
node scripts/migrate.mjs up 0003         # 只应用到 <= 0003
node scripts/migrate.mjs down 0005       # 回滚 >= 0005 的已应用迁移（新→旧）
node scripts/migrate.mjs baseline 0005   # 把 <= 0005 标记为已应用但**不执行**
```

npm 入口（`package.json:22-23`）[已证实]：
```bash
npm run migrate          # = node ./scripts/migrate.mjs（默认 up）
npm run migrate:status   # = node ./scripts/migrate.mjs status
```
> 只有这两个 npm 脚本。`up` / `down` / `verify` / `baseline` **没有**对应的 npm 脚本名，
> 直接调 `node scripts/migrate.mjs <cmd>`。文档里不要编造 `npm run migrate:up`。

### 6.1 `status` / `verify` 的只读性质（很重要）

`ensureMigrationsTable()` 只在 `up` / `down` / `baseline` 中被调用；
`status` / `verify` 通过
`SELECT to_regclass('public.schema_migrations') IS NOT NULL`
先探测表是否存在（`migrate.mjs:155-166`）。

**因此**：在一个**从未跑过迁移**的库上，`status` 也能正常报告
"全部 pending"，而不是崩在 `relation "schema_migrations" does not exist`。
[已证实]

### 6.2 `baseline` —— 采用既有数据库的唯一安全方式（也是危险命令）

用途：数据库**已经**具备前几个迁移的效果（例如平台早已建好表），
不想重跑它们，但要建立 `schema_migrations` 记录。

```
warn('BASELINE: recording migrations as applied WITHOUT executing them.');
warn('Use this only when the database already contains their effects.');
```
（`migrate.mjs:368-369`）[已证实]。`applied_by` 会写成 `baseline:<user>` 以便事后区分。

**执行前的强制核对清单**（运行器不会替你判断）：

- [ ] 该库是否已有 `teachers` 的 6 个认证列（`username, password_hash, must_change_password,
      failed_login_attempts, locked_until, password_updated_at`）？→ 决定 `0001` 能否 baseline
- [ ] 是否已有 `schema_migrations`（若有，说明已迁移过，**不要** baseline）
- [ ] 是否已有 `permissions_version` 列与 `teachers` 上的 3 个触发器？→ 决定 `0003`
- [ ] 是否已有 `anon_` / `authenticated_` / `service_role_` 角色与对应 policy？→ 决定 `0004`
- [ ] `teacher_mfa` / `mfa_recovery_codes` / `mfa_challenges` 是否已存在？→ 决定 `0006`
- [ ] 已按 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §3.1 做过备份
- [ ] 已用 `node scripts/db-snapshot.mjs --out before.json` 留底

用错 `baseline` 的后果：**永远不会再补建那些对象**，而 `status` 会显示"全部已应用" ——
一个"看起来健康"但实际缺列的数据库。

### 6.3 `down` 的语义与拒绝守卫

```bash
node scripts/migrate.mjs down <target_version>
```
- 回滚**所有** `version >= target_version` 的**已应用**迁移，从新到旧；
- 每个 `.down.sql` 在**独立事务**内执行，并删除对应 `schema_migrations` 行；
- **任何一个缺少 `.down.sql` → 整体拒绝（exit 2）**，不会回滚一半；
- 没有 `down` 目标参数 → `die('down requires a target version, e.g. down 0001')`。

证据：`migrate.mjs:309-355`。 [已证实]

各 `down` 的拒绝条件见 [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §5.4。
**核心原则：`down` 只回滚"结构"，绝不为回滚而销毁"数据"。**
这一原则在 `0001` 与 `0006` 的 down 文件头里写得最清楚：

> "A rollback must reverse STRUCTURE, never DATA.
>  Several columns introduced by 0001 hold security-critical material (`password_hash`)
>  or account state (`locked_until`, `failed_login_attempts`).
>  Dropping them would silently destroy every account's credentials."
> —— `0001_schema_baseline_alignment.down.sql:4-8`

#### 6.3.1 逃生门（force-down）：**现在是真实可用的**

`.down.sql` 里的 "拒绝" 是守卫，不是墙 —— 但**必须有可用的开关**，
否则运维在真正需要回滚时会被永久卡住。

| migration | SQL 读取的 GUC | 文档化的环境变量 | 说明 |
|---|---|---|---|
| `0003` | `qls.rbac_force_down` | `QLS_MIGRATION_GUC_RBAC_FORCE_DOWN=on` | RBAC 表有数据时放行删除 |
| `0006` | `qls.mfa_force_down` | `QLS_MIGRATION_GUC_MFA_FORCE_DOWN=on` | 有已确认 MFA 绑定时放行删表（= 把账号降级为单因素，**危险**） |
| `0007` | `qls.soft_delete_force_down` | **`QLS_SOFT_DELETE_FORCE_DOWN=on`**（有显式别名） | 回收站非空时放行删除软删除列 |

映射由 `migrate.mjs` 的 `applyMigrationGucs()` 完成（在 `up` **和** `down` 的事务内、
迁移 SQL 之前执行 `set_config(name, value, true)`）：

```
QLS_MIGRATION_GUC_<name>=<value>   →  GUC qls.<name>      （name 必须匹配 [a-z0-9_]+）
QLS_SOFT_DELETE_FORCE_DOWN=on|1|true|yes  →  qls.soft_delete_force_down = on
```

值通过**绑定参数**传入，因此环境变量无法注入 SQL。 [已证实，代码阅读]

用法示例：
```bash
# 回滚 0006，明知会让已绑定 MFA 的账号降级为单因素
QLS_MIGRATION_GUC_MFA_FORCE_DOWN=on node scripts/migrate.mjs down 0006

# 回滚 0007（回收站里有行时）
QLS_SOFT_DELETE_FORCE_DOWN=on node scripts/migrate.mjs down 0007
```
运行时会在日志里打印 `migration GUC: qls.<name>=<value>`，便于事后核对。

> ⚠️ **历史教训（值得记住）**：这些开关**曾经是假的**。
> `0003`/`0006`/`0007` 的 down 文件里的提示语写着一个环境变量名，
> 但当时**没有任何代码**把它映射到 SQL 实际读取的 GUC
> → 运维照着提示重跑，仍然被拒。commit `18fd396`
> （`fix(migrate): make the documented down-migration escape hatch real`）修复了它。
> **教训：错误信息里提到的开关必须真的存在，否则比没有提示更糟。**
> 写新迁移的 down 时，请同时确认开关已被 `applyMigrationGucs()` 覆盖（命名一致性）。

---

## 7. 铁律（写任何迁移前先读这一节）

### ⛔ 禁止 1：不要删除并重建数据库

```
DROP DATABASE / DROP SCHEMA public CASCADE / createdb 覆盖
```
不是"重置环境"，而是**销毁唯一一份真实数据**。
本项目目前**没有**任何生产数据导出（[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §0），
重建 = 不可恢复。

### ⛔ 禁止 2：不要用"重跑 init.sql"代替迁移

`init.sql` 在原生 PG 上**无法执行**，重复执行**会失败**，且缺 6 个认证列。 [已证实，§E-1/3/4]

### ⛔ 禁止 3：不要重置或重灌 seed 数据

- `server/database/seed-curriculum.sql` 以 `uploader_id = (SELECT id FROM teachers WHERE
  wecom_user_id = 'system_initializer')` 为条件，**开头就有一条 `DELETE FROM resources
  WHERE uploader_id = …system_initializer`**（`seed-curriculum.sql:9-10`）[已证实]。
  在一个真实上线库里重跑它 = **删除并重灌全部课程资源**。
- 应用侧的 `AuthService.seedTeachers()` 是幂等的（按 username 查存在性），
  但它在 `0002` 之前**会为无 username 的旧账号创建重复账号**（21 → 41 的实测结果，
  `0002_backfill_legacy_usernames.sql:4-21`）。 [已证实]
- **种子数据是"初始化用"的，不是"修复用"的。**

### ⛔ 禁止 4：不要修改已应用的迁移文件

见 §3。要变更 → **新增迁移**。

### ⛔ 禁止 5：不要在同一个迁移里既改结构又大批量改数据

拆分理由：结构 DDL 往往需要锁，数据 DML 可能很长；混在一起会让锁窗口不可控，
而且失败时无法只重试其中一半。参考 `0001`（纯结构）与 `0002`（纯数据）的划分。

### ⛔ 禁止 6：不要在没有备份的情况下执行 `up` / `down`

`up` 本身不做备份（`migrate.mjs` 文件头 `:28` 明确"never drops or recreates the database
and never clears data"，但也不备份）。备份是**部署流程**的责任。

---

## 8. 如何写一个新迁移（标准流程）

以新增 `0007` 为例。

```bash
# 0) 确认当前状态干净
node scripts/migrate.mjs status          # 无 pending、无 drift
git status --short                       # migrations 目录无本地改动

# 1) 备份 + 快照（生产/预发必做）
pg_dump -Fc -f /var/backups/qls/pre_0007.dump     # 见 DISASTER_RECOVERY.md §3.1
DATABASE_URL="…" node scripts/db-snapshot.mjs --out snapshots/pre_0007.json

# 2) 写 UP（命名全小写！）
$EDITOR server/database/migrations/0007_add_xxx.sql

# 3) 写 DOWN（必须同时写）
$EDITOR server/database/migrations/0007_add_xxx.down.sql

# 4) 先在**本地/预发**库上验证（绝不在生产直接试）
DATABASE_URL="postgresql://…本地…" node scripts/migrate.mjs status   # ← 必须看到 0007 pending
DATABASE_URL="postgresql://…本地…" node scripts/migrate.mjs up
DATABASE_URL="postgresql://…本地…" node scripts/migrate.mjs verify

# 5) 数据一致性比对
DATABASE_URL="…" node scripts/db-snapshot.mjs --out snapshots/post_0007.json
node scripts/db-snapshot.mjs --compare snapshots/pre_0007.json --against snapshots/post_0007.json

# 6) 回滚验证（必须做！）
DATABASE_URL="…" node scripts/migrate.mjs down 0007
DATABASE_URL="…" node scripts/migrate.mjs status
DATABASE_URL="…" node scripts/migrate.mjs up       # 再装回去

# 7) 应用级验证
npm run type:check:server
NODE_ENV=production npm run start   # + GET /api/health、/api/health/ready
```

### 8.1 UP 文件的标准骨架

```
-- =============================================================================
-- 0007 — <一句话说明>
-- =============================================================================
-- 为什么需要（问题是什么，最好附实测到的错误码/现象）
-- 做了什么（逐条）
-- SAFETY
--   * 不删列/不删表/不删行
--   * 幂等：重复执行是 no-op
--   * 由运行器包在单个事务里
-- =============================================================================

-- 幂等写法示例
ALTER TABLE resources ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS foo (
  ...
);

-- 条件化 DDL 用 DO 块
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bar') THEN
    CREATE TYPE bar AS (...);
    RAISE NOTICE '0007: created type bar';
  END IF;
END
$$;

-- 末尾断言：迁移必须"自己证明自己生效了"
DO $$
DECLARE missing text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='resources' AND column_name='archived_at') THEN
    missing := missing || 'resources.archived_at ';
  END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '0007 incomplete: %', missing;
  END IF;
  RAISE NOTICE '0007: ok';
END
$$;
```

**"末尾断言"是本项目已确立的约定**：`0001`~`0006` **每一个**都有
（`0001:128-148`、`0002:142-156`、`0003:328-355`、`0004:145-177`、`0005:197-237`、`0006:109-126`）。
[已证实] 它把"迁移悄悄没生效"变成**明确失败**，而不是几天后在业务里发现。

### 8.2 DOWN 文件的标准骨架

```
-- =============================================================================
-- 0007 — <名字>  (ROLLBACK)
-- =============================================================================
-- 明确写出：这个回滚会破坏什么、什么情况下拒绝执行
-- =============================================================================

DO $$
DECLARE n integer := 0;
BEGIN
  IF to_regclass('public.foo') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM foo' INTO n;
  END IF;
  IF n > 0 THEN
    RAISE EXCEPTION
      '0007 down refused: % row(s) present; dropping would destroy configuration. '
      'Take a backup and perform a deliberate manual rollback if intended.', n
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

DROP TABLE IF EXISTS foo;
```

要点：
- **能拒绝就拒绝**（有数据依赖时抛异常，而不是静默删）；
- 需要"明知故犯"的逃生门时，用 `current_setting('qls.xxx_force_down', true)` 这类
  **显式**开关（`0003` 用 `qls.rbac_force_down`、`0006` 用 `qls.mfa_force_down`、
  `0007` 用 `qls.soft_delete_force_down`）；
  ⚠️ **开关必须在 `migrate.mjs` 里真正被接线**（见 §6.3.1）——
  错误信息里写一个不存在的环境变量，比不写提示更糟（本项目踩过，commit `18fd396` 才修复）；
- `IF EXISTS` 全覆盖，保证 down 可重复执行；
- 只回滚**本迁移自己创建**的对象，绝不越界（`0004 down` 只删 `rls0004_%` 前缀的 policy）。

---

## 9. RLS policy 编写的坑（**本项目真实踩过的，逐条记录**）

> 这一节来自 migration `0004` 与 `0005` 的文件注释与代码。
> 每一条都是**实际发生过**的故障，不是假想。

### 9.1 `FOR INSERT` 只能写 `WITH CHECK`，不能写 `USING`

错误写法：
```sql
CREATE POLICY p ON t FOR INSERT TO r USING (true) WITH CHECK (true);
```
报错：`only WITH CHECK expression allowed for INSERT`。
正确：`CREATE POLICY p ON t FOR INSERT TO r WITH CHECK (true);`

出处：`0004_rls_role_alignment.sql:92-95`（注释明确记录）。 [已证实]

### 9.2 角色名**带后缀**：写错角色名不会报错，但会**静默返回 0 行**

这是本项目最严重的一次"不是 bug 的 bug"：

平台的 `SqlExecutionContextMiddleware` 对每个请求执行
```sql
SET LOCAL ROLE 'anon_<roleSchema>' | 'authenticated_<roleSchema>' | 'service_role_<roleSchema>';
```
其中 `<roleSchema>` 来自连接串的 `schema` 参数，**独立部署时为空** → 角色名是 `anon_`。

后果链（实测观察，`0004:21-27`）：
```
SET LOCAL ROLE "anon_"; SELECT ... FROM teachers;  -->  0 rows
```
RLS 已启用而该角色**没有匹配的 policy** 时，PostgreSQL **不报错、只返回 0 行**。
表现为：**密码正确却提示"用户名或密码错误"，且不写审计**（审计 INSERT 被同一机制挡住）。

**教训**：
1. 新增 RLS policy 时，**必须同时覆盖无后缀与空后缀两套角色名**
   （`anon` 与 `anon_`，`authenticated` 与 `authenticated_`，`service_role` 与 `service_role_`），
   只要该角色在集群中存在；
2. 排查"查不到数据"时，先问"当前 `current_user` / `current_role` 是谁、
   这个角色有没有 policy"，而不是先怀疑业务代码。

### 9.3 删 policy 时容易**漏掉后缀版本**，导致功能静默失效

`0005` 第一步 `DROP POLICY` 同时删掉了 `anon` 与 `anon_` 的名字，
但第二步重建时**只重建了无后缀的那个** → 独立部署下匿名角色**失去了会话 UPDATE 权限**
→ 会话撤销 `42501`，**表现为"任何权限变更后的第一个请求 500"**。

出处：`0005_tighten_rls_writes.sql:74-79`（注释原文：
"recreating only the unsuffixed one silently removed the anonymous UPDATE policy from a
standalone deployment, and session revocation then failed with 42501 (observed while
testing this migration)"）。 [已证实]

**教训**：`DROP` 的角色范围与 `CREATE` 的角色范围**必须一致**。
写完立刻用断言检查"该角色仍然有它需要的 policy"（见 9.6）。

### 9.4 列级 GRANT 收得太紧会**静默打断正常查询**

`0005` 的第一版把 `teachers` 的 `SELECT` 也收成列清单，结果任何触及清单外列
（`password_updated_at`、`_created_at`/`_updated_at` 等）的查询都
`permission denied for table teachers` → **普通页面 HTTP 500**。

出处：`0005:135-149` 的详细复盘。结论被写进代码：`teachers` 的 `SELECT` **保留表级**，
只收 `UPDATE`。 [已证实]

**教训**：
- RLS 是**行级**的，无法表达"只能改这一列" → 列级控制只能用 `GRANT (col) ...`；
- **写权限可以精确收窄，读权限收窄的收益通常很小而破坏性很大**
  （登录查询本来就必须能读 `password_hash`）；
- 每一次列级收窄，都要把**所有**触及该表的查询过一遍（在这个项目里，
  连 `RETURNING` 子句都会踩到 —— 见 9.5）。

### 9.5 `RETURNING id` 也需要 `id` 的 SELECT 权限

`0005` 给 `sessions` 做列级 `SELECT` 时漏了 `id`，
而 `SessionService.destroySession()` 使用 `RETURNING id` →
`42501`，**表现为当时同上**。

出处：`0005:157-159`（"Omitting it made session revocation fail with 42501 —
observed as an HTTP 500 on the first request after any permission change."）。 [已证实]

**教训**：列级 `SELECT` 清单必须包含**所有**被读取的列，
包括 `RETURNING`、`WHERE`、`ORDER BY`、`JOIN` 里出现的列 —— 而不仅是"业务上关心的列"。

### 9.6 收紧权限后必须用断言证明"危险能力真的没了"

`0005` 末尾用 `has_column_privilege()` 断言匿名角色**不能**再改
`teachers.password_hash` / `teachers.roles`，否则 `RAISE EXCEPTION`：

```sql
SELECT has_column_privilege(role_name, 'teachers', 'password_hash', 'UPDATE') INTO can_update_password;
IF can_update_password THEN
  problems := problems || role_name || ' can UPDATE teachers.password_hash; ';
END IF;
```
出处：`0005:197-237`。 [已证实]

**教训**：安全类迁移**必须自带反证断言**，否则"以为收紧了"和"真的收紧了"无法区分。

### 9.7 RLS 无法表达列级限制（根本约束，必须承认）

RLS policy 的 `USING` / `WITH CHECK` 是**行级谓词**。
`init.sql` 里想表达"匿名角色只能更新 `last_login_at`"，
写成了 `FOR UPDATE TO anon USING (true) WITH CHECK (true)` ——
**实际含义是"可以改任意行、任意列"**，包括 `password_hash`、`roles`、`status`。
（`0005:6-23` 的整改对象，审计发现 §D-5。） [已证实]

**教训**：
- 需要"按列"控制 → 用 `GRANT (col1, col2) ON tbl TO role`，这是**唯一**有该粒度的手段；
- 看到 `USING (true)` 的写策略，先假设它等于"给该角色全部写权限"。

### 9.8 应用是否 `SET ROLE` 决定了 RLS 的实际意义

见 [`SECURITY.md`](SECURITY.md) §8.2：独立部署下**每个请求**都跑在匿名角色上，
**数据库角色无法区分应用用户**（因为 `SET ROLE` 由平台的 `userContext.userId` 驱动，
而它在独立部署时为空）。
因此：**RLS 不能作为应用授权的手段**，应用层授权才是真正的闸门
（`0005:179-184` 的注释把这个结论写得很明确）。 [已证实]

**教训**：写 RLS policy 前先确认"我这个请求到底以哪个角色执行"。
否则会写出一套**看起来安全、实际从不生效**（或反过来，让所有人查不到数据）的 policy。

### 9.9 平台角色不存在时，`CREATE POLICY ... TO <role>` 的行为

`0004` 的文件头（`:36-42`）记录了这一点：policy 引用一个不存在的角色会失败，
**因此必须先 `CREATE ROLE`**。该迁移因此显式创建了 `anon_` / `authenticated_` / `service_role_`。
[已证实]

**教训**：写 RLS 迁移时**必须先确保目标角色存在**（`IF NOT EXISTS` 语义），
不能假定平台一定建好了。

---

## 10. 新迁移评审清单（Reviewer 逐条打勾）

### 命名与形式

- [ ] 文件名为 `NNNN_lower_snake.sql`（4 位数字、全小写），且**已确认出现在 `status` 的 pending 列表里**
- [ ] 版本号未与既有冲突，且 > 当前最大版本（当前最大 = `0007`）
- [ ] **同版本存在 `.down.sql`**
- [ ] 文件头写清了「为什么 / 做了什么 / 安全性」
- [ ] 只使用标准 SQL；**没有** `psql` 元命令（`\i` `\copy` `\echo`），**没有**不能在事务内执行的语句
      （`CREATE INDEX CONCURRENTLY` / `VACUUM` 等）
- [ ] 末尾有**断言块**，能证明自己生效

### 安全性（数据）

- [ ] 没有任何 `DROP TABLE` / `DROP COLUMN` / `DELETE` / `TRUNCATE`（确实必要时，`down` 必须有拒绝守卫）
- [ ] 所有 DDL 都幂等（`IF NOT EXISTS` / `DO` 块条件判断），重复执行为 no-op
- [ ] 新增 `NOT NULL` 列**带默认值**，或先加可空列 + 回填 + 再加约束（三步走）
- [ ] 新增 `NOT NULL DEFAULT …` 到已有表时，**确认该默认值的业务语义是真的**
      （`0001:89-94` 记录了反面例子：`password_updated_at NOT NULL DEFAULT now()` 会
      **谎称所有账号刚刚改过密码**，因此该列被有意设计为可空）
- [ ] 不重建、不重置、不重灌任何 seed 数据
- [ ] 大表操作已评估锁窗口与执行时长

### 安全性（授权 / RLS）

- [ ] 若涉及 RLS：policy 覆盖了**所有实际使用的角色名拼写**（含空后缀与带后缀）
- [ ] `DROP POLICY` 与 `CREATE POLICY` 的角色范围**一致**
- [ ] `FOR INSERT` 只写 `WITH CHECK`
- [ ] 列级 `GRANT` 清单包含所有被读/写/`RETURNING` 的列
- [ ] 有 `has_column_privilege` / `has_table_privilege` 之类的**反证断言**
- [ ] 已确认该改动**不会**把 `USING (true)` 的写权限重新引入
- [ ] 若放宽任何权限，说明理由并写进文件头

### 可回滚性

- [ ] `down` 能真正撤掉 `up` 创建的对象（在本地实测过）
- [ ] `down` 在有数据依赖时**拒绝执行**（而不是静默销毁）
- [ ] `down` 可重复执行
- [ ] `down` **不越界**（不删其他迁移创建的对象）

### 验证证据（必须附在 PR 里）

- [ ] 本地/预发 `status` → `up` → 输出全文
- [ ] `verify` 通过
- [ ] `db-snapshot.mjs --compare pre.json --against post.json` → **无 integrity problem**
- [ ] `down` 实测输出（回滚成功 + 数据完好）
- [ ] 再 `up` 一次（幂等性）
- [ ] `npm run type:check:server` 通过
- [ ] 若影响 `server/database/schema.ts` → 已同步（见 §11）

---

## 11. 与 `server/database/schema.ts` 的关系

| 项 | 事实 |
|---|---|
| 来源 | **由平台库反向生成**：`npm run gen:db-schema` = `npx -y @lark-apaas/db-schema-sync@latest --output server/database/schema.ts --export-custom-types`（`package.json:14`）[已证实] |
| 角色 | 它只是 **Drizzle 的类型/表定义**，供应用查询使用；**不是**结构权威 |
| 权威 | `migrations/` 下的 SQL |
| 漂移风险 | 该文件与 `init.sql` 已经双向漂移过（teachers 差 6 列等）[已证实，§E-6] |

**因此**：新增迁移后，若该迁移改变了应用需要感知的结构，
需要同步更新 `schema.ts`（手工或重新生成），否则 Drizzle 的列类型与真实表不一致，
`type:check` 也不会发现（因为它只检查 TS 类型自洽）。

> ⚠️ `gen:db-schema` 会**覆盖** `schema.ts`，且会**联网**（`npx -y ... @latest`）。
> 不要在有未提交改动时盲跑；跑完必须 `git diff` 逐行审阅。 [推断]

---

## 12. 一个已知的脆弱点（建议修复，但属代码改动）

`scripts/migrate.mjs:52` 与 `scripts/db-snapshot.mjs:30` 都直接
`import postgres from 'postgres'`，但：

```
package.json 是否声明 postgres：false
lockfile 中 node_modules/postgres：存在，version 3.4.9，dev=false（传递依赖）
```
[已证实]

即迁移运行器依赖一个**没有在 `package.json` 中声明**的包，仅靠传递依赖被提升到
`node_modules/postgres`。一旦上游（`drizzle-orm` 或平台包）不再依赖它，
`npm run migrate` 会直接 `ERR_MODULE_NOT_FOUND`。

**建议**：把 `postgres` 显式加入 `devDependencies`（锁定当前 `3.4.9`）。
本文档**不修改** `package.json`（文档职责边界），仅记录该风险。

---

## 13. 速查卡

```bash
# 状态 / 校验（只读）
node scripts/migrate.mjs status
node scripts/migrate.mjs verify

# 应用
node scripts/migrate.mjs up
node scripts/migrate.mjs up 0003

# 回滚（先读 §6.3 与 DEPLOYMENT_PRODUCTION.md §5.4）
node scripts/migrate.mjs down 0005

# 采用既有库（危险，先跑 §6.2 的核对清单）
node scripts/migrate.mjs baseline 0005

# 一致性留痕
node scripts/db-snapshot.mjs --out snapshots/before.json
node scripts/db-snapshot.mjs --out snapshots/after.json
node scripts/db-snapshot.mjs --compare snapshots/before.json --against snapshots/after.json

# 便捷入口
npm run migrate
npm run migrate:status
npm run db:snapshot

# 连接串优先级
MIGRATION_DATABASE_URL > DATABASE_URL > SUDA_DATABASE_URL
```

**四条不能做的事**：删除重建数据库 · 重跑 `init.sql` · 重置 seed · 编辑已应用的迁移。
