# 生产账号与权限矩阵（Stage 12C §6.1；Stage 13B §2 更新）

> 数据来源：**V2 专用迁移文件** `v2-cutover-20261008.ndjson`（sha256 `b01c1fec…`）。
> 迁移**刻意不发授权**（V2 设计：权限只有 `user_permissions` 一个真相），
> 所以下表里当前权限一律是 0 —— 上线当天必须由管理员按下面的建议逐条确认后初始化。

## 超级管理员：**只有 `TsinglanAdmin`**（业主 Stage 13B §2 的确认）

| 项 | 决定 |
|---|---|
| 唯一的超级管理员 | **`TsinglanAdmin`**（V1 里是 `super_admin`；业主已明确确认） |
| 迁移怎么给身份 | `--admin-usernames TsinglanAdmin` **显式点名**；`DEFAULT_ADMIN_ROLES` 为**空**，不按 V1 岗位名自动提升 |
| 其他 V1 管理员岗位（`principal`） | **一律 TEACHER**：`qlsadmin`（园长/平台管理员）保留为教师（active）；无用户名的 `系统初始化` 按迁移规则导入为**停用**教师 |
| 至多一名有效超级管理员 | 由服务端强制：`POST /api/users` 只建教师；`PATCH /api/users/:id` **拒绝**把任何人升为管理员（`SUPERADMIN_TRANSFER_REQUIRED`）；`bootstrap-admin.mjs` 只在**没有**管理员时创建；换人只能走 `scripts/transfer-superadmin.mjs`（一降一升在同一事务、写两条审计、撤销双方会话） |
| 不删除历史 | 只改身份，**不删账号、不删审计**；`biz_probe_*` 的历史审计原样保留 |

> 上表里 `建议身份` 一列已按这条规则更新：只有 `TsinglanAdmin` 是 `ADMIN`，其余都是 `TEACHER`。

| 账号 | 姓名 | V1 角色 | 建议身份 | 开放目录 | 当前权限 | 状态 | 证据来源 |
|---|---|---|---|---|---|---|---|
| biz_probe_405561 | 全链路探针账号 405561 | visitor | TEACHER | **BLOCKED：待业务确认** | 0 条 | inactive | 生产快照 + V1 角色 |
| biz_probe_413492 | 全链路探针账号 413492 | visitor | TEACHER | **BLOCKED：待业务确认** | 0 条 | inactive | 生产快照 + V1 角色 |
| k-head01 | K主教01 | k_head | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| k-head02 | K主教02 | k_head | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| k-head03 | K主教03 | k_head | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| k-teacher01 | K教师01 | k_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| k-teacher02 | K教师02 | k_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| k-teacher03 | K教师03 | k_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| k-teacher04 | K教师04 | k_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| `v1-no-username-749e5d41` | 系统初始化 | principal | TEACHER | 无（**导入时即停用**，登不进去） | 0 条 | **inactive** | 生产快照 + 迁移规则（无用户名 → 停用占位账号） |
| pe-teacher01 | 体能教师01 | pe_specialist | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| pe-teacher02 | 体能教师02 | pe_specialist | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| pe-teacher03 | 体能教师03 | pe_specialist | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| pe-teacher04 | 体能教师04 | pe_specialist | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| prek-head01 | Pre-K主教01 | prek_head | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| prek-head02 | Pre-K主教02 | prek_head | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| prek-head03 | Pre-K主教03 | prek_head | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| prek-teacher01 | Pre-K教师01 | prek_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| prek-teacher02 | Pre-K教师02 | prek_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| prek-teacher03 | Pre-K教师03 | prek_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| prek-teacher04 | Pre-K教师04 | prek_assistant | TEACHER | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| qlsadmin | 园长/平台管理员 | principal | TEACHER（**不再因岗位名成为管理员**） | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + Stage 13B §2 规则 |
| qlsdirector | 教学主任/教研主管 | curriculum_director | TEACHER（不按岗位名提升；由业主确认后按需授权） | **BLOCKED：待业务确认** | 0 条 | active | 生产快照 + V1 角色 |
| TsinglanAdmin | 系统超级管理员 | super_admin | **ADMIN（唯一超级管理员，业主已确认）** | 全部 | 0 条 | active | 生产快照 + 业主确认（Stage 13B §2） |

## 待确认事项（BLOCKED）

1. **谁是管理员**：V1 角色名与 V2 身份**不自动等同**。上表按 V1 角色给出*建议*，
   每条 ADMIN 都必须由业主确认后才可初始化（禁止因为角色名相似就提权）。
2. **每位教师开放哪些目录**：无法从数据推断（V1 是角色制），必须由业务给出。
   未确认前一律标 BLOCKED，**不得**给所有教师开放所有目录。
3. **口令迁移**：V1 哈希为 `scrypt$16384$8$1…`（86 字符），V2 校验逻辑兼容；
   但能否真的登录必须在生产环境用**真实账号**验证一次，不得假设。
