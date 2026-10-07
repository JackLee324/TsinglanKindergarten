# V1 → V2 数据迁移（阶段 9）

> **设计先于实现。** 本文是迁移的规则书：哪些能自动搬、哪些必须人来决定、
> 什么情况下**拒绝迁移**。
>
> 一句话原则：**宁可停下来问人，也不猜。**
> 迁移里最贵的错误不是"少搬了一条"，而是"搬过去一条谁也没授权的权限"
> 或者"资源挂到了错的目录"—— 这两种错在老师那边表现为"平台在胡说"。

---

## 0. 目标与红线

| 目标 | 说明 |
|---|---|
| 一次搬完 | 用户 / 目录 / 资源 / 文件 / 审核历史 / 审计历史 / 授权 |
| 可重复 | 连跑两次，第二次**一条也不新增**（幂等） |
| 可核对 | 迁移前后都有快照（行数 + sha256），能证明没丢、没重、没凭空多 |
| 可追溯 | 每条搬过来的记录都能回答"它原来是 V1 的哪一行" |
| 可回退 | 不修改 V1；V2 侧导入失败可以整批删掉（都是标记过的行） |

**红线（不可协商）**

1. **不写 V1。** 源连接一律 `default_transaction_read_only = on`，写操作会被数据库拒绝。
   迁移结束后源库快照必须与迁移前**逐字节一致**（用例会核对）。
2. **不删 V1 数据。** 没有任何 `DELETE` / `TRUNCATE` / `DROP` 指向源库。
3. **不做 V2 的运行时依赖。** V1 只在迁移时被读一次，之后 V2 启动不需要 V1 存在。
4. **不猜。** 任何映射不出来的东西进报告、停下来，不"就近放一个"。

---

## 1. 现状盘点（迁移的输入）

本机可用的 V1 库（同一个 PostgreSQL 实例，端口 55432）：

| 库 | teachers | resources | review_records | audit_logs | directories | 权限表 | 有文件的资源 |
|---|---|---|---|---|---|---|---|
| `qls_test_0005` | 27（26 启用 / 1 停用） | **348** | 2 | **7651**（30 种动作） | 69 | 0 | **0** |
| `qls_test_migration` | 21 | 347 | **18** | 25 | 69 | 0 | **0** |
| `qls_test_rbac_db` | 21 | 347 | 18 | 25 | 69 | override 1 + scope 1 | **0** |

三个库互补：`0005` 有审计与口令、`migration` 有审核历史、`rbac_db` 有覆盖/范围行。
所以**迁移脚本必须能被指向任意一个 V1 库**，而验证要三个都跑。

### 1.1 三个必须先知道的事实

**（一）V1 里没有文件对象。** 三个库里 `file_path` / `file_bucket_id` /
`file_name` / `file_size` 全部为 NULL（V1 自己的注释也写了这件事：
"all 347 seeded rows have NULL file columns, so every one of them rendered an
enabled 下载 button that then failed"）。
所以本次迁移的文件源是 **空**，但**文件迁移能力必须实现并被证明**（§6），
否则将来 V1 真的上了文件就得再写一遍。

**（二）V1 的授权表是空的。** `subject_permissions` / `account_permission_overrides`
/ `account_scopes` 在三库里几乎全是 0 行（唯一例外是 rbac 夹具各 1 行）。
V1 实际"有什么权限"只体现在 `teachers.roles` 上 —— 而这正是业主明令
**不许平移**的东西（§7）。

**（三）346 / 348 个资源的上传者是"系统初始化"账号**，它**没有用户名**、
V1 状态是停用。也就是说：这份语料的主人是一个登录不了的种子账号。
若跳过它，346 条资源就变成"无上传者"（V2 允许，但历史断链）。

---

## 2. 身份：谁是谁

| V1 | V2 | 规则 |
|---|---|---|
| `teachers.id` | `users.id` | **原样保留 V1 的 uuid** |
| `resources.id` | `resources.id` | **原样保留**（审计/审核里的引用不需要翻译） |
| `directories.id` | — | **不保留**：V2 的初始目录由 `seed.mjs` 建，uuid 不同 → 走映射表 |

资源保留同一个 uuid 有个直接好处：V1 审计里的 `resource_id`、审核记录里的
`resource_id` 搬过来依然指向同一条资源，**不需要**在搬迁时重写引用。

### 2.1 记账表（唯一的 schema 变更）

`database/migrations/0003_v1_migration.sql` 增加两张**迁移记账表**
（不是业务表，前缀 `v1_` 已经说明它们的来历）：

