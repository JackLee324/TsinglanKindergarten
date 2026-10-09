# Stage 13B 报告：超级管理员唯一化 / 侧边栏展开收起 / 上传后可见 / 文件打开

> 范围：`V2/`（本地 `main`）。**V1 源码零改动**（`git status` 里 V2 之外 0 个改动）。
> 未部署 Zeabur、未触碰正式域名 / 正式 PostgreSQL / 生产 R2、未删除任何生产数据。
> 状态词只用 `PASS / FAIL / UNVERIFIED / BLOCKED / NOT RUN`；
> 每条结论都来自**本轮实际执行**的输出，没有引用历史全绿结果。

## 0. 结论（逐项）

```
SUPERADMIN UNIQUE             : PASS
DIRECTORY NAVIGATION          : PASS
UPLOAD RESOURCE VISIBILITY    : PASS
PDF/IMAGE/TXT PREVIEW         : PASS
OFFICE/ZIP DOWNLOAD           : PASS
FILE PERSISTENCE & HASH       : PASS
PERMISSION ISOLATION          : PASS
FULL TEST GATE                : PASS
PRODUCTION CUTOVER            : NOT READY
```

未验证 / 阻塞项（不影响上面这 8 条，但影响正式切换）见 §9：生产 R2 的对象枚举（只有 Zeabur 里有凭证）。

## 1. 本轮目标与边界

业主本轮点名四件事，加上两条硬要求：

| # | 要求 | 本报告的哪一节 |
|---|---|---|
| 1 | `TsinglanAdmin` 是**唯一**的超级管理员（不得按 V1 岗位名自动提升） | §2 |
| 2 | 「教师成长」左侧展开/收起箭头失效 | §3 |
| 3 | 上传后的资源在对应目录**不展示** | §4 |
| 4 | 文件打不开 / 预览 / 下载失败 | §5 |
| 5 | 真实浏览器端到端验收（部署环境） | §6 |
| 6 | 完整测试 + 部署前报告 | §7 / §10 |

业主的两条纪律，本轮的执行方式：

* **「不要只靠刷新页面解决」** —— 四条缺陷都追到了代码里的根因（见各节的「根因」），并且每一条都有一个**只能靠真实行为通过**的用例；刷新只作为"状态是否真的持久"的一个断言点（§4、§6）。
* **「不要把『上传接口成功』当作文件功能完成」** —— 验收链路是：
  **教师在界面上选文件 → 详情页出现 → 数据库 `resources` + `resource_files` 两行 → 回到目录页看得到 → 点文件名打开预览 → 预览里出现真实内容 → 下载回来的字节 sha256 与源文件一致**。
  这条链在**本机门禁**与**部署演练环境**上各跑了一遍（§6）。§10 逐项对照业主的"功能完成 = 八项"。

## 2. 缺陷一：超级管理员不唯一

### 2.1 根因

三处叠加，缺一处都补不齐：

1. **迁移会按 V1 岗位名自动提升**：`scripts/import-v1.mjs` 里 `DEFAULT_ADMIN_ROLES = ['super_admin','principal']`
   → V1 里叫"园长/平台管理员"的账号被自动写成 ADMIN。演练库里因此有 **3 个** 管理员
   （`TsinglanAdmin`、`qlsadmin`、`v1-no-username-749e5d41`）。
2. **账号编辑接口留了第二条提权通道**：`PATCH /api/users/:id` 接受任意 `role`，
   一个被误配 `user.manage` 的老师可以把自己/别人升成 ADMIN。
3. **账号管理的门槛是"权限"而不是"身份"**：`user.manage` 是**可授予**的权限，
   只要它是唯一门槛，前端把按钮藏起来挡不住 curl。

### 2.2 修复（服务端为唯一事实）

