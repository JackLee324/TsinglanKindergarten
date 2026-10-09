# V2 第一轮代码审查与修复报告（超级管理员自审 / 教师账号管理 / 权限安全 / 迁移完整性）

> 审查范围：`V2/`（以本地 `main` 为准）。**V1 源码零改动**；未部署 Zeabur、未触碰正式域名/正式库/生产 R2。
> 状态词只用 `PASS / FAIL / UNVERIFIED / BLOCKED / NOT RUN`。
> 所有结论都以**本次实际执行**的输出为准，没有引用历史全绿结果。

## 0. 结论（逐项）

```
SUPERADMIN SELF-REVIEW        : PASS
TEACHER ACCOUNT MANAGEMENT    : PASS
USER PRIVILEGE ESCALATION     : PASS
ACCOUNT CREATION ATOMICITY    : PASS
MIGRATION FILES & REVIEW HISTORY : UNVERIFIED（数据库侧四表交叉核对 PASS；对象存储侧无法枚举）
FULL TEST GATE                : PASS
PRODUCTION CUTOVER            : NOT READY
```

## 1. 当前代码版本与审查范围

| 项 | 值 |
|---|---|
| 分支 / HEAD | `main` @ `f73aca8`（本轮改动在其之上，见提交信息） |
| 审查方式 | **先读代码确认调用链**（UI → API → Guard → AuthorizationService → Service → DB → 审计），再改，再测 |
| 重点文件 | `server/authz/authorization.service.ts`、`server/resources/resources.service.ts`、`server/users/{users.controller,users.service,users.dto}.ts`、`server/common/{authz.guard,decorators}.ts`、`shared/permissions.ts`、`client/src/pages/AdminUsersPage.tsx`、`client/src/components/admin/PermissionEditor.tsx`、`scripts/import-v1.mjs`、`scripts/bootstrap-admin.mjs`、`docs/CUTOVER_PREFLIGHT_REPORT.md`、`docs/PRODUCTION_PERMISSION_MATRIX.md` |

## 2. 确认的缺陷（全部先经代码核实，再修）

| # | 严重度 | 缺陷 | 代码位置（修复前） |
|---|---|---|---|
| 1 | **P0** | `canActOnResource()` 把 `forbidSelf` 无差别地用在所有角色上，注释明写"管理员也不例外" → 超级管理员无法审核并发布自己的资源 | `server/authz/authorization.service.ts:206` |
| 2 | **P0** | 账号管理接口只用 `user.manage` 保护，而 `create()` 接受任意 `role`；`update()` 允许改他人身份 → 被误配 `user.manage` 的老师可建管理员 / 提升他人 | `server/users/users.controller.ts`（全部 6 个端点）、`users.service.ts create()/update()` |
| 3 | P1 | `UpdateUserDto` 没有 `username` → 编辑账号改不了登录名 | `server/users/users.dto.ts` |
| 4 | P1 | 创建账号的启用状态不是一次落库：前端先建、再按用户名**模糊搜索**、再发第二个请求停用 | `client/src/pages/AdminUsersPage.tsx`（旧 `submit()`）、`CreateUserDto` 无 `active` |
| 5 | P1 | 迁移**按 V1 岗位名自动提升管理员**：`DEFAULT_ADMIN_ROLES = ['super_admin','principal']` | `scripts/import-v1.mjs:167` |
| 6 | P1 | 权限编辑器把「管理教师」当普通勾选项提供，而它其实是身份自带的能力 | `shared/permissions.ts` `permissionChecklist()`、`client/src/components/admin/PermissionEditor.tsx` |

## 3. 修复内容、根因与安全影响

### 3.1 超级管理员可以审核自己的资源（P0-1）

- **根因**：自审保护写成了"看上传者是不是本人"，与角色无关。它并不增加安全性（管理员本来就有全平台权限，放行入口始终只有 `can()` 里那一处），却让**单管理员站点**出现死结：管理员上传的资源永远卡在待审。
- **改法**（只改中央授权层一处）：`forbidSelf` 在 `scopeDecision.reason === 'admin'` 时不生效。
  - 不新增角色、不在 Service/Controller/组件里再写角色判断；`'ADMIN'` 字面量仍只出现在 `authorization.service.ts`（`tests/unit/route-declarations.test.mjs` 会扫全仓库）。
  - 普通教师的 `forbidSelf` **原样保留**（未放宽任何断言）。