```
v1_import_runs   —— 每次导入一行：源标签、时间、各表搬运计数（JSON）
v1_migration_map —— 每个搬过来的对象一行：(source, entity, v1_id) → v2_id + legacy JSON
```

`legacy` 存放 **V1 有、V2 故意没有**的字段（§4）。这是"不丢数据"的落点：
V2 的业务表保持干净，历史字段仍然查得到。

审计去重靠数据库约束而不是靠脚本自觉：

```sql
CREATE UNIQUE INDEX audit_logs_v1_dedup
  ON audit_logs ((detail ->> 'v1AuditId')) WHERE detail ? 'v1AuditId';
```

---

## 3. 目录：按名字路径对齐，一格一格核

V1 的目录树（69 节点）与 V2 的初始目录树（69 节点）**是同一棵 PDF 树**，
只是编码方式不同：

```
V1:  root:edu / prek / prek:virtue / prek:virtue_outline
V2:  education / pre-k / virtue / outline          ← slug 路径
```

映射规则：**逐级按名字对齐**（V1 的 `name` 序列 == V2 的 `name` 序列），
从根往下走：`教育教学 → education`、`Pre-K → pre-k`、`美德 → virtue`、
`课程大纲 → outline`。

* 两边名字序列完全一致 → 建立 `(source,'directory',v1_id) → v2_id` 映射。
* V1 有、V2 没有的节点（管理员在 V1 里自建的栏目）→ **插入**到映射后的父节点下，
  `slug` 由 V1 code 末段规整而来，`allow_*` 取安全默认（`allowFiles=false`，
  因为 V1 的 directories 表根本没有"能不能放文件"这一列）。
* 名字对不上 → **NEEDS_MANUAL_REVIEW**，写进报告并停止（`--allow-partial` 才继续）。

> 为什么不是"按 code 硬编码一张 69 行的表"：硬编码表一旦和 V2 的 seed 漂移，
> 迁移会静默把资源挂错地方。名字对齐则是**每次运行都重新核对**，
> 对不上就报错。两种做法都能过今天的用例，只有一种能过明天的。

---

## 4. 资源归属：用 V1 自己的分类表落到资料夹

V1 有两套归属信息：`directory_id`（migration 0012 加的）与 `folder_type`（6 值旧分类）。
**实测事实**：V1 的 348 条资源**全部挂在科目层**（美德 / 蒙特梭利 / 英文教学），
一条都没挂到资料夹上 —— 这不是脏数据，是 0012 当年的**有意选择**：
那张映射表当时没被规定，所以只回填到科目（见 V1 的
`legacy-folder-mapping.ts` 里记录的那段历史）。

而 V2 的浏览页**只在资料夹层列资源**（`allowFiles = true` 的节点）。
所以"忠实照搬 `directory_id`"的结果是：

> **348 条资源迁移之后，老师在目录浏览里一条都看不到。**

这是本阶段最危险的一个坑，而且是**浏览器用例**抓出来的（接口层全绿、
行数全对、sha256 全一致，只有"老师点进去看不到东西"这一个症状）。
搬到老师找不到的地方，不叫忠实，叫丢。

### 4.1 规则

```
folder_type ──(V1 自己的分类表)──> V2 资料夹
   curriculum_outline  → 课程大纲 outline
   weekly_plans        → 教学详案 lesson
   courseware          → 教学资源 resources
   materials           → 教学资源 resources
   observation         → 考核评估 assessment
   research_archive    → （PDF 里没有对应资料夹，V1 自己也不给它写目录）
```

这张表**不是迁移脚本发明的**，就是 V1 `legacy-folder-mapping.ts` 里那份
（业主在 V1 §9 逐条给出过）。所以它既不是猜，也不是我们擅自扩大业务含义。

* 有对应资料夹 → 资源落到那个资料夹（**这才是老师能在浏览页看到的位置**）。
* 分类表里没有的值（`research_archive`）→ 资源**留在 V1 的目录**上，
  并在报告里记一条：该位置在 V2 浏览页不列资源，需要人工决定去哪个资料夹。
* `folder_type` 为空或未知 → 同上（留在原目录 + 报告），**绝不替它选一个**。

落点同时写进记账表的 legacy，附带依据：

```json
{ "v1DirectoryId": "…美德…", "folderType": "curriculum_outline",
  "placedIn": "folder:outline", "placementBasis": "folder_type（V1 的分类表）" }
```

于是任何一条资源都能回答："它原来在哪、现在在哪、**凭什么**在那儿"。

### 4.2 其余字段

