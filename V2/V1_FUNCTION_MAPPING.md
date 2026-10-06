# V1 → V2 功能对照表

> 本文件是**阶段 0（只读分析 V1）**的产出，也是 V2 的需求边界。
> 每一行都必须回答："V1 现在到底有没有这个功能？V2 拿它怎么办？为什么？"
>
> **事实来源**：本文的"V1 现状"一列全部来自对
> `../qls-kindergarten-resource-platform-v1.3.0` 的**实际盘点**（路由表、66 个接口、
> 13 张表、16 个前端页面、12 个迁移文件），不是凭印象写的。
> 凡我**没有**在代码里找到证据的，一律标注为"不存在"，不写成"可能"。

## 处置分类的五个取值

| 分类 | 含义 | 判定标准 |
|---|---|---|
| **KEEP** | 原样保留（含视觉） | 功能正确、无业务缺陷，重写没有收益 |
| **REBUILD** | 重新实现 | 业务价值真实存在，但 V1 的实现方式本身就是问题来源 |
| **SIMPLIFY** | 简化后保留 | 能力有用，但 V1 把它做成了多层概念，用户/开发者都要理解多余的东西 |
| **REMOVE** | 删除，不进 V2 | 无业务价值 / 死代码 / 兼容层 / V1 才需要的补丁 |
| **FUTURE** | 明确延后，V2 第一阶段不做 | 真实需求但非核心，先留出扩展位，不提前实现 |

---

## 1. 登录与会话

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 1.1 | 用户名 + 密码登录 | `POST /api/auth/login`（auth.controller.ts:134），scrypt hash | **REBUILD** | 业务模型对，但要**去掉**登录后的多步跳转（V1 有 MFA challenge / 强制改密 / 未授权页三种分支） |
| 1.2 | 企业微信 OAuth | **半成品**：`teachers.wecom_user_id`（含唯一索引）与 `audit_logs.wecom_user_id` 两列存在，`auth.service.ts` 有一个 `wecomUserId?` 字段，`AGENTS.md` 也把它写成卖点；但 `auth.controller.ts` 里**只有** `POST login`（用户名+口令）与 6 个 MFA 端点，**没有任何企业微信登录/OAuth 端点** | **REMOVE** | 业务从未接入，只留下"看起来支持"的列与文档。V2 不保留"预留却不存在"的登录方式（真需要时 `ADD COLUMN` 是安全操作） |
| 1.3 | Session（HttpOnly Cookie） | `sessions` 表 + cookie session | **KEEP** | 正确且必要。V2 沿用 HttpOnly + SameSite + Secure |
| 1.4 | CSRF | `suda-csrf-token` cookie + `x-suda-csrf-token` 头 | **KEEP** | 必要。保留同一机制，但**不让前端开发者感知**（统一封装在 api client 里） |
| 1.5 | 修改密码 | `POST /api/auth/change-password`（:356）、页面 `ChangePassword` | **SIMPLIFY** | 保留。去掉"密码历史/复杂度策略"这类 V1 也没真正用起来的部分 |
| 1.6 | 管理员重置他人密码 | `POST /api/auth/reset-password`（:448） | **SIMPLIFY** | 保留为"管理员设初始密码"，不暴露一次性 token 流程 |
| 1.7 | MFA（TOTP + 恢复码 + challenge） | 3 张表（`teacher_mfa` / `mfa_recovery_codes` / `mfa_challenges`）+ 7 个接口 + `mfa-web` 17 条浏览器断言 | **FUTURE** | 真实存在且实现完整，但业主明确要求"教师日常工作不要增加验证码/恢复码/challenge"。V2 第一阶段**不实现**，且在数据模型上预留 `users.mfa_*` 的位置。**注意：这是"延后"，不是"不需要"** |
| 1.8 | 退出登录 | `POST /api/auth/logout`（:503） | **KEEP** | |
| 1.9 | 未授权页 / 404 页 | `Unauthorized` / `NotFound` 页面 + `/unauthorized` 路由 | **KEEP** | |
| 1.10 | 登录 IP 速率限制 | `LOGIN_IP_RATE_LIMIT_MAX`（门禁必须调到 100000 才能跑并发套件） | **KEEP** | 保留，但 V2 的门禁必须**默认值**下也能跑（V1 这个坑让门禁与生产配置永久分叉） |

