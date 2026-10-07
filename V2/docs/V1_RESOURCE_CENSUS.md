# V1 → V2 迁移盘点（V1_RESOURCE_CENSUS）

> 由 `scripts/v1-census.mjs` 生成。**只读**：它不写任何数据库。

生成时间：2026-10-07T13:14:04.277Z

这份表回答三个问题：V1 里有多少东西、迁移有没有真的搬过来、V1 自己有没有被动过。

## 1. V1 源库逐表行数与内容指纹

### `postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_0005`

| 表 | 行数 | sha256（前 16 位） |
|---|---:|---|
| `teachers` | 27 | 82abb96e77c971e4 |
| `sessions` | 1968 | 35b3f00ab3a5dbda |
| `audit_logs` | 7651 | 8c80922cf0ff19ff |
| `review_records` | 2 | e571be6ad3c10f2e |
| `resources` | 348 | 363c32a434e062d4 |
| `subject_permissions` | 0 | e3b0c44298fc1c14 |
| `account_permission_overrides` | 0 | e3b0c44298fc1c14 |
| `account_scopes` | 0 | e3b0c44298fc1c14 |
| `teacher_mfa` | 0 | e3b0c44298fc1c14 |
| `mfa_recovery_codes` | 0 | e3b0c44298fc1c14 |
| `mfa_challenges` | 0 | e3b0c44298fc1c14 |
| `directories` | 69 | 39a4add7743620cc |
| `resource_versions` | 348 | 1d52075a04e4d006 |

**资源分布**

- 合计：**348**（草稿 1 / 待审核 1 / 已发布 346 / 退回 0 / 撤回 0）
- 回收站（软删除）：0
- 有目录归属：348；**没有目录归属**：0
- 带 `folder_type`（V1 旧分类）：348
- **声称有文件的资源：0** ← 这一项决定"文件迁移"是不是空活
- 落在几个不同目录上：3
- 按 `folder_type`：courseware=245，curriculum_outline=23，weekly_plans=80

**账号**

- 合计 27（启用 26 / 非启用 1）
- **没有口令**：2；**没有用户名**：1
- 要求首次登录改口令：0

**审计**

- 合计 7651；没有操作者 14；**操作者已不在 teachers 表里**：3092
- 动作词表（30 种）：data_export=1，directory_create=442，directory_delete=427，directory_rename=363，directory_update=150，file_validation_rejected=3，login=2703，login_failed=67，mfa_challenge_issued=310，mfa_enabled=131，mfa_enrolled=133，mfa_failed=128，mfa_success=128，password_changed=236，permission_change=803，permission_denied=3，resource_approve=27，resource_delete=132，resource_directory_assign=1，resource_download=80，resource_download_denied=18，resource_edit=258，resource_file_register=40，resource_purge=2，resource_recall=1，resource_restore=25，resource_submit_review=31，resource_upload=434，teacher_create=351，teacher_update=223

**授权来源**：subject_permissions=0，account_permission_overrides=0，account_scopes=0

### `postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_migration`

| 表 | 行数 | sha256（前 16 位） |
|---|---:|---|
| `teachers` | 21 | 61ad049ea52f4e6c |
| `sessions` | 0 | e3b0c44298fc1c14 |
| `audit_logs` | 25 | f7d9b88eb80e4ba3 |
| `review_records` | 18 | 846a0acc7a9b326d |
| `resources` | 347 | d32484eb873d4cb8 |
| `subject_permissions` | 0 | e3b0c44298fc1c14 |
| `account_permission_overrides` | 0 | e3b0c44298fc1c14 |
| `account_scopes` | 0 | e3b0c44298fc1c14 |
| `teacher_mfa` | 0 | e3b0c44298fc1c14 |
| `mfa_recovery_codes` | 0 | e3b0c44298fc1c14 |
| `mfa_challenges` | 0 | e3b0c44298fc1c14 |
| `directories` | 69 | e1949d06bd0c3db2 |
| `resource_versions` | 347 | cacd0903692f79ed |

**资源分布**

- 合计：**347**（草稿 0 / 待审核 0 / 已发布 347 / 退回 0 / 撤回 0）
- 回收站（软删除）：0
- 有目录归属：347；**没有目录归属**：0
- 带 `folder_type`（V1 旧分类）：347
- **声称有文件的资源：0** ← 这一项决定"文件迁移"是不是空活
- 落在几个不同目录上：3
- 按 `folder_type`：courseware=245，curriculum_outline=22，weekly_plans=80

**账号**

- 合计 21（启用 21 / 非启用 0）
- **没有口令**：20；**没有用户名**：0
- 要求首次登录改口令：0

**审计**

- 合计 25；没有操作者 0；**操作者已不在 teachers 表里**：0
- 动作词表（2 种）：login=18，login_failed=7

