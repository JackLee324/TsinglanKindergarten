# PRODUCTION_READINESS.md — 清澜山幼儿园教师课程资源平台

> 本文档是**公网生产化改造的现状基线**。
> 所有结论以**实际代码与本机真实运行结果**为准，不相信任何既有文档的声称。
>
> - 基线版本：v1.3.0
> - 基线 git tag：`baseline-v1.3.0`（commit `88b7fc5`，tree `e99d3df`）
> - 基线文件数：325
> - 审计方式：源码静态分析 + **真实 PostgreSQL 16.14 上执行验证** + 真实 `tsc` / build
> - 本文件由改造工程维护；每次重大变更后更新。

---

## 0. 证据等级说明（重要）

本文档对每条结论标注证据等级，避免把"看起来"当成"已证实"：

| 标记 | 含义 |
|---|---|
| **[已证实]** | 在本机真实环境执行并观察到结果，或由源码逐行确证 |
| **[推断]** | 由配置/代码互证推出，但未实机执行 |
| **[无法验证]** | 需要目标部署环境（平台侧 / 真实数据）才能确认，本文档明确标注而非猜测 |

### 0.1 本机验证环境（已具备）

| 能力 | 状态 | 说明 |
|---|---|---|
| Node.js | ✅ v22.23.2 | 满足 `engines: >=22` |
| npm | ✅ 10.9.8 | |
| node_modules | ✅ 905 个顶层包 | `@lark-apaas/*` 平台运行时已可离线审阅 |
| **PostgreSQL 16.14** | ✅ **真实服务端运行中** | 127.0.0.1:55432，库 `qls_kindergarten`；由 `scripts/dev-postgres.sh` 拉起 |
| TypeScript 类型检查 | ✅ 通过 | server 44 文件 / client 216 文件，**均为真实检查**（非空跑） |
| git | ✅ 2.50.1 | 已建立 pristine 基线，可随时 `git diff baseline-v1.3.0` |
| Docker | ❌ 不可用 | 本机无 docker，容器化交付**无法在本机验证** |
| 平台 aPaaS 运行时 | ❌ 不可用 | 无法在本机验证妙搭平台的存储/发布/vefaas 行为 |

### 0.2 因此本机**可以**验证 / **不能**验证

**可以真实验证：** migration 执行与回滚、数据完整性与数量比对、RLS 策略实际行为、SQL 层约束与触发器、后端鉴权逻辑（真实 DB 上的集成测试）、`tsc`、lint、build、生产模式启动、健康检查、CSRF 链路（本地 dev 路径）、限流、审计落库。

**不能真实验证（必须由部署环境提供）：**
1. 妙搭平台侧的 dataloom 对象存储真实上传/签名下载 —— 需要平台凭据与 bucket。
2. vefaas / 妙搭发布管线对 `{{...}}` HBS 占位符的替换行为。
3. Docker 镜像构建与容器编排（本机无 docker）。
4. 真实反向代理（Nginx/Cloudflare）下的 `X-Forwarded-*` 行为与 `trust proxy`。
5. 真实生产域名下的 HTTPS / HSTS / Cookie `Secure` 行为。

> 交付时会明确区分「已实测」与「需部署环境复验」，**不会假装备份、回滚、容器或平台集成已成功**。

---

## A. 已经真实实现（可直接沿用，不重写）

| # | 能力 | 证据 | 等级 |
|---|---|---|---|
| A1 | 密码学处理正确 | scrypt N=16384/r=8/p=1、`timingSafeEqual` 常数时间比较、16 字节随机 salt（`auth.service.ts:73-101`） | [已证实] |
| A2 | 会话令牌哈希存储 | DB 只存 `sha256(sessionId)`，Cookie 侧为不透明随机值（`session.service.ts:16-18,63-75`） | [已证实] |
| A3 | 生产环境 Cookie 不可降级 | `NODE_ENV=production` 时强制 `isHttps=true`，`HTTPS_ENABLED=false` 无法关闭 `Secure`（`session.service.ts:47-51`） | [已证实] |
| A4 | 登录防爆破真实存在 | 5 次失败锁 15 分钟 + IP 限流 30 次/分钟（`auth.service.ts:26-29,299-326`） | [已证实] |
| A5 | 审计日志覆盖失败路径 | 下载被拒、越权尝试均写 `resource_download_denied` / `permission_denied`（`resources.service.ts:1398-1448`） | [已证实] |
| A6 | 全局认证守卫 | `AuthGuard` 经 `APP_GUARD` 全局注册，`@Public()` 显式放行（`auth.module.ts:14-17`） | [已证实] |
| A7 | **CSRF 链路实际可用** | 详见 §D-1：平台 `CsrfTokenMiddleware` 无条件注册并下发 cookie，`ViewContextMiddleware` 填充 `res.locals.csrfToken`，被 hbs 渲染进产物 HTML 的 `window.csrfToken`，axios 请求拦截器再注入 `X-Suda-Csrf-Token` | [已证实] |
| A8 | 种子数据幂等 | `NOT EXISTS` 守卫；本机连续执行 3 次，资源数恒为 347 | [已证实] |
| A9 | 种子数据质量良好 | 347 条 `description` JSON **全部可解析**；34 张封面文件名与磁盘文件**集合完全相等** | [已证实] |
| A10 | 前后端共享契约源 | `shared/api.interface.ts` 作为类型单一来源 | [已证实] |
| A11 | 双语字典完整 | zh-CN / en-US 各 280 键，**零漂移**，且由 TS 类型强制 | [已证实] |
| A12 | 既有 DB schema 的 DDL 本身有效 | 补齐平台提供的 `user_profile` 类型与三个角色后，`init.sql` **可完整执行** | [已证实] |
| A13 | 类型系统健康 | 改造前 server/client `tsc --noEmit` **均通过** | [已证实] |

---

## B. 部分实现（骨架在，能力缺）