## 2. 账号与权限

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 2.1 | 教师账号列表/详情 | `GET /api/teachers`、`/api/teachers/:id` | **REBUILD** | 保留能力，界面简化成"姓名/用户名/密码/权限"一屏 |
| 2.2 | 新建/编辑/停用账号 | `POST`/`PATCH`/`DELETE /api/teachers/:id` | **SIMPLIFY** | V1 的表单包含 7 种角色勾选 + 班型 + 科目 + 数据范围；业主明确要求"只填姓名/用户名/密码/权限" |
| 2.3 | **角色数组**（`teachers.roles`，7 种角色） | `teachers.roles` 列 + `shared/rbac.ts` 的 `ROLE_PERMISSIONS`/`roleDefaults` | **REMOVE** | 这是"多套权限真相"的根源之一。V2 只有 `ADMIN` / `TEACHER` 两种身份，其余全部表达为**权限 + 目录范围** |
| 2.4 | `subject_permissions` 表（教师-班型-科目） | 表存在，`roleSubjectScope` 依赖它 | **REMOVE** | 与 2.3、2.5、2.6 四套模型重叠。V2 统一成 `user_permissions` |
| 2.5 | `account_permission_overrides`（按账号 grant/deny） | 表 + `POST /api/teachers/:id/permission-overrides/{grant,deny}` + `DELETE .../:permission` | **REMOVE** | "grant/deny/override"三层概念正是业主点名要删的复杂性。V2 只有"授予（permission + 目录）"，没有否定规则 |
| 2.6 | `account_scopes`（ALL/OWN/PROGRAM/SUBJECT 四种形态） | 表 + `GET/POST /api/teachers/:id/scopes` + 权限面板的数据范围编辑器 | **SIMPLIFY → REMOVE 该表** | 四种形态想表达的其实是"对哪些目录"，而目录本身就是树。V2 用 `user_permissions.directory_id`（NULL = 全部；否则含子树）**一个字段**覆盖全部四种情况 |
| 2.7 | 生效权限查看面板 | `GET /api/teachers/:id/effective-permissions` + `EffectivePermissionsPanel` | **SIMPLIFY** | 保留"我到底能做什么"的可解释性，但只展示最终结果，不展示 8 层推导过程 |
| 2.8 | 幽灵权限检测 | `tests/ghost-permissions.test.mjs`（"定义了 permission 但没有业务"） | **KEEP** | 把这条测试**原样带进 V2**：权限目录里的每一项都必须被真实接口引用 |
| 2.9 | 权限即时生效 | `teachers.permissions_version` 自增 → 旧会话按版本号失效 | **REBUILD（换个机制）** | 效果必须保留（改完立刻生效），但**业主明确不要 `permission version` 这个概念**。V2 改为"权限变更 → 撤销该用户全部会话"，语义更直白，且不需要在账号表上多一列 |
| 2.10 | 管理员绕过权限 | `isPlatformAdmin` / `hasAnyRole(super_admin)` 通配 | **SIMPLIFY** | V2 里 `role === 'ADMIN'` 是**唯一**一处绕过，单点、可审计、有测试。不允许出现第二处 |
| 2.11 | `super_admin` 第三个平台角色 | `PLATFORM_ADMIN_ROLES` | **REMOVE** | V2 只有 ADMIN。平台级"超级管理员"是 V1 为部署引导引入的，V2 用一次性 bootstrap 环境变量替代 |
| 2.12 | 数据库层 RLS（`anon_` / `authenticated_` 角色 + FORCE RLS） | 迁移 0004/0005，`withRbacWriteContext` | **FUTURE** | V1 的 RLS 需要"应用层授权 + 数据库角色切换"两个真相同时正确，实测出现过 `resource.purge` 影响 0 行而审计声称成功。V2 第一阶段**只做应用层强制**（单点、可测），RLS 作为后续纵深防御，**不假装已经有** |