| 位置 | 改动 |
|---|---|
| `server/authz/authorization.service.ts` | 新增 `isSuperAdmin(user)` / `assertSuperAdmin(user)`（唯一判定处，角色字面量仍只出现在这个文件）；`forbidSelf` 在 `reason === 'admin'` 时不再生效（超级管理员可以审核自己的资源 —— 上一轮业主已确认） |
| `server/common/decorators.ts` + `authz.guard.ts` | 新增 `@RequireSuperAdmin()`：过了权限检查之后**还要**过身份检查，拒绝时写 `authz.denied`（`reason: 'superadmin-required'`）再抛 403 |
| `server/users/users.controller.ts` | 6 个账号管理端点全部加 `@RequireSuperAdmin()`，并把 `actor` 传进 service |
| `server/users/users.service.ts` | 每个写操作开头 `assertSuperAdmin(actor)`；创建接口**只**能建 TEACHER（塞 `role: 'ADMIN'` → 400 `ROLE_NOT_CREATABLE`）；`PATCH` 把教师升成 ADMIN → 400 `SUPERADMIN_TRANSFER_REQUIRED`（**降级仍允许** —— 那是把历史遗留多个管理员收敛到一个的动作，仍受"最后一名管理员"保护） |
| `shared/permissions.ts` | `NON_GRANTABLE_PERMISSIONS = ['user.manage']` + `isGrantable()`；权限清单从 12 项变 **11 项**（`user.manage` 不再出现在界面上） |
| `scripts/import-v1.mjs` | `DEFAULT_ADMIN_ROLES = []`（**不再按岗位名提升**）；新增 `--admin-usernames a,b` 按**账号**显式指定；没有指定时打印醒目警告并在报告里写「身份迁移：**没有自动提升的管理员**」 |
| `scripts/transfer-superadmin.mjs`（新） | 唯一允许"换人"的入口：要求 `TRANSFER_FROM_USERNAME` / `TRANSFER_TO_USERNAME` / `TRANSFER_CONFIRM=TRANSFER-SUPERADMIN`；**一个事务**里锁行 → 一降一升 → 撤销双方会话 → 写两条审计（`user.role_transfer_out` / `user.role_transfer_in`）→ 自检"恰好一名有效管理员" |

### 2.3 证据

| 验证 | 结果 |
|---|---|
| `node --test tests/integration/account-privileges.test.mjs` | **16/16 PASS**（① 误配 `user.manage` 的老师调账号接口全部 403；② 创建只建 TEACHER；③ 改用户名 + 审计 + 会话失效；④ 升管理员被拒 + 交接脚本缺确认被拒且**没动数据** + 交接后**恰好一名**有效管理员 + 两条审计 + 能力互换） |
| 演练库（真实数据，走**接口**降级，可审计） | 降级前 `TsinglanAdmin` / `qlsadmin` / `v1-no-username-749e5d41` **3 个 ADMIN**；对后两个 `PATCH {role:'TEACHER'}` 各返回 200，并各写一条 `user.update` 审计（`detail.before.role = ADMIN`）；降级后 `SELECT role, status, count(*) FROM users GROUP BY 1,2` = **`ADMIN | active | 1`**、`TEACHER | active | 20`、`TEACHER | inactive | 3` |
| 演练验收脚本每次运行都断言 | `assert.equal(baseline.admins, 1)`（全部 3 次演练运行都通过） |
| `docs/PRODUCTION_PERMISSION_MATRIX.md` | 已重写：只有 `TsinglanAdmin` 一行是 ADMIN，全局**恰好 1 行** |

> 演练环境现在 = 生产的目标状态：**1 个超级管理员**、24 个业务账号（`qlsadmin` 保留为教师、
> `v1-no-username-749e5d41` 保留为**停用**教师 —— 历史审计不断链）。
> 生产库里这三条是 `import-v1.mjs --admin-usernames TsinglanAdmin` 直接产生的，不需要事后收敛。

## 3. 缺陷二：「教师成长」侧边栏的展开/收起失效

### 3.1 根因

`Sidebar.tsx` 里展开状态是**从"当前是否在这一支里"推导**出来的：

```tsx
const [open, setOpen] = useState(depth === 0 ? active : false)
const shouldBeOpen = open || (depth === 0 && active)   // ← 在这里被"当前活动"覆盖
```

于是站在「教师成长」这一支里时，`active === true` **永远**把 `shouldBeOpen` 拉回 true ——
点箭头把 `open` 改成 false 也没用：**动画和 `aria-expanded` 都被覆盖**，看起来就是"箭头点了没反应"。

### 3.2 修复

展开状态改成"用户的显式选择优先，未选择时才跟随当前地址"：

```tsx
const [userChoice, setUserChoice] = useState<boolean | null>(null)
useEffect(() => { setUserChoice(null) }, [active])   // 导航到别处 → 回到"跟随活动"
const shouldBeOpen = userChoice ?? active
onClick={() => setUserChoice(!shouldBeOpen)}         // 箭头只改选择，不导航
```