| # | 能力 | 已实现 | 缺口 |
|---|---|---|---|
| B1 | 文件上传 | 前端表单、文件选择、大小格式化、DTO 字段 | **无上传接口**；前端硬编码 `fileBucketId='placeholder-bucket'` 与伪造 `filePath`（`UploadPage.tsx:157-171`）；UI 直接渲染 "TODO:" 文案给终端用户（`ResourceFileUpload.tsx:95-100`） |
| B2 | 文件下载 | 完整鉴权序列（发布状态 → 科目权限 → 文件存在），且每步写审计 | 末段是 `// TODO: 接入真实 dataloom FileService` + 手拼**未签名、无过期**URL（`resources.service.ts:1465-1467`）。平台 `FileService.createSignedUrl(path, expiresIn)` **已安装可用但从未调用** |
| B3 | 文件存储 | `FileService` 已注入构造函数 | `this.fileService` **全仓库零引用**（`resources.service.ts:55`）。`@lark-apaas/dataloom`、`@lark-apaas/file-service` 已安装但未使用 |
| B4 | 强制改密 | `must_change_password` 字段、`mustChangePassword` 类型、修改密码接口 | **`mustChangePassword` 全代码库只被赋 `false`，从未赋 `true`**；前端从不读取该字段；无强制跳转流程 |
| B5 | 密码策略 | 长度≥10 + 大小写 + 数字（`auth.service.ts:103-109`） | 无弱密码字典、无相似度校验、无历史密码、无有效期 |
| B6 | 多设备会话管理 | `sessions` 表含 `ip_address` / `user_agent` / `revoked` | 无 `revoked_at` / `revoke_reason` / 设备信息；**无任何面向管理员的 Session 查询或强制下线接口** |
| B7 | 权限矩阵 UI | `PermissionAdminPage` + `PermissionMatrix` 完整 | 保存接口前后端**方法不一致（PATCH vs POST）→ 404**，功能实际不可用 |
| B8 | 审核工作台 | 完整 UI + 后端 service | 审核动作与审核历史**接口路径不一致 → 404** |
| B9 | 角色定义 | `RoleCode` 8 个角色 | `ROLE_DEFINITIONS` **只有 7 个，漏 `k_assistant`**；5 处角色清单各不相同 |
| B10 | 课程目录 | 静态结构完整（班型/科目/资料夹） | **6 类资料夹只有 3 类有数据**；K 中文 / K 美德 / Pre-K 体能 / K 体能 **0 条数据**，但导航入口存在 |

---

## C. 文档声称实现但代码没有（文档不可信）

> 可信度排序：**`RELEASE_NOTES.md` ＞ 代码 ＞ `README.md` ＞ `DEPLOYMENT.md`**。
> **`DEPLOYMENT.md` 中 §3/§4/§6/§9 描述了一个当前不存在的系统状态。**

| # | 文档声称 | 代码事实 | 证据 |
|---|---|---|---|
| C1 | `DEPLOYMENT.md:25,64,163,256,314,411` + `README.md:50`：首次登录**强制改密** | 未实现，`mustChangePassword` 只被赋 `false` | [已证实] |
| C2 | `DEPLOYMENT.md:64,255`：初始密码**系统随机生成并写入启动日志** | 种账号是**静态硬编码哈希**，无任何日志输出；同文档 `:112` 自相矛盾 | [已证实] |
| C3 | `DEPLOYMENT.md:73`：不得与最近 5 次历史密码重复 | 无 `password_history` 表/字段/代码 | [已证实] |
| C4 | `DEPLOYMENT.md:75`：密码有效期 180 天，到期前 7 天提示 | 无任何相关实现 | [已证实] |
| C5 | `DEPLOYMENT.md:211-219`：种子含 20 名教师、各角色默认科目权限、六类资料夹结构 | 种子**只插 resources**；教师/权限/资料夹结构均 0 行（本机实测） | [已证实] |
| C6 | `DEPLOYMENT.md:204`：上线后课程内容**立即可见** | 现装状态下种子插入 **0 行** | [已证实] |
| C7 | `DEPLOYMENT.md:269`：下载为**临时签名 URL，有过期时间** | 未签名、无过期的拼接路径 | [已证实] |
| C8 | `DEPLOYMENT.md:242,249`：`npm run db:codegen` | **无此脚本**（真名 `gen:db-schema`） | [已证实] |
| C9 | `DEPLOYMENT.md:188`：RLS 默认 policy 由平台管理 | policy 由 `init.sql` 创建，且谓词全为 `true` | [已证实] |
| C10 | `README.md:39,42,45`：`psql <your_database_url> -f ...` | `<...>` 在 shell 中是重定向符，**语法非法**；与 DEPLOYMENT 的 `miaoda db sql` 路线冲突 | [已证实] |
| C11 | `README.md:33`：编辑 `.env` 填入数据库连接 | `.env.example` **无任何数据库变量**；连接来自平台注入的 `SUDA_DATABASE_URL` | [已证实] |
| C12 | `README.md:89`：`npm run start:prod` | **脚本不存在** | [已证实] |
| C13 | `README.md:185`：`node scripts/reset-password.js` | **文件不存在** | [已证实] |
| C14 | `AGENTS.md:9,126`：企业微信 OAuth 2.0 登录 | v1.3.0 已改为账号密码 | [已证实] |
| C15 | `AGENTS.md:123-144`：6 个路由（`/logout` `/virtue` `/montessori` `/prek/:subject` …） | **均不存在** | [已证实] |
| C16 | `AGENTS.md:56-64`：角色表 7 个（含 visitor，无 k_assistant） | `RoleCode` 是 8 个 | [已证实] |
| C17 | `RELEASE_NOTES.md:17-23`：prek_head=2, k_head=2, pe=2, 配班=6+6 | 实际种子为 **3 / 3 / 4 / 4 / 4**（`README.md:55-61` 才对） | [已证实] |
| C18 | 种子尾部自计数合计 341 | 实际 347（漏计 6 条蒙氏领域大纲） | [已证实] |

---

## D. 安全漏洞

### D-0 结论先行：CSRF 不是漏洞，我上一轮把它列为「待验证风险」，现已**实测确认为可用**

链路（全部由已安装源码逐行确证）：

1. `PlatformModule.configure()` 中 `CsrfTokenMiddleware` **无条件注册**（不被 `enableCsrf` 影响）：
   `consumer.apply(CsrfTokenMiddleware, ViewContextMiddleware, …).exclude("/api/(.*)","/openapi/(.*)","/static/(.*)").forRoutes("*")`
   → 浏览器访问 `/`（SPA HTML，非 `/api`）时下发 `suda-csrf-token` cookie。
2. `CsrfTokenMiddleware` 把 token 写入 `req.csrfToken`；`ViewContextMiddleware` 写入 `req.__platform_data__.csrfToken` **以及 `res.locals.csrfToken`**。
3. 生产构建产物 HTML 含 HBS 占位符 `window.csrfToken = "{{csrfToken}}"`（预设 `view-context.js:99`）。
   本应用用 `hbsExpressEngine` 渲染 `index.html`（`server/main.ts:24`），Handlebars 会用 `res.locals.csrfToken` **真实替换**该占位符。