- **前端一致性**：`resourceCapabilities()` 走同一个函数，所以详情页/审核台的按钮能力位自动跟着变；新增测试直接断言能力位。
- **未动**：状态机、事务里的条件更新、并发冲突处理、审计与时间线写法。

### 3.2 账号管理只有超级管理员能做（P0-2）

- **根因**：门槛是**可授予的权限**而不是**身份**。`user.manage` 一旦落到老师身上，`POST /api/users`（`role: 'ADMIN'`）与 `PATCH /api/users/:id`（改他人身份）就是两条现成的提权通道，而界面藏按钮挡不住直接调 API。
- **改法**（两层，都在服务端）：
  1. `AuthorizationService.isSuperAdmin() / assertSuperAdmin()` —— 身份的**唯一定义处**，并明确写清设计边界：
     本项目只有 `ADMIN` 与 `TEACHER` 两种业务身份，`ADMIN` 在语义上就是超级管理员，**不新增第三种角色**。
  2. `@RequireSuperAdmin()` 装饰器 + `AuthzGuard` 检查（拒绝时写审计 `authz.denied`），**并且** `UsersService` 的每个方法（列表/详情/权限读/创建/编辑/停用/改权限）再调一次 `assertSuperAdmin()` —— 即使有人绕过控制器直接调 Service 也拒绝。
- **权限模型收口**：`shared/permissions.ts` 新增 `NON_GRANTABLE_PERMISSIONS = ['user.manage']` 与 `isGrantable()`：
  - 服务端：`setPermissions` 收到 `user.manage` → **400**（`SUPERADMIN_IS_ROLE_DERIVED`），并给出正确做法；
  - 前端：`permissionChecklist()` 与 `PermissionEditor` 都不再渲染它（不是"藏起来但接口还留着"）。
- **创建接口只建教师**：`role !== 'TEACHER'` → **400**（`ROLE_NOT_CREATABLE`），而不是"悄悄降级成教师"。新增管理员的正确路径：先建教师 → 再用编辑接口调整身份（只有超级管理员能做，写审计并撤销会话）。第一个超级管理员仍由 `scripts/bootstrap-admin.mjs` 用显式凭据创建（没有默认账号/默认口令）。
- **保留的护栏**：不能改自己的身份（`SELF_ROLE_CHANGE`）；不能停用/降级最后一名有效管理员（`LAST_ADMIN`，`assertSystemKeepsAnAdmin`）。

### 3.3 教师账号手动创建/编辑（P1-3、P1-4）

- **用户名可改**（新能力）：`UpdateUserDto.username`；大小写不敏感唯一（服务端先给可读 409，**真正的保证**是既有的 `users_username_key` 唯一索引）；审计单独记 `user.username_change`（含 before/after 用户名，**不记口令**）；改名后**撤销该账号全部会话**。
- **创建即定启用状态**：`CreateUserDto.active`，在**同一个事务**里与账号、初始授权一起落库；创建接口返回 `{ id, username, active }`。前端删掉"再搜一次 + 第二个请求停用"的两步舞（既不是原子操作，模糊搜索还可能命中别人）。
- **并发创建**：唯一索引违反（`23505`）翻译成 **409**，不会漏成 500；新增并发用例断言"只成功一个"。
- **不做的事**：不自动生成教师用户名/口令/默认账号；`seed.mjs` 仍只初始化目录树；`bootstrap-admin.mjs` 仍只管第一个管理员。

### 3.4 迁移不再按 V1 岗位名自动提升（P1-5）

- `DEFAULT_ADMIN_ROLES` 改为 **`[]`**：迁移**不会**把任何账号变成管理员。
- 新增 `--admin-usernames a,b`（**点名账号**，推荐的粒度）；`--admin-roles` 仍可用但要显式给出。
- 原先"迁移结果里没有管理员就中止导入"改成了**显著的提示**（因为第一个管理员的正规入口是导入之后的 `bootstrap-admin.mjs`，硬中止会让人卡在中间）。
- 报告新增「身份迁移：**没有自动提升的管理员**」一节，逐条列出被显式提升的账号（若有）。

