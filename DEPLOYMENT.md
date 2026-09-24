# DEPLOYMENT.md（已归档）

> **本文档已归档，请勿据此部署。**
>
> 生产部署的权威文档是 **`DEPLOYMENT_PRODUCTION.md`**。本文档保留的仅有妙搭平台
> 相关的历史说明，且早于本次生产加固，其中的环境变量、`dist/` 启动路径、
> 数据库构建流程与上传/下载鉴权模型**均已过时**。

## 请改用

| 需求 | 文档 |
|---|---|
| 生产部署完整步骤、必需环境变量 | `DEPLOYMENT_PRODUCTION.md` |
| 数据库迁移与回滚 | `MIGRATION.md` |
| 备份与恢复（含尚未执行的演练） | `DISASTER_RECOVERY.md` |
| 日常运维、排障、密钥轮换 | `RUNBOOK.md` |
| 安全模型与已知缺口 | `SECURITY.md` |
| 发布闸门与阻塞项 | `PRODUCTION_RELEASE_REPORT.md` |

## 三个最容易踩的坑

1. **从零建库**：`init.sql` 与迁移 `0001` **互为前提**，单独执行任一都会失败。
   必须用 `bash scripts/db-bootstrap.mjs --url "$DATABASE_URL"`。
2. **`trust proxy`**：平台 `configureApp()` 会硬编码 `app.set('trust proxy', true)`，
   因此应用必须在**其后**再设置一次，否则 `X-Forwarded-For` 可被伪造，
   客户端 IP 与 `audit_logs.ip_address` 全部失真，按 IP 的登录限流也可被绕过。
3. **必需密钥**：`MFA_ENCRYPTION_KEY` 与 `DOWNLOAD_TOKEN_SECRET` 缺失时对应功能
   **明确失败**（不会退化成无签名链接或明文存储）。各用 `openssl rand -base64 32`
   生成，两者不可复用。

原文不再保留：其中包含与新文档冲突的可执行指令，保留会造成误用。

---

## 妙搭（aPaaS）平台专章 —— 现行、可核对的要点

> 以下每条都标注了证据来源。**未标注 [已证实] 的，一律视为需要平台侧确认。**
> 平台内部实现（发布管线、vefaas、dataloom 控制面）本仓库无法读取，
> 相关行为统一标 **[无法验证]**。

### 1. 平台会预先提供什么

| 项 | 说明 | 证据 |
|---|---|---|
| **数据库**（含 `user_profile` 复合类型与 `anon`/`authenticated`/`service_role` 角色） | 这是"从零建库必须用 `db-bootstrap.mjs`"这个缺陷**在平台上从未暴露**的原因：平台在 `init.sql` / 迁移运行之前就把类型与角色准备好了 | `scripts/db-bootstrap.mjs` 文件头 [已证实] |
| **连接串** | 以 `SUDA_DATABASE_URL` 注入。应用侧读取顺序为 `MIGRATION_DATABASE_URL` > `DATABASE_URL` > `SUDA_DATABASE_URL` | `scripts/migrate.mjs:79-91` [已证实] |
| **请求上下文 / 角色切换** | `@lark-apaas/nestjs-datapaas` 的 `SqlExecutionContextMiddleware` 对**每个请求**执行 `SET LOCAL app.user_id` 与 `SET LOCAL ROLE 'anon_<roleSchema>' \| 'authenticated_<roleSchema>' \| 'service_role_<roleSchema>'`，`<roleSchema>` 取自连接串的 `schema` 参数 | migration `0004` 文件头 [已证实] |
| **CSRF 中间件与 cookie** | 平台中间件**无条件**下发 `suda-csrf-token` cookie（属性被硬编码为 `Secure; SameSite=None; Partitioned`，本机 curl 实测确认） | `PRODUCTION_READINESS.md` §D-0/D-1 + 本次实测响应头 [已证实] |
| **HTML 渲染占位符** | 产物 HTML 含 `{{csrfToken}}` / `{{userId}}` 等 HBS 占位符，需由本应用的 Handlebars 渲染链路替换 | `server/main.ts:24,67-69`；`PRODUCTION_READINESS.md` §G-14 [已证实] |
| **对象存储** | dataloom，经由 `@lark-apaas/file-service`（由 `fullstack-nestjs-core` 再导出为 `FileService`）。下载的实际签名直链由它提供；平台存储不可用时本应用返回**明确 503**，不返回占位 URL | `server/modules/files/files.service.ts:1-45` [已证实] |

