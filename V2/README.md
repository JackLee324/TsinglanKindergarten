# V2 — 清澜山幼儿园教师资源平台（全新实现）

> **当前状态：阶段 0–7 已完成并通过验收门禁。**
> 阶段 7 = **审核工作流**：提交审核 → 审核队列（搜索/目录/排序/分页）→
> 通过并发布（一步）/ 退回（必须写原因）→ 教师看到结果 → 编辑后重新提交 → 撤回。
> 自审保护、并发审核、完整审核时间线、四个动作的审计全都到位。
> **管理员后台（教师账号 / 权限管理 / 审计明细页 / 彻底删除）属于阶段 8**。
> 阶段 0/1 产出的设计基线仍然逐条有效，本文档集是它的实现记录。

## V2 是什么

V1（本仓库根目录）经过多轮迭代后，仍然同时存在：

- 两套课程目录来源（旧页面的写死数组 + 新的 `directories` 表）
- 旧的 `folder_type` 与新的 `directory_id` 并存
- 三套权限数据（`subject_permissions` / `account_permission_overrides` / `account_scopes`）+ `teachers.roles` 角色数组
- 14 个服务端模块、66 个接口、16 个前端页面、17 个测试文件、21 份 Markdown、13 张表

其中相当一部分是**兼容层**，而不是业务。继续在其上叠加的边际成本已经高于重写。

V2 不是"把 V1 再写一遍"，而是**用最简单、最清晰的方式重新实现同一批真实业务**，
并且把复杂性全部收进后端，让教师的日常操作只有：

```
目录 → 资源 → 文件 → 审核
```

## V2 与 V1 的关系

```
TsinglanKindergarten/                     ← V1 项目根目录（唯一 Git 仓库）
├── client/  server/  shared/  ...        ← V1 的代码，V2 一个字节都不改
├── V2/                                   ← V2 在这里，由父项目统一管理版本
│   ├── client/  server/  shared/  database/  scripts/  tests/  docs/
│   └── *.md                              ← 设计基线（当前阶段）
└── ...
```

| | V1 | V2 |
|---|---|---|
| 位置 | 项目根目录 | 项目根目录下的 `V2/` |
| 代码 | **完全不动**（不再打补丁） | 全新实现 |
| 视觉 | 当前线上风格（视觉基准） | 继承，不重做 |
| 业务数据 | 生产库 | 通过 `scripts/import-v1.mjs` 单向导入，**绝不修改 V1 数据** |
| 版本管理 | 同一个 Git 仓库（父项目统一管理） | 同一个 Git 仓库；**暂不建第二个仓库** |
| 依赖 | 无（`@lark-apaas/*` 已于 V1 早期移除） | 同样零平台依赖 |

V2 **不允许** import V1 的 `client/*`、`server/*`、`shared/*`。
V1 只作为**视觉参考**与**迁移数据源**。

> 等 V2 真正完成、测试通过、准备发布时，再单独创建
> `JackLee324/TsinglanKindergarten-V2`（届时用 `git subtree` 切出历史）。
> **现在不提前建立第二层 Git 仓库。**

## 怎么写代码（后续阶段必须遵守）

每一步都是 **先设计 → 实现 → 测试 → 再进入下一步**，不允许跨阶段并行改。

| 阶段 | 内容 | 产出 |
|---|---|---|
| 0 | 只读分析 V1 | `V1_FUNCTION_MAPPING.md` |
| 1 | 需求与设计基线 | `PRODUCT_REQUIREMENTS.md`、`ARCHITECTURE.md`、`DATA_MODEL.md`、`DIRECTORY_MODEL.md`、`PERMISSION_MODEL.md`、`RESOURCE_LIFECYCLE.md` |
| 2 | 后端骨架（auth / users / guard） | 可登录的最小闭环 |
| 3 | Directory（树、浏览、管理） | 目录即导航；**新增一级栏目可用** |
| 4 | 前端 UI（沿用 V1 视觉） | ✅ Shell / Directory Browser / Directory Management |
| 5 | Resource（CRUD + 详情 + 我的资源 + 搜索 + 分页） | ✅ 读取面完成 |
| 6 | Upload / Preview / Download（真实对象存储） | ✅ 双驱动 + 直传 + 预览 + 下载 |
| 7 | Review（状态机 + 审核台） | ✅ 提交 / 队列 / 通过并发布 / 退回 / 重新提交 / 撤回 |
| 8 | Admin（教师账号、权限） | |
| 9 | Permissions（后端强制 + 即时生效） | |
| 10 | Migration（`import-v1.mjs`） | `docs/V1_MIGRATION_REPORT.md` |
| 11 | 浏览器 E2E（10 条真实业务流程） | |
| 12 | Docker / 生产部署 | `docs/DEPLOYMENT.md` |

