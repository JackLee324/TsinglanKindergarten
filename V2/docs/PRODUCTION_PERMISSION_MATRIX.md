# 生产账号与权限矩阵（Stage 12C §6.1；Stage 13B §2 + Stage 13C 更新）

> 数据来源：**V2 专用迁移文件** `v2-cutover-20261008.ndjson`（sha256 `b01c1fec…`）。
> 迁移**刻意不发授权**（V2 设计：权限只有 `user_permissions` 一个真相），
> 所以下表里当前权限一律是 0 —— 上线当天必须由管理员按下面的建议逐条确认后初始化。


## 0. 状态（三件事分开说，不要混成一句"待确认"）

```
超级管理员身份     : PASS      唯一账号 = TsinglanAdmin（业主 Stage 13B §2 已确认）
教师目录授权       : BLOCKED   24 个迁移账号当前 0 条授权；每位教师开放哪些目录**必须由业务给出**
生产账号登录       : NOT RUN   口令兼容性只能在真实生产环境用真实账号验证一次，不得假设
```

> ⚠️ **确认唯一管理员 ≠ 完成教师权限初始化。** 这两件事的进度不同，必须分开记。
> ⚠️ **不得为了让页面"看起来能用"就给所有教师开放全部目录** ——
> 那等于把 V1 的角色制换成"人人全站可见"，是权限的实质降级。

## 1. 超级管理员：已确认（PASS）

| 项 | 状态 | 证据 |
|---|---|---|
| 唯一超级管理员是 `TsinglanAdmin` | **PASS** | 业主 Stage 13B §2 明确确认；上表只有这一行是 `ADMIN` |
| 服务端强制唯一 | **PASS** | `POST /api/users` 只建教师；`PATCH /api/users/:id` 升管理员 → 400 `SUPERADMIN_TRANSFER_REQUIRED`；`bootstrap-admin.mjs` 只在没有管理员时创建；换人只走 `scripts/transfer-superadmin.mjs`（同一事务一降一升 + 两条审计 + 撤双方会话） |
| 第 13B 版实现已被测试盯住 | **PASS** | `tests/integration/account-privileges.test.mjs` **17 条**（含 Stage 13C 新增的"没给 `DATABASE_URL` 就退出、不动数据"与"输出脱敏"） |

> 这条**已经不需要再逐条确认**了 —— 它是本文件里唯一完成状态的身份决定。


## 2. 每位教师开放哪些目录：**BLOCKED（等业务给）**

| 事实 | 值 |
|---|---|
| 迁移账号总数 | **24** |
| 这 24 个账号在 V2 里的目录授权 | **0 条**（迁移刻意不发授权） |
| V1 导出里可推导授权的数据 | `subject_permissions` **0 行**、`account_scopes` **0 行**、`account_permission_overrides` **0 行** |
| 结论 | **没有任何可推导的数据**：V1 是角色制（`prek_head` / `k_assistant` / `pe_specialist` …），V2 是"权限 × 目录"的显式授权。映射是业务决策，不是数据搬运。 |

**决策材料（只读生成，不写库）**：
`node scripts/propose-directory-grants.mjs` 会从**已校验的迁移文件**里读 24 个账号，
和 69 个目录一起输出一张决策清单（`V2/.migration/production-grant-decision-sheet.{md,json}`），
每个账号一行、每个待定项标 `DECISION_REQUIRED`。业主在这张表上填写后，
再由管理员在界面上按目录勾选初始化。

**硬规则**：未确认前一律 BLOCKED；**不得**给所有教师开放所有目录，
也**不得**用 V1 角色名直接换算成"全班型全科目可见"。


## 3. 生产账号登录：**NOT RUN**

V1 哈希为 `scrypt$16384$8$1…`（86 字符），V2 校验逻辑兼容；
但能否真的登录，必须在**正式环境**用**真实账号**验证一次（至少一个 `TsinglanAdmin`
+ 一个普通教师），在演练库里登录成功**不算**通过。


## 4. 数据来源与隔离：**演练库不是迁移来源**（业主 Stage 13C §2）
两个环境的数据**必须分开看**，不能因为"演练通过"就把演练数据带进正式库：