## 4. 验证证据

### 4.1 单元与集成（命令、退出码、结果）

| 命令 | 退出码 | 结果 |
|---|---|---|
下面这一组是**同一次运行**（最终代码、修复全部到位后从头跑一遍）的输出：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | 通过（含前端产物自检闸门） |
| `npm run typecheck`（server + client） | 0 | 通过 |
| `npm run lint` | 0 | 0 error |
| `npm run test:unit` | 0 | **206 / 206** |
| `npm run test:integration` | 0 | **595 / 595** |

修复过程中还出现过一次单点红灯：改了权限清册后 `tests/unit/permission-catalog.test.mjs` 仍按旧清单断言 12 项 → 该断言已按"权限码仍 12 项、可授予的 11 项"更新（新增 `isGrantable('user.manage') === false` 的断言，而不是把这条测试删掉或放宽）。

新增/更新后的专项结果：

| 套件 | 结果 | 说明 |
|---|---|---|
| `tests/integration/review-permission.test.mjs` | **17 / 17** | 含"管理员**可以**自审并发布"+"教师自审仍 403"+自审走状态机（重复审核被拒） |
| `tests/integration/account-privileges.test.mjs`（**新增**） | **12 / 12** | 主动把 `user.manage` 写进授权表制造误配置，断言账号管理接口全部 403；创建/改名/并发/唯一/审计 |
| `tests/integration/admin-security.test.mjs` | **12 / 12** | 第二个管理员改走"先建教师 → 再改身份"的正规两步 |
| `tests/integration/users.integration.test.mjs` | **8 / 8** | 全平台权限不得带目录范围的用例改用 `audit.view`（`user.manage` 已不可授予） |
| `tests/integration/migration-v1.test.mjs` | **30 / 30** | 断言"默认不提升任何账号为管理员" |
| `tests/integration/browser.stage9.test.mjs` | **12 / 12** | 真实 V1 数据迁移改成用 `--admin-usernames` **显式点名**管理员（顺带验证新参数） |

修复过程中我自己引入并修掉的两个问题（如实记录）：
1. 报告函数里误用了 `apply()` 作用域的局部变量（`adminConversions is not defined`）→ 导入直接失败（10 个用例红）→ 改走 `result.adminConversions` 后恢复。
2. `admin-security` 的第二个管理员原先用创建接口直接建 `ADMIN`，被新规则正确拒绝（400）→ 该钩子在 `startServer()` 之后抛错、留下孤儿服务，连带 4 个用例红 → 改为正规两步后全绿。

### 4.2 演练环境真浏览器验收（`https://v2.localhost:8443`，镜像已重建）

| 项 | 结果 |
|---|---|
| 超级管理员登录 | PASS |
| 账号管理页创建"启用"教师 → 该账号可登录 | PASS（HTTP 201） |
| 创建"停用"教师 → 该账号登不进去 | PASS（HTTP 401；首轮因演练**登录限流**拿到 429，改用遵守限流的精确复核闭掉） |
| 编辑弹窗出现「用户名（登录名）」输入框 | PASS |
| 改名后新用户名可登录 / 旧用户名失效 | PASS（201 / 401；并用账号列表确认旧名已消失） |
| 权限页**不再出现**「管理教师」勾选项 | PASS |
| 自审：管理员上传 → 提交 → 详情页出现「通过并发布」按钮 | PASS（截图 `self-review-approve-button.png`） |
| 点击后状态变为「已发布」 | PASS（截图 `self-review-published.png`） |
| 全程控制台/网络 0 未处理异常 | PASS |
| 探针资源 purge + 探针账号清理 | PASS（账号总数回到 24，残留 0） |

## 5. 一次必须披露的验收事故（已修复并恢复）

**我的浏览器验收脚本改错并删除了两个真实账号。**

- **经过**：脚本里"编辑刚创建的账号"那一步写成了 `点击第一个编辑按钮`，而**搜索是表单提交触发的**：
  - 第一次运行时搜索没有过滤，脚本点到了表格第一行 —— V1 迁移来的 **`qlsadmin`（园长/平台管理员）**，把它改名成 `sr7c_*`；
  - 最后一次运行时同一失败模式改到了 **`v1-no-username-749e5d41`（系统初始化）**；
  - 随后脚本的清理语句按 `sr7%` 前缀删除，把这两个改名后的账号**删掉了**。