**当前进度：阶段 0–7 已完成。**

| 阶段 | 状态 | 交付 |
|---|---|---|
| 0 | ✅ | `V1_FUNCTION_MAPPING.md`（逐项盘点 V1） |
| 1 | ✅ | 设计基线（需求 / 架构 / 数据 / 目录 / 权限 / 生命周期） |
| 2 | ✅ | 后端骨架：auth / users / authorization / directories / resources / files / reviews / audit（8 张表，48 个接口） |
| 3 | ✅ | Directory 完整化：`enabled` 的真实语义（整棵子树）、三种删除保护、slug 不可变 |
| 4 | ✅ | 前端：Shell + Directory Browser + Directory Management（**不含上传/审核/预览**） |
| 5 | ✅ | Resource 读取面：`GET /api/resources`（搜索 / 筛选 / 服务端分页）、`/api/resources/mine`、`/api/resources/:id`；界面：目录浏览页的资源列表、资源详情 `/resources/:id`、我的资源 `/my-resources`；每张卡片都显示**完整目录位置** |
| 6 | ✅ | 文件：`LocalStorageProvider` + `S3StorageProvider`（R2 / S3 / MinIO 同一段代码）、浏览器直传（`upload-url` → `PUT` → `register`）、上传进度与取消、预览（PDF/图片/TXT）、短命签名下载、`+ 添加文件`、删除文件、孤儿对象清理、`GET /api/health/storage` |
| 7 | ✅ | 审核：严格状态机（六条转换）、`POST /api/resources/:id/submit`、`GET /api/reviews/{pending,published,rejected}`（搜索 / 目录 / 排序 / 分页）、`POST /api/resources/:id/review`（通过并发布 / 退回必须写原因）、`POST /api/resources/:id/recall`、`GET /api/resources/:id/review-history`；界面：审核工作台 `/review`、详情页按权限显示动作、我的资源的提交与退回原因 |

**阶段的边界（诚实说明）**：阶段 7 只做审核工作流。管理员后台属于阶段 8。

**阶段的边界（诚实说明）**：阶段 6 只做文件本身。审核台 / 发布 / 撤回 / 回收站**界面**
属于阶段 7；这些接口在阶段 2 就有，但本阶段**没有**给它们做界面。

**阶段 6 明确不做**（属于阶段 7）：审核台、发布、撤回、回收站**界面**、批量上传、断点续传、
文件在线编辑、病毒扫描。接口层在阶段 2 就有的那些（submit / review / recall / recycle-bin）
仍然没有界面 —— 不是漏了，是排期。

**阶段 7 明确不做**（属于阶段 8）：教师账号管理、权限管理界面、审计明细页、
彻底删除（purge）界面、通知（邮件 / 站内信）、统计报表、复杂版本对比。
这些接口有的在阶段 2 就绪，但**没有**给它们做界面。

**下一步（阶段 8）：管理员后台**（教师账号 + 权限 + 目录管理 + 审核 + 审计）。

## 文档索引

| 文档 | 回答什么问题 |
|---|---|
| `PRODUCT_REQUIREMENTS.md` | **产品要什么**：两条主线、教师/管理员分别看到什么、初始目录、成功标准 |
| `V1_FUNCTION_MAPPING.md` | V1 的每一个功能，V2 是保留 / 重做 / 简化 / 删除 / 延后？（附处置理由） |
| `ARCHITECTURE.md` | 系统由哪几层组成、技术选型、V2 放在哪里、已确认的 10 条决策 |
| `DATA_MODEL.md` | 有哪些表、字段、外键、索引、约束，为什么是这几张表 |
| `DIRECTORY_MODEL.md` | 目录树怎么建模、URL 怎么定、怎么扩展出新栏目、删除怎么保护 |
| `PERMISSION_MODEL.md` | 谁能做什么、对哪里做、后端怎么强制、怎么即时生效 |
| `RESOURCE_LIFECYCLE.md` | 资源从草稿到发布到回收站的完整状态机与副作用 |

| `docs/STORAGE.md` | **文件存在哪、怎么进去的、谁能在什么时候拿到它**（双驱动、三个实测坑、部署清单） |
| `docs/REVIEW_WORKFLOW.md` | **谁能把资源从哪个状态推到哪个状态**（六条转换、自审保护、并发、审核时间线与审计的分工） |