## 3. 目录（V2 的核心）

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 3.1 | 可编辑目录树 | 迁移 0009/0010 + `directories` 表 + `GET /api/directories/{tree,node}` | **REBUILD** | 能力方向对，但 V1 的树是**为课程场景定制的**（`program`/`subject` 列、`isSystem` 标记）。V2 做成通用树，见 `DIRECTORY_MODEL.md` |
| 3.2 | 改中文名 | `PATCH /api/directories/node/:code` | **KEEP** | 行为正确（改名后五处同步已浏览器级验证） |
| 3.3 | 改英文名 / 改说明 | 同上（`name_en` / `description`） | **KEEP** | |
| 3.4 | 新建资料夹 | `POST /api/directories/folder` | **REBUILD** | V1 只能"在允许自建的资料夹下建子文件夹"；V2 允许建**任意层级**（含新一级栏目） |
| 3.5 | **新增一级栏目（如"活动""班级""校历"）** | ❌ **不存在**。V1 的一级栏目是迁移里写死的数据，服务端没有"新增科目型/栏目型节点"的接口 | **REBUILD（V2 必须新增）** | 这是业主 V2 需求的核心：`教师平台 → 教育教学 / 教师成长 / 活动 / 班级 / 校历`，管理员点一下就出现，**不改代码** |
| 3.6 | 排序（↑↓ / 拖拽） | ❌ **不存在**。目录没有 `sort_order`，`shared/api.interface.ts` 也没有任何排序参数 | **REBUILD（V2 必须新增）** | 业主 §41 明确要求 |
| 3.7 | 启用 / 停用节点 | 部分存在：`GET /api/directories/tree?includeDisabled=true`、管理页有停用 | **KEEP** | 保留语义；停用节点及其子树对教师不可见 |
| 3.8 | 删除节点保护 | 服务层有三条规则（父节点须允许自建 / 系统节点不可改删 / 非空不可删） | **SIMPLIFY** | V2 去掉"系统节点不可改删"（业主 §12 已明确：正式目录也必须能改名），只保留"有子节点或有资源 → 拒绝删除，绝不级联" |
| 3.9 | 自建文件夹开关 | `allowCustomFolders`（V1 是 code 后缀 + 服务层规则推导） | **SIMPLIFY** | V2 变成节点上一个显式布尔列，行为完全由数据决定 |
| 3.10 | 目录 URL（`code` → 路径） | `codeToPath()`：`prek:virtue` → `/directory/prek/virtue`；兼容 6 条旧地址 | **REBUILD** | V1 的 `code` 把"路径"和"稳定标识"混在一个字段里，改名虽不动 code，但 code 本身不可编辑也不可排序。V2 拆成不可变 `slug` + 可编辑展示名，见 `DIRECTORY_MODEL.md` §4 |
| 3.11 | 浏览视图 vs 管理视图 | V1 已分离（`/directory/*` 浏览，`/directory/manage` 管理），`canManage` 决定是否出现"管理此目录" | **KEEP** | 这个设计是对的，V2 沿用并把权限判定改成统一的 permission code |
| 3.12 | 旧地址兼容（`/prek`、`/k`、`/virtue`…） | 7 个旧页面已删除，改由 `LegacyDirectoryRedirect` 按 code 反解重定向 | **REMOVE** | V1 的历史包袱。V2 **不产生**这类地址，因此不需要兼容层（V1 的旧地址由 V1 自己继续服务） |

