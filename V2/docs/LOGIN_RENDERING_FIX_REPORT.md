# V2 登录页无样式故障 —— 根因定位与修复报告

> 范围：**只动 V2**。V1 源码零改动。未触碰 Zeabur、正式库、正式域名、生产 R2。
> 状态词只用 `PASS / FAIL / UNVERIFIED / BLOCKED / NOT RUN`。

## 0. 结论

```
根因定位            : PASS（有实测证据链，见 §1）
根因修复            : PASS（Dockerfile 构建阶段漏拷 postcss.config.mjs）
真浏览器验收（演练）  : PASS（31/31 项，含 computed style，见 §4）
部署级浏览器门禁     : PASS（8/8，含新增 ③bis 样式门禁）
部署巡检 verify.mjs  : PASS（12/12，含新增"样式已被编译"检查与登录限流）
全量门禁            : PASS（build / typecheck / lint / unit 206/206 / integration 582/582）
Zeabur 正式切换      : BLOCKED（本轮不涉及，未获授权）
```

**一句话根因**：演练镜像的 CSS 是"**200 + text/css、但里面一个工具类都没有**" ——
Tailwind v4 是通过 `postcss.config.mjs` 接进 Vite 的，而 Dockerfile 的构建阶段
**漏拷了 `postcss.config.mjs`**，于是容器里没有 PostCSS 配置、Tailwind 插件从未运行：
Vite 只把 `@import 'tailwindcss'` 内联了一遍（theme + preflight），
`@theme` 与全部工具类都没有被展开。页面因此以浏览器默认样式渲染 —— 就是你看到的"挤在左上角"。

**不是**这些原因（都实测排除了）：不是 CSP、不是响应头、不是 404/403/重定向、不是
Content-Type 冒充、不是代理把 `/assets/` 打错、不是浏览器缓存、不是自签证书。

## 1. 证据链（按实际排查顺序，每一步都是实测）

### 1.1 页面与静态资源请求（真实 HTTP）

| 检查 | 实际结果 |
|---|---|
| `GET /login` | `200`，返回 SPA 外壳 HTML |
| HTML 引用 | `/assets/index-G0k_OBHy.js`、`/assets/index-fJHUGZez.css` |
| `GET /assets/index-fJHUGZez.css` | `200` ｜ `text/css; charset=UTF-8` ｜ 23 150 B（**不是 404、不是 HTML 冒充**） |
| `GET /assets/index-G0k_OBHy.js` | `200` ｜ `application/javascript` ｜ 423 464 B |

→ 静态资源**都取到了**。所以问题不在"资源没加载"，而在**那份 CSS 的内容**。

### 1.2 打开那份 CSS 看内容（决定性证据）

被服务的 `index-fJHUGZez.css` 里：

| 特征 | 被服务的 CSS（坏） | 本地构建 CSS（好） |
|---|---|---|
| 未展开的 `@theme` | **1 个（残留）** | 0 |
| 编译出的主题变量 `:root,:host{` | **没有** | 有（`--font-sans` 等令牌） |
| `.flex{` / `.min-h-screen{` / `.items-center{` | **全部缺失** | 全都有 |
| `.bg-background{` / `.max-w-sm{` / `.text-2xl{` | **全部缺失** | 全都有 |
| `.rounded-lg{`（登录按钮/输入框/卡片） | **缺失** | 有 |
| `.text-muted-foreground{` | **缺失** | 有 |

`@theme` 残留 + 没有编译出的 `:root` + 工具类为零 = **Tailwind 插件根本没运行**，
只留下了"被内联进来的 Tailwind 源文件"。这与"页面是裸 HTML"完全吻合。

### 1.3 镜像里的产物（不是宿主机的问题）

```
docker run --rm --entrypoint sh qls-v2-app:2.0.0-rehearsal \
  -c 'wc -c /app/dist/client/assets/*.css; grep -c "\.flex{" …'
→ /app/dist/client/assets/index-fJHUGZez.css   23 150 B   .flex 计数 = 0
镜像构建时间：2026-10-08T03:54:24Z
```

同一份源码，**本地构建正常、容器里不正常** ⇒ 差异在**构建环境**，不在源码。

### 1.4 构建链：Tailwind 到底怎么接进来的