4. 客户端 `axiosConfig.js:346-347` 请求拦截器注入 `X-Suda-Csrf-Token: window.csrfToken`。
5. 应用自建 `CsrfCheckMiddleware`（`csrf-check.middleware.ts:5-6`）用的正是 **同一对** cookie/header 名，与平台约定一致。

→ **[已证实] 写操作 CSRF 校验链路成立。** 但仍存在下列真实问题：

| # | 问题 | 等级 | 证据 |
|---|---|---|---|
| D-1 | **CSRF cookie 被强制 `secure: true; sameSite: 'none'; partitioned: true`**（平台硬编码）。在纯 HTTP 本地开发下浏览器会拒绝该 cookie → 本地 dev 写操作 403。生产 HTTPS 下正常 | 中（开发体验） | `fullstack-nestjs-core/dist/index.js:34792-34798` [已证实] |
| D-2 | **20 个生产账号的 scrypt 密码哈希硬编码在源码** | **高** | `server/modules/auth/seed-teachers.ts:11-172` [已证实] |
| D-3 | **`.gitignore` 未忽略 `.env`**（只有 `.env.local`），而 `.env.example:5` 声称已忽略——**该声称是假的**；`build.sh:166` 还会把 `.env` 复制进产物目录 | **高** | [已证实] |
| D-4 | **RLS 提供零行级保护**：所有 policy 谓词为 `USING (true)` / `WITH CHECK (true)`，无 `FORCE ROW LEVEL SECURITY`；应用全程单一 DB 身份，从不 `SET ROLE`、从不 `set_config('app.user_id')` | **高** | `init.sql:38-47,283-309` [已证实] |
| D-5 | **`anon` 可改写 teachers 任意列**：`teachers_anon_update_last_login FOR UPDATE TO anon USING (true) WITH CHECK (true)`，本意只更新 `last_login_at`，实际可改 `password_hash` / `roles` / `status`（RLS 是行级，无法按列收窄） | **高（若 `anon` 可达）** | `init.sql:293-295` [已证实] |
| D-6 | **`anon` 可读/写全部 session**：`sessions_anon_select/insert/update USING (true)` → 可读全部会话哈希、伪造会话、撤销后恢复 | **高（若 `anon` 可达）** | `init.sql:298-305` [已证实] |
| D-7 | **死代码中藏越权口子**：`getPublicDownloadUrl` / `getPublicStorybookCoverStream` 只校验 `published`、**完全不校验科目权限**且未挂路由；一旦被接上公开路由即权限失效 | **高** | `resources.service.ts:758,786` [已证实] |
| D-8 | **客户端可自选存储坐标**：`POST /api/resources` 接受客户端传入的 `fileBucketId` / `filePath` | **高** | `resources.dto.ts:164,218` [已证实] |
| D-9 | **无全局 `ValidationPipe`** → 所有 DTO 的 `@IsString/@IsIn/@IsUUID` 装饰器**从未执行**，任意字符串可直达 DB | **高** | 全 `server/` 无 `useGlobalPipes`/`APP_PIPE` [已证实] |
| D-10 | **`X-Forwarded-For` 被直接信任**：`req.headers['x-forwarded-for'].split(',')[0]`，未配置 `trust proxy` → 可伪造 IP 绕过 IP 限流并污染审计 | **高** | `auth.controller.ts:129-133`、`resources.controller.ts:29-35` [已证实] |
| D-11 | **员工可绕过前端直接调用 API**：前端角色门禁只是 UX（`ProtectedRoute.tsx:33`）。后端在多数 controller 有独立校验（复审结论：**这部分做得对**），但 `ResourcesController` 全部路由**仅依赖 AuthGuard 登录态**，细粒度判断散落在 service 内，且下载/编辑/删除各写一套 | 中 | `resources.controller.ts:37-150` [已证实] |
| D-12 | **IP 限流为进程内 `Map`**：多实例下形同虚设；且 Map 无清理 → 内存持续增长 | 中 | `auth.service.ts:55,111-121` [已证实] |
| D-13 | **`setInterval` 永不清理**：`auth.service.ts:68-70` 每小时清理会话，无 `onModuleDestroy`，优雅退出时悬挂 | 低 | [已证实] |
| D-14 | **会话清理不清理已撤销记录**：`cleanup()` 只删 `expiresAt < now` | 低 | `session.service.ts:197-209` [已证实] |
| D-15 | 第三方 workspace id `aadkvzfw5lges` 硬编码 3 处 | 低 | `fix-rls-policies.sql:25-27` [已证实] |
| D-16 | `PlatformModule.forRoot({ enableCsrf: false })` 关闭了平台自带校验，改为自建中间件——**当前等价**，但自建版缺少平台的 403 语义与日志降级逻辑 | 低 | `app.module.ts:19` [已证实] |

---

## E. 数据库问题