后续阶段再补 `docs/`：`MIGRATION.md`、`DEPLOYMENT.md`、`TESTING.md`、
`KNOWN_LIMITATIONS.md`、`FINAL_V2_REPORT.md`。已补：`docs/V1_KNOWN_LIMITATIONS.md`、`docs/STORAGE.md`。

## 构建与门禁

```bash
npm run build              # prepare-build → nest build → check-dist → vite build
npm run typecheck          # 服务端 + 前端
npm run lint
npm test                   # 上面全部 + 单元 + 集成（含真实浏览器 + 真实 S3）
```

集成测试打的是**真实 S3 后端**（不是 mock），所以 `npm test` 会先自动执行
`npm run devtools:storage` 把 SeaweedFS 取到 `.devtools/`（已 gitignore，幂等，
已有就跳过）。想手工准备：`npm run devtools:storage`。

生产侧的存储自检与配置：

```bash
npm run storage:check      # 配置齐不齐 / 桶连不连得上 / CORS 是不是通配符
npm run storage:cors       # 把 CORS 写进桶（需要 V2_PUBLIC_ORIGIN）
npm run storage:cleanup    # 清理孤儿对象（--sweep 扫桶，--dry-run 只报告）
```

`build` 链里有一道 `scripts/check-dist.mjs`：**每个 `server/**/*.ts`、`shared/**/*.ts`
都必须有对应的 `dist/**/*.js`，且产物不早于源文件**。
它不是装饰 —— "产物比源文件旧"会让服务照常启动、测试照常全绿，但跑的是旧代码（假绿）。
（`nest build` 自己会在编译失败时以非 0 退出，这一条不需要脚本兜。）

## 前端结构（阶段 4–5）

```
client/src/
├── api/            http.ts（唯一 HTTP 出口：cookie / CSRF / 错误形状）
│                   auth.ts  directories.ts  resources.ts  types.ts
├── auth/           AuthProvider（会话 + 服务端给的能力开关）
├── directory/      path.ts（**唯一** URL authority：slug ↔ URL 的纯函数）
│                   DirectoryProvider（全站唯一持有目录树的地方）
│                   DirectoryBrowser（**唯一**的目录渲染器）
├── components/     Layout / Sidebar / Header / Breadcrumb + ui/（V1 视觉基准）
│   └── resource/   ResourceList（搜索 + 服务端分页）  ResourceCard（含「所在位置」）
└── pages/          Login / Home / DirectoryBrowse / DirectoryManage
                    ResourceDetail / MyResources / NotFound
```

四条约束（都有测试钉住）：

1. **目录只有一个真相**：只有 `DirectoryProvider` 持有目录树，页面不得自己请求并缓存副本。
2. **URL 只由 slug 生成**：只有 `directory/path.ts` 能把节点变成地址；
   改中文名不动 slug，因此改中文名不会让任何链接失效。
   资源详情是 `/resources/:id` —— 用 **id** 不用标题（标题可改、可重复），两者不混用。
3. **前端不判断角色**：能不能看到"目录管理"由服务端的 `capabilities` 决定，
   页面里没有 `role === 'ADMIN'`。
4. **分页与分栏只在服务端算**：页码文案（"第 1 页 / 共 2 页"）用的是接口返回的
   `total` / `totalPages`；前端不"先拉全部再自己截断"。

## 硬性约束（贯穿全部阶段）

1. **一个 Directory 真相、一个 Permission 真相、一个 Resource 真相、一个 File 真相、一个 Review 状态机。**
2. 教师界面**不得出现**：RBAC、Scope、Permission Code、Session Token、MFA Challenge、
   Directory ID、Storage Bucket、Presigned URL。
3. 管理员界面**不得出现**：RBAC、Scope、Deny、Grant、Effective Permission、Role Ceiling。
4. 不允许"假成功"：UI 只能渲染服务端返回的真实状态，不做乐观成功提示。
5. 不允许"开发中 / Coming Soon"按钮；做不到的能力就不放按钮。
6. 不允许测试造假：`ok(false)` 不算 PASS、不用 `|| true`、不吞错误、探针必须清理并核对残留。
7. 不允许把目录/权限/课程结构写死进代码或数组；一切由数据库驱动。
8. **V1 不得被 V2 修改**：V2 不 import V1 的代码，也不改 V1 的任何文件。