| 事实 | 证据 |
|---|---|
| 样式入口 | `client/src/styles.css`：`@import 'tailwindcss'` + `@theme { … }` 设计令牌 |
| Vite 插件 | `vite.config.mts`：`plugins: [react()]` —— **没有** `@tailwindcss/vite` |
| 所以 Tailwind 只能走 PostCSS | `postcss.config.mjs`：`{ plugins: { '@tailwindcss/postcss': {} } }` |
| Dockerfile 构建阶段 COPY 了什么 | `package.json package-lock.json nest-cli.json tsconfig*.json vite.config.mts` …… **没有 `postcss.config.mjs`** |

容器里没有 PostCSS 配置 → Tailwind 插件不运行 → 产物"成功"但没样式。
**这就是根因。**

### 1.5 逐条排除的其他可能

| 假设 | 实测结论 |
|---|---|
| CSP 挡住了样式 | CSP 里 `style-src 'self' 'unsafe-inline'`；CSS 本身能取到 → 与 CSP 无关 |
| 反向代理把 `/assets/` 打错 | `/assets/*` 均 `200` + 正确 MIME（同源，无重定向） |
| 浏览器缓存/旧产物 | 全新 profile（等价无痕）下同样缺样式；且镜像内文件与页面引用一致 |
| 自签证书导致 | 证书只影响 TLS 信任（浏览器显示 Not Secure），不影响 CSS 解析与应用 |
| 前端 JS 崩了导致 React 没渲染 | 修复前后 `#root` 都有子节点、文字都在；是"有 DOM、没样式"而不是"没渲染" |

> 关于浏览器地址栏 `Not Secure`：这是**演练环境自签证书**造成的，与本次样式故障**无关**，
> 也不是同一条因果链。正式域名使用真实证书后该提示自然消失。

## 2. 修改的文件（全部是 V2；无业务代码与 UI 改动）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `Dockerfile` | build 阶段 COPY 增加 `postcss.config.mjs`（并写明为什么） | **根因修复** |
| `scripts/check-client-assets.mjs` | **新增**：构建期闸门（`@theme` 不得残留、主题变量必须编译、必需工具类必须存在、index.html 引用必须有效） | 让"没样式的产物"**构建失败**，而不是发给用户 |
| `package.json` | `build` 末尾接上闸门（`… && node scripts/check-client-assets.mjs`） | 本地与 Docker 走同一条链，都会拦 |
| `tests/production/production-browser.test.mjs` | 新增 `③bis 样式真的生效`：查 CSS 内容 + 浏览器 computed style | 原来的 ③ 只查"取到了没"，**结构上抓不到**这类故障 |
| `deploy/verify.mjs` | 新增"样式已被编译（CSS 里有工具类）"检查 | 正式域名上线后可以一条命令自证 |

**没有**：加内联样式、改设计、改业务逻辑、关 CSP/安全头、放宽任何测试断言。

## 3. 修复前后对照

| 项 | 修复前（2026-10-08 镜像） | 修复后（2026-10-09 镜像） |
|---|---|---|
| CSS 产物 | `index-fJHUGZez.css` ｜ 23 150 B | `index-FpP7TyDI.css` ｜ 28 472 B |
| `@theme` 残留 | 1（未展开） | 0 |
| 编译出的主题变量 | 无 | 有 |
| 工具类（`.flex{` 等） | 0 | 齐全 |
| 登录页呈现 | 裸 HTML、全部挤在左上角 | 居中卡片 + 紫色主按钮 + 带边框输入框 |

> 附注（诚实披露）：本地构建的 CSS（27 995 B）与镜像里的 CSS（28 472 B）**不是逐字节相同** ——
> 逐类比对后差异只有 **1 个类选择器**（`.transition` 只在镜像里有），因为 Tailwind v4 的
> 自动扫描集合在 Docker 构建上下文（排除了 `tests/`、`*.md`、`.gitignore`/`.git`）与本机不同。
> 两边**必需工具类都在**。所以门禁按"特征存在"断言，而不是按字节相等 —— 后者会假红。

## 4. 修复后的真浏览器验收（演练环境）

地址：`https://v2.localhost:8443/login` ｜ 浏览器：本机 Chrome（headless，CDP，`--ignore-certificate-errors`）

### 4.1 与样式直接相关的测量（computed style，不是看代码）