| V1 资源字段 | V2 | 说明 |
|---|---|---|
| `title` / `title_en` / `description` | 同名 | 直接搬 |
| `folder_type` 等 7 个分类字段 | `legacy` | V2 的库里没有这些列，历史值不丢 |
| `status` | `status` | 小写 → 大写；未知取值 → **停止** |
| `uploader_id` | `uploader_id` | 该用户搬过来了就指过去；没搬（或 V1 里就没有）→ NULL |
| `deleted_at` | `deleted_at` | V1 回收站 → V2 回收站（同一个概念） |
| `deleted_by` / `purge_after` | `legacy` | V2 没有这两列 |
| `reviewer_id` / `review_comment` / `reviewed_at` | 不进资源列 | 走审核历史（§5）——V2 不把"当前审核结论"存在资源行上 |
| `file_*` | `resource_files`（§6） | 文件是独立的行，不是资源上的列 |

`directory_id` 为空、或 V1 的目录在 V2 找不到对应节点 → 进 `UNASSIGNED_RESOURCES.md`
并**中止整批导入**（V2 没有"未归属"节点，`resources.directory_id` 是 NOT NULL，
脚本没有地方放它，所以不会替它编一个）。

## 5. 审核历史：把时间线拼回来

业主的要求是"不能只迁当前状态"。V1 的时间线散在两个地方：

| 来源 | 内容 |
|---|---|
| `review_records` | 审核人动作：`approve` / `reject` / `recall`（**没有** submit） |
| `audit_logs` | `resource_submit_review`（提交）以及历史状态变化 |

所以时间线 = **两边并按时间排序**，然后逐条推导 `from_status → to_status`：

```
初始 DRAFT
  submit   DRAFT          → PENDING_REVIEW
  approve  PENDING_REVIEW → PUBLISHED
  reject   PENDING_REVIEW → REJECTED      （必须带原因）
  recall   PUBLISHED      → RECALLED
```

* `action` 映射到 V2 的四个值：`submit` / `review.approve` / `review.reject` / `review.recall`。
* V2 的 CHECK 要求"退回必须有原因"。V1 的退回记录若没有原因，**不编原因**：
  写成 `（V1 未记录退回原因）` 并在 legacy 里标 `commentMissing: true`，
  同时计入报告的"需要人工确认"。**不丢这条记录**，也不假装 V1 当时写了理由。
* 某条动作算不出合法迁移（例如 `approve` 出现在 `DRAFT`）→ 仍然保留，
  `from_status` 取推导出的当前状态，并把该资源计入 **NEEDS_MANUAL_REVIEW**。
  宁可报告里多一条，也不要静默丢一条。

---

## 6. 文件：真的有对象才搬，没有就报出来

V2 的文件是 `resource_files` 行 + 对象存储里的对象，两者缺一不可。

| V1 的情形 | 处理 |
|---|---|
| 有 `file_path` + `file_bucket_id`，源对象**读得到** | 读出字节 → 算 sha256 → 写入 V2 存储（key 用 V2 约定 `resources/{v2ResourceId}/{uuid}-{safeName}`）→ 插 `resource_files`（sha256 用**真实算出来的**值） |
| 有 `file_path`，但源对象**读不到** | **MISSING_FILE**：写进报告，**不插** `resource_files` 行 |
| 只有元数据（`file_path` 为空） | `no_file_in_v1`：写进报告，不造文件 |

**绝不伪造文件。** 一个"看起来能下载、点下去 404"的资源，正是 V1 被投诉的那个毛病。

源对象的位置由参数决定：

```
--v1-storage local:/path/to/v1/storage     本地目录驱动
--v1-storage s3                            用 V1_STORAGE_* 环境变量（R2/S3/MinIO）
--v1-storage none                          明确声明"本次没有对象要搬"
```

`--v1-storage none` 时若发现任何资源**声称**有文件 → 报错退出（不许装作搬成功）。

`resource_versions`（V1 的版本行）V2 没有对应表：条数与 id 前缀进 `legacy` + 报告，
不编一张新表出来。

---

## 7. 账号、口令、权限

### 7.1 口令：先证明兼容，再决定搬不搬

两边的口令都是 scrypt，但实现细节**不一样**：

| | V1 | V2 |
|---|---|---|
| salt 参与运算的形式 | **base64 字符串本身**（`scryptSync(pw, saltString, 32, …)`） | **解码后的 16 字节**（`Buffer.from(salt,'base64')`） |
| 派生长度 | 32 字节 | 64 字节 |
| 存储格式 | `scrypt$N$r$p$salt$hash` | 同左 |

