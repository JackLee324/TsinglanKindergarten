# 脱平台（移除妙搭 @lark-apaas 依赖）— 证据与结果

**日期**：2026-09-26
**范围**：`qls-kindergarten-resource-platform-v1.3.0` 全仓

这次改动的目标只有一个：把妙搭（ByteDance 妙搭 / miaoda aPaaS）平台依赖**彻底移除**，
让应用成为普通的 NestJS + React 项目，可以独立部署在 Zeabur / Docker / VPS 上。
所有改动都是**管线迁移**：界面、数据、路由、i18n、安全控制都不允许变化。

---

## 1. 结论一览

| 验证 | 改动前 | 改动后 |
|------|--------|--------|
| `npm test` | 225 个用例，**224 pass / 1 fail** | **225 pass / 0 fail**（gate 语境下 230/230） |
| `npm run type:check:server` | PASS | PASS |
| `npm run type:check:client` | PASS | PASS |
| `npm run build` | PASS | PASS |
| `scripts/verify-e2e-deploy.sh` | **31/31 PASS** | **36/36 PASS** |
| `scripts/verify-all.sh`（HTTP 门禁） | **红**：authz-http / mfa / security-headers / files-http / naming-http 全部 FAIL | **绿**：74+10+55+20+74+49 = **282/282** |

> 门禁在改动前是**红的**，而且红的原因正是这次要删掉的那个绕行（见 §4）。

平台依赖的最终状态：

| 位置 | 平台导入数 |
|------|-----------|
| `server/` `client/` `shared/` `scripts/` `tests/` | **0**（`grep -rnE "(from\|require\()\s*['\"]@lark-apaas"` 无匹配） |
| `package.json` | **0** 条 |
| `package-lock.json` | **0** 个 node、**0** 条声明 |
| 构建出的镜像 `node_modules/@lark-apaas` | **0** 个目录（镜像由 `npm ci` 从新 lockfile 安装） |
| 镜像内 `dist/server` 的运行时 `require()` | **0** |

详见 `01-zero-platform-dependency.txt`。

证据文件：`01-zero-platform-dependency.txt`（依赖归零）、`02-e2e-and-gate-raw.txt`（逐阶段
E2E 与门禁原始输出）、`03-ui-parity.txt`（样式表与 DOM 比对）、`04-data-and-security.txt`
（数据完整性与数据库级控制）、`05-authenticated-render.txt`（登录后页面的真浏览器渲染）。源码里仍能 grep 到 16 处 `@lark-apaas` 字样，
**全部在注释里**，用途是记录"这一行原来是什么、为什么这样改"（含迁移前版本的
provenance）。其中 1 处在 `server/database/migrations/0004_rls_role_alignment.sql`，
是**已应用的迁移文件，按校验和约束不得改动**，因此原样保留。

---

## 2. 每个阶段都跑了同一套验收

| 阶段 | 内容 | npm test | 类型检查 | build | E2E |
|------|------|----------|----------|-------|-----|
| 基线 | 未改动 | 224/225 | PASS | PASS | 31/31 |
| Stage 1 | 服务端：自己的 bootstrap / Drizzle provider / logger / 异常过滤器 / trust proxy | 225/225 | PASS | PASS | 32/32 |
| Stage 2 | 客户端：自己的根组件 / logger / axios / 404 页 / antd 主题 / 删死代码 | 225/225 | PASS | PASS | 32/32 |
| Stage 3 | 构建：原生 Vite + tsconfig 内联 + tailwind 配置 + build.sh | 225/225 | PASS | PASS | 36/36 |
| Stage 4 | 删除 4 个平台包 + 重生成 lockfile + 完整验收 | 225/225（gate 230/230） | PASS | PASS | **36/36** |

E2E 原始输出见 `02-e2e-and-gate-raw.txt`。

E2E 的断言数量从 31 增加到 36，增加的都是**脱平台的可观测验收**（标题不得是「妙搭应用」、
HTML 里不得有 `{{appName}}` / `__platform__` / `__BASENAME__` / 字节外链脚本、
不得再注入 polyfills），并且 `/` 的断言从「302 跳到 /app/」改成「直接 200 且没有重定向」——
不是放宽，是同一个白屏缺陷修复后的正确形态。

---

## 3. 替换了什么（一一对应）