| 项 | 实测值 |
|---|---|
| 容器布局 | `display=flex` ｜ `align-items=center` ｜ `justify-content=center` |
| 容器背景 | `rgb(252, 250, 255)`（V1 的浅紫底，不是浏览器默认白） |
| 容器高度 | `min-height=857px`（`min-h-screen` 生效） |
| 卡片 | 圆角 `12px` + 阴影 |
| 输入框 | `334 × 38 px` ｜ `border: 1px solid` ｜ 圆角 `8px` ｜ `padding: 8px 12px` |
| 登录按钮 | 背景 `rgb(143, 130, 196)`（主色）｜ 文字 `rgb(255,255,255)` ｜ 圆角 `8px` ｜ 宽度与输入框一致（334） |
| CSS / JS 请求 | `200 text/css` ｜ `200 application/javascript` |

### 4.2 交互与登录闭环

| 项 | 结果 |
|---|---|
| 错误口令 | 被拒（服务端 `401`），页面显示可读原因「用户名或密码不正确」，**仍停在 /login** |
| 正确口令（授权管理员账号） | `201` → 跳转离开 `/login` 到 `/` |
| 会话 Cookie | `v2_session`：`HttpOnly=true` ｜ `Secure=true` ｜ `SameSite=Lax` |
| 刷新后 | 仍是同一界面（导航 9 个链接、`display=flex`）、静态资源重新请求且全部 `200` |
| 无痕 / 全新 profile | 样式与尺寸一致（`display=flex`、`inputW=334`、`radius=8px`）→ 排除"缓存假象" |
| 控制台 / 网络 | 无未处理异常、无失败请求（allowlist 内只有主动制造的 401） |
| 其他页面回归 | `/`、`/directory` 静态资源全部 `200`、均已挂载且有布局样式 |

**合计 31/31 项通过。** 截图证据（gitignored，本机保留）：

```
V2/.devdata/login-render-evidence/login-desktop-1440x900.png   ← 登录页（桌面）
V2/.devdata/login-render-evidence/login-mobile-390x844.png     ← 登录页（手机）
V2/.devdata/login-render-evidence/login-wrong-password.png     ← 错误口令反馈
V2/.devdata/login-render-evidence/after-login-home.png         ← 登录成功后的首页
V2/.devdata/login-render-evidence/after-reload.png             ← 刷新后
V2/.devdata/login-render-evidence/home.png / directory.png     ← 其他页面回归
V2/.devdata/login-render-evidence/login-incognito.png          ← 无痕复测
V2/.devdata/login-render-evidence/results.json                 ← 逐项机器的判定结果
```

### 4.3 部署级门禁（真实域名通道，含新增 ③bis）

```
PRODUCTION_BASE_URL=https://v2.localhost:8443 PRODUCTION_INSECURE_TLS=1 \
NODE_EXTRA_CA_CERTS=$PWD/deploy/tls/fullchain.pem \
node --test --test-concurrency=1 tests/production/production-browser.test.mjs
```

`8/8 通过`：①HTTPS/证书 ②Cookie ③静态资源 ④**③bis 样式真的生效（新增）** ⑤目录点进
⑥迁移资源详情 ⑦真实文件下载 ⑧全程 0 错误。

### 4.4 巡检脚本

```
node deploy/verify.mjs --base https://v2.localhost:8443 --http-port 10088 \
  --cacert deploy/tls/fullchain.pem --skip-rate-limit --expected resources=349,users=24
```

`11/11 通过`，其中新增项 **"样式已被编译（CSS 里有工具类）"** 为 PASS。

再去掉 `--skip-rate-limit` 完整跑一次（含限流用例）：**12/12 通过**。

### 4.5 闸门的反向验证（证明它真的能拦住）

用**演练镜像里那份真实的坏 CSS** 跑新闸门：