## 4. 资源

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 4.1 | 资源 CRUD | `GET/POST/PATCH/DELETE /api/resources` | **REBUILD** | 保留能力；去掉 `program`/`subject`/`subSubject`/`folderType` 四个冗余分类字段 |
| 4.2 | **legacy `folder_type`（6 值资料夹）** | `resources.folder_type` 列 + 上传页 6 值下拉 → 已在收口时从上传页移除，改由目录 code 反缀推导（`legacy-folder-mapping.ts`） | **REMOVE** | V2 的库里**根本没有这一列**。六个历史分类只在 `import-v1.mjs` 的映射表里出现一次，运行期不存在 |
| 4.3 | 资源必须挂在目录上 | migration 0012 加了 `resources.directory_id`，`CreateResourceDto.directoryId` 必填 | **KEEP** | 方向正确，V2 把它变成**唯一**归属方式 |
| 4.4 | 资源详情 | `ResourceDetailDialog`（标题/状态/版本/上传者/时间/目录/文件） | **REBUILD** | 保留信息，但 V1 的详情里**没有预览**（见 6.4） |
| 4.5 | 我的资源（全部/草稿/待审/已发布/已退回/回收站） | `MyResourcesPage` + `GET /api/resources/mine` | **REBUILD** | 保留；V1 缺"已撤回"这一栏（状态机里有 recalled 但页面没过滤项） |
| 4.6 | 回收站 / 恢复 / 永久删除 | `GET /api/resources/recycle-bin`、`POST /:id/restore`、`POST /:id/purge`、`RecycleBinPage`、`tests/auth-reset-password`…以及 `resource-purge` 22 条断言 | **KEEP** | 行为正确，V2 沿用（软删除 + 到期清理 + 硬删需单独权限） |
| 4.7 | 资源版本 | 迁移 0011 + `resource_versions` 表 + `GET /:id/versions` + `tests/resource-versions` | **SIMPLIFY** | 保留"已发布不可直接覆盖"，但 V2 第一阶段不做完整版本树，只做"编辑已发布资源 → 生成新版本" |
| 4.8 | 审核历史 | `GET /api/resources/:id/review-history` + `review_records` 表 | **KEEP** | |
| 4.9 | 资源列表分页 | `pageSize` / `total` / `page` 在 `shared/api.interface.ts` | **REBUILD** | V1 有分页，但业主点名的缺陷是"只显示 50 条就结束"。V2 采用**游标/加载更多 + 显式总数**，并在浏览器测试里断言"超过一页时仍能看到更多" |
| 4.10 | **全平台搜索** | ❌ **不存在**。`resources` 列表与 `MyResources` 都没有 `keyword`/`search` 参数 | **REBUILD（V2 必须新增）** | 业主 §35 明确要求（标题/描述/文件名/目录名） |
| 4.11 | 资源列表排序 | ❌ **不存在** | **REBUILD（V2 必须新增）** | 业主 §72 列出了"排序"，V2 至少支持按更新时间/标题 |
| 4.12 | storybook 封面（`/:id/storybook-cover/:index`） | 接口存在，`resource-card.tsx` 引用 `StorybookCover` 组件 | **REMOVE** | 业主从未要求；是 V1 的装饰性遗留，且它让"资源"看起来有封面而实际没有 |
| 4.13 | 仪表盘统计 | `GET /api/dashboard/{stats,recent}` + `HomePage` | **SIMPLIFY** | 保留一个极简首页（最近资源 + 我的待办），不做图表仪表盘 |
| 4.14 | 图表（echarts / recharts） | 依赖里有 `echarts`、`echarts-for-react`、`recharts` | **REMOVE** | 与 4.13 同一决定：V2 不做仪表盘，因此不需要图表库（约 3 个依赖） |

## 5. 上传

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 5.1 | 真实文件上传（签名 URL + 浏览器 PUT） | `POST /:id/upload-url` + `POST /:id/file` 登记；`storage-sigv4` 22 条 + `upload-web` 13 条 | **REBUILD** | 链路是对的，V2 重写为"申请 → PUT → **服务端 HEAD 校验** → 登记"三步，并强制校验 sha256 / magic bytes |
| 5.2 | 上传时选班型 + 科目 + 资料夹 + 目录 | V1 收口前有 4 个下拉；收口后仍有「班型」+「科目」+「所属目录」三个 | **REMOVE** | 业主 §16 的原话："教师不需要再次选择班型/科目/资料夹/目录"。V2 **从目录页进入上传**，这三个值**从所在目录推导**，界面上一个都不出现 |
| 5.3 | 上传后"不知道文件去哪了" | V1 保存后跳回列表，不显示所属目录 | **REBUILD** | V2 上传成功后**必须**显示：文件名 + 所属目录完整路径 + 上传状态，且刷新后仍能在该目录看到 |
| 5.4 | 文件存在性校验（`hasFile`） | 迁移 0008 + `tests/file-security` | **KEEP** | V1 已经因为"声称有文件但对象不存在"吃过一次假成功，V2 直接内建 |
| 5.5 | 多文件 / 资源 | `resources` 表把文件字段内联（`file_name`/`file_size`/`file_type`） | **REBUILD** | V2 拆出 `resource_files`（0..n），支持一个资源多个文件（教案 pdf + 课件 pptx） |
| 5.6 | 上传限流 / body 限制 | 1mb body limit（启动日志）、文件类型白名单 | **KEEP** | 保留；V2 明确写进 `docs/STORAGE.md` |

