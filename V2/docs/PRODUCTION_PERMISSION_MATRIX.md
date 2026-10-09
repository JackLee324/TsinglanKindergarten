# 生产账号与权限矩阵（Stage 12C §6.1）

> 数据来源：**V2 专用迁移文件** `v2-cutover-20261008.ndjson`（sha256 `b01c1fec…`）。
> 迁移**刻意不发授权**（V2 设计：权限只有 `user_permissions` 一个真相），
> 所以下表里当前权限一律是 0 —— 上线当天必须由管理员按下面的建议逐条确认后初始化。

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
| null | 系统初始化 | principal | ADMIN（**待人工确认**） | 全部（管理员） | 0 条 | active | 生产快照 + V1 角色 |
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
| qlsadmin | 园长/平台管理员 | principal | ADMIN（**待人工确认**） | 全部（管理员） | 0 条 | active | 生产快照 + V1 角色 |
| qlsdirector | 教学主任/教研主管 | curriculum_director | ADMIN（**待人工确认**） | 全部（管理员） | 0 条 | active | 生产快照 + V1 角色 |
| TsinglanAdmin | 系统超级管理员 | super_admin | ADMIN（**待人工确认**） | 全部（管理员） | 0 条 | active | 生产快照 + V1 角色 |

## 待确认事项（BLOCKED）

1. **谁是管理员**：V1 角色名与 V2 身份**不自动等同**。上表按 V1 角色给出*建议*，
   每条 ADMIN 都必须由业主确认后才可初始化（禁止因为角色名相似就提权）。
2. **每位教师开放哪些目录**：无法从数据推断（V1 是角色制），必须由业务给出。
   未确认前一律标 BLOCKED，**不得**给所有教师开放所有目录。
3. **口令迁移**：V1 哈希为 `scrypt$16384$8$1…`（86 字符），V2 校验逻辑兼容；
   但能否真的登录必须在生产环境用**真实账号**验证一次，不得假设。