### 3.3 证据（断言的是 DOM，不是"点了没报错"）

| 用例 | 断言 |
|---|---|
| 本地 `browser.stage13b.test.mjs` ①（5 条） | 进入 `/directory/growth/l1/safety` 后自动展开（`aria-expanded="true"`、子节点数 > 0）→ 点箭头后 `aria-expanded="false"` 且**子节点从 DOM 消失** → 再点回来 → 连点 5 次（奇数）收 / 第 6 次展开 → 收起后**不会**被"当前就在这里"重新展开 → 点箭头**不导航**（URL 不变）→ 点名字仍导航并让新分支自动展开 → 深层 URL 直接进入时祖先链自动展开 → 没有子节点的目录**不渲染**箭头 |
| 演练环境（§6 ①） | 同样 5 条断言，跑在 `https://v2.localhost:8443` 的最终镜像上 |

## 4. 缺陷三：上传后的资源在对应目录不展示

### 4.1 根因（两个叠加，缺一不可）

1. **公开列表按设计只列 `PUBLISHED`**（业主 Stage 7 §17：目录浏览默认只显示已发布），
   而上传动作创建的是一条 `DRAFT` —— 老师上传完回到原目录，**看不到自己刚放上去的东西**，
   在老师看来就是"上传失败了"。
2. **`onlyMine` 参数在服务端被丢掉**：DTO 里有 `onlyMine`，但
   `resources.controller.ts` 组装 `ResourceFilters` 时**没有把它传下去** ——
   即使前端按"只看我的"查，服务端也当成没写。

### 4.2 修复

* `server/resources/resources.controller.ts`：把 `onlyMine`（以及 `recycled: false`）真的传进 `ResourceFilters`。
* `client/src/components/resource/MyUnpublishedResources.tsx`（新）：目录页里加一块
  「我的未发布资源」（`data-testid="my-unpublished-section"`），用 `onlyMine` 取**自己在当前目录**的未发布内容，
  复用同一张 `ResourceCard`（自带状态徽章、位置标签、退回意见）。没有内容时**整块不渲染**。
* 这一块的边界（都写进了组件注释，也有用例钉住）：
  * **只给自己看** —— 过滤在**服务端**（`uploader_id`），前端不做安全判断；
  * **不污染公开列表** —— 两个独立请求，公开列表的总数/分页仍然只算已发布；
  * **已退回要出现**（正等着老师改完再交，卡片上带退回意见）、**已撤回不出现**
    （撤回是老师**主动**把东西从目录里拿走，再摆回去等于没撤回）；
  * **不参与搜索/分页** —— 搜索框过滤的是下面那块公开列表，这一块稳在搜索框上方。
* `client/src/directory/label.ts`（新）+ `MyUnpublishedResources`：卡片位置标签复用**同一份**
  slug→中文翻译（`ResourceList` 原来内联了一份，抽出来避免"第二份目录翻译"）。

### 4.3 证据

| 层 | 证据 |
|---|---|
| 数据库 | 演练环境里教师在界面选文件上传 4 次（PNG / TXT / PDF / ZIP），每次都用 `psql` 查 `resources JOIN directories JOIN resource_files`：状态 `DRAFT`、目录 id **等于界面上选的那个目录**、文件名、字节数、**sha256 等于源文件**、`storage_key` 非空、mime 正确 |
| 接口 | `GET /api/resources?directoryId=…&status=PUBLISHED` 不含自己的草稿；`…&onlyMine=true` 含；别人的 `onlyMine` 查询不含（服务端过滤） |
| 浏览器（本人） | 目录页出现「我的未发布资源」，4 条标题都在、徽章都是「草稿」；**真实 reload 之后仍在** |
| 浏览器（别人） | 另一个只读教师在同一目录：公开列表没有、**那一块整块不出现**、单条详情 403 |
| 状态迁移 | 被退回 → 出现在那一块且带「已退回」+ 退回意见；发布 → 从那一块消失并进入公开列表；撤回 → 目录页**任何地方**都没有（只在「我的资源」，状态「已撤回」） |

### 4.4 一处必须说明的测试发现

`tests/integration/browser.stage6.test.mjs` 的 PNG 夹具原本是
**"PNG 签名 + 一段文本"的假图**（不是能解码的图片），而旧断言只数 `<img>` 元素在不在 ——
**它一直在验一个假成功**。本轮让界面在图片加载失败时如实报错之后，这张假图立刻把这条用例顶红了。
处理方式不是放宽断言，而是：夹具换成**真图**，断言升级为"真的解码出来了"（`naturalWidth > 0`）
且不出现错误提示。

