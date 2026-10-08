# V2 手机端验收（阶段 11）

> 业主 Stage 11 的目标：**把手机端这一步做完，不是"先支持着，以后再补"**。
> 一开始业主就点明了本阶段的第一任务：
>
> > 上一阶段（Stage 10）在真 Safari 上量出一个真问题：**视口 < 1024px 时全站没有任何导航入口**
> > （侧边栏 0px、没有汉堡菜单）。**Stage 11 的第一任务就是修这个问题。**
>
> 同时给了一条同样硬的边界：
>
> > **不要重新设计 UI。** 颜色、字体、卡片、圆角、间距、Sidebar、Header、Button、
> > Dialog、ResourceCard 都保持现状 —— 只做「加移动导航 + 响应式 + 触控 + 布局
> > + 上传/预览/下载修正」。
> >
> > 不要为了"移动端设计"再做：**底部 Tab + 侧滑菜单 + 顶部菜单** 三套导航。
> > 只要 `桌面: Sidebar` / `手机: ☰ → Drawer`。
> > **不要复制第二套导航数据**；**禁止 MobileMenu 自己硬编码 Pre-K / K / 美德 / 活动**。
>
> 判据仍然是 Stage 10 那条：
> **功能完成 = UI 有入口 + 用户可点击 + API 存在 + 后端逻辑存在 + 数据库真的改变
> + 刷新后状态还在 + 权限正确 + 异常正确 + 浏览器真实通过。少任何一项都叫 INCOMPLETE。**

验收脚本：`tests/integration/browser.stage11.test.mjs`（25 条，CDP 驱动真实 Chrome +
真实机型仿真）、`tests/safari/acceptance.safari.test.mjs`（`SAFARI_VIEWPORT=mobile`，真 Safari）。
全程采集 console 与网络（CDP 的 `Runtime` / `Log` / `Network` 三个域）。

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 25 条手机端验收 | **全部通过**（`# fail 0`、`# skipped 0`） |
| Chrome 手机（iPhone 14 / iPhone SE / Pixel 7 仿真） | ✅ 25 条 |
| Chrome 桌面 | ✅ 42 条（Stage 10 全业务验收，**无回归**） |
| Safari 桌面（1440×900） | ✅ 10/10，9 个业务步骤全 PASS |
| Safari 手机（390×844） | ✅ 10/10，9 个业务步骤全 PASS |
| 断点 1440 / 1200 / 1023 / 900 / 768 / 430 / 390 / 375 / 320 | ✅ **9/9 无横向溢出、无白屏** |
| console error / 500 / 意外 4xx | **0**（且有"采集器自检"证明它不是永远为 0） |
| 门禁 | unit **206** + integration **554** = **760 通过，0 失败，0 跳过**；typecheck / lint / build 全绿（见 §6） |
| 新增依赖 | **0**（没有引 UI 库、没有引手势库、没有引测试框架） |

## 2. 本阶段修掉的 5 个真问题

### （一）视口 < 1024px 全站没有导航 —— 本阶段第一任务

**问题**（Stage 10 在真 Safari 上量到的，不是猜的）：

| 视口 | 侧边栏宽度 | 导航链接数 | 汉堡按钮 |
|---|---|---|---|
| 1440 / 1200 | 240px | 9 | 0 |
| **1023 / 900 / 390** | **0px** | **0** | **0** |

根因是侧边栏用的 `hidden lg:flex`：**DOM 还在，只是被 CSS 藏了**，而那个尺寸下
又没有任何替代入口 —— 手机上只能靠手输网址才能到任何页面。

**修法**（业主点名要的那一种，没有第二种导航）：

* `client/src/components/useMediaQuery.ts`（新）：`useMediaQuery()` / `useIsDesktop()`，
  `DESKTOP_QUERY = '(min-width: 1024px)'` —— **全站唯一的断点定义**；
