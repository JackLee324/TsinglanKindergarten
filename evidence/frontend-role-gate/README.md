# 前端授权判定缺陷 —— 登录成功后「无权访问」

> 状态：**已修复，行为级证据齐备**。修复需要**重新部署**才能到达线上。
>
> 证据等级：这是可复现的用户可见故障，因此证据不是"读代码"，而是
> "用真浏览器、真登录、真渲染，在**构建产物**上复现出来再修掉"。

---

## 1. 用户看到的现象

部署成功、登录成功，然后：

```
English  无权访问
您没有权限访问此页面，请联系管理员。
返回首页
```

点「返回首页」又回到同一个页面 —— 看起来"按钮坏了"、"首页坏了"。

## 2. 根因（一条缺陷，两个症状）

前后端**对同一个问题给了两个不同答案**：

| 位置 | 判定 | 对 `super_admin` 的结论 |
| --- | --- | --- |
| `server/modules/authz/authorization.service.ts:207-208` | `if (authz.roles.includes(SUPER_ADMIN_ROLE)) return true;` | **放行**（持有全部权限、跳过 scope） |
| `client/src/auth/ProtectedRoute.tsx:33`（修复前） | `requiredRoles.length > 0 && !user.roles.some(r => requiredRoles.includes(r))` → 跳 `/unauthorized` | **拒绝** |
| `client/src/auth/auth-context.tsx:76`（修复前） | `user.roles.some(r => roles.includes(r))` | **拒绝**（侧边栏管理菜单被隐藏） |

`client/src/app.tsx:30` 的 `TEACHER_ROLES` 是一份**白名单字面量**：

```
['principal','curriculum_director','prek_head','k_head','pe_specialist','prek_assistant','k_assistant']
```

`super_admin` **不在里面**。而 `app.tsx:65` 用 `TEACHER_ROLES` 包住了**整块**受保护路由。

于是对**只持 `super_admin`** 的账号：

1. 登录 201 成功 → 浏览器跳到 `/`；
2. `/` 在 `<ProtectedRoute requiredRoles={TEACHER_ROLES}>` 里 → 交集为空 → `Navigate to="/unauthorized"`；
3. `UnauthorizedPage` 的 `返回首页` 是 `<Link to="/">` → 回到第 2 步。

**症状 1**「无权访问」与**症状 2**「返回首页没反应」是同一个根因的两个面，不是两个 bug。

### 为什么这就是线上那台机器的形态（不是猜测）

`scripts/provision-super-admin.mjs:135`：

```js
const ROLE = typeof args['role'] === 'string' ? args['role'] : 'super_admin';
```

**默认就是 `super_admin`**，且 `scripts/entrypoint.sh:128-132` 创建初始管理员时走的正是这条默认路径。
所以**每一次全新部署拿到的初始账号就是这个形态**，登录后必然看到上面那一屏。

本地测试库中的实际行（与线上同构）：

```
{"username":"Tsinglan001",   "roles":["super_admin"], "status":"active"}
{"username":"NoMfaAdmin",    "roles":["super_admin"], "status":"active"}
{"username":"TsinglanAdmin", "roles":["super_admin"], "status":"active"}
```

浏览器实测 `/api/auth/me` 返回：

```json
{"username":"E2EAdmin","name":"系统超级管理员","roles":["super_admin"],"status":"active"}
```

### 为什么以前所有测试都是绿的

- 后端对 `super_admin` **本来就放行**：`/api/teachers` → 200、`/api/resources` → 200。
- 因此全部 HTTP 套件（`authz-http` 74 / `hardening` 10 / `mfa` 55 / `security-headers` 20 /
  `files-http` 74 / `naming-http` 49，共 282 条）**只看状态码，一条都测不出来**。
- 部署 E2E 第 6 节确实用了无头浏览器，但渲染的是**未登录**的 `/`（登录页）；
  第 7 节只做 curl 登录，不渲染页面。

**这是一条纯前端的缺陷，必须"真登录 + 真渲染"才能发现。**

### 归因：这是原项目自带的问题，不是迁移引入的

```
$ git diff --stat baseline-v1.3.0 -- client/src/app.tsx client/src/auth/ProtectedRoute.tsx
（空输出 —— 两个文件与 v1.3.0 基线逐字节一致）
```