所以"格式一样"不等于"能校验通过"。V2 加了一条**只针对 V1 长度（32 字节）的兼容分支**：
派生长度取存储值本身的长度，salt 按 V1 的语义（字符串）参与运算。
`tests/unit/password-v1-compat.test.mjs` 用 **V1 的代码原样**造一个哈希，
断言 V2 能校验通过、错口令被拒 —— 兼容性是**测出来的**，不是声称的。

* 有口令且兼容 → 原样搬，老师不用重设。
* V1 就没有口令（`password_hash IS NULL`，本机 2 个账号）→ 写入**明确不可用**的占位
  `v1$no-password$<random>`（V2 的校验器结构上不认这种串，任何口令都过不了），
  状态照 V1 搬，并进报告的"需要管理员重置口令"清单。
  **不设默认口令、不设明文、不设空口令。**
* 出现 V1 之外的哈希形态 → **停止**，不猜算法。

### 7.2 角色：只产出 ADMIN / TEACHER，其余进 legacy

V1 有 8 种角色（super_admin / principal / curriculum_director / prek_head /
k_head / k_assistant / prek_assistant / pe_specialist），V2 只有两个身份。

```
--admin-roles  super_admin,principal      （默认；不是 ADMIN 的都成为 TEACHER）
```

* 原角色数组完整写进 `legacy.roles`，报告里逐人列出。
* 运行结束必须**至少有一名 ADMIN**，否则整个导入失败（V2 的护栏要求系统里有管理员）。
* 不重建 principal / curriculum_director 之类的 V2 业务角色。

### 7.3 权限：能编码的才编码，编不出来的交给人

V1 有四个权限来源，逐个处理：

| 来源 | 处理 | 本机实际情况 |
|---|---|---|
| `subject_permissions`（教师 × 班型 × 科目） | **转换成** `user_permissions(user_id, permission, directory_id)`：科目 → 目录（映射后），权限码按 §7.4 翻译 | 0 行 |
| `account_permission_overrides`，`effect='allow'` | 转换成一条授权 | 0 行 |
| `account_permission_overrides`，`effect='deny'` | **不转换**：V2 没有 deny。写进报告，人工确认 | 0 行 |
| `account_scopes`（ALL/OWN/PROGRAM/SUBJECT） | **不单独转换**：V2 的"范围"就是授权指向的目录；单独一个 scope 不产生任何权限。写进报告 | 0 行（rbac 夹具 1 行） |
| `teachers.roles` | **不转换**（业主明令）。报告里给出"这个人原来是 X 角色，建议授予 Y"的建议表 | 27 行 |

**默认不产生任何授权。** 于是迁移后老师能登录、但看不到目录，
必须由管理员在 V2 界面里授权 —— 这正是 V2 设计好的流程，
也是唯一不会"擅自扩大权限"的方向。报告末尾给出建议表，
让管理员照着点几下就能把老师恢复成原来的可见范围。

### 7.4 权限码翻译表（只用于 `subject_permissions` / allow 覆盖）

| V1 | V2 |
|---|---|
| `curriculum.view` | `resource.view` |
| `resource.view` | `resource.view` |
| `resource.create` / `storage.upload` | `resource.create` |
| `resource.update` | `resource.update.own` |
| `resource.delete` | `resource.delete.own` |
| `resource.download` / `storage.download` | `resource.download` |
| `resource.submit_review` | `resource.submit` |
| `review.view` | `resource.review` |
| `review.approve` | `resource.publish` |
| `curriculum.manage` / `storage.delete` | `directory.manage` |
| `audit.view` | `audit.view` |
| `account.*` / `role.*` / `permission.*` | `user.manage` |
| 其余（MFA / 安全 / 会话 / 健康检查等） | **不翻译**，进报告 |

"不翻译"的含义是：那项能力在 V2 里不存在（比如 MFA），
所以它既不产生授权，也不假装产生。

---

## 8. 审计：一条都不丢，包括登录不了的人做的

V2 的审计行有两个 V1 没有的好处：`actor_name` 是**文本快照**，
`target_type` 有约束。搬运用它们消化 V1 的脏数据：

* `actor_id`：V1 的 `teacher_id` 若搬过来了 → 指过去；否则 **NULL**，
  但 `actor_name` 保留 V1 的 `teacher_name`。
  （本机 `qls_test_0005` 的 7651 行里有 **3092 行**的 actor 是测试造出来的、
  在 `teachers` 表里并不存在。丢掉它们等于篡改历史。）
* `result`：V1 `success=true` → `success`；`false` → `failed`；
  `resource_download_denied` / `permission_denied` → `denied`。