| 平台能力 | 原实现 | 现实现 |
|---------|--------|--------|
| HTTP 外壳 | `configureApp()` | `server/main.ts`：`express.json` + `urlencoded` + `cookie-parser` + 静态资源 + 视图回退 |
| 数据库 | `DataPaasModule` / `DRIZZLE_DATABASE`（懒加载 Proxy + 凭据轮换 + OTel） | `server/database/database.module.ts`：postgres.js + drizzle，同样的 token 名、同样的连接池参数 |
| 每请求 DB 角色 | `SqlExecutionContextMiddleware` + 平台 monkey patch | `server/database/database-role.middleware.ts` + `server/database/request-database-role.ts` |
| CSRF Token | `CsrfTokenMiddleware` + `ViewContextMiddleware` | `server/common/http/csrf-token.middleware.ts` |
| OTel 日志 + 请求/响应体记录 | `PlatformModule` 的 `AppLogger` + `TraceInterceptor` | 标准 Nest `Logger`（**不再记录请求/响应体**，这是安全修复） |
| 对象存储 | `@lark-apaas/file-service`（dataloom） | `server/modules/files/object-storage.ts`：可插拔 `ObjectStorage` 接口；默认实现诚实返回 503 |
| 客户端根组件 | `AppContainer` + `ErrorRender` | `client/src/components/AppRoot.tsx`（保留 antd `ConfigProvider` 主题/中文 locale）+ 应用自己的 `AppErrorBoundary` |
| 客户端日志 | `client-toolkit/logger` | `client/src/lib/logger.ts` |
| HTTP 客户端 | `axiosForBackend`（client-toolkit） | `client/src/api/client.ts` 自建 axios 实例 |
| 404 页 | `NotFoundRender` | `client/src/pages/NotFound/NotFound.tsx` |
| 设计 token | `client-toolkit/lib/index.css` | `client/src/vendor/toolkit-theme.css`（逐字 vendored，见 §5） |
| 构建 | `coding-preset-vite-react`（24 个插件） | `vite.config.ts`：原生 `vite` + `@vitejs/plugin-react` |
| tsconfig preset | `@lark-apaas/fullstack-presets` | `tsconfig.app.json` / `tsconfig.node.json` 内联同一组编译选项 |
| Tailwind preset | `createTailwindPresetOfSimple()` | `tailwind.config.ts`（`tw-animate-css` 已提供全部动画工具类） |

### 顺带解决的两个真问题

1. **`FORCE_AUTHN_INNERAPI_DOMAIN` 不再是启动硬依赖。** 以前必须设一个（哪怕是假域名），
   否则 DI 容器失败、进程退出。现在这个变量既不读取也不需要；`.env.deploy.example`
   与 `render.yaml` 里的相关条目已删除或标注。
2. **请求/响应体日志泄漏已消除。** 平台的 `TraceInterceptor` 把每个成功请求的 body
   写进日志（实测一次门禁运行里有 28 个明文登录密码和全部 MFA 码）。该拦截器随
   `PlatformModule` 一起消失，`auth.controller.ts` 的凭据擦除作为纵深防御保留。

---

## 4. `/` 不再需要 302 跳转（用户可见的白屏缺陷已修）

- **改动前**：平台把 React Router 的 basename 写死成 `/app/`（注入 `window.__BASENAME__`），
  于是 `/` 匹配不到任何路由 —— 200 响应、`#root` 空白，**白屏**。上一轮为此加了
  `/` → `/app/` 的 302 绕行。
- **改动后**：basename 是真 `/`，`/` 直接渲染应用。E2E 断言：
  `GET / -> 200`、`redirect_url 为空`、`GET /login -> 200`、`GET /api/health -> 200`。
- `/app/*` 保留一条**老书签兼容**跳转（`/app/login -> /login`，query 原样保留），
  这是礼节而非所需：应用内没有任何路由以 `/app` 开头。
- **副作用**：那条绕行还顺带弄坏了整套 HTTP 门禁 —— 各套件用 `GET /` 拿 CSRF cookie，
  拿到的是 302、没有 `Set-Cookie`，于是登录 403、后面全部 401。改动前门禁是红的，
  删掉绕行后 282/282 全绿（`npm test` 里那个 cover-asset-root 的失败也正是这一条）。

---

## 5. 界面没有变化（可复现的比对）

### 5.1 渲染出的 DOM

- E2E 的浏览器断言（唯一能发现白屏的检查）在改动前后都是 PASS。
- `#root` 文本长度：改动前 **63** 字符 → 改动后 **58** 字符。
  差值正是被移除的水印文案「妙搭生成 」（4 字 + 1 空格 = 5）。
- 逐字节比对根子树：**除了被移除的水印元素，以及 React 内部 id 计数器因少渲染一个组件
  而从 `_r_2_` 变成 `_r_1_`，两者完全一致**（归一化该 id 后字符串相等）。
- antd 的 `ConfigProvider` 仍然生效：注入的 `ant-` 样式数量改动前后同为 **381**。

### 5.2 样式表

- 设计 token（`--color-*` 调色板、`.dark`、`@font-face`、base 覆盖）逐字 vendored，
  见 `client/src/vendor/toolkit-theme.css`（头部写明了来源与两处删改）。
- 构建产物 CSS 类选择器集合：**新增 0 个**；移除 86 个 token，其中 10 个是数值误匹配、
  76 个真实类名，**逐个在 `client/` 源码里查过，被应用引用的数量为 0** —— 也就是说
  移除的全部是死 CSS（只被已删除的平台组件引用）。