迁移没有碰过这两个文件。原版之所以没暴露，是因为它的初始账号同时持有 `principal`
（`principal ∈ TEACHER_ROLES`）。本项目 bootstrap 创建的是纯 `super_admin`，把这个潜伏缺陷
顶了出来。

> 方法论结论：**"保持 UI 不变"不等于"保持行为不变"**。这两个文件逐字节没变，
> 但账号的**角色构成**变了，于是同一份 UI 代码表现出完全不同的行为。

## 3. 修复

**一处规则、三个调用点**：

| 文件 | 改动 |
| --- | --- |
| `shared/rbac.ts` | 新增纯函数 `hasAnyRole(held, required)`：`required` 为空 → true；`held` 含 `super_admin` → true；否则取交集。注释写明它**镜像后端**的 `authorization.service.ts`，且**不是安全边界**（只决定渲染什么，不决定允许什么；服务端每个请求都会重新校验）。 |
| `client/src/auth/ProtectedRoute.tsx` | 手写交集 → `hasAnyRole(user.roles, requiredRoles)` |
| `client/src/auth/auth-context.tsx` | 手写交集 → `hasAnyRole(user.roles, roles)` |
| `client/src/pages/Home/HomePage.tsx` | 手写 `user?.roles?.includes('principal') \|\| …` → `hasRole(['principal','curriculum_director'])`（见 §5） |

把规则放进 `shared/` 而不是抄两遍，是为了**让两侧无法各自演化** —— 这正是本条缺陷的形态。

`Layout.tsx` 的 `filterMenuByRoles` 与 `TeacherAdminPage.tsx` 的 `canEdit` 都经由
`auth-context.hasRole`，因此这两处一并被修复，不需要单独改。

### 没有改动的东西（刻意）

- 后端 `authorization.service.ts`：**一行都没动**。后端本来就是对的。
- UI：除权限判定外，**没有改动任何文案、布局、样式**。
- `TEACHER_ROLES` 等白名单字面量：**保持原样**。修的是"怎么用它们判定"，
  不是"白名单里放谁"。`visitor` 依旧被拒（AGENTS.md 明确要求访客不能进入课程内容）。

## 4. 行为级证据：三个镜像的三段式定位

测试位置：`scripts/verify-e2e-deploy.sh` 第 **6c** 节（新增）。
它把一次性探针页拷进**本次测试的临时容器**（不进镜像、不进产物、不进仓库），
由探针完成真实登录后跳转 `/`，再由**构建产物里的 SPA 自己**决定渲染什么。

三个账号构成完整三态，缺一不可：

| 账号 | 角色 | 作用 |
| --- | --- | --- |
| `E2EPrincipal` | `principal` | **阳性对照 + 探针机制自检** |
| `E2EAdmin` | `super_admin` | **故障复现** |
| `E2EVisitor` | `visitor` | **阴性对照**（防止用"把门开大"的方式假修复） |

### 三个镜像，两处缺陷，各自被精确指认

| 镜像 | 客户端状态 | 6c 失败项 | 整轮 E2E |
| --- | --- | --- | --- |
| `qls-e2e:prefix` | 两处缺陷都在 | **4 条**（super_admin：无权访问 / 渲染首页 / 平台统计 ×2） | **45 / 49** |
| `qls-e2e:homepage-bug` | 只修了路由守卫 | **2 条**（super_admin：平台统计 ×2） | **47 / 49** |
| `qls-e2e:test` | 两处都修好 | **0 条** | **49 / 49** |

**每一处缺陷恰好产生它自己的那几条失败**，没有互相掩盖，也没有多余的失败 ——
这说明断言测的确实是它们声称要测的东西。

原始日志：`before-fail.txt` / `second-instance-isolation.txt` / `after-pass.txt`。

### 浏览器实际渲染文本

修复前（`qls-e2e:prefix`）：

```
probe[principal]   … 首页 Pre-K K 资源上传 我的资源 审核工作台 管理后台 … 园长/平台管理员
                   早上好，园长/平台管理员 今天是 … Pre-K 资源 303 K 资源 44
probe[superadmin]  English 无权访问 您没有权限访问此页面，请联系管理员。 返回首页
                                                    ↑ 与用户截图逐字一致
probe[visitor]     English 无权访问 您没有权限访问此页面，请联系管理员。 返回首页
```