* `client/src/components/Layout.tsx`：`{isDesktop && <Sidebar />}` —— 桌面才渲染侧边栏；
* `client/src/components/MobileNav.tsx`（新）：`☰`（`aria-label="打开导航"`、`aria-expanded`、
  `aria-controls`）+ 抽屉，渲染的是 **`SidebarNav` 本体**；
* `client/src/components/Sidebar.tsx`：拆成 `Sidebar()`（桌面外壳）+ 导出的 `SidebarNav()`。
  **导航条目（首页 / 我的资源 / 审核 / 目录根 / 管理组）只有这一处定义**，
  桌面与手机读的是同一份 `useDirectory()` + `useAuth().capabilities` 数据。

抽屉的四条关闭路径都做了：点导航项、Esc、右上角关闭按钮、点遮罩（用 `mousedown`
而不是 `click`，避免"在抽屉里按下、拖到遮罩上松开"被误判为点击遮罩）；
换路由自动关（`useLocation`）；打开时锁背景滚动，关闭后恢复原值。

**同时验证了"不是两套"**：1023px 与 390px 下 `sidebar=false, hamburger=true`；
1440px 下 `sidebar=true, hamburger=false`；任何尺寸下页面里的导航节点都**只有一份**。

### （二）中文 `.txt` 上传被判"内容与扩展名不符"

**问题**：老师传中文 `.txt` 教案，服务端回
`登记失败（400）{"code":"FILE_TYPE_NOT_ALLOWED","message":"文件内容与扩展名不符（.txt 的实际内容看起来是 未知二进制内容）"}`。

**根因**：服务端只读文件**前 64 字节**判容器，而中文是 3 字节 UTF-8，第 64 字节
正好把一个汉字切成两半 → 解码失败 → 判定为二进制。**这是 100% 会命中的真实场景**
（中文教案的第一行几乎必然是中文）。

**修法**（`shared/file-policy.ts`）：`looksLikeText()` 先整体试解码；失败时再看
**尾部是不是被截断的多字节字符**（去掉 1~3 个字节后的前缀若能解码，就是截断而不是二进制）。
单测覆盖了**每一种前缀长度 4..64**，同时 `0xFF`、`e5 41`、游离续接字节仍然判为二进制 ——
放宽的是"截断"，不是"随便什么都是文本"。

### （三）触控目标小于 40px

在 390×844 上实测：`file-download` / `file-preview` 只有 **78×34**，
审核台的 `reject-submit` 高 **38px** —— 手指点不准，尤其是"退回"这种带后果的按钮。

**修法**：`Button` 的 `SIZES` 加 `min-h-10 sm:min-h-0`（手机 40px、桌面像素不变），
`Sidebar` 的 `NavItem`、`DirectoryManagePage` 的 IconButton（`min-h-10 min-w-10`）同样处理。
**桌面端尺寸一个像素都没变** —— 这是业主"不要重新设计 UI"的直接落实。

### （四）目录树加载失败时谎报"找不到这个目录"

断网后打开目录页，页面说的是"找不到这个目录"（好像目录被删了），而且**重试按钮出不来**：
provider 在失败时把 `ready` 置成了 `true`，于是重试 UI 的条件永远不成立。

**修法**：条件改成 `treeError !== null && roots.length === 0`（`DirectoryBrowsePage.tsx`），
文案改成说清原因 + 「重试」（`data-testid="directory-retry"`）。
资源列表同样补了 `resource-list-error` / `resource-list-retry`（`ResourceList.tsx`
用 `reloadToken` 重新请求）。**"点重试就能加载"是手机端验收里单独的一条**，不是看着像修好了。

### （五）新增文件夹弹窗里的 `pattern` 在浏览器里是**非法正则**

`pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"` 里的 `-` 在 HTML 的 `v` 标志下位置非法，
浏览器**报一条 console error 之后就静默忽略**这条约束 —— 也就是说这个校验**从来没生效过**，
而 console 采集把它抓了出来。改成 `[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?`。