**授权来源**：subject_permissions=0，account_permission_overrides=0，account_scopes=0

### `postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_rbac_db`

| 表 | 行数 | sha256（前 16 位） |
|---|---:|---|
| `teachers` | 21 | 0a34332871a9cb21 |
| `sessions` | 0 | e3b0c44298fc1c14 |
| `audit_logs` | 25 | 2f6a74c8e276d587 |
| `review_records` | 18 | f2c1bc7238c5eb22 |
| `resources` | 347 | a75b5b129cbe5eba |
| `subject_permissions` | 0 | e3b0c44298fc1c14 |
| `account_permission_overrides` | 1 | a9c1b07ccf76ca09 |
| `account_scopes` | 1 | e6582fc12161df97 |
| `teacher_mfa` | 0 | e3b0c44298fc1c14 |
| `mfa_recovery_codes` | 0 | e3b0c44298fc1c14 |
| `mfa_challenges` | 0 | e3b0c44298fc1c14 |
| `directories` | 69 | 151441cd1e30f61f |
| `resource_versions` | 347 | 73b30be55b509b40 |

**资源分布**

- 合计：**347**（草稿 0 / 待审核 0 / 已发布 347 / 退回 0 / 撤回 0）
- 回收站（软删除）：0
- 有目录归属：347；**没有目录归属**：0
- 带 `folder_type`（V1 旧分类）：347
- **声称有文件的资源：0** ← 这一项决定"文件迁移"是不是空活
- 落在几个不同目录上：3
- 按 `folder_type`：courseware=245，curriculum_outline=22，weekly_plans=80

**账号**

- 合计 21（启用 21 / 非启用 0）
- **没有口令**：20；**没有用户名**：0
- 要求首次登录改口令：0

**审计**

- 合计 25；没有操作者 0；**操作者已不在 teachers 表里**：0
- 动作词表（2 种）：login=18，login_failed=7

**授权来源**：subject_permissions=0，account_permission_overrides=1，account_scopes=1

## 2. V2 目标库现状

`postgresql://qlsadmin:***@127.0.0.1:55432/qls_v2_staging`

| 表 | 行数 |
|---|---:|
| `users` | 27 |
| `sessions` | 0 |
| `directories` | 69 |
| `user_permissions` | 0 |
| `resources` | 348 |
| `resource_files` | 0 |
| `resource_reviews` | 4 |
| `audit_logs` | 7651 |
| `upload_tickets` | 0 |
| `storage_orphans` | 0 |
| `v1_import_runs` | 2 |
| `v1_migration_map` | 448 |

- 资源：{"total":348,"draft":1,"pending_review":1,"published":346,"rejected":0,"recalled":0,"recycled":0,"no_uploader":0}
- 文件对象：0
- 迁移记账：{"total":448,"needs_review":1,"byEntity":{"directory":69,"resource":348,"review":4,"user":27}}

## 3. V1 → V2 对读（业主 Stage 9 §4 / §14）

本 V2 库的数据来自：`postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005`（其余源库只作盘点，未导入本库）

| 项 | V1 | V2 | 两边口径 | 判定 |
|---|---:|---:|---|---|
| **postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_0005** | | | | |
| 账号 | 27 | 27 | 迁移记账行数（每个 V1 账号一行） | ✅ 一致 |
| 资源 | 348 | 348 | 迁移记账行数（每条 V1 资源一行） | ✅ 一致 |
| 目录映射 | 69 | 69 | 每个 V1 目录节点的映射（对齐上的也算） | ✅ 一致 |
| 审核时间线 | 2 条审核记录 + 2 次提交（另有 29 条提交指向不存在的资源，只搬审计） | 4 条时间线事件 | V2 的时间线 = 审核记录 + 审计里的提交事件 | ✅ 一致（提交事件只有审计记着） |
| 审计 | 7651 | 7651 | 两边都数审计行本身（V2 看 detail 里的 v1AuditId） | ✅ 一致 |
| 文件对象 | 0 | 0 | V1 没有对象可搬时两边都是 0 | ✅ V1 里没有对象可搬 |
| 授权 | 0（三个授权表都是空的） | 0 | 只转换 V1 里真实存在的显式授权 | ✅ 不凭空多授权 |
| ~~postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_migration~~ | | | 未导入本库 | 仅盘点，见 §1 |
| ~~postgresql://qlsadmin:***@127.0.0.1:55432/qls_test_rbac_db~~ | | | 未导入本库 | 仅盘点，见 §1 |

> "目录映射"两边数字口径不同：V2 侧记的是**每个 V1 目录节点**的映射行数，
> 所以它等于 V1 的目录节点数（同名对齐的 + 新建的），不是 V2 的目录总数。