### 2. 平台部署**必须**满足的硬性条件

| 条件 | 不满足时 |
|---|---|
| 设 `FORCE_AUTHN_INNERAPI_DOMAIN`（或改用 `PlatformModule.forRoot({ httpClient: { enabled: false } })`） | **进程直接退出**：`平台模式需要基础域名，请设置环境变量 FORCE_AUTHN_INNERAPI_DOMAIN`。原因：`PlatformHttpClientService` 是 `PlatformModule` 的常驻 provider，只要引入 `PlatformModule` 就要求该域名 | `PRODUCTION_READINESS.md` §O-1 [已证实] |
| 应用连接角色是 `anon_` / `authenticated_` / `service_role_` 的**成员** | `SET LOCAL ROLE` 失败 → `42501`；表现为**登录报"用户名或密码错误"且不写审计**（查不到任何行） | migration `0004:48-54` [已证实] |
| 入口 HTML 必须经本应用渲染（不能把 client 产物直接丢到纯静态 CDN） | CSRF 与用户上下文**全部失效** | `PRODUCTION_READINESS.md` §G-14 [已证实] |
| 生产用 HTTPS 访问 | 平台 CSRF cookie 带 `Secure`；且应用在生产强制会话 cookie `Secure` → **HTTP 下无法登录** | `session.service.ts:47-51` + 实测 cookie 属性 [已证实] |
| 不要把 `client/` 产物的 HTML 上传到公网 CDN | 同上（HTML 必须留在服务端渲染路径上） | `scripts/build.sh:165-166` 的注释 [已证实] |

### 3. 与本应用自建实现的边界（**不要重复实现**）

| 能力 | 由谁提供 |
|---|---|
| 认证/授权 | **本应用**（`AuthGuard` + `PermissionGuard` + `AuthorizationService`）—— 平台的用户上下文是空的，不能用作授权依据 |
| CSRF 校验 | **本应用**（`CsrfCheckMiddleware`，双提交令牌）；平台自带校验被 `PlatformModule.forRoot({ enableCsrf: false })` 关闭，但**cookie 仍由平台中间件下发** | `server/app.module.ts:21` + `csrf-check.middleware.ts` [已证实] |
| 会话存储 | **数据库**（`sessions` 表），非平台能力 |
| 文件签名直链 | **平台**（`FileService`）；**访问控制**在本应用（下载令牌 + 资源权限判定） |
| 迁移 | **本应用**（`scripts/migrate.mjs` + `server/database/migrations/`），**不要**用平台控制台手工改结构：手工 DDL 不受 advisory lock 与校验和保护 |

### 4. [无法验证] 的项（需平台侧确认，不得在验收中假定）

- vefaas / 妙搭发布管线对产物结构的要求，以及对 `{{...}}` HBS 占位符的替换行为。
- `miaoda db sql` 等平台 CLI 的**当前**可用性与语义（旧 `DEPLOYMENT.md` 曾以它为主路径，
  但本文档**未能验证该命令仍存在**，因此不再给出可执行指令）。
- dataloom bucket 是否私有、路径是否可枚举、是否有版本化/备份能力。
- 平台侧账号与密钥的隔离与审计能力。
- 生产库的实际角色名（是否带 workspace 后缀）—— 用
  `SELECT rolname FROM pg_roles WHERE rolname LIKE 'anon%' OR rolname LIKE 'authenticated%' OR rolname LIKE 'service_role%';`
  现场确认；若带后缀，需按 `server/database/fix-rls-policies.sql` 的思路处理。 [推断]

### 5. 独立部署（VPS / Docker）与平台部署的差别

| 项 | 平台部署 | 独立部署 |
|---|---|---|
| 数据库角色 | 平台按 `schema` 参数决定（通常带后缀） | **空后缀** `anon_` / `authenticated_` / `service_role_`，需由 migration `0004` 创建并授权 |
| 用户上下文 | 平台注入 | **为空** → 每个请求都跑在 `anon_` 上 → **应用层鉴权是唯一关卡**（`SECURITY.md` §8.2） |
| 文件存储 | dataloom 可用 | 需替换实现；当前 `FilesService` 会返回明确的 **503**（不会伪造 URL） |
| 基础域名 | 平台提供 | 必须自设 `FORCE_AUTHN_INNERAPI_DOMAIN`（可用占位值，实测可独立运行） |
| 容器化 | 平台构建 | 仓库**没有** Dockerfile / 编排文件，需自行编写；**本机无 docker，无法验证** |