> 这一条只有"console 0 错误"这个门禁抓得住：功能看起来是好的，页面也不报错给用户看。

## 3. 手机上跑了什么（25 条 / 7 组）

| 组 | 条数 | 覆盖 |
|---|---|---|
| ① 移动导航 | 3 | 侧边栏不渲染 + ☰ 在 + 抽屉是同一份导航；桌面只有侧边栏；点项自动关、Esc 关、点遮罩关 |
| ② 目录浏览 | 3 | 教育教学 → Pre-K → 美德 → 教学资源；教师成长 → L1 → 安全施教规范 → 应急预案 → 传染病识别与防治；首页卡片自适应 |
| ③ 断点回归 | 2 | 9 个宽度（1440/1200/1023/900/768/430/390/375/320）逐个查核心内容 + 横向溢出；横竖屏（390×844 与 844×390） |
| ④ 资源 | 6 | 详情可滚动 + 触控区 ≥40px；PDF 预览适配视口；图片真实解码不变形；TXT 长行换行；下载 sha256 一致；上传→进度→存草稿→**刷新仍在** |
| ⑤ 管理员 | 5 | 审核通过并发布；退回必须写原因且教师看得到；目录管理新建/改名/停用/排序/保存；教师账号搜索/新增/编辑/启停/重置口令/改权限；撤回→删除→回收站恢复 |
| ⑥ 权限与网络异常 | 4 | 未授权目录进不去且接口 403；断网 → Error + Retry → 恢复后点重试真的加载；目录树失败不谎报；慢网络先 Loading 后内容 |
| ⑦ Console 与网络 | 2 | 整条手机流程 0 错误（**allowlist 逐条登记**）；采集器自检 |

**设备与尺寸（真实仿真，不是"把窗口拖窄"）**：
iPhone 14（390×844, DPR 3, 触摸, iOS UA）、iPhone SE（375×667, DPR 2, 触摸）、
Android Pixel 7（412×915, DPR 2.625, 触摸, Android UA）；
断点全跑 1440 / 1200 / 1023 / 900 / 768 / 430 / 390 / 375 / 320。
仿真用 `Emulation.setDeviceMetricsOverride` + `setTouchEmulationEnabled` + `setUserAgentOverride`，
每次跑完 `clearDeviceMetricsOverride` —— **同一台 Chrome 上先后跑手机与桌面**，
所以"手机修好了、桌面没坏"是在同一次运行里验证的。

**"不输网址"是真的**：②⑤ 里的每一步都用点击（点卡片、点抽屉项、点面包屑、点按钮），
没有一条测试靠 `goto('/directory/...')` 到达目标页面。

## 4. 真 Safari（桌面 + 手机，两遍都是真浏览器）

`npm run test:safari`（W3C WebDriver，零依赖客户端 `tests/helpers/safari.mjs`）：

| 视口 | 结果 |
|---|---|
| 1440×900（桌面） | ✅ 10/10，9 个业务步骤全 PASS |
| **390×844（手机，`SAFARI_VIEWPORT=mobile`）** | ✅ **10/10，9 个业务步骤全 PASS** |

Safari 手机上走的是**真 iPhone 视口**，登录后**用 `☰` 打开抽屉再点进去**（不是直接跳 URL），
点的是真实元素；客户端对每次点击都做了 `elementFromPoint` 命中测试，
**9 个步骤的点击全部走 WebDriver 标准点击，没有一次回退到 JS 点击**。

> Safari 需要一次性手工开关：Safari → 设置 → 开发者 → **允许远程自动化**。
> 没打开时 `npm run test:safari` 会**退出码 2 并打印这两步**，
> **不会假装通过** —— 这是刻意的。

## 5. 业主明确要求"不许降级"的三件事

1. **没有 SKIP**：25 条全部真跑，`# skipped 0`；Safari 两遍都是真跑。
   没有 `UNVERIFIED`、没有"手机以后再测"。
