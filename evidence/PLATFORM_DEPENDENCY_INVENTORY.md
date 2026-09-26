# 妙搭（@lark-apaas）平台依赖完整清单

**目的**：既然确定留在 Zeabur（脱平台部署），就必须知道**代码里还有多少地方依赖妙搭**、
每一处脱平台后的真实行为、以及风险等级。这份清单取代"一个个撞出来"的方式。

**CURRENT_COMMIT**: `fdce673`
**方法**：全仓扫描 `@lark-apaas` 导入、平台数据库角色、平台环境变量、平台构建工具。

---

## 一、依赖总览

| 平台包 | 直接依赖 | 代码中被 import 的文件数 |
|--------|---------|------------------------|
| `@lark-apaas/fullstack-nestjs-core` | ✅ | 服务端 **16** 个文件 |
| `@lark-apaas/client-toolkit` | ✅ | 前端 **26+** 个文件 |
| `@lark-apaas/coding-preset-vite-react` | ✅ | 构建期（Vite 预设） |
| `@lark-apaas/fullstack-presets` | ✅ | 构建期 |

---

## 二、逐项清单（按风险分级）

### 🔴 阻塞级 —— 脱平台后功能不可用或安全语义改变

| # | 依赖点 | 位置 | 脱平台后的真实行为 | 现状 |
|---|--------|------|-------------------|------|
| 1 | **数据库请求角色**：平台每请求执行 `SET LOCAL app.user_id=''; SET LOCAL ROLE 'anon_'` | 平台 `nestjs-datapass`；应用在 `auth.service.ts:688/915` 有绕行 | **平台上下文为空 → 每个请求都跑在 `anon_` 角色上**。migration 0004/0005 为这组角色建的 RLS 因此**无法区分应用用户** —— 应用层鉴权才是真正的关卡，数据库层 RLS 退化为"匿名角色能做什么" | 部分绕行（密码写入已改 `authenticated_`）；**RLS 的安全语义未在脱平台前提下重新确认** |
| 2 | **对象存储 dataloom**（客户端 `getDataloom()` / `getDefaultBucketId()`） | `client/src/components/business-ui/api/files/service.ts` | 平台不可达 → 上传完全不可用 | **已确认是死代码**：`business-ui/` 无任何页面引用；上传页 `UploadPage.tsx` 走的是应用自己的 `createResource` API |
| 3 | **对象存储 FileService**（服务端） | `server/modules/files/files.service.ts` | 平台不可达 → 明确 `503 STORAGE_NOT_CONFIGURED` | 已实现，行为诚实（不伪造 URL）。**但意味着"下载"功能在生产上是不可用的** |
| 4 | **飞书组织架构 API**（users / departments / chats / user-profiles） | `client/src/components/business-ui/api/*/service.ts` | 平台不可达 → 报错或空数据 | **同为死代码**（无页面引用） |

### 🟡 已绕行 —— 平台假设已被拆掉，但根因仍在

| # | 依赖点 | 平台假设 | 我做的绕行 | 根因是否仍在 |
|---|--------|---------|-----------|-------------|
| 5 | 路由 basename `/app/` | 平台往 HTML 注入 `window.__BASENAME__="/app/"` 与 `__platform__.basename="/app/"` | 服务端 `/` → `/app/` 302 跳转 | **在**。HTML 里仍然是 `/app/`，只是访问入口被引导过去了 |
| 6 | 静态资源不走同源（`PLATFORM_PREFIXES` 跳过 `assets/`，注释写"走 CDN"） | 平台 CDN 提供 hashed 产物 | `vite.config.ts` 改 `assetsDir='bundle'` + `build.sh` 复制进 `dist/dist/client` | 在（绕开了跳过列表） |
| 7 | `publicAssetsMiddleware` 只读 `dist/dist/client` | 平台目录约定 | `build.sh` 把 `bundle/`、`assets/` 复制过去 | 在 |
| 8 | 构建调用平台内部 CLI `generate-api-routes` / `generate-page-routes` | 工具在平台 PATH 里 | 不存在则跳过（`fdce673`） | 是死步骤，已安全跳过 |
| 9 | `configureApp()` 硬编码 `app.set('trust proxy', true)` | 平台入口会覆写 `X-Forwarded-For` | 在其**之后**重新设置 `trust proxy` | 在（顺序依赖，注释已说明） |
| 10 | `configureApp()` 用 HBS 渲染 `index.html`（`{{{__platform__}}}` 占位符） | 平台注入 `__platform__` | 无（平台注入脚本仍在 HTML 里，字段为空） | 在 |
| 11 | 强制 `FORCE_AUTHN_INNERAPI_DOMAIN` | 平台鉴权内网域 | 启动时给一个假值 `https://127.0.0.1:1` | 在，属启动硬依赖 |
| 12 | 平台日志拦截器无条件记录请求/响应体 | 平台可观测性 | 仅在 auth 模块封堵（消费即擦除） | **在，且是高危**：其它模块的请求/响应体仍会被记录 |