| # | 问题 | 等级 | 证据 |
|---|---|---|---|
| E-1 | **`init.sql` 无法在原生 PostgreSQL 上执行** —— 实测报 `42704: type "user_profile" does not exist`（第 21 行）。全仓库无 `CREATE TYPE` | **致命** | [已证实，真实 PG 16.14] |
| E-2 | **`init.sql` 未创建 `anon`/`authenticated`/`service_role`** —— 实测原生 PG 中三者**均不存在**（全仓库无 `CREATE ROLE`） | **致命** | [已证实] |
| E-3 | **`init.sql` 重复执行不安全** —— 实测第二次报 `42710: policy "service_role_bypass_policy_teachers" already exists`。但文件头声称"可安全重复执行" | **致命** | [已证实] |
| E-4 | **`init.sql` 缺 6 个 v1.3.0 认证必需字段** —— 实测生成的 `teachers` 表列为 `id, wecom_user_id, name, name_en, email, roles, status, last_login_at, _created_at, _created_by, _updated_at, _updated_by`；**缺 `username, password_hash, must_change_password, failed_login_attempts, locked_until, password_updated_at`** → 任何登录路径都会 `42703` | **致命** | [已证实] |
| E-5 | **`init.sql` 把 `wecom_user_id` 声明为 `NOT NULL`**，但 `seedTeachers()` 从不写该字段 → 20 条 insert 全抛错，且被 `try/catch` **吞掉**（`auth.service.ts:200-207`），应用照常启动、**零账号** | **致命** | [已证实] |
| E-6 | **两套 schema 定义已双向漂移**：`schema.ts`（自动生成，来自线上库）vs `init.sql`（手工）。teachers 差 6 列、sessions 差 `_created_at`、`wecom_user_id` 可空性冲突 | **致命** | [已证实] |
| E-7 | 无任何 migration 机制：无 `drizzle.config.*`、无 `migrations/`、无 `schema_migrations` 表、`drizzle-kit` **不在依赖中且 lockfile 零命中** | **高** | [已证实] |
| E-8 | `_updated_at` 永不变化：三份 SQL 中**无任何 `CREATE TRIGGER` / `CREATE FUNCTION`**，应用侧也从不写系统字段 | 中 | [已证实] |
| E-9 | `_created_by` / `_updated_by` 永不记录操作者：GUC `app.user_id` 从未被应用设置 | 中 | [已证实] |
| E-10 | `schema.ts:273` 与 `:276` 是**两个列完全相同的唯一索引**（线上库历史遗留） | 低 | [已证实] |
| E-11 | `schema.ts:311` 的 `idx_teachers_username` 只以**注释**形式存在，但 `auth.service.ts:174` 查询 `lower(username)=…` 依赖它 | 中 | [已证实] |
| E-12 | `audit_logs` 无任何外键（`teacher_id`/`resource_id` 为裸 uuid）—— 设计上可接受（留痕），但需确认是有意为之 | 低 | [已证实] |
| E-13 | 时间精度不一致：`locked_until`/`password_updated_at` 为 `timestamptz(6)`，其余为 `(3)` | 低 | [已证实] |

### E-14 种子数据实测结果（真实 PG 上执行）—— 关键

| 场景 | 结果 |
|---|---|
| 按交付状态执行 `seed-curriculum.sql`（无 `system_initializer` 教师） | 脚本**报告成功、无任何报错、插入 0 行** |
| 先创建 `system_initializer` 教师，再执行 | **插入 347 行**（prek 303 + k 44），与 README 声称完全一致 |
| 第 3 次执行 | 仍为 347 行 → **幂等** |
| 347 行中带文件引用的 | **0 行** → 可下载资源 **0 个** |
| 种子创建的 `subject_permissions` | **0 行** |

> 结论：种子的**数据质量是好的**，但**依赖一个全仓库无处创建的教师账号**，因此按交付状态安装后系统是空的。`system_initializer` 在仓库中出现 349 次，**全部位于 seed 文件自身**。

---

## F. API 契约问题（前后端错位）

| # | 前端调用 | 服务端实际 | 后果 | 等级 |
|---|---|---|---|---|
| F-1 | `GET /api/resources/mine`（`api/resources.ts:69`） | 无此路由 → 落入 `@Get(':id')`，以 `'mine'` 查询 uuid 主键 | 500（异常过滤器只检查顶层 `code==='22P02'`，未遍历 `cause` 链；Drizzle 把驱动错误包在 `cause`）。`getMyResources()` 服务方法**无任何 controller 调用** | **致命** |
| F-2 | `POST /api/review/resources/:id`（`api/review.ts:24`） | `POST /api/resources/:id/review` | 404，**审核通过/退回全部失败** | **致命** |
| F-3 | `GET /api/review/resources/:id/history`（`api/review.ts:32`） | `GET /api/resources/:id/review-history` | 404，审核历史不可用 | **致命** |
| F-4 | `PATCH /api/teachers/:id/permissions`（`api/teachers.ts:69`） | `POST /api/teachers/:id/permissions` | 404，**权限矩阵无法保存** | **致命** |
| F-5 | 下载时期望 JSON `{downloadUrl}`（`resource-card.tsx:101-109`） | `res.redirect(302, …)` + `Content-Disposition` | axios 跟随后返回文件字节 → `result?.downloadUrl` 为 `undefined` → **按钮无反应、无报错、无提示** | **高** |
| F-6 | 新建教师后丢弃响应（`TeacherFormDialog.tsx:121`） | 服务端随机生成临时密码且**仅在该响应返回一次** | **管理员永远拿不到新账号初始密码**，只能再走一次重置 | **高** |
| F-7 | 前端调 `getResources({pageSize:1})` 当计数器 | `dashboard/stats` 就是干这个的 | 4~5 次多余往返 | 低 |
| F-8 | `api/dashboard.ts:3-13` 本地重复声明 `TeacherDashboardStats` | `shared/api.interface.ts` 无此类型；并在 `:19-22` 用 `myPublished ?? published ?? 0` 打补丁 | 契约漂移被掩盖 | 中 |
| F-9 | `getAuthConfig` / `getFolders` / `getRoles` / `getPendingReviews` | 端点存在 | **零调用方**（死代码） | 低 |
| F-10 | 前端 `ReviewPage.tsx:61` 用 `getResources({status:'pending_review'})` | 存在专用端点 `/api/review/pending` | 语义重复 | 低 |

### F-11 数据命名不一致（导致资源在 UI 中不可达）

| 位置 | 约定 | 例 |
|---|---|---|
| 前端路由/链接 | **kebab-case** | `practical-life`、`english-language`、`chinese-language` |
| 数据库 `sub_subject` / 种子 | **snake_case** | `practical_life`、`english_language`、`chinese_language` |
| 转换代码 | **全仓库不存在任何 kebab→snake 转换** | — |

→ `/prek/montessori/practical-life` 查询命中 **0 条**。受影响：79 + 43 + 1 = **约 122 条 Pre-K 资源在 UI 中不可访问**。
单词型子科目（`sensorial`/`math`/`culture`）恰好同名所以正常 → 属于**局部性 bug**，更易漏测。 [已证实]

### F-12 K 英文主题不一致

前端 `THEME_SLUG_MAP` 发送 `theme=Myself`；种子里存的是 `主题1：我自己` → **44 条 K 资源全部查不到**。 [已证实]
且 K 英文周次的 semester/week **只写在标题里**（`主题1：我自己 - S1 W1`），`semester` / `week_number` 列为 NULL → 学期/周次筛选对其无效。 [已证实]

---

## G. 公网部署问题