| 数据来源 | 资源 | 账号 | 目录 | 文件记录 | 审计记录 |
|---|---|---|---|---|---|
| **正式迁移文件** `v2-cutover-20261008.ndjson`（sha256 `b01c1fec…`，Stage 12C 冻结） | **347** | **24** | **69** | **0** | **621** |
| 本机演练库（Stage 13B 验收用） | 354 | 26 | 69 | 4 | — |

差异**全部**来自演练环境自己的测试数据：
`349 → 347` 是排除两条已授权的 smoke 测试资源；`24 → 26` 是本轮验收新建的
`s13b_ui_teacher` / `s13b_read_teacher`（已停用）；`0 → 4` 是验收上传的 4 个文件。

**规则（写死，不靠记忆）**：
1. 正式切换**只**用经 SHA-256 校验的迁移文件（`prepare-v2-cutover-snapshot.mjs --check`），
   **不**从任何演练库导出、**不**做"演练库 → 正式库"的复制；
2. 演练库里的测试资源、测试账号、上传对象**一律不进正式环境**；
3. 正式切换维护窗口内**重新核验最终生产快照**（sha256 + 计数 + dangling = 0）后才导入。


## 5. 账号矩阵（24 个迁移账号，逐条）


### 5.1 唯一超级管理员的那一行
| 项 | 决定 |
|---|---|
| 唯一的超级管理员 | **`TsinglanAdmin`**（V1 里是 `super_admin`；业主已明确确认） |
| 迁移怎么给身份 | `--admin-usernames TsinglanAdmin` **显式点名**；`DEFAULT_ADMIN_ROLES` 为**空**，不按 V1 岗位名自动提升 |
| 其他 V1 管理员岗位（`principal`） | **一律 TEACHER**：`qlsadmin`（园长/平台管理员）保留为教师（active）；无用户名的 `系统初始化` 按迁移规则导入为**停用**教师 |
| 至多一名有效超级管理员 | 由服务端强制：`POST /api/users` 只建教师；`PATCH /api/users/:id` **拒绝**把任何人升为管理员（`SUPERADMIN_TRANSFER_REQUIRED`）；`bootstrap-admin.mjs` 只在**没有**管理员时创建；换人只能走 `scripts/transfer-superadmin.mjs`（一降一升在同一事务、写两条审计、撤销双方会话） |
| 不删除历史 | 只改身份，**不删账号、不删审计**；`biz_probe_*` 的历史审计原样保留 |


### 5.2 全部 24 个账号
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


### 5.3 正式环境的目录清单（69 个，供填「开放目录」时对照）

> 由 `node scripts/propose-directory-grants.mjs` 从**冻结的迁移文件**（sha256 `b01c1fec…`）生成；
> `V2 路径`就是正式环境侧边栏/「权限管理」里看到的层级。**本表不是授权**，只是编号对照。