## 5. 缺陷四：文件打不开 / 预览 / 下载失败

### 5.1 根因（三类，全部会表现成"点了没反应"）

1. **失败被静默掉**：
   * TXT 预览直接 `fetch(url).then(r => r.text())`，**不看 `response.ok`** ——
     地址过期 / 对象不在时，服务端返回的 XML 错误页会被当成**文件内容渲染**出来，
     看起来像"预览成功了，只是内容很怪"（比报错更糟）；
   * `<img>` 没有 `onError` —— 坏图/地址过期时停在空白或加载中；
   * 下载 `download()` 里异常会**逃出去**（调用方 `void download()`），用户没有任何提示，
     控制台多一条未处理 rejection。
2. **没有可用的恢复动作**：失败之后只能关掉重开，没有"重新申请一个地址"的出口。
3. **文件名是纯文本**：老师最自然的动作是点文件名，而它不可点（只有右侧小按钮）。

### 5.2 修复

| 文件 | 改动 |
|---|---|
| `client/src/components/resource/FilePreviewDialog.tsx` | 每次打开/重试都先回到 `loading`；TXT 分支检查 `response.ok`，失败给一句人话（含状态码 + "可能已移除/已过期" + 重试指引）；图片加 `onError` → 明确错误；PDF 分支写明"一直空白说明没取到，可重新加载或下载"；下载改成 `try/catch` → 错误状态；新增「重新加载」按钮（`file-preview-reload`）与错误里的重试按钮（`file-preview-retry`），点它**重新申请一个新的签名地址** |
| `client/src/components/resource/FileList.tsx` | 文件名变成按钮（`data-testid="file-name"`）：可预览 → 打开预览；不可预览（Office/ZIP）→ 直接下载 |
| `client/src/flows`/`file-policy.ts`（沿用） | 预览类型白名单仍是 pdf / png / jpg / jpeg / txt；Office / ZIP 显示「此文件类型暂不支持在线预览，请下载查看。」 |

### 5.3 证据

| 场景 | 本机门禁 | 演练环境（部署栈） |
|---|---|---|
| PNG 预览 | 点文件名 → 图片**真的解码**（`naturalWidth > 0`） | 同左（真 Chrome，HTTPS，跨域直传） |
| TXT 预览 | 预览里出现文件**真实内容**（含第二行） | 同左（内容为演练夹具的文本） |
| PDF 预览 | iframe 预览（阶段 6/9/10/11 原有用例 + Safari） | 预览 iframe 的 `src` **取回来是 `%PDF-` 开头**的真实字节 |
| ZIP / Office | ZIP 点文件名 → 下载；DOCX/ZIP **没有**预览按钮、有「不支持预览」提示 | ZIP 点文件名 → 下载，**sha256 与源文件一致** |
| **对象真的不存在** | 本地 provider 直接删掉磁盘对象 → 预览显示错误、**不**渲染"内容"、给得出重试 | 用 S3 客户端删掉**本次自己刚传的**对象（先 `HeadObject` 确认 404）→ 界面报错、不假成功、有重试入口 |

## 6. 真实浏览器端到端验收（对**部署环境**，不是测试替身）

本机门禁跑的是同一份 `dist`，但存储是 local provider、没有 nginx、没有 HTTPS、没有跨域直传、
没有真实 S3 签名。所以另建一份**部署环境验收**：
`tests/production/browser.stage13b-rehearsal.test.mjs`（真 Chrome + `https://v2.localhost:8443`
+ 真 PostgreSQL + 真对象存储），7 个用例组 / 12 条断言，**连续 3 次 12/12 PASS**（含最终镜像那一次）。

它做的事（每一步都断言**可观察结果**，不是"没报错"）：

1. **① 侧边栏**：`/directory/growth/l1/safety` 上收起 / 展开 / 点箭头不导航 / 收起后不被自动展开。
2. **② 界面选文件上传**：教师登录 →「上传资源」→ 填标题 → **选本地文件** → 保存 →
   详情页出现 → `psql` 查库（资源行 + 文件行、目录 id、字节数、**sha256**）。
3. **③ 目录可见性**：回到那个目录 → 4 条都在「我的未发布资源」里、徽章「草稿」、
   公开列表里没有 → **真实 reload 之后仍在**。