| # | 问题 | 等级 | 证据 |
|---|---|---|---|
| G-1 | **`npm install` 失败（exit 127）** —— `postinstall` 执行 `fullstack-cli action-plugin init`，而 `fullstack-cli` 不可解析（lockfile 零命中） | **致命** | [已证实，本机实测] |
| G-2 | **`npm run build` 必然失败** —— `scripts/build.sh:188` 调用不存在的 `scripts/prune-smart.js`，脚本开头为 `set -euo pipefail` | **致命** | [已证实] |
| G-3 | **`npm run dev` 不可用** —— `scripts/dev.sh` 不存在 | **高** | [已证实] |
| G-4 | **`npm run start` 不可用** —— 写死 `node main.js`，而构建产物为 `dist/server/main.js`（`nest-cli.json` 无顶层 `outDir`、`tsconfig.node.json` `outDir=./dist`、`stripLeadingPaths:false`、自动生成的 `run.sh` 亦印证 cwd=`dist/`） | **高** | [推断，待 build 产物验证] |
| G-5 | `npm run lint` / `npm run precommit` 指向不存在文件；`prepare` 静默把 `core.hooksPath` 指向不存在的 `.githooks/` | 中 | [已证实] |
| G-6 | **无 Dockerfile / docker-compose / CI / IaC** —— 仓库无任何部署自动化资产 | **高** | [已证实] |
| G-7 | **无健康检查端点**（`/api/health` 不存在） | **高** | [已证实] |
| G-8 | **无 `trust proxy` 配置** → HTTPS 判断、客户端 IP、审计全部可能出错（见 D-10） | **高** | [已证实] |
| G-9 | **无安全响应头**（HSTS / CSP / X-Content-Type-Options / Referrer-Policy / Permissions-Policy）。需确认平台 `configureApp` 是否已注入，本机无法验证 | **高** | [无法验证] |
| G-10 | **无 requestId** → 线上问题无法追踪 | 中 | [已证实] |
| G-11 | **错误响应不统一**：`GlobalExceptionFilter` 输出 `{error:{code,message,details,stack,…}}`，但 5xx 分支会把 **`stack` 与 `cause` 直接返回给客户端** → 公网信息泄露 | **高** | `exception.filter.ts:62-73` [已证实] |
| G-12 | `.env.example` 未包含代码实际使用的变量（`SERVER_HOST`/`SERVER_PORT`/`CSRF_STATE_TTL_SECONDS`/`CLIENT_BASE_PATH`/`NODE_ENV`），却声明了 3 个从不读取的 `LOG_*` | 中 | [已证实] |
| G-13 | `components.json:8` 指向不存在的 `client/src/shadcn.css` | 低 | [已证实] |
| G-14 | **硬耦合平台 HBS 占位符**：产物 HTML 含 `{{csrfToken}}`/`{{userId}}` 等，靠服务端 Handlebars 替换。脱离本应用的渲染链路（例如把 client 产物直接丢到纯静态 CDN）会导致 CSRF 与用户上下文全部失效 | **高** | [已证实] |
| G-15 | 平台存储代理路径 `/api/__platform__/storage/download` 由平台提供，**本仓库未定义**。脱离平台部署时该端点不存在 | **高** | [已证实] |
| G-16 | **`package-lock.json` 仅含 `linux-x64` 平台可选依赖**（实测平台门控条目共 12 条，全部为 `linux \| x64`；`darwin-*` 条目为 **0**）。lockfile 生成于 linux-x64（aPaaS 构建机）。后果：在 macOS/arm64 等非 linux-x64 机器上 `npm install` 产出的依赖树**无法构建**，5 个原生绑定全缺 | **高（可复现性阻塞）** | [已证实] |
| G-17 | **`scripts/build.sh` 步骤 0 阻塞在交互式提示**：`npx fullstack-cli` 拉取到**同名但无关的第三方包**（提示 `What do you want to create? front / back / catalog`），非 TTY 环境（CI / Docker）**exit 130** 中止。比步骤 6 的 `prune-smart.js` 更早触发，是 `npm run build` 失败的首要原因 | **致命** | [已证实] |

---

## H. 测试缺口

| # | 缺口 | 现状 |
|---|---|---|
| H-1 | **零测试文件** | 全仓库无 `*.spec.ts` / `*.test.ts`，`tsconfig` 中 `**/*.spec.ts` 的 exclude 只是模板残留 |
| H-2 | 无测试运行器 | `package.json` 无 `test` 脚本；未安装 jest / vitest / supertest |
| H-3 | 无 RBAC 矩阵测试 | — |
| H-4 | 无安全回归测试（越权 / IDOR / 提权 / CSRF / 暴破 / 停用生效） | — |
| H-5 | 无 migration 测试 | — |
| H-6 | 无 E2E | — |
| H-7 | 无 build / 生产启动冒烟测试 | — |
| H-8 | 无依赖漏洞审计基线 | 未执行 `npm audit` |

---

## I. 数据迁移风险

| # | 风险 | 说明 |
|---|---|---|
| I-1 | **现有数据规模未知** | 交付包中**没有数据库导出**。现有 347 条资源、20 个账号、审核记录、审计日志**只存在于用户的线上/测试库中**，本机无法读取 |
| I-2 | **无法在本机做真实备份** | 本机没有用户的数据库连接。**备份必须由部署环境执行**，本文档不假装备份完成 |
| I-3 | 命名映射迁移风险 | 修正 kebab/snake 需 `UPDATE resources SET sub_subject=…`，必须**幂等 + 可回滚**，且不能误伤单词型科目 |
| I-4 | K 英文主题迁移风险 | 需把中文 theme 与前端 slug 建立映射表；映射不全会导致部分资源查不到 |
| I-5 | 角色体系升级风险 | 新增 `super_admin` 与权限表，必须不影响既有 8 角色的既有行为 |
| I-6 | `teachers.wecom_user_id NOT NULL` 冲突 | 现有库若由平台生成则该项可空；若由 `init.sql` 生成则**无法插入账号**。迁移前必须探测 |
| I-7 | 权限版本号引入 | 新增 `permissions_version` 会使所有既有会话失效（设计意图），需提前告知 |
| I-8 | 系统字段语义 | `_created_by`/`_updated_by` 当前为 NULL/`'()'`，若改为真实值需考虑历史数据 |

---

## J. 必须修复（公网发布阻塞项）

**J-1 安装与构建可用性**
1. 修复 `postinstall`（移除/替换不可解析的 `fullstack-cli`）。
2. 修复 `scripts/build.sh` 对 `prune-smart.js` 的依赖。
3. 补齐 `scripts/dev.sh`，统一 `dev`/`build`/`start`/`start:prod` 命名。
4. 确认并修正 `start` 的产物路径。