| # | V2 路径 | 中文名 | 英文名 | 类型 | V1 code |
|---|---|---|---|---|---|
| 1 | `edu` | 教育教学 | Teaching & Curriculum | root | `root:edu` |
| 2 | `edu/k` | K | K | program | `k` |
| 3 | `edu/k/chinese` | 中文教学 | Chinese | subject | `k:chinese` |
| 4 | `edu/k/chinese/arts` | 美育 | Aesthetic Education | sub_subject | `k:chinese:arts` |
| 5 | `edu/k/chinese/arts/assessment` | 考核评估 | Assessment | folder | `k:chinese:arts_assessment` |
| 6 | `edu/k/chinese/arts/lesson` | 教学详案 | Lesson Plans | folder | `k:chinese:arts_lesson` |
| 7 | `edu/k/chinese/arts/outline` | 课程大纲 | Curriculum Outline | folder | `k:chinese:arts_outline` |
| 8 | `edu/k/chinese/arts/resources` | 教学资源 | Teaching Resources | folder | `k:chinese:arts_resource` |
| 9 | `edu/k/chinese/poetry` | 古诗 | Classical Poetry | sub_subject | `k:chinese:poetry` |
| 10 | `edu/k/chinese/poetry/assessment` | 考核评估 | Assessment | folder | `k:chinese:poetry_assessment` |
| 11 | `edu/k/chinese/poetry/lesson` | 教学详案 | Lesson Plans | folder | `k:chinese:poetry_lesson` |
| 12 | `edu/k/chinese/poetry/outline` | 课程大纲 | Curriculum Outline | folder | `k:chinese:poetry_outline` |
| 13 | `edu/k/chinese/poetry/resources` | 教学资源 | Teaching Resources | folder | `k:chinese:poetry_resource` |
| 14 | `edu/k/chinese/reading` | 绘本阅读 | Picture Book Reading | sub_subject | `k:chinese:reading` |
| 15 | `edu/k/chinese/reading/assessment` | 考核评估 | Assessment | folder | `k:chinese:reading_assessment` |
| 16 | `edu/k/chinese/reading/lesson` | 教学详案 | Lesson Plans | folder | `k:chinese:reading_lesson` |
| 17 | `edu/k/chinese/reading/outline` | 课程大纲 | Curriculum Outline | folder | `k:chinese:reading_outline` |
| 18 | `edu/k/chinese/reading/resources` | 教学资源 | Teaching Resources | folder | `k:chinese:reading_resource` |
| 19 | `edu/k/chinese/stem` | STEM | STEM | sub_subject | `k:chinese:stem` |
| 20 | `edu/k/chinese/stem/assessment` | 考核评估 | Assessment | folder | `k:chinese:stem_assessment` |
| 21 | `edu/k/chinese/stem/lesson` | 教学详案 | Lesson Plans | folder | `k:chinese:stem_lesson` |
| 22 | `edu/k/chinese/stem/outline` | 课程大纲 | Curriculum Outline | folder | `k:chinese:stem_outline` |
| 23 | `edu/k/chinese/stem/resources` | 教学资源 | Teaching Resources | folder | `k:chinese:stem_resource` |
| 24 | `edu/k/english` | 英文教学 | English | subject | `k:english` |
| 25 | `edu/k/english/assessment` | 考核评估 | Assessment | folder | `k:english_assessment` |
| 26 | `edu/k/english/lesson` | 教学详案 | Lesson Plans | folder | `k:english_lesson` |
| 27 | `edu/k/english/outline` | 课程大纲 | Curriculum Outline | folder | `k:english_outline` |
| 28 | `edu/k/english/resources` | 教学资源 | Teaching Resources | folder | `k:english_resource` |
| 29 | `edu/k/pe` | 体能 | Physical Education | subject | `k:pe` |
| 30 | `edu/k/pe/assessment` | 考核评估 | Assessment | folder | `k:pe_assessment` |
| 31 | `edu/k/pe/lesson` | 教学详案 | Lesson Plans | folder | `k:pe_lesson` |
| 32 | `edu/k/pe/outline` | 课程大纲 | Curriculum Outline | folder | `k:pe_outline` |
| 33 | `edu/k/pe/resources` | 教学资源 | Teaching Resources | folder | `k:pe_resource` |
| 34 | `edu/prek` | Pre-K | Pre-K | program | `prek` |
| 35 | `edu/prek/english` | 英文 | English | subject | `prek:english` |
| 36 | `edu/prek/english/assessment` | 考核评估 | Assessment | folder | `prek:english_assessment` |
| 37 | `edu/prek/english/lesson` | 教学详案 | Lesson Plans | folder | `prek:english_lesson` |
| 38 | `edu/prek/english/outline` | 课程大纲 | Curriculum Outline | folder | `prek:english_outline` |
| 39 | `edu/prek/english/resources` | 教学资源 | Teaching Resources | folder | `prek:english_resource` |
| 40 | `edu/prek/montessori` | 蒙特梭利 | Montessori | subject | `prek:montessori` |
| 41 | `edu/prek/montessori/assessment` | 考核评估 | Assessment | folder | `prek:montessori_assessment` |
| 42 | `edu/prek/montessori/lesson` | 教学详案 | Lesson Plans | folder | `prek:montessori_lesson` |
| 43 | `edu/prek/montessori/outline` | 课程大纲 | Curriculum Outline | folder | `prek:montessori_outline` |
| 44 | `edu/prek/montessori/resources` | 教学资源 | Teaching Resources | folder | `prek:montessori_resource` |
| 45 | `edu/prek/pe` | 体能 | Physical Education | subject | `prek:pe` |
| 46 | `edu/prek/pe/assessment` | 考核评估 | Assessment | folder | `prek:pe_assessment` |
| 47 | `edu/prek/pe/lesson` | 教学详案 | Lesson Plans | folder | `prek:pe_lesson` |
| 48 | `edu/prek/pe/outline` | 课程大纲 | Curriculum Outline | folder | `prek:pe_outline` |
| 49 | `edu/prek/pe/resources` | 教学资源 | Teaching Resources | folder | `prek:pe_resource` |
| 50 | `edu/prek/virtue` | 美德 | Virtue | subject | `prek:virtue` |
| 51 | `edu/prek/virtue/assessment` | 考核评估 | Assessment | folder | `prek:virtue_assessment` |
| 52 | `edu/prek/virtue/lesson` | 教学详案 | Lesson Plans | folder | `prek:virtue_lesson` |
| 53 | `edu/prek/virtue/outline` | 课程大纲 | Curriculum Outline | folder | `prek:virtue_outline` |
| 54 | `edu/prek/virtue/resources` | 教学资源 | Teaching Resources | folder | `prek:virtue_resource` |
| 55 | `growth` | 教师成长 | Teacher Growth | root | `root:growth` |
| 56 | `growth/l1` | L1 基础规范 | L1 Foundations | growth_level | `growth:l1` |
| 57 | `growth/l1/ethics` | 职业道德规范 | Professional Ethics | growth_node | `growth:l1:ethics` |
| 58 | `growth/l1/ethics/conduct` | 师风师德建设 | Teacher Conduct | growth_node | `growth:l1:ethics:conduct` |
| 59 | `growth/l1/know` | 专业知识 | Professional Knowledge | growth_node | `growth:l1:know` |
| 60 | `growth/l1/safety` | 安全施教规范 | Safe Teaching | growth_node | `growth:l1:safety` |
| 61 | `growth/l1/safety/plan` | 应急预案 | Emergency Plans | growth_node | `growth:l1:safety:plan` |
| 62 | `growth/l1/safety/plan/disease` | 传染病识别与防治 | Infectious Disease Prevention | growth_node | `growth:l1:safety:plan:disease` |
| 63 | `growth/l1/safety/plan/injury` | 意外伤害预防与处置 | Injury Prevention & Response | growth_node | `growth:l1:safety:plan:injury` |
| 64 | `growth/l1/skill` | 专业技能 | Professional Skills | growth_node | `growth:l1:skill` |
| 65 | `growth/l1/skill/connect` | 与幼儿建立连接 | Building Connections | growth_node | `growth:l1:skill:connect` |
| 66 | `growth/l1/skill/daily` | 一日生活规范 | Daily Routine Standards | growth_node | `growth:l1:skill:daily` |
| 67 | `growth/l1/skill/play` | 游戏化教学 | Play-based Teaching | growth_node | `growth:l1:skill:play` |
| 68 | `growth/l2` | L2 独立胜任 | L2 Independent | growth_level | `growth:l2` |
| 69 | `growth/l3` | L3 卓越引领 | L3 Leading | growth_level | `growth:l3` |

账号与目录都齐了之后：业主在 §6 的决策表上填写 → 管理员在 `/admin/permissions` 初始化 →
用真实账号登录验证（§3）→ 才把「教师目录授权」从 `BLOCKED` 改成 `PASS`。
## 6. 决策与执行流程（谁在哪个界面做什么）

1. **业主**在 `V2/.migration/production-grant-decision-sheet.md`（由
   `node scripts/propose-directory-grants.mjs` 只读生成）上填写每个账号要开放哪些目录；
2. **管理员**在正式环境的「权限管理」（`/admin/permissions`）里按目录勾选初始化 —— 
   那是唯一会写 `user_permissions` 的地方；
3. 初始化完成后，用**真实账号**各登录一次（§3），并把结果回填到本文件；
4. 全部完成、且 §4 的迁移来源核验通过之后，才允许进入域名切换。

> 本文件的状态词只用 `PASS / BLOCKED / NOT RUN`：
> 只有"本次实际执行且有证据"才写 `PASS`；没跑过的**一律不计为通过**。