修复后（`qls-e2e:test`）：

```
probe[superadmin]  … 首页 Pre-K K 资源上传 我的资源 审核工作台 管理后台 … 系统超级管理员
                   早上好，系统超级管理员 今天是 … 我的资源总数 0 待审核数量 0 …
                   ← 且出现平台统计三张卡：Pre-K 资源 / K 资源 / 本周绘本封面
```

## 5. 同一缺陷形态的第二个实例（本次一并修掉）

`client/src/pages/Home/HomePage.tsx:128` 原文：

```ts
const isAdmin = user?.roles?.includes('principal') || user?.roles?.includes('curriculum_director');
```

`super_admin` 同样被漏掉 → 首页**少显示三张平台统计卡片**，只显示教师那一排
（`我的资源总数 0 / 待审核数量 0 / …`）。页面**能打开**，所以"渲染出首页"那条断言抓不到它。

第一次排查时它被漏掉，因为搜的是 `roles.includes`，而这里写的是 `roles?.includes`
（中间有可选链）。**"靠一次 grep 记住还有没有别的地方"是不可靠的。**

因此新增了一条**泛化**守卫（`tests/client-role-gate.test.mjs`）：扫描整个 `client/src`，
任何 `user(.?)?.roles(.?)?.includes|some|indexOf(` 都必须改为 `hasRole(...)`。
注释会先被剥离（否则解释这条缺陷的注释本身会被误判 —— 这是第一次运行失败暴露出来的），
白名单只有一处且写明理由（`TeacherFormDialog.tsx` 的表单角色勾选，与当前登录者无关）。

## 6. 非空洞性证明

### 6.1 单元级变异测试（`mutation-test.txt`）

把三处被保护的性质逐个破坏，确认测试会失败：

| 变异 | 结果 |
| --- | --- |
| 删掉 `hasAnyRole` 里的 `super_admin` 通配 | **pass 11 / fail 5** ✅ 被抓 |
| 把 `ProtectedRoute.tsx` 改回手写交集（故障原形态） | **pass 15 / fail 1** ✅ 被抓 |
| 抹掉后端 `authorization.service.ts` 的 super_admin 放行 | **pass 15 / fail 1** ✅ 被抓 |
| 全部还原 | **pass 17 / fail 0** |

第 3 条是有意为之的：前端镜像的是后端那条规则，后端一旦改变语义，前端的放宽就失去依据，
测试必须失败并把这件事说出来。它是**源码断言**，比前两条弱，因此在文件里明确标注了，
并指向第 6c 节作为端到端证据。

### 6.2 泛化守卫的非空洞性

| 变异 | 结果 |
| --- | --- |
| 把 `HomePage.tsx` 的真实缺陷改回去 | ✅ 被抓（`pages/Home/HomePage.tsx:137`） |
| 在一个**从未有过该缺陷**的文件（`Layout.tsx`）里植入同类写法 | ✅ 也被抓（`components/Layout.tsx:72`） |

第二条是这条守卫的价值所在：它证明这是**真扫描**，不是一份"已知违规清单"。

### 6.3 我自己写错的一条断言（保留，因为它是本次最重要的教训）

第一版"平台统计"断言用的是 `资源总数`。它**永远为真**：

```
'资源总数' in '我的资源总数'  ->  True     ← dashboard.stat.myResources，教师那一排的标签
```

`dashboard.stat.totalResources`（资源总数）在 `translations.ts` 里存在，
但**全代码库没有任何地方渲染它** —— 是个死 key。所以那条断言在任何状态下都通过，
测不出任何东西。改用 `Pre-K 资源` 与 `本周绘本封面`（都不是教师标签的子串，
也不会被导航串 `Pre-K K 资源上传` 误命中），并用 §4 的中间镜像证明了它们真的会失败。

> 一条永远为真的断言比没有断言更糟：它看起来像有覆盖。

### 6.4 探针机制自身的两次失败（同样保留）

第一版探针**静默失效**并让两条断言**假绿**：