## 6. 文件预览与下载

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 6.1 | 下载 | `GET /api/resources/:id/download`（302 到签名 URL）+ `resource-card.tsx` 的下载按钮 | **SIMPLIFY** | 保留。V2 统一到一个 `/api/resources/:id/download`，前端不需要理解 token |
| 6.2 | 下载权限 | `@RequirePermission('resource.download')` + `storage.download`（两个权限 AND） | **SIMPLIFY** | V2 保留**一个** `resource.download` 业务权限（业主最终清单里有「下载资源」这一勾选框），去掉第二个 `storage.download` —— 存储是**实现细节**，不该成为业务权限。审计上也只需记一次下载 |
| 6.3 | 短期限签名 URL | `DOWNLOAD_TOKEN_SECRET`（必须 32 字节 base64）、`DOWNLOAD_TOKEN_TTL_SECONDS` | **KEEP** | 机制正确；V2 的签名 URL **只出现在服务端**，前端永远看不到 bucket/key |
| 6.4 | **文件预览** | ❌ **完全不存在**。`client/src` 与 `server/` 里搜不到任何"预览"实现；`ResourceDetailDialog` 里没有 iframe/img/embed | **REBUILD（V2 必须新增）** | 业主 §19 明确要求。V2 落地"PDF/图片/TXT 内嵌预览 + 其他类型明确提示下载"，**不允许点了没反应** |
| 6.5 | 预览安全 | — | **REBUILD** | 预览与下载走同一套授权；不存在公开的 `/uploads/xxx.pdf` 可猜路径 |
| 6.6 | 封面资源（课程封面 jpg） | `server/modules/health/cover-assets.ts`（34 个 jpg）+ `tests/cover-asset-root`、`evidence/deplatforming` | **SIMPLIFY** | V1 为"封面在 dist 里找不到"专门写了一层 cwd 无关的解析。V2 只需要一个静态目录 + 一条测试，不做平台适配 |

## 7. 审核

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 7.1 | 提交审核 | `POST /api/resources/:id/submit-review` | **REBUILD** | 保留；V2 用一个显式状态机模块，并把"提交后状态没变"钉成测试（V1 出现过假成功） |
| 7.2 | 待审列表 | `GET /api/review/pending` + `ReviewPage` | **REBUILD** | |
| 7.3 | 通过 / 退回 | `POST /api/resources/:id/review`（`review_records` 落库） | **REBUILD** | 退回**必须**带原因，且教师端能看到原因（业主业务流程 5） |
| 7.4 | 撤回（published → recalled） | 状态枚举里有 `recalled`，但**没有独立接口**（靠通用 PATCH 改状态） | **REBUILD** | 业主 §23 要求显式 `POST /:id/recall`，并且"撤回"不能误伤 published 资源（V1 缺陷清单第 14 条） |
| 7.5 | 审核权限与查看权限分离 | `@RequirePermission('review.view')` / `resource.review` | **KEEP** | 分离是对的，V2 保留为 `resource.review`（看）与 `resource.publish`（发） |
| 7.6 | 通知（提交/退回/发布） | ❌ **不存在** | **FUTURE** | 业主 §37 明确第一阶段不做。V2 只做页面内状态提醒，数据层预留 `audit_logs` 足够回溯 |

## 8. 审计

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 8.1 | 审计日志写入 | `audit_logs` 表，登录/拒绝/下载/上传/编辑/权限变更/导出均落库 | **KEEP** | |
| 8.2 | 审计查询界面 | `GET /api/audit/logs` + `AuditLogPage` | **SIMPLIFY** | 保留最简查询（时间/人/动作/结果），去掉 V1 的 `AuditAction` 联合类型与界面标签必须手工同步的耦合（V1 曾因新增 `data_export` 未加标签导致类型检查红） |
| 8.3 | 审计导出 | `GET /api/audit/logs/export` | **SIMPLIFY** | 保留，并对导出本身写审计 |
| 8.4 | 审计不记录敏感值 | V1 已在设计上排除密码/token | **KEEP** | V1 曾出现"运维接口回显密钥"的事故，V2 把"响应体不得包含密钥"做成测试 |

## 9. 备份与数据导出

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 9.1 | 逻辑导出接口 | `POST /api/admin/data-export`（**无界面**，RUNBOOK §10 标记 INTERNAL-ONLY） | **SIMPLIFY** | V2 保留为脚本（`scripts/export-*.mjs`），**不做**应用内接口——它需要的权限高于普通管理员 |
| 9.2 | 备份/恢复演练 | `scripts/backup-rehearse.mjs`（明确说明它不是 `pg_dump`/`pg_restore`） | **REBUILD** | 业主 §68 要求"真实的每日备份 + restore 文档"。V2 提供 `pg_dump` 脚本 + 对象存储同步 + `docs/DEPLOYMENT.md` 的恢复步骤，并**在测试库上真跑一次恢复** |
| 9.3 | 灾难恢复文档 | `DISASTER_RECOVERY.md` | **SIMPLIFY** | 内容并入 V2 的 `docs/DEPLOYMENT.md`，不再单独一份 |