4. **④ 打开文件**：PNG 解码 / TXT 真实内容 / PDF `%PDF-` 字节 / ZIP 下载 **sha256 一致**且没有预览按钮。
5. **⑤ 失败路径**：删掉 TXT 的对象（`HeadObject` 404 复核）→ 界面报错、不渲染内容、有重试。
6. **⑥ 权限隔离**：只读教师（能进这个目录、没有上传权）→ 列表没有、详情 **403**、目录页没有那一块。
7. **⑦ 收尾**：`purge` 掉本次 4 条资源 + 停用验收账号 → `resources` / `resource_files`
   计数**回到基线**、`阶段13B验收-%` 残留 0 条、管理员仍然**恰好 1 名**；
   并检查浏览器**控制台/网络**里没有未登记的错误（登记在案的只有两处**被测行为**制造的失败：
   故意删对象后的存储 404、只读教师取别人草稿的 403，以及设计如此
   `/api/auth/me` 未登录 401）。

另外 `deploy/verify.mjs` 对着同一环境跑 **12/12 PASS**（含样式真的被编译、服务端能访问对象存储、
迁移 0 pending、核心计数）。

### 6.1 本轮的一次操作事故与恢复（必须披露）

我在跑本机门禁时习惯性执行了 `pkill -9 -f "weed server"`，**把演练环境的 SeaweedFS
（18443）一起杀掉了**（它和测试用的存储后端是同一类进程）。发现后立刻重启，
并**做了对象级复核**（不只看"服务可达"）：

* 演练库 4 条 `resource_files`：3 条可读（HTTP 200，字节数与登记一致）、
  1 条 404 —— 查库确认那条资源 `deleted_at IS NOT NULL`（**软删除**的测试资源），
  404 是**正确的可见性行为**，不是对象丢失；
* `deploy/verify.mjs` 复跑 12/12，`resource_files` 计数仍为 4，业主的数据没有被改动。

结论：**没有数据丢失**；但这条命令是危险动作，已记在本报告里，后续不要在演练栈运行时执行它。

## 7. 完整测试门禁（本轮实际执行）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | PASS（SWC 52 文件 + 前端产物自检：主题变量已编译、工具类齐全） |
| 类型 | `npm run typecheck`（server + client） | PASS（0 错误） |
| 静态 | `npm run lint` | PASS（0 问题） |
| 单元 | `npm run test:unit` | **206 / 206 PASS** |
| 集成 | `npm run test:integration` | **614 / 614 PASS**（**连续三次**全绿，最后一次跑的正是本提交的冻结代码） |
| 部署环境验收 | `PRODUCTION_BASE_URL=… node --test tests/production/browser.stage13b-rehearsal.test.mjs` | **12 / 12 PASS** |
| 部署环境自检 | `node deploy/verify.mjs --base https://v2.localhost:8443 --cacert deploy/tls/fullchain.pem --http-port 10088` | **12 / 12 PASS** |
| Safari | `npm run test:safari` / `SAFARI_VIEWPORT=mobile npm run test:safari` | 见 §7.1 |

**没有**通过降低断言、跳过网络错误、关闭证书校验、删除测试或 mock-only 拿到全绿：
演练验收不设 `PRODUCTION_INSECURE_TLS`（靠开发 CA 真信任），
`problemReport` 的 allowlist 每条都写明了理由，删除对象的失败路径是**真的删对象**。

### 7.1 Safari

| 视口 | 结果 |
|---|---|
| 桌面 1440×900（`npm run test:safari`） | **10 / 10 PASS**，**连续两次**都全绿 |
| 移动 390×844（`SAFARI_VIEWPORT=mobile npm run test:safari`） | **10 / 10 PASS** |

覆盖：登录 → 教育教学 → Pre-K → 美德 → 教学资源（全靠点击）→ 资源详情 →
PDF 预览（Safari 自己取回字节）→ 图片预览（**真的解码**）→ 下载（sha256 一致 + 服务端留下载审计）→
我的资源 → 提交审核 → 管理员通过并发布 → 撤回 → 删除 → 回收站 → 恢复。

**修这一条时发现的真问题（值得写下来）**：第一轮 Safari 跑出 8/10，失败的是
「回收站 → 恢复」；再跑又变成另一组失败（⑤/⑦/⑧/⑨ 每次都不同）。于是写了一个**只验一步**的探针
（`/tmp` 里的临时脚本，不入库），记录到的现场是：