- 探针调 `/api/auth/login` 时没有带 `x-suda-csrf-token` 头 → 服务端 403
  `csrf token not found in header`；
- 登录失败后仍然 `location.replace('/')` → SPA 渲染出**登录页**；
- 于是「super_admin：看不到「无权访问」」**通过**了 —— 因为登录页里也没有那四个字。

修正：探针先读 `document.cookie` 里的 `suda-csrf-token` 再放进请求头（cookie 由页面路由签发，
`csrf-token.middleware.ts` 的契约）；登录失败时**不跳转**，把状态与原因留在 DOM 里；
并新增"探针跑通"断言（DOM 中不得残留 `PROBE-` 前缀），使探针自身失败**不可能**再被当成通过。

这条与 B6（`process.exit()` 让中断的套件打印 `pass=22 fail=0`）是同一类：
**测试基础设施的失败必须表现为失败，不能表现为什么都没发生。**

## 7. 部署侧需要做什么

**必须重新部署**（重新构建镜像），因为修复在客户端产物里。

部署后自检（不需要命令行）：

1. 用管理员账号登录 → 应当直接进入工作台，右上角显示姓名；
2. 首页应当出现平台统计三张卡（Pre-K 资源 / K 资源 / 本周绘本封面）；
3. 侧边栏应当出现「管理后台」（`admin/teachers`、`admin/permissions`、`admin/audit`）；
4. 用**普通访客**账号登录 → 仍应看到「无权访问」（这是正确行为，不是回归）。

### 无法重新部署时的临时处置（不推荐，仅备选）

线上账号是**只持 `super_admin`**。由于 `client/src/app.tsx` 的白名单是硬编码的，
在不改代码的前提下唯一能立刻进去的办法是让账号**同时**持有 `principal`：

```sql
UPDATE teachers
SET roles = ARRAY['super_admin','principal']::varchar[]
WHERE username = '<你的管理员用户名>';
```

> ⚠️ 这个 SQL 需要数据库直连权限（Zeabur 的 PostgreSQL 服务里有 connection string / 终端）。
> 我没有、也不应该持有你的线上凭据，因此**这条没有被执行过**，只是可行方案。

> ⚠️ **不要**用 `scripts/provision-super-admin.mjs --grant-role --role principal` 来"追加"角色：
> 尽管名字叫 `--grant-role`，它的实现是 `set roles = array[${ROLE}]`（**整体替换**，不是追加）。
> 对 `super_admin` 账号执行它会把账号**降级**为 `principal`。
> 文件头把它描述为"只恢复角色"，所以这是**命名误导**而非实现缺陷 —— 但后果很重，故记录在案。
> 本次没有改动该行为，避免在故障处置期移动工具语义。

## 8. 本次改动的文件

```
shared/rbac.ts                                  +hasAnyRole（单一真相来源）
client/src/auth/ProtectedRoute.tsx              改用 hasAnyRole
client/src/auth/auth-context.tsx                改用 hasAnyRole
client/src/pages/Home/HomePage.tsx              改用 hasRole（第二个实例）
tests/client-role-gate.test.mjs                 新增 17 条（含变异验证 + 泛化守卫）
scripts/verify-e2e-deploy.sh                    新增第 6c 节；新增 E2E_SKIP_BUILD
evidence/frontend-role-gate/                    本目录
PRODUCTION_RELEASE_REPORT.md                    附录 G（摘要）
```

未删除任何文件；未改动任何 UI 文案/样式；未改动后端授权逻辑。

## 9. 本目录的证据清单

| 文件 | 内容 |
| --- | --- |
| `before-fail.txt` | `qls-e2e:prefix`（两处缺陷都在）第 6c 节 + 整轮结果 |
| `second-instance-isolation.txt` | `qls-e2e:homepage-bug`（只修了路由守卫）—— 第二个缺陷的隔离证明 |
| `after-pass.txt` | `qls-e2e:test`（两处都修好）第 6c 节 + 整轮结果 |
| `mutation-test.txt` | 单元级变异测试（三处性质逐个破坏） |
| `gate-and-deploy-final.txt` | 权威门禁（282 条 HTTP + 单元 + 类型 + 构建 + 契约）与最终部署验收 |