### 🟢 无影响 —— 只是 token、类型或纯工具

| # | 依赖点 | 说明 |
|---|--------|------|
| 13 | `DRIZZLE_DATABASE` 令牌 + `PostgresJsDatabase` 类型 | 10 个文件 import，本质就是 postgres.js 实例，脱平台完全可用 |
| 14 | `client-toolkit/logger` | 多文件 import，纯日志 |
| 15 | `AppContainer` / `ErrorRender`（`index.tsx`） | 应用根组件，实测渲染正常 |
| 16 | `getEnv`（`user-profile.tsx`） | 属死代码路径 |

---

## 三、修正之前的判断

**我此前把"对象存储"列为最大阻塞之一，现在要修正：**

- **客户端** dataloom（`business-ui/api/files/service.ts`）**是死代码** —— `business-ui/` 无任何页面引用
- **服务端** `FileService` 确实依赖平台，但它已经诚实返回 503

所以"上传/下载不可用"的准确表述是：**服务端存储集成未接入**，而不是"整个客户端存储链路都是平台依赖"。

**另一个修正**：`client/index.html` 里的标题**本来就是对的**：

```html
<title>TsinglanKindergarten - 清澜山幼儿园课程资源平台</title>
```

但线上渲染出来是「妙搭应用」—— 说明标题被平台注入的 `__platform__.appName`（值为默认的"妙搭应用"）覆盖了。**这是可以修的**：在应用启动时用固定标题覆盖 `document.title`。

---

## 四、按风险排序的收敛路径

| 优先级 | 项 | 为什么优先 | 可验证性 |
|--------|----|-----------|---------|
| P0 | #12 平台日志拦截器记录请求/响应体 | **会把明文密码、token 写进日志**。目前只在 auth 模块封堵，其它模块（如 `POST /api/teachers` 返回 `temporaryPassword`）仍泄露 | 本地可验证（构造请求 + 检查日志） |
| P0 | #1 数据库角色在脱平台后的真实语义 | RLS 策略依赖平台上下文；需确认脱平台后**是否还有意义**，或明确记录"应用层才是唯一关卡" | 本地可验证（用 anon_ 角色实连测试） |
| P1 | #3 服务端对象存储 | 无存储 = 平台无核心功能（下载） | 需要真实平台或第三方存储（S3/R2/MinIO） |
| P1 | #5 basename 根因 / #9 title 覆盖 | 用户可见；现在靠跳转绕开 | 本地可验证 |
| P2 | #6 #7 #8 #10 #11 | 已绕行且稳定 | 已由 E2E 覆盖 |
| P3 | #2 #4 死代码清理 | 减少困惑面，但不影响运行 | 纯静态分析 |

---

## 五、诚实标注

- **未验证**：`SET LOCAL ROLE` 在真实平台（非空 schema）下的角色名是否为 `anon_` 以外的形式
- **未验证**：平台日志拦截器在 Zeabur 环境下是否真的落盘（本机是 stdout，Zeabur 会收集）
- **未验证**：`__platform__` 注入脚本在 Zeabur 下除 basename/appName 外是否还有其它副作用
- **未验证**：`business-ui/` 是否被 `client/src/components` 内部的其它非页面组件间接引用（只确认了 `pages/` 与 `app.tsx` 无引用）