**J-2 数据库唯一来源与迁移**
5. 建立 `migrations/` + `schema_migrations` + 校验和 + 回滚方案。
6. 一次性对齐 `init.sql` / `schema.ts`：补 6 个认证字段、统一 `wecom_user_id` 可空性、补角色与类型创建、policy 改为幂等。
7. 迁移必须先自动备份并写入 `MIGRATION_REPORT.md`。

**J-3 种子与启动**
8. 明确 `system_initializer` 的创建方式（或改为真实上传者），使种子真正生效。
9. 初始化失败必须**让进程失败退出（非 0）**，禁止 catch 后假装启动成功。

**J-4 认证与权限**
10. 引入 `super_admin`，且**只有 super_admin 能管理 super_admin**（DB 层 + 应用层双重保护）。
11. 统一 RBAC 契约源 `shared/rbac.ts`：角色、权限、scope 单一来源，消除 5 处角色清单不一致。
12. `AuthorizationService` + `PermissionGuard` 统一授权入口，替换散落的 `roles.includes(...)`。
13. **数据范围 Scope**（ALL / PROGRAM / SUBJECT / OWN）。
14. `permissions_version` 实现权限变更即时生效。
15. 停用账号 → 会话立即失效。
16. `ValidationPipe`（whitelist + forbidNonWhitelisted + transform）。
17. 禁止自我提权、禁止授予高于自己的角色、`roles` 白名单校验。
18. MFA/TOTP 用于 super_admin（含恢复码、加密存储、一次性展示）。
19. 渐进式密码 hash 升级（不使现有密码失效）。

**J-5 会话与传输**
20. Cookie 前缀 `__Host-`、`SameSite` 按架构择最严、`Path=/`。
21. `trust proxy` 正确配置，只信任可信代理。
22. 限流抽象为可替换 `RateLimitStore`（内存 → 分布式）。
23. 会话补充 `revoked_at` / `revoke_reason` / 设备信息 / 强制下线接口。

**J-6 数据库安全**
24. 移除全部 `USING (true)` / `WITH CHECK (true)` 写策略，特别是 `anon` 对 `teachers` / `sessions` 的写权限。
25. 证明每个 DB 角色的实际用途；浏览器不得直连数据库。

**J-7 文件**
26. 真实上传（服务端生成 key，不信任客户端 bucket/path）。
27. 真实签名下载（`FileService.createSignedUrl` 或 S3 兼容签名），短时效。
28. 类型/扩展名/Magic Bytes 校验，大小与请求体限制，ZIP 炸弹/路径穿越防护。
29. 软删除 + 回收站；永久删除仅 super_admin 且需二次认证。
30. 清理 `placeholder-bucket`、伪造路径、TODO URL、以及渲染给用户的 "TODO:" 文案。

**J-8 API 契约**
31. 修复 F-1 ~ F-6 全部错位。
32. 下载改为与前端的契约一致的实现。
33. 新建教师必须把一次性临时密码返回并在 UI 展示。

**J-9 数据一致性**
34. 统一 kebab/snake（`shared/canonical.ts` + 迁移脚本修复既有数据）。
35. 统一 K 英文 theme；补齐 `semester` / `week_number`。
36. 资源状态机后端强制合法迁移；管理员绕过审核需独立权限。
37. 修复 `ROLE_DEFINITIONS` 漏 `k_assistant`。

**J-10 可观测与运维**
38. `/api/health` + `/api/health/ready`。
39. requestId 贯穿响应头/日志/审计。
40. 错误响应统一且**脱敏**（不得返回 stack/cause/SQL/路径）。
41. 安全响应头（HSTS/CSP/X-Content-Type-Options/Referrer-Policy/Permissions-Policy）。
42. 日志脱敏白名单（禁 password/cookie/sessionId/MFA secret/recovery code/DSN/存储密钥）。
43. CORS 收敛到 `PUBLIC_APP_URL`，禁止 `*` + credentials。
44. 备份脚本 + **恢复演练**。

**J-11 测试与闸门**
45. 引入测试栈并补齐：单元 / service / controller / API 集成 / E2E / 安全回归 / migration / build。
46. `scripts/predeploy-check.sh` 发布闸门，失败即输出 `NOT READY FOR PRODUCTION`。

**J-12 文档**
47. `PRODUCTION_READINESS.md`（本文）、`SECURITY.md`、`RBAC.md`、`DEPLOYMENT_PRODUCTION.md`、`DISASTER_RECOVERY.md`、`MIGRATION.md`、`MIGRATION_REPORT.md`。
48. 重写 `README.md` / `DEPLOYMENT.md` / `AGENTS.md`，使其与真实代码一致（尤其 **删除 WeCom OAuth 与不存在的路由**）。

---

## K. 可以延期（不阻塞公网发布）

| # | 项 | 理由 |
|---|---|---|
| K-1 | 删除 80 个文件的 `business-ui` 死代码（420 KB） | 安全无关；但需先 grep 全仓引用 + build 验证后才可删 |
| K-2 | 清理 39 个未使用 shadcn 原语 / 23 个图标组件 | 同上 |
| K-3 | 移除未使用的重依赖（echarts / recharts / embla / input-otp / vaul / react-day-picker / cmdk） | 仅影响体积；react-query 需等 business-ui 决策后处理 |
| K-4 | 前端 i18n 三套机制（字典 / `L()` / 硬编码）统一 | 不影响安全 |
| K-5 | `AuditLogPage` 导出 CSV 目前 disabled | 功能增强 |
| K-6 | 死代码 `getPublicDownloadUrl` / `getPublicStorybookCoverStream` / `generateState` 清理 | **注意：删除前必须确认未被路由**；或直接删除以消除 D-7 隐患（建议提前到 J） |
| K-7 | `components.json` 指向不存在的 css | 仅影响 shadcn CLI |
| K-8 | `.prettierrc` 未生效（未安装 prettier） | 开发体验 |
| K-9 | 优化 `getResources({pageSize:1})` 计数为 `dashboard/stats` | 性能 |
| K-10 | 前端按键/分页/排序等 UX 增强 | 非安全 |

---

## L. 数据迁移前置清单（必须在动数据库**之前**完成）