* `target_type`：按动作归类为 `user` / `directory` / `resource` / `file` / `system`。
* `target_id`：V1 的 `resource_id`（资源 uuid 保持一致，所以直接可用）。
* `detail`：`{ v1AuditId, v1Action?, program, subject, errorMessage? }` —— 保留原文，
  同时给去重索引提供键。
* `created_at`：**保留 V1 的时间**（不是导入时间）。
* 动作名：能对上 V2 词汇表的按表翻译；V2 里没有的概念（MFA、导出、
  文件登记、目录归属指派）**保留 V1 原名**，并在 `shared/audit-actions.ts`
  里以 `V1_LEGACY_ACTIONS` 单独登记中文标签（带"（V1 历史）"字样），
  这样审计页仍然筛选得到、看得懂，而 V2 自己的动作清单保持干净。

**停用账号的审计照样搬。** 审计属于历史，不属于账号。

---

## 9. 幂等：第二次运行必须是空操作

| 对象 | 幂等键 |
|---|---|
| 用户 / 资源 | 主键 = V1 uuid → `ON CONFLICT (id) DO NOTHING` |
| 目录映射 | `v1_migration_map` 主键 `(source,'directory',v1_id)` |
| 审核记录 | `v1_migration_map` 主键 `(source,'review',v1_id)` |
| 审计 | `audit_logs_v1_dedup` 唯一索引（`detail->>'v1AuditId'`） |
| 文件 | `v1_migration_map` 主键 `(source,'resource_file',v1_id)`；对象 key 固定，重复 PUT 幂等 |
| 授权 | `v1_migration_map` 主键 `(source,'permission',v1_id)` |

第二次运行**不覆盖**已经搬过来的行 —— 因为管理员可能已经在 V2 里改过它们
（改了标题、调了目录、撤了权限）。"重新导入"不能变成"回滚管理员的修改"。
报告里会写清：`已存在，跳过 N`。

---

## 10. 环境与顺序

```
① 迁移测试库（本机 qls_v2_test）  —— 用例自动跑，含合成 V1 夹具
② 预演库（qls_v2_staging）        —— 搬真实 V1 数据，出快照与报告，供人看
③ 生产                            —— 需要 --allow-production + 先备份；本轮不执行
```

生产导入的前置条件（脚本会自己检查，缺一条就拒绝）：

* 目标库 URL 与源库 URL 不同；
* 目标库有 `schema_migrations` 且迁移 0 pending；
* 目标库**没有** `teachers` 表（那是 V1 的标志）；
* `--allow-production` 显式给出，且 `--backup` 指向一个存在的备份文件。

---

## 11. 失败标准（任何一条成立 = NOT READY FOR STAGE 9）

* 资源 / 用户 / 目录 / 审核 / 审计 的行数与快照对不上；
* 出现重复行（同一 V1 行搬了两次）；
* 资源落到与 V1 `directory_id` 不同的目录；
* 声称有文件的资源，迁移后**没有**对象或没有 `resource_files` 行；
* 审核历史缺条（或退回原因被凭空补上）；
* 审计缺条（含 actor 已不存在的行）；
* 产生了**任何** V1 里不存在的授权（权限扩大）；
* 源库快照发生变化（V1 被动过）；
* 第二次运行产生了新的行；
* 迁移后存在悬空外键（`uploader_id` / `directory_id` / `actor_id` 指向不存在的行）。

---

## 12. 命令

```bash
# 1) 迁移前快照（源 + 目标都拍）
node scripts/v1-snapshot.mjs --url "$V1_URL" --out .migration/v1-before.json
node scripts/v1-snapshot.mjs --url "$V2_URL" --out .migration/v2-before.json

# 2) 预演（只读、只打印，不写库）
node scripts/import-v1.mjs --source "$V1_URL" --target "$V2_URL" --dry-run

# 3) 真跑
node scripts/import-v1.mjs --source "$V1_URL" --target "$V2_URL" \
  --v1-storage none --admin-roles super_admin,principal \
  --report docs/V1_MIGRATION_REPORT.md --unassigned UNASSIGNED_RESOURCES.md

# 4) 再跑一次：必须 0 新增（幂等）
node scripts/import-v1.mjs --source "$V1_URL" --target "$V2_URL" --v1-storage none

# 5) 迁移后快照 + 核对
node scripts/v1-snapshot.mjs --url "$V1_URL" --out .migration/v1-after.json
node scripts/v1-snapshot.mjs --url "$V2_URL" --out .migration/v2-after.json
```

`--dry-run` 与真跑走**同一条代码路径**，只是最后不提交事务 ——
否则"预演通过、真跑失败"这种最坏的情况迟早会发生。