- 动画工具类（`animate-in` / `fade-in-0` / `slide-in-from-*` / `zoom-in-95` 等）
  在改动前后**出现次数完全相同**，`tw-animate-css` 已完整覆盖（原 Tailwind 预设里的
  内联 `tailwindcss-animate` 插件是冗余的）。
- `--ud-*`（sonner toast 用到的 token）曾因删除 vendored sonner 样式而丢失，
  已通过 `client/src/vendor/toolkit-sonner.css` 恢复。

### 5.3 唯一两处刻意的、用户可见的变化（必须点名）

1. **右下角的「妙搭生成」水印徽标消失。** 它由平台 `AppContainer` 内的 `Watermark`
   渲染，且会向 `lf3-static.bytednsdoc.com` 请求一张 logo —— 既是平台品牌，也是一条
   第三方运行时依赖。任务要求"彻底移除平台依赖"，因此它被移除而不是被复刻。
2. **404 页的插图改为本地文件。** 原来的 `<img>` 指向 `lf3-static.bytednsdoc.com`；
   现在指向 `client/public/not-found.svg`（同一份 SVG 的本地副本），页面结构、class、
   文案与尺寸完全不变，但不再有对外请求。

除这两处外，没有改动任何界面元素、布局、文案、路由或 i18n 字符串。

---

## 6. 数据与安全没有变化

- **数据**：347 条 resources、8 个迁移、全部账号（含 `__rbac_keeper`）与审计日志均未变动；
  迁移文件 0001–0008 一个字节都没改（`git diff --stat server/database/migrations/` 为空）。
  唯一新增的账号是 `__qt_naming_admin_*`，来自**改动前那次门禁运行**（naming-http 因
  `/` 跳转 ABORTED，夹具没来得及清理），不是这次改动产生的。
- **数据库级控制保留**：每个请求仍然以 `anon_` 角色执行 SQL。实测证据：对不存在的
  teacher 发 `PATCH`，改动前后的响应**同为 500**（`42501 permission denied for table teachers`
  —— 权限检查在 WHERE 之前失败），说明"每请求 `SET LOCAL ROLE 'anon_'`"语义被完整复刻。
- **其余安全控制逐项仍在**：安全响应头（20/20）、RBAC/PermissionGuard、MFA（55/55）、
  CSRF（cookie + header 双提交）、登录限流、审计写库、会话吊销、`/api/health` +
  `/api/health/ready`、`assert-admin-exists` 启动守卫、优雅关闭（`verify-shutdown.sh` 24/24）。
- **`trust proxy` 不再照抄平台**：平台在 `configureApp()` 末尾无条件
  `app.set('trust proxy', true)`（相信客户端提供的整条 `X-Forwarded-For`）。现在只有
  `resolveTrustProxySetting()` 一处写入，默认是安全值 `false`，日志会明确打印当前取值。

---

## 7. 已知问题与未验证项

1. **`bash scripts/verify-all.sh` 需要 `MFA_ENFORCE_SUPER_ADMIN=true`** 才能拿到
   `mfa 55/55`。这是**既有**的口径问题：CI 工作流
   （`.github/workflows/ci.yml`）没有设这个变量，因此在 CI 里 mfa 套件会失败
   （夹具 `superadmin` 期望被强制 MFA）。本次门禁是在设了该变量的服务上跑绿的，
   与仓库里 `evidence/gate-run-final.txt` 的历史口径一致。**未改动 CI 工作流**。
2. **`PATCH /api/teachers/:id` 与软删除在 `anon_` 角色下仍然 500**（角色/状态列没有
   UPDATE 授权）。这是**改动前就存在**的行为，本次刻意保持不变（迁移迁移，不改行为）。
   证据与代码位置：`server/modules/auth/auth.service.ts` 的 `writePasswordReset` 注释；
   `tests/…`/`scripts/verify-authz-http.mjs` 覆盖的提权拒绝路径不受影响。
   若要修复，应给 `teachers` 的相关列补 GRANT 或把写入改走 `authenticated_` 原始客户端——
   那是独立的一次变更。
3. **`client/api/client.ts` 保留了平台的"403 直接 resolve"行为**（不 reject）。
   应用里没有任何代码依赖它（`ForbiddenError` 无人引用），保留是为了不改动用户可见行为。
   已在文件里写清来由。
4. **未在真实 Zeabur 环境验证**：本次全部验收在本机（Docker + 本机 PostgreSQL）完成。
   镜像能构建、能启动、能登录、能渲染，但 Zeabur 的网络/网关行为没有被验证过。
5. **对象存储仍然不可用**（按设计）：没有 S3/R2/MinIO 后端，下载返回 503
   `STORAGE_NOT_CONFIGURED`，从不伪造 URL。接入方式是实现 `ObjectStorage` 并在
   `files.module.ts` 里换掉 provider。
6. **`npm run dev`（Vite dev server + Nest 同时跑）未端到端验证**：vite.config.ts 里补了
   `/api` 代理以维持原有工作方式，但没有实际启动过开发模式。