- **发现方式**：清理后账号总数不是 24 而是 22 → 用 `audit_logs` 反查 `user.username_change` 的 before/after 用户名，逐条对上（`qlsadmin → sr7c_088464 → sr7c_106636`；`v1-no-username-749e5d41 → sr7c_124269`）。
- **修复**：
  1. 从**冻结的生产快照**原样恢复这两个账号（id、username、姓名、口令哈希、role、status、创建/更新时间全部保留；"没有用户名"的账号恢复成与迁移一致的占位名 `v1-no-username-749e5d41`，并按迁移规则置为 `inactive`、口令用同一形态的不可用占位值）；
  2. 恢复后复核：**24 个账号、3 个管理员**（`TsinglanAdmin` / `qlsadmin` / `v1-no-username-749e5d41`），无用户名账号登录返回 401；
  3. 脚本加固：**只按 `data-username` 定位那一行**，找不到就**中止**（绝不按位置点）；清理按本次确切的用户名执行；清理后自检残留为 0。加固后的运行确实在找不到行时中止过一次，没有再去碰错账号。
- **影响范围**：只有本机演练库（生产库、生产快照、正式环境均未被触碰；冻结快照文件本身只读）。演练库已回到事故前状态。

## 6. 迁移完整性核验（附件 0 / 审核历史 0 / 探针账号）

### 6.1 导出本身是否完整

V1 的导出接口（`POST /api/admin/data-export`）由 `BackupService.tableNames()` **枚举 `public` schema 的全部基表**再逐表导出 —— 快照里确实是 14 张表，没有"只导了部分表"的可能。

### 6.2 附件：四张表交叉核对（PASS）

| 证据来源 | 结果 |
|---|---|
| `resources.has_stored_file`（V1 自己的 GENERATED 列） | 349 条中 **2 条为 true**，都是被授权排除的两条测试资源（`76b60eb6` / `62928bcc`，同一个 smoke 文件 `校服申领登记.png`） |
| `resources` 的文件列（path/bucket/name） | 恰好同样是这 2 条，与上面完全一致 |
| `resource_versions`（独立表，350 行） | 带文件字段的 **3 行**，全部属于这两个资源 |
| `audit_logs`（独立表，621 行） | 文件类事件 113 条；带 resource_id 的 105 条中 **100 条指向 V1 已删除的历史资源**（标题几乎全是 10-05～10-06 的联调探针：`R2 往返探针` / `浏览器直传探针` / `CORS 探针` / `存储往返探针`），**5 条**指向仍存在的资源 —— 其中 4 条是那两条测试资源的上传/登记，1 条是**被拒绝的下载**（`resource_download_denied`，与"没有文件"一致） |

**结论（数据库侧）**：V1 里从来没有过"业务附件"——所有真实文件事件都属于那两条已授权排除的测试资源；
其余文件活动属于 V1 自己已删除的探针资源。**因此排除后 V2 的 `resource_files = 0` 是正确结果**，不是漏导。

### 6.3 审核历史：同样交叉核对（PASS）

- `review_records` 共 **1 条**（`approve`），挂在 `76b60eb6`（被排除的测试资源）；
- 审计里的"提交审核"事件 **3 条**：2 条指向**已不存在**的探针资源（`全链路探针（已编辑）405561/413492`），1 条指向同一条被排除的测试资源。
- 于是 V2 的 `resource_reviews = 0` 与"审核流水为空"完全可解释；**影响**：V2 里所有现存资源的审核时间线从空开始（历史只有那 1 条，且属于测试数据）。

### 6.4 探针账号

| 账号 | V1 角色 | V1 状态 | 迁移后 | 审计引用 |
|---|---|---|---|---|
| `biz_probe_405561` | `visitor` | inactive | TEACHER / inactive | 9 条（**保留，不删**） |
| `biz_probe_413492` | `visitor` | inactive | TEACHER / inactive | 9 条（**保留，不删**） |