2. **没有把新问题写成"已知限制"**：本阶段发现的问题**全部当场修掉**（§2 五条），
   `docs/V1_KNOWN_LIMITATIONS.md` 里一个字都没有新增。
3. **没有偷偷改业务逻辑**：本阶段没有加限流、没有改错误码契约、没有动状态机；
   唯一的服务端改动是 `.txt` 内容判定（§2 二），属于"手机上传教案必然踩到"的 bug。

## 6. 门禁（本阶段最终一次全量运行）

```
npm run build              ✅  prepare-build + nest build + check-dist + vite build
npm run typecheck          ✅  server + client
npm run lint               ✅  server shared scripts tests client/src
npm run test:unit          ✅  206 通过 / 0 失败 / 0 跳过
                               （新增 tests/unit/mobile-nav.test.mjs 7 条结构约束 +
                                 tests/unit/file-policy.test.mjs 的前缀长度用例）
npm run test:integration   ✅  554 通过 / 0 失败 / 0 跳过（399s）
                               含 browser.stage10.test.mjs 42 条（桌面，无回归）
                               + browser.stage11.test.mjs 25 条（手机）
npm run test:safari        ✅  桌面 1440×900：10/10
SAFARI_VIEWPORT=mobile npm run test:safari  ✅  手机 390×844：10/10
```

合计 **760 条**（unit 206 + integration 554），另有 Safari 两遍共 20 条。
`# skipped 0` —— 本阶段没有任何一条被跳过。

> 说明（诚实）：最后只改了两处**注释**（`Layout.tsx` 与 `shared/file-policy.ts` 的说明文字），
> 改完后重量了一遍 build / typecheck / lint / unit 全绿。
> integration 那 554 条跑的是同一份**逻辑**产物：SWC 会把注释原样带进 `dist/`，
> 所以 `dist/shared/file-policy.js` 的哈希变了，而 `dist/server/main.js` **逐字节相同**，
> 且 `file-policy` 的单元用例（覆盖每一种前缀长度 4..64）在两次构建下都是 206/206 通过。

### 结构约束：导航只有一份真相

`tests/unit/mobile-nav.test.mjs`（7 条）**读源码**来钉业主那三条结构性要求 ——
靠点击测试是钉不住的（今天抽屉里恰好点得到，明天有人为了快写死一个「活动」也能通过点击测试）：

* 导航条目**只有** `components/Sidebar.tsx` 一处定义；
* 抽屉必须 `import { SidebarNav }` 并真的渲染它；
* `MobileNav.tsx` 里**不许出现** `Pre-K` / `美德` / `蒙特梭利` / `教师成长` / `教育教学` /
  `活动` 这些目录名，也不许出现写死的 `/directory/...` 路径；
* 桌面与移动**互斥**条件渲染，且**禁止**用 `hidden lg:flex` 这类 CSS 隐藏
  （那样 DOM 里会有两份导航节点）；
* `matchMedia` **只允许**出现在 `useMediaQuery.ts`（断点不能各写各的）；
* 抽屉的四条关闭路径 + 背景滚动锁都在。

**做了变异验证**：故意往 `MobileNav.tsx` 里塞一个
`<NavItem to="/directory/prek/virtue" label="美德" testId="nav-home" />`，
这 7 条里**立刻红 2 条**；撤掉后恢复 7/7 —— 它不是一条永远绿的装饰测试。

## 7. 状态

* 本阶段提交：见下方「提交记录」。
* 阶段 0–11 全部 ✅。**阶段 12（Docker / 公网部署）未开始。**
* 按业主的收尾安排：手机端修完之后**不再改业务逻辑**，
  下一步直接 **Docker → 公网 → 最终全量验收**。

### 提交记录

| 提交 | 内容 |
|---|---|
| `3d126b7` | 阶段 10 补完（Safari 真实浏览器验收） |
| （本阶段） | 阶段 11 手机端：移动导航 + 响应式 + 触控 + 上传/预览/下载修正 |