> 规则：**禁止直接删除数据库重建；禁止用重建数据库代替迁移；禁止重置 seed。**
> 下列动作**需要部署环境提供**，因为本机无法访问用户的真实数据库。

| # | 动作 | 命令/方式 | 状态 |
|---|---|---|---|
| L-1 | 数据库备份 | `pg_dump "$DATABASE_URL" -Fc -f backup_$(date +%Y%m%d_%H%M%S).dump` | ⬜ **待部署环境执行** |
| L-2 | 导出当前 schema | `pg_dump "$DATABASE_URL" --schema-only -f schema_before.sql` | ⬜ **待部署环境执行** |
| L-3 | 保存数据统计 | tools 脚本 `scripts/db-snapshot.mjs`（**将提供**） | ⬜ 待实现 |
| L-4 | 资源数量 | 同上 | ⬜ |
| L-5 | 教师账号数量 | 同上 | ⬜ |
| L-6 | 权限数量 | 同上 | ⬜ |
| L-7 | 审核记录数量 | 同上 | ⬜ |
| L-8 | 审计日志数量 | 同上 | ⬜ |
| L-9 | 记录迁移前版本 | `schema_migrations` 表 + 手动记录 | ⬜ |
| L-10 | 生成可回滚方案 | 每个 migration 配套 `NNNN_*.down.sql` | ⬜ 待实现 |

**明确声明：本机当前无法对用户数据库执行 L-1 ~ L-10。不得声称备份已完成。**

---

## M. 当前总体判定

```
PRODUCTION STATUS: NOT READY
```

### 阻塞项（按优先级）

1. **安装与构建不可用**（`npm install` exit 127、`npm run build` 必挂、`dev`/`start` 不可用）—— 无法产出可部署产物。
2. **数据库无单一来源、无迁移机制，且 `init.sql` 在原生 PG 上无法执行、重复执行会失败、缺 6 个认证字段** —— 无法安全建库或升级。
3. **种子按交付状态静默插入 0 行** —— 安装后系统为空。
4. **6 处前后端 API 错位** —— 审核、权限矩阵、"我的资源"核心功能全部不可用。
5. **零测试** —— 任何改动都无回归保护，公网发布不可接受。
6. **RBAC 不统一、无 super_admin、无数据范围、无权限即时生效机制** —— 不满足第 3/4/5/6 条目标。
7. **文件上传下载未实现**（0 个可下载资源 + 未签名 URL + 客户端可伪造存储坐标）。
8. **RLS 名存实亡**（全 `USING(true)`，`anon` 可改 `teachers`/`sessions`）。
9. **无健康检查 / requestId / 安全响应头 / 错误脱敏 / CORS 收敛**。
10. **`.gitignore` 未忽略 `.env`** + 20 个生产密码哈希入库。
11. **应用与妙搭平台硬耦合**：无 `FORCE_AUTHN_INNERAPI_DOMAIN` 时 DI 容器直接失败、进程退出（§O-1）。VPS/Docker 路线必须先解除该耦合。

---

## O. 实测证据日志（本轮新增，全部可复现）

> 每条都附命令与观察结果。**没有实测证据的结论一律不列入"已修复"。**

### O-1 应用在平台之外**无法启动**（新增致命发现）

```
$ cd dist && SUDA_DATABASE_URL=... NODE_ENV=production node server/main.js
ERROR [ExceptionHandler] 平台模式需要基础域名，请设置环境变量 FORCE_AUTHN_INNERAPI_DOMAIN
Error: 平台模式需要基础域名，请设置环境变量 FORCE_AUTHN_INNERAPI_DOMAIN
    at resolvePlatformBaseURL (@lark-apaas/http-client/dist/index.js:305:11)
    at new HttpClient (...)
    at new PlatformHttpClientService (@lark-apaas/fullstack-nestjs-core/dist/index.cjs:35153:19)
```
**进程退出，端口未监听。** `PlatformHttpClientService` 是 `PlatformModule` 的常驻 provider，因此**只要引入 `PlatformModule` 就要求平台域名**。
→ 直接阻塞"路线 A：VPS + Docker"。已在 §J 增加解除耦合任务。

### O-2 **好消息：解除耦合后可以独立运行**（已实测）

以真实 PostgreSQL 16.14 + 假域名启动：
```
$ FORCE_AUTHN_INNERAPI_DOMAIN="https://127.0.0.1:1" \
  SUDA_DATABASE_URL="postgres://...@127.0.0.1:55432/qls_prod_test" \
  NODE_ENV=production SERVER_PORT=3101 node server/main.js

LOG [InstanceLoader] AppModule dependencies initialized
LOG [NestApplication] Nest application successfully started
LOG [Bootstrap] Server running on 127.0.0.1:3101
LOG [Bootstrap] API endpoints ready at http://127.0.0.1:3101/api

$ curl http://127.0.0.1:3101/api/auth/config
HTTP 200  {"loginType":"password"}
```
**结论：应用可以在自有 PostgreSQL 上独立运行。** 需要的条件：
1. 设置 `FORCE_AUTHN_INNERAPI_DOMAIN`（不用平台鉴权时可为占位值）；
2. 使用自有存储实现替换平台 dataloom（见 §J-7）；
3. 接受平台遥测不可用（仅出现一次 `cache-service: failed to read token file /var/run/secrets/zti/credential` 警告，不影响启动）。

替代方案（更干净）：`PlatformModule.forRoot({ httpClient: { enabled: false } })` —— 源码已确认 `resolvePlatformBaseURL` 在 `!options.enabled` 时直接返回，不读域名。

### O-3 §E-4 / §E-5 / §J-3 **在运行时被证实**

同一份启动日志中，20 个种子账号**全部失败**：
```
ERROR Failed to seed teacher k-teacher02: ... column "password_hash" does not exist
ERROR Failed to seed teacher pe-teacher01: ... column "password_hash" does not exist
...（共 20 条）
LOG   Seed teachers: created=0, skipped=0
LOG   Nest application successfully started        <-- 仍然报告启动成功
```
**证实：**
- `init.sql` 建出的 `teachers` 表缺 6 个认证字段 → 每个 seed 都 `42703`；
- 20 个失败被 `auth.service.ts:200-207` 的 `try/catch` **逐个吞掉**；
- 应用**报告"启动成功"**，而实际可用账号数为 **0** —— 这正是"禁止 catch 后继续假启动"要修的缺陷（§J-3）。

### O-4 安装与构建：修复前 / 修复后（均已实测）