- 它们**不会被启用**、也不是管理员（`visitor` 不在任何管理员集合里）；迁移只按 V1 状态照搬，并保留其审计历史。
- 未做"因为历史数据就删除账号"这类简化。

### 6.5 仍然无法核验的部分（UNVERIFIED / BLOCKED）

**对象存储（R2）里的对象清单无法在本机枚举**：R2 凭据只存在于 Zeabur 环境变量里（本机 `credentials/` 只有 V1 的超级管理员凭据）。
因此"线上确实没有其他应迁移的附件"这句话，只能证明到**数据库侧**；存储桶里是否还留着 V1 已删探针资源的**孤儿对象**，需要业主提供其一：

1. 在 Zeabur 里给 V2 的 R2 控制台/凭据，我列出 V1 bucket 的对象清单并与快照的 `file_path` 对账；
2. 或在 R2 控制台导出对象清单（CSV/JSON）交给我比对。

> 注意：即便存在孤儿对象，它们属于 V1 **已删除**的探针资源，**不需要**迁移到 V2；这项核验的目的是把"没有漏导"从"数据库侧成立"升级为"两侧都成立"。

## 7. 账号相关的其他安全复查（本轮实际检查的项）

| 检查 | 结论 |
|---|---|
| 所有账号管理接口是否有不可绕过的服务端授权 | PASS：Guard 的身份门槛 + Service 层再判一次（双层） |
| 角色变更是否会造成提权 | PASS：只有超级管理员能改；不能改自己；不能移走最后一个管理员 |
| 权限编辑是否会把目录权限放大成全平台 | PASS：既有校验保留（全局权限不得带 `directoryId`），且 `user.manage` 直接拒授 |
| 停用/改密/改身份/改权限后是否撤销正确的会话 | PASS：四类改动都会 `revokeAllForUser`；改用户名也纳入 |
| 用户名唯一性是否由数据库约束保障 | PASS：`users_username_key`（`lower(username)` 唯一）既有；并发创建用例证明只成功一个 |
| 审计是否记录账号类动作且不含口令 | PASS：`user.create / user.update / user.disable / user.password_change / user.username_change`；口令只记"改过"，不记值 |
| 错误信息是否泄露内部信息 | 复查后**未**发现新的泄露点（拒绝文案统一为可读中文 + 错误码） |
| 资源详情/文件列表/预览/下载的可见性 | 本轮未改动这条链路（既有实现与测试保持全绿） |

## 8. 仍未解决 / 阻塞项

| 项 | 状态 | 说明 |
|---|---|---|
| R2 对象清单核验 | **UNVERIFIED / BLOCKED** | 需要业主提供 R2 凭据或对象清单（见 §6.5） |
| 正式切换 | **NOT READY** | 见 §9；本轮按指示不启动切换 |
| "谁是超级管理员"的业务确认 | **待业主确认** | 迁移默认不提升任何人；`PRODUCTION_PERMISSION_MATRIX.md` 列出的 24 个账号需要业主指名确认 |
| 24 个账号的权限初始化 | **待业主确认** | 迁移刻意不发授权；上线当天须按矩阵初始化 |
| 生产域名上的浏览器验收 | **NOT RUN** | 依赖正式部署 |

## 9. 正式切换前还需要完成的事

1. **指名确认超级管理员**（`--admin-usernames` 或导入后用 `bootstrap-admin.mjs`/编辑接口提升），并逐条确认矩阵里的 24 个账号身份与开放目录；
2. **提供 R2 对象清单**，完成 §6.5 的存储侧核验（或书面确认"接受数据库侧结论"）；
3. 在正式部署上跑一遍完整门禁与浏览器验收（含本轮新增的 ③bis/③ter/③quater 与自审、账号管理用例）；
4. 备份/恢复演练与回滚材料（仍为 NOT RUN）。

## 10. 交付与边界

- 只提交 V2 的代码、测试与文档；**未**提交生产快照、数据库备份、凭据或密钥（`.migration/`、`credentials/`、`.env.deploy`、`deploy/tls/*.pem` 均被 gitignore 挡住）。
- 完整 Git diff 已检查：**V1 零改动**。
- 未部署 Zeabur、未切换正式域名、未修改生产库、未退役 V1。