```
恢复按钮状态： {"w":52,"h":32,"disabled":false,"topTag":"BUTTON","topText":"恢复"}   ← 命中测试 ok
点击方式： webdriver                                                              ← 原生点击没报错
t=1..12s deleted_at=still-set dom={"error":null,"restoreStillThere":true}           ← 但什么都没发生
页面内 el.click()： clicked
页面内点击后 deleted_at： null(已恢复)                                              ← 同一个按钮，页面内点击有效
页面内直接调恢复接口： {"status":409,"message":"资源没有被删除"}                     ← 接口本身也是好的
```

结论：**产品在 Safari 里是好的，丢失的是驱动层的输入** ——
`element/click` 是"先按 ID 找到节点、再发点击"两步走，列表因为请求回来而重渲染
（React 换掉节点）时驱动手里的节点已经不在文档里，点击就**静默丢失**。
Chrome 那条 CDP 通道每次点击都重新查询 DOM，所以从来没出过这个问题。

处理方式（只动测试怎么点，不动判据）：Safari 验收里**按 testid 定位的动作按钮**
统一改成页面内 `el.click()`（导航链接仍然用原生点击 —— 它们带 `href`，更接近真实用户，
而且从未出过问题）；所有断言仍然是**数据库效果**（状态 / `deleted_at` / 审计 / sha256），
产品逻辑真的坏掉照样会红。改完连续两次桌面 10/10、一次移动 10/10。

### 7.2 本轮为对齐新规则而更新的既有用例（一处不能少，只能**加强**）

| 文件 | 为什么必须改 | 改法 |
|---|---|---|
| `browser.stage5`（目录卡片 / 搜索） | 目录页现在多了一块「我的未发布资源」，旧的"页面上所有卡片都是已发布"选择器会把它算进去 | 选择器**限定到公开列表**（`resource-list`），并**新增**断言：自己那条草稿必须在那一块里且徽章「草稿」、别人的草稿在页面上**任何地方**都不出现 |
| `browser.stage6`（上传路径 / 图片预览） | ① 同上；② 图片夹具是假图 | ① 公开列表里没有它 + **那一块里有它**（两处都断言）；② 夹具换成真 PNG，断言升级为"真的解码" |
| `browser.stage7`（撤回） | 撤回后目录页**不该**再出现它 | **不改用例**：改产品 —— 已撤回不进那一块（撤回 = 从目录里拿走） |
| `browser.stage10` / `browser.stage9` / `users` / `admin-users` / `migration-v1` / `review-permission` | 上一轮已对齐"超级管理员唯一化"与"未发布可见性"的新规则 | 同左（见上一轮提交） |
| `admin-security` | 第二个管理员原来是"创建教师 + PATCH 提升"造的，而这条通道**已被封**（这正是本轮的修复） | 第二个管理员改用夹具直写（**模拟历史数据**——生产上确实出现过 3 个管理员），并**新增**用例钉住"PATCH 提升教师被 400 `SUPERADMIN_TRANSFER_REQUIRED` 拒绝且不留变化" |

## 8. 权限与安全复查（本轮实际检查项）

| 项 | 结论 |
|---|---|
| 账号管理门槛是**身份**而不是权限 | PASS —— 6 个端点 `@RequireSuperAdmin()`；误配 `user.manage` 的老师全部 403（① 组用例）；被拒时写 `authz.denied` 审计 |
| 提权通道 | PASS —— 创建只能建 TEACHER；PATCH 升 ADMIN 被拒（400）；`transfer-superadmin.mjs` 要求显式确认字符串，且缺确认时**不动数据**（用例断言） |
| 最后一名管理员护栏 | PASS —— 停用/降级最后一名有效管理员被拒（`LAST_ADMIN`，文案「系统至少需要一名管理员。」）；自我降级被拒（`SELF_ROLE_CHANGE`） |
| 会话即时失效 | PASS —— 改身份 / 停用 / 改口令 / 改用户名 / 改权限都撤销该账号全部会话（用例逐条验） |
| 未发布资源的可见性 | PASS —— 服务端按 `uploader_id` 过滤 `onlyMine`；别人的草稿列表没有、详情 403、页面上任何地方都不出现 |
| 审计 | PASS —— 身份/状态/口令/用户名/交接都有独立 action，`detail.before` 记录前值；审计内容里**没有**口令 |
| 浏览器端安全（沿用 stage12 用例） | PASS（`/api/auth/me` 未登录返回 401 是设计如此；会话 cookie `Secure + HttpOnly + SameSite=Lax`，令牌不进 localStorage） |