## 10. 国际化 / 前端 / 工程

| # | 功能 | V1 现状（证据） | 处置 | 理由 |
|---|---|---|---|---|
| 10.1 | 中英双语 | `client/src/i18n/translations.ts`（`zh-CN` / `en-US`） | **KEEP** | 保留，并保留"改名后英文界面也要同步"（V1 的 `name_en` 已支持） |
| 10.2 | 视觉风格（柔和紫、卡片、圆角、留白） | `AGENTS.md` 的完整设计规范 + `client/src/components/ui/*`（63 个组件） | **KEEP（作为视觉基准）** | 业主明确："不要重新发明视觉风格"。V2 复用同一套设计 token 与组件写法 |
| 10.3 | 组件库体积与"双组件体系" | `client/src/components/ui/*` 共 **63** 个组件（shadcn/ui 风格）；**同时** `antd ^6.6.2` 在 `dependencies` 里且被 **6 个文件**真实 import。另有 6 个**完全无人 import** 的依赖：`echarts`、`echarts-for-react`、`gsap`、`framer-motion`、`crypto-js`、`lodash`（逐个 grep 验证为 0 次引用） | **SIMPLIFY** | 两个设计语言同时存在于一个产品里，是"每加一个页面都要先决定用哪套"的税。V2 只留 shadcn/ui（视觉基准），并删除 0 引用的依赖。**注意：antd 不是"未使用"，是"与 shadcn/ui 并存"** —— 这点必须说准，否则会误判工作量 |
| 10.4 | 全局状态管理 | 无（用的是 react-query + context） | **KEEP** | 决定正确。V2 用 TanStack Query + 少量 context，**不引入 Zustand/Redux** |
| 10.5 | 前端硬编码课程数组 | 7 个旧页面各自持有一份，已在收口时删除并由 `tests/no-legacy-directory-truth.test.mjs` 钉住 | **KEEP（继承这条约束）** | V2 从第一行代码起就禁止；该测试的等价物在 V2 建立 |
| 10.6 | 死代码：`ExamplePage`、`use-example.ts`、`client/src/api/curriculum.ts` | 三个文件都还在；`curriculumApi` **无人引用**（`/api/curriculum/{structure,folders,roles}` 是唯一消费者） | **REMOVE** | V1 的平台脚手架残留。V2 不带 |
| 10.7 | `/api/hello/test` 探活接口 | `hello.controller.ts` | **REMOVE** | 用 `/api/health` 取代 |
| 10.8 | `/api/curriculum/*` 三个接口 | `curriculum.controller.ts` | **REMOVE** | 死接口（10.6 已证无人调用） |
| 10.9 | 平台 runtime（`@lark-apaas/*`） | **已不存在于 `package.json`**；仅在 `tsconfig.node.json` 与 `stylelint.config.mjs` 的注释里提到"该预设包已删除" | **KEEP（已满足）** | 业主 §4 的要求 V1 其实已经达成。V2 直接不引入即可。**不要把它写成"V1 的重大缺陷"** |
| 10.10 | 21 份 Markdown 文档 | 见 V1 根目录 | **SIMPLIFY** | V2 只保留 11 份**活的**文档（`README` + `docs/*`），且每份都必须与代码一致 |
| 10.11 | 迁移校验（checksum） | `scripts/migrate.mjs verify` + `migrate:verify` 门禁 | **KEEP** | 机制好，V2 沿用（已应用的迁移永不修改） |
| 10.12 | 单一门禁入口 | `scripts/verify-all.sh`（323 单测 + 737 浏览器/HTTP 断言 + 残留核对 + 咨询锁） | **KEEP** | 这是 V1 最值得继承的工程资产。V2 沿用同一形状，但**套件数量必须下降**（接口从 66 降到 ~30） |

---

## 附：V1 现有目录树 与 PDF 的逐项比对（**好消息**）

我直接查了 V1 测试库的 `directories` 表（69 个节点），逐行打印了完整路径。
结论是：**V1 数据库里的目录树已经和 PDF 一致**，不是"需要重新设计"的状态。