```
node scripts/check-client-assets.mjs --client-dir /tmp/guardbad
→ 退出码 1，并逐条点出：
  · 还留着未展开的 `@theme` —— Tailwind 插件没有运行（构建链缺 postcss 配置？）
  · 没有编译出的主题变量（`:root,:host{`）
  · 缺少工具类：.min-h-screen{、.flex{、.items-center{、.w-full{、.rounded-lg{
```

好产物则是 `退出码 0`。也就是说：**同样的故障再来一次，会在构建阶段就红，而不是等你打开页面才发现。**

## 5. 演练服务与准确 commit

| 项 | 值 |
|---|---|
| 演练地址 | `https://v2.localhost:8443`（自签证书；HTTP 10088 跳转） |
| 应用镜像 | `qls-v2-app:2.0.0-rehearsal` |
| 镜像 ID | `sha256:b68d82f67bbb71b2460ef3fe04dc1eea06f59d4b4d420561912fe3f9796c594a` |
| 镜像构建时间 | `2026-10-09T00:54:45Z`（本次修复后重建） |
| 镜像内前端产物 | `dist/client/assets/index-FpP7TyDI.css` + `index-C6HClnHj.js` |
| 服务状态 | app / db / proxy 全部 healthy |
| 源码状态 | 构建时工作树 = `d58d97b` + 本次修复；本次修复与本报告是**同一次提交**（提交号见 git log），构建后**未再改动任何源码** |
| 演练库数据 | 24 账号 / 69 目录 / **349** 资源（= 演练导入的**原始生产快照**，未做排除） |

> 演练库仍是 349 条，而正式切换文件是 347 条 —— 这是**刻意的**：演练保留原始快照用于演练，
> 正式切换用 §Stage 12C 里那份排除 2 条测试资源的 `v2-cutover-20261008.ndjson`。
> 本轮的样式修复与这两者的差异无关。**没有重置数据库、没有重新播种。**

## 6. 全量门禁（实际命令、退出码、结果）

工作目录 `V2/`，`V2_TEST_DATABASE_URL=postgresql://…@127.0.0.1:55432/qls_v2_test`：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build`（SWC + Vite + 两道产物自检，含本次新增闸门） | **0** | 通过；`✔ 前端产物自检通过（主题变量已编译、工具类齐全、index.html 引用有效）` |
| `npm run typecheck`（server + client） | **0** | 通过 |
| `npm run lint` | **0** | 0 error |
| `npm run test:unit` | **0** | **206 / 206 pass，0 fail** |
| `npm run test:integration` | **0** | **582 / 582 pass，0 fail**（含 stage9 / stage10 / stage11 / stage12 浏览器套件与 S3 套件） |
| `node --test tests/production/production-browser.test.mjs`（对演练地址） | **0** | **8 / 8 pass** |
| `node deploy/verify.mjs …`（含限流用例） | **0** | **12 / 12 项通过** |

## 7. 安全没有被削弱

| 项 | 结果 |
|---|---|
| 六个安全响应头 | 齐全：`strict-transport-security: max-age=31536000; includeSubDomains`、`x-content-type-options: nosniff`、`x-frame-options: SAMEORIGIN`、`referrer-policy: strict-origin-when-cross-origin`、完整 `content-security-policy`（`default-src 'self'`、`object-src 'none'`、`frame-ancestors 'self'` …） |
| `x-powered-by` | 未暴露 |
| 会话 Cookie | `HttpOnly` + `Secure` + `SameSite=Lax`（浏览器实测） |
| 登录限流 | **实测仍然生效**：连续错口令返回 `401,401,401,401,429,429,429,429,429,429`（第 5 次起 429） |
| 越权/权限判定 | 未改动任何权限代码；`/api/health/ready` 仍真的查库 |

## 8. 未解决 / 未做（严格标注）

| 项 | 状态 | 说明 |
|---|---|---|
| 正式域名（Zeabur）上的样式验收 | **NOT RUN** | 需要 Zeabur 访问；本轮按指示不推进正式切换 |
| 正式切换本身 | **BLOCKED** | 同上（Stage 12C 的前置条件未变） |
| 演练环境"Not Secure" | **NOT CONFIGURED** | 自签证书所致，与样式无关；正式域名用真实证书 |
| 演练库 349 条 vs 切换文件 347 条 | 刻意差异 | 见 §5 说明，不是缺陷 |
| Tailwind 扫描集合在 Docker 与本机略有差异 | 已量化 | 只差 1 个类（`.transition`）；门禁按特征断言，不按字节相等 |

## 9. 复现与后续防护

1. 任何环境（本地 / Docker / Zeabur）构建后，`npm run build` 会自动跑闸门；
   样式没编译出来 → **构建失败**，不会再发布"裸 HTML"的镜像。
2. 任何已部署环境（含正式域名）可以用一条命令自证：
   `node deploy/verify.mjs --base https://你的域名 --cacert …`，其中包含样式检查。
3. 部署级浏览器门禁 `tests/production/production-browser.test.mjs` 现在包含 `③bis`，
   正式切换时对着正式域名跑一次即可覆盖这一整类故障。