## 9. 剩余风险、未验证项与阻塞

| 项 | 状态 | 说明 |
|---|---|---|
| 生产 R2 的对象枚举 | **UNVERIFIED / BLOCKED** | 只有 Zeabur 里有凭证，本地无法列出生产桶；需要业主提供只读凭证或对象清单 |
| 正式环境切换（Zeabur / 正式域名 / 正式库） | **BLOCKED** | 我没有 Zeabur 访问权限；`docs/CUTOVER_PREFLIGHT_REPORT.md` 已备好步骤与回滚 |
| 演练环境 ≠ 正式环境 | 风险 | 演练栈是本机 Docker（同名服务、同名契约、真 HTTPS/真 S3 签名），但**不是** Zeabur 的网络与配额 |
| 一次观察到的偶发红 | 已缓解，需继续观察 | 某一次全量集成里 `browser.stage11` 的"9 个尺寸不溢出"红了一次（当时输出被过滤，没留下细节）；随后**连续两次全量 614/614 全绿**。期间我做了两件与之相关的事：已撤回不再进入新那一块（去掉一个可能的渲染源）、把那一块的标题改成可换行（320px 下不顶横向滚动条）。若再出现，应当**保留完整输出**再修，不要当偶发忽略。 |
| Safari 的驱动层不稳（已定位并绕过） | 已缓解 | 见 §7.1：WebDriver 原生点击在列表重渲染后可能静默丢失。验收改用页面内点击；**这是测试送事件的方式，不是产品行为**，产品在 Safari 里点得动（探针证据）。 |
| 新那一块在极窄宽度下的表现 | PASS（间接） | 320 / 375 / 390 … 9 个尺寸的断点回归在最终代码上两次全绿 |

## 10. 部署前结论：按业主的"功能完成 = 八项"逐条对照

| 业主的判据 | ① 超管唯一化 | ② 侧边栏 | ③ 上传后可见 | ④ 文件打开 |
|---|---|---|---|---|
| UI 有入口 | 账号管理页（仅超管可见） | 侧边栏箭头 | 目录页「我的未发布资源」 | 文件名可点 + 预览/下载按钮 |
| 用户可点击 | 编辑身份 / 交接（脚本） | 点箭头 | 上传按钮 → 弹窗 | 点文件名 / 预览 / 下载 / 重新加载 |
| API 存在 | `POST/PATCH/PUT /api/users…` | 纯前端 | `GET /api/resources?onlyMine=true` | `…/files/:id/preview`、`…/download` |
| 后端逻辑存在 | `assertSuperAdmin` + 守卫 + 交接脚本 | 前端状态机 | `ResourceFilters.onlyMine`（服务端过滤） | `file-policy` + 签名地址 |
| 数据库真的改变 | 演练库 3 → 1 个 ADMIN（有审计） | — | 每次上传两行（含 sha256，`psql` 复核） | 对象真的落进存储（S3 复核） |
| 刷新后状态还在 | 是（权限来自服务端） | 是 | **真实 reload 后仍在** | 是（详情页文件行仍在） |
| 权限正确 | 误配 `user.manage` 也 403；无法新增管理员 | — | 别人看不到（403 / 不渲染） | 只读教师也能下载，但不能改 |
| 异常正确 | 缺确认字符串拒绝且不动数据 | — | 那一块加载失败只提示、不挡公开列表 | 对象不存在 → 明确报错 + 重试，**不假成功** |
| 浏览器真实通过 | 是（本机 + 演练） | 是（本机 + 演练） | 是（本机 + 演练） | 是（本机 + 演练） |

```
SUPERADMIN UNIQUE             : PASS
DIRECTORY NAVIGATION          : PASS
UPLOAD RESOURCE VISIBILITY    : PASS
PDF/IMAGE/TXT PREVIEW         : PASS
OFFICE/ZIP DOWNLOAD           : PASS
FILE PERSISTENCE & HASH       : PASS
PERMISSION ISOLATION          : PASS
FULL TEST GATE                : PASS
PRODUCTION CUTOVER            : NOT READY   ← 只差正式环境的访问权限与生产 R2 的枚举核验
```