| PDF 要求 | V1 数据库实际（`code`） | 结论 |
|---|---|---|
| 教育教学（一级） | `root:edu` | ✅ 一致 |
| 教师成长（一级） | `root:growth` | ✅ 一致 |
| Pre-K → 美德 | `prek` → `prek:virtue` | ✅ |
| Pre-K → 蒙台梭利 | `prek:montessori` | ✅ |
| Pre-K → 体能 | `prek:pe` | ✅ |
| **Pre-K → 英文** | `prek:english` | ✅ **V1 也有**（业主特别指出 PDF 里有，确认一致） |
| K → 中文教学 → 绘本阅读 / 古诗 / STEM / 美育 | `k:chinese:{reading,poetry,stem,arts}` | ✅ **四个子科目逐字一致，含"美育"** |
| K → 英文教学 | `k:english` | ✅ |
| K → 体能 | `k:pe` | ✅ |
| 每个末级科目下四类资料夹 | `*_outline` / `*_lesson` / `*_resource` / `*_assessment` <br>= 课程大纲 / 教学详案 / 教学资源 / 考核评估 | ✅ **逐字一致** |
| 教师成长 L1/L2/L3 | `growth:l1` 基础规范 / `growth:l2` 独立胜任 / `growth:l3` 卓越引领 | ✅ |
| L1 → 职业道德规范 / 安全施教规范 / 专业知识 / 专业技能 | `growth:l1:{ethics,safety,know,skill}` | ✅ |
| 安全施教规范 → 应急预案 → 传染病识别与防治 / 意外伤害预防与处置 | `growth:l1:safety:plan:{disease,injury}` | ✅ **两个子项都在** |
| 专业技能 → 一日生活规范 / 与幼儿建立联系 / 游戏化教学 | `growth:l1:skill:{daily,connect,play}` | ✅ |

**一个 PDF 里没有、但 V1 库里有的节点**（需要业主决定）：

| V1 节点 | 路径 | 说明 |
|---|---|---|
| `growth:l1:ethics:conduct` | 教师成长 / L1 基础规范 / 职业道德规范 / **师风师德建设** | 业主的 PDF 清单里"职业道德规范"是叶节点（没有下级），V1 库里它有一个子节点。V2 的 seed **保留它**（多一个节点不影响任何逻辑），但请确认这是真实业务还是当年的多余数据 |

### 这对 V2 意味着两件事

1. **seed 不用重新设计**：`database/seeds/001_directory_tree.sql` 直接照 V1 这份树生成，
   而且它同时满足 PDF 与业主 V2 需求文档里列的结构。
2. **迁移几乎是一对一映射**：`directories.code` 的 `:` 分隔正好对应 V2 的 slug 路径层级
   （`prek:virtue_outline` → `教育教学/prek/virtue/课程大纲`），
   `import-v1.mjs` 可以把 69 个节点无损搬过去，**不需要"猜"**。
   唯一需要做判断的是 `*_outline` 这类后缀 —— 在 V1 里它同时承担"路径段"与"资料夹类型码"
   两个角色，进 V2 后只作为 slug 的一段，`folder_type` 不再存在。

---

## 汇总：V1 → V2 的数字

| 维度 | V1 | V2 目标 |
|---|---|---|
| 数据库表 | 13 | 8（+1 可选） |
| 权限模型 | 4 套（roles / subject_permissions / overrides / scopes） | **1 套**（`user_permissions`） |
| 身份种类 | 7 角色 + super_admin | **2**（ADMIN / TEACHER） |
| 目录真相 | 2（旧页面数组 + `directories` 表） | **1**（`directories` 表） |
| 后端接口 | 66 | ~30 |
| 服务端模块 | 14 | ~8 |
| 前端页面 | 16（含 4 个死页） | ~11 |
| 依赖项 | 78（`dependencies` 23 + `devDependencies` 55；其中 6 个**零引用**，antd 与 shadcn/ui 并存） | 待阶段 2 定稿，目标 ≤ 35 |

## 明确不做的事（避免误解）

1. **不做** MFA、企业微信登录、通知系统、仪表盘图表（FUTURE/REMOVE，理由见上）。
2. **不搬** V1 的 RLS、账户覆盖规则（grant/deny）、`super_admin`、storybook 封面。
3. **不改** V1 的任何代码或数据。V1 继续按 `72015a3` 运行。
4. **不自动猜**迁移数据。`import-v1.mjs` 只处理能唯一确定的映射，其余列进
   `docs/V1_MIGRATION_REPORT.md` 的"需要人工处理"。