| 项目 | 修复前 | 修复后 |
|---|---|---|
| `npm install` | **exit 127**（`fullstack-cli: command not found`） | **exit 0**，`added 1500 packages` |
| `npm run build:server` | exit 1（`@swc/core` 原生绑定缺失） | **exit 0**，`Successfully compiled: 43 files with swc` |
| `npm run build:client` | exit 1（`rolldown`/`lightningcss`/`oxide` 绑定缺失） | **exit 0**，`✓ 3802 modules transformed`，`built in 2.56s` |
| `npm run build`（build.sh） | exit 130（步骤 0 交互式提示挂起）→ 之后 exit 1 | **exit 0**，`构建完成`，产物 11 MB |
| 入口 HTML 位置 | `dist/dist/client/` 只有 `favicon.svg`，**HTML 丢失** | **`dist/dist/client/index.html` 5676 B 存在** |
| `npm run dev` | `scripts/dev.sh` 不存在 | 已创建 |

### O-5 `package-lock.json` 的平台覆盖缺陷（已实测）

```
lockfileVersion 3 · 1513 packages · 平台门控条目 12 条 —— 全部为 linux | x64
darwin-arm64 条目：0
```
在该机器（darwin/arm64）上全新 `npm install` 后，5 个原生绑定**全部缺失**：
`@swc/core-darwin-arm64`、`@rolldown/binding-darwin-arm64`、`lightningcss-darwin-arm64`、`@napi-rs/nice-darwin-arm64`、`@tailwindcss/oxide-darwin-arm64`。

同时确认：**这些包在 npmmirror 上均可获取（HTTP 200/302）**，因此**不是镜像缺失**，而是 lockfile 不含这些平台条目。我此前一度把原因错判为"install 被中断"，已通过实验（`--os`/`--cpu` 无效、lockfile 未变）**修正为现在这个结论**。

影响：
- **部署目标 linux-x64（aPaaS）不受影响** —— lockfile 对其是正确的，**不应盲目重新生成**（重新生成会反过来丢掉 linux 条目）。
- **macOS/arm64 开发者与 arm64 CI 无法构建**。需要提供平台预检脚本 + 明确的补救命令，并写进文档。

### O-6 已完成的修复清单（本轮）

| 文件 | 变更 | 验证 |
|---|---|---|
| `scripts/postinstall.mjs` | 新增：受控、非交互的插件初始化；有 `capabilities/` 才执行，且只用本地可解析的 CLI（绝不联网下载同名第三方包）；可用 `QLS_STRICT_PLATFORM_CLI=1` 变硬失败 | `npm install` exit 0 |
| `package.json` | `postinstall` 改指向上述脚本；`start` 修正为 `cd dist && node server/main.js`；新增 `start:prod` / `lint` / `migrate` / `migrate:status` / `db:snapshot` / `test` / `predeploy`；移除会把 `core.hooksPath` 指向不存在目录的 `prepare` | `npm run start` 路径与产物一致 |
| `scripts/build.sh` | 步骤 0 受控非交互（修复 exit 130）；步骤 6 `prune-smart.js` 缺失时跳过而非失败；`du dist/node_modules` 加守卫；**步骤 5 入口 HTML 改为递归搬迁 + 提升到 `dist/dist/client/index.html` 并在缺失时硬失败** | `npm run build` exit 0 |
| `scripts/dev.sh` | 新增：`concurrently` 同时起 server/client | 存在且可执行 |
| `.gitignore` | 新增 `.env` / `.env.*`、密钥、备份、dump、`uploads/`、`.devtools/` 规则 | — |
| `scripts/dev-postgres.sh` | 新增：本地真实 PostgreSQL 16 验证环境（start/stop/status/psql/destroy） | PG 16.14 已跑通 |
| `PRODUCTION_READINESS.md` | 本文档 | — |

### O-7 本机验证环境现状（可用于后续阶段的真实测试）

| 能力 | 状态 |
|---|---|
| Node 22.23.1 / npm 10.9.8 | ✅ |
| 依赖 + 5 个原生绑定 | ✅ |
| PostgreSQL 16.14 @ 127.0.0.1:55432 | ✅ 运行中 |
| `tsc` server+client | ✅ 均通过 |
| `npm run build` | ✅ exit 0 |
| 生产模式启动 + 真实 API 200 | ✅ 已证实 |
| Docker | ❌ 本机不可用（容器化交付需在部署环境验证） |
| 平台 dataloom / vefaas | ❌ 不可用 |

### 已确认**不**是问题的项（避免无谓改造）

- CSRF 链路**实际可用**（§D-0），无需重写，只需在非平台部署时确保 HBS 占位符仍被替换。
- `tsc` 类型检查**基线干净**（server/client 均通过），不需要大规模类型修复。
- 种子**数据质量良好且幂等**，347 条 JSON 全部合法、34 张封面完全对应；问题只在"依赖缺失的教师账号"。
- 密码学处理（scrypt + `timingSafeEqual` + 随机 salt）、会话哈希存储、生产 `Secure` 强制、登录锁定与 IP 限流、审计覆盖失败路径 —— **实现正确，保留**。
- `init.sql` 本身的 DDL 有效（补齐平台前置类型/角色后实测可完整执行）。

---

## N. 下一步（阶段推进计划）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段 1 | 只读完整审计 | ✅ 完成（本文档） |
| 阶段 2 | `PRODUCTION_READINESS.md` | ✅ 完成（本文档） |
| 阶段 3 | 设计 RBAC / Permission / Scope / super_admin → `RBAC.md` | ⬜ 进行中 |
| 阶段 4 | 实现可迁移可回滚 migration + 备份/快照工具 | ⬜ |
| 阶段 5 | 后端授权与安全机制（AuthorizationService / PermissionGuard / MFA / Session / CSRF / 限流 / trust proxy） | ⬜ |
| 阶段 6 | 文件存储生产化（上传 / 签名下载 / 校验 / 软删除） | ⬜ |
| 阶段 7 | 修复全部 API 契约错位 | ⬜ |
| 阶段 8 | 分层测试 + 安全回归测试 | ⬜ |
| 阶段 9 | 执行 migration + build + 生产启动验证 | ⬜ |
| 阶段 10 | 公网安全验收 + 发布闸门 + 最终报告 | ⬜ |

---

*本文件在阶段 3 起将持续更新；任何"已修复"结论都必须附实测证据（命令 + 输出），否则仍标 ⬜。*
