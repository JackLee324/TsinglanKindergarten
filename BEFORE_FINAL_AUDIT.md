# BEFORE_FINAL_AUDIT.md — 只读基线扫描

> **本文档只做只读核对，不修改任何东西。** 每一条都标注了证据（file:line 或命令输出）
> 与判定：**已证实 / 已推翻 / 待验证**。没有证据的条目一律不进"已证实"。
>
> 扫描时间：2026-09-26　HEAD = `a90c33c`（已推送 origin/main）
> 扫描方式：`grep` / `git ls-files` / `git status` / 构建产物指纹，未运行写操作。

---

## 0. 先说三件影响全局的事

### 0.1 `教师平台.pdf` 不在本机 —— 需要你提供

```
$ find ~/Desktop -maxdepth 3 -iname "*.pdf"
1报告数据分析.pdf / File.pdf / P采购与仓储管理工作交接手册.pdf / V采购与仓储管理工作交接手册.pdf
/ 家具扫描件.pdf / 家具采购结算单.pdf / 床品.pdf / 床品扫描件.pdf / ~$紧急预案.pdf
```

**没有 `教师平台.pdf`。** 你消息里贴的目录树是文字转录，我以它为准先把结构记下来，
但 §1「PDF 目录要求必须完整落地」的验收基准是 PDF 本身（节点层级、"允许自建文件夹"
标在哪些节点上）。**请把 PDF 放到项目目录或告诉我路径**，否则我无法声称"PDF 目录已完整落地"。

### 0.2 §28「项目仍依赖 @lark-apaas」——**已推翻**

```
$ grep -c '@lark-apaas' package.json                      → 0
$ grep -rnE "(from|require\()\s*['\"]@lark-apaas" server/ client/ shared/ scripts/  → 0 命中
$ ls node_modules/@lark-apaas                              → 存在（仅是本地残留目录，未被依赖）
```

- `package.json` 与全部源码：**0 引用**；
- `package-lock.json` 在脱平台提交里移除了 467 个节点、0 个版本变化、0 个新增；
- 构建出的镜像内 `node_modules/@lark-apaas` 为 **0 个**，运行时 require 为 **0**。

**结论：运行时耦合已经不存在。** 唯一残留是**本机** `node_modules/@lark-apaas` 这个未清理的安装目录
（不进 git、不进镜像）。§28 的这句描述对当前 HEAD 不成立，不需要再做"最终统一"。

### 0.3 工作区里有**未跟踪**的垃圾文件与一个"看似已删其实还在"的目录树

```
$ git status --short
?? client/src/components/business-ui/
?? scripts/.diag-files-http.mjs
?? scripts/postinstall.mjs
?? "scripts/verify-mfa 2.mjs"
?? "server/database/schema 2.ts"
```

| 路径 | 规模 | 判定 |
| --- | --- | --- |
| `client/src/components/business-ui/` | **82 个文件** | **死代码**。`git ls-files` = 0（脱平台时已从 git 删除），`AppRoot.tsx:39` 的注释写着 "which is deleted"，且全仓无任何引用。只是**磁盘上的残留副本**没删。 |
| `server/database/schema 2.ts` | 20,800 B | 复制残渣。与 `schema.ts`（23,936 B）**内容不同**，说明是某次复制产生、之后未同步。 |
| `scripts/verify-mfa 2.mjs` | — | 同上。 |
| `scripts/.diag-files-http.mjs` | — | 临时诊断脚本，点开头（会被构建的 `dotfiles:'ignore'` 跳过）。 |
| `scripts/postinstall.mjs` | — | 未被 `package.json` 引用（scripts 里没有 postinstall 项），也未跟踪。 |

**重要含义**：这些文件**不在 git 里**，所以线上（Zeabur 从 GitHub 构建）拿到的产物是干净的；
但本机工作区与 git 内容不一致，任何"在本机看到某文件还在/不在"的判断都必须先问 `git ls-files`。
这条已写入本轮方法论：**凡是"删除"类结论，必须同时核对 git 跟踪状态与磁盘状态。**

---

## 1. 你点名的硬伤逐条核对

格式：`页面/入口 → 前端 API → Controller → Service → 数据库 → 实际终态`

### ✅ 已证实（有证据，需要修）

| # | 链路 | 证据 | 实际终态 |
| --- | --- | --- | --- |
| §4 | 上传真实文件 | `client/src/pages/Upload/UploadPage.tsx:157` `// TODO: Integrate dataloom storage SDK for real file upload`；`:159` `'placeholder-bucket'` | **假上传**：bucket 是字面量字符串 |
| §4b | 上传页用户可见文案 | `client/src/pages/Upload/ResourceFileUpload.tsx:98-99` 直接显示「后续接入 dataloom storage SDK 实现真实上传」 | 把未完成功能写在界面上 |
| §5 | 提交审核 | `resources.service.ts:1372` `status: 'draft' as const`（创建路径） | 创建恒为 draft |
| §6 | 审核状态机 | `resources.service.ts` 只有 `:2090` `.set({ status: 'pending_review' })`（submit-review）。全文件**没有** `review.revoke` / recall 路径 | published 无法撤回 |
| §9 | 改角色 | `teachers.controller.ts:103` `@RequirePermission('account.update')`（PATCH 只查这一项） | 改 roles 不需要 `role.assign` |
| §10 | 重复角色表 | `server/modules/teachers/teachers.dto.ts:21` 自己定义 `const ROLE_CODES: RoleCode[] = [...]`（`:55`/`:108`/`:141` 用它做 `@IsIn`） | 与 `shared/rbac.ts` 两份，需核对是否含 `super_admin` |
| §14 | 我的资源详情 | `client/src/pages/MyResources/MyResourcesPage.tsx:208` `toast.info(L('详情功能开发中', 'Detail view coming soon'))` | 假功能入口 |
| §16 | 分页 | `client/src/pages/Subject/SubjectPage.tsx:154` `pageSize: 50` 且无页码/加载更多 | 第 51 条起不可达 |
| §18 | 自动清理 | `resources.service.ts:1797` `async purgeExpiredResources(...)` 存在；全仓**没有** Cron/@Interval/ScheduleModule（`main.ts:233` 的 `setInterval` 是关闭空闲连接，`auth.service.ts:217` 是内存清理） | 有方法、无调度器 |
| §20 | 前端硬编码目录 | `client/src/pages/KHome/KHomePage.tsx`、`client/src/pages/PreKHome/PreKHomePage.tsx`、`client/src/pages/PermissionAdmin/PermissionAdminPage.tsx` 命中 `PREK_SUBJECTS` / `K_SUBJECTS` / `ROLE_AUTO_PERMISSIONS` | 多处各自维护课程数组 |

### ⚠️ 待验证（我还没读到确证，不能算已证实也不能算推翻）

| # | 待查 | 下一步怎么查 |
| --- | --- | --- |
| §7 | 审核端点用了 `review.view` 而不是 `review.approve`/`reject` | 我目前只在 `resources.controller.ts:219-220` 找到 `@Post(':id/submit-review')` + `resource.submit_review`；**审核动作端点还没定位到**（可能在别的 controller）。必须先把审核端点的 `@RequirePermission` 打出来。 |
| §6 | published → reject 一定失败 | 需读 `reviewResource()` 的入参校验 |
| §21 | `getStructure()` 是否 `push` 共享对象 | `curriculum.service.ts:28` 直接 `return PROGRAM_STRUCTURES`（**不是拷贝**）；`:38-39` 用 `.find()`。是否还有 `push` 未确认 —— 但"直接返回共享引用"本身就值得修。 |
| §17 | 「删除后无法恢复」文案 | `translations.ts` 里**搜不到**「无法恢复/不可恢复」。可能在组件里硬编码，需继续定位。 |
| §19 | audit 导出是否真不可用 | `audit.controller.ts` 只有类声明被 grep 到，尚未列出全部路由。 |
| §22 | 幽灵权限清单 | 需要把 `shared/rbac.ts` 的权限目录与 `@RequirePermission` 出现处做双向比对。 |
| §25 | 自建文件夹落库 | `directories` 表尚不存在，PDF 要求的 `allowCustomFolders` 无任何承载。 |
| §28 | —— | 已推翻，见 §0.2。 |

### ❌ 与本轮无关但已在本会话修掉（避免重复劳动）

| 项 | 提交 |
| --- | --- |
| 登录后处处「无权访问」（前端角色判定与后端不一致） | `7772b6a` |
| 每个科目页 403 → 前端整页崩溃（`resources.service.ts` 自造管理员名单） | `25945dc` |
| 首页统计恒 0、班型结构判定（`dashboard.service.ts` / `curriculum.service.ts` 同样自造名单） | `efdb5fd` |
| 每次部署覆盖管理员密码 | `a90c33c` |
| 347 条课程内容从未载入线上（新增 `scripts/seed-curriculum.mjs`，已灌生产库） | `16a2dd9` |

---

## 2. 关于这次任务的规模——必须先说清楚

你给的是 **36 节、约 25 项独立能力**的收口工程，其中包含：

- **新增数据模型**：`directories`（PDF 那棵树 + `allowCustomFolders`）、`resource_files`、`resource_versions`
- **新增存储层**：S3 兼容对象存储（上传授权 → 直传 → 服务端登记 → 签名下载）
- **重做状态机**：`draft / pending_review / published / rejected` + `recall`，且每一步事务+审计+权限
- **RBAC 收口**：把散落在业务层的 `roles.includes(...)`、`subject_permissions` 全部收敛到 `AuthorizationService`
- **MFA 网页闭环**、**首次登录强制改密**、**真实浏览器 E2E 九条流程**、**迁移 up/down/backfill/checksum**

这不是一次对话能完成并**诚实验收**的量。而且你明确要求：**任何一项失败都不得标记完成**、
**禁止只跑单元测试就说完成**、**必须有真实浏览器端到端证据**。

所以我的做法是：

1. **本轮先交付你要的第一步**：这份只读基线（已完成，含上表证据）。
2. **把 36 节拆成有依赖顺序的阶段**，每阶段都有可验证的产出与门禁（见 §3）。
3. **逐阶段推进，每阶段都跑完整门禁 + 真实链路验证**，不合并、不跳步、不提前宣布完成。
4. 最终产出 `FINAL_COMPLETION_REPORT.md`，逐项对应你 §34 要求的 18 条。

我不会在没跑通真实链路的情况下说"完成"。现在这份文档就是基线，之后每一节的"已修"都必须附带**修复前后的链路对比**。

---

## 3. 建议的执行顺序（按依赖，不按你的编号）

```
阶段 0  基线（本文档）+ 取得 PDF + 清理未跟踪垃圾（82 文件 / 3 个残渣）
阶段 1  单一真相：角色与权限
        §10 角色表去重 → §8 RBAC 收口 → §9 role.assign → §22 幽灵权限
        （先做这个，因为目录/审核/上传的权限判断都依赖它）
阶段 2  目录数据模型（PDF 基准）
        §1 §2 §20 §21 §24 §25 §26  directories 表 + API + Directory Renderer
        门禁：后台改目录 → 刷新仍在 → 权限随目录生效
阶段 3  资源状态机与审核
        §5 §6 §7 §30  含 recall，事务+审计
阶段 4  对象存储与真实上传
        §4 §23  真实上传/下载 E2E（PDF/PNG/DOCX 实际二进制）
阶段 5  账户与安全闭环
        §12 MFA 网页闭环 → §13 强制改密 → §11 有效权限管理
阶段 6  完整性收尾
        §14 详情 → §15 版本 → §16 分页 → §17 回收站文案 → §18 调度器 → §19 导出
阶段 7  死代码与依赖审计 §27 §28(已推翻) §29
阶段 8  测试与验收 §31 §32 §33 §34 §35
        14 项命令全绿 + 9 条浏览器流程 + Docker + 迁移验证
```

**阶段 2 之前必须拿到 PDF** —— 目录树是它的业务基准，用文字转录去实现等于把验收标准变成我自己写的。

---

## 4. 我需要你提供/确认的三件事

1. **`教师平台.pdf`**（放项目目录或给路径）—— 没有它，§1 的"完整落地"无法验收。
2. **对象存储凭据**：你在 Zeabur 已设了 `S3_*` 五个变量（endpoint/region/bucket/access key/secret）。
   §23 要真正跑通"上传→登记→签名下载"，我需要在**本地或测试环境**能用同一套 bucket（或一个测试 bucket）。
   请确认：能否给我一个可用于测试的 bucket，或允许我在本地起 MinIO 做等价验证？
   （你之前的规则是"不能在当前环境验证的必须明确标注"——所以这一条我不会假装跑通。）
3. **§28 的处理意见**：按 §0.2 的证据，运行时平台依赖**已经不存在**了。
   你看到的"仍存在 @lark-apaas"很可能是本机 `node_modules` 残留目录。
   我打算把它作为**本机环境清理**处理（不进 git、不影响产物），而不是当作代码任务。有异议请说。

---

## 5. 本轮的诚实结论

- **可以进入生产吗**：否。基线里 §4/§5/§6/§9/§14/§16/§18/§20 这些硬伤仍然存在（都已定位到 file:line）。
- **本轮做了什么**：只做只读扫描，未修改任何业务代码；写成本文档。
- **本轮没做什么**：没有开始任何修复；没有跑门禁（因为还没有改动）；
  没有 PDF，所以没有动目录结构。
- **下一步**：拿到 PDF + 你对 §4 三点的答复后，从**阶段 1（角色与权限单一真相）**开始，
  每阶段结束后给出该阶段的链路对比与门禁结果。

---

## 6. 追加（第 16 轮）：本机门禁当前**跑不起来** —— 根因已定位

### 6.1 现象

`npm run build` 失败：

```
Error  Failed to load "@swc/cli" and/or "@swc/core" required packages.
```

### 6.2 根因

`package-lock.json` 里**没有任何 `*-darwin-arm64` 条目**（lockfile 是在 linux/x64 上生成的）。
于是本机 macOS 上：

- `npm install` 按 lockfile 正确地把这些"当前平台用不到"的可选依赖**裁剪掉**（实测 `removed 487 packages`）；
- 又因为 lockfile 里根本没有它们，`npm install` **也无法从 lockfile 装回来**；
- `@swc/cli` / `@swc/core` 的平台二进制缺失 → 构建直接失败。

**这解释了上一阶段那次"native bindings 缺失"的未解之谜**：那不是 npm 的 bug，
而是 lockfile 与当前平台不匹配的必然结果。

### 6.3 影响范围（重要：**线上不受影响**）

| 环境 | 影响 |
| --- | --- |
| Zeabur / Docker（linux/x64） | **不受影响**。它按 lockfile 安装 linux 平台包，今天所有部署都成功。 |
| 本机 macOS | **门禁跑不起来**：`npm run build` 失败 → `verify-all.sh` 无法通过 → 任何"已通过门禁"的说法在本机都不成立。 |

### 6.4 恢复办法（下一轮开工前先做这一步）

按**父包版本**显式安装平台包（lockfile 里没有，只能按版本号从 registry 取）：

```bash
node -p "require('./node_modules/@swc/core/package.json').version"   # 取父包版本
npm install --no-save --no-audit --no-fund \
  @swc/cli @swc/core \
  @swc/core-darwin-arm64@<与 @swc/core 同版本> \
  lightningcss-darwin-arm64@<与 lightningcss 同版本> \
  @tailwindcss/oxide-darwin-arm64@<同上> \
  @rolldown/binding-darwin-arm64@<与 rolldown 同版本> \
  @napi-rs/nice-darwin-arm64@<与 @napi-rs/nice 同版本>
```

或在本机以 `--include=optional` / 临时移除 lockfile 重装（**但不得把由此产生的 lockfile 变更提交**，
否则会把 linux 条目换掉，破坏 Docker 构建）。

### 6.5 顺带发现：macOS 文件提供程序会"驱逐"未跟踪文件

`server/database/schema 2.ts`、`scripts/verify-mfa 2.mjs`、`client/src/components/business-ui/**`
（82 个文件）都是**未跟踪**且**不可读**（`head` 报 `Error reading`，`grep` 报
`Resource deadlock avoided`）。它们会被 `tsconfig.*.json` 的 `include` 命中，
导致 `tsc` 报 `File not found` —— **双类型检查因此随机失败**（同一棵工作区，前后两次结果不同）。

已删除，依据：三者 `git ls-files` 均为 0、无任何引用；`business-ui` 在原始交付 zip 中有 197 条备份，
另两个连 zip 里都没有（纯复制残渣）。**项目位于本地磁盘而非 iCloud，126 GB 可用空间**，
因此这不是磁盘或同步目录的问题，而是未跟踪文件长期未被访问后的驱逐/占位状态。

> 工作纪律：本机工作区 ≠ git 内容。凡"删了/没删""能读/不能读"的结论，
> 必须同时核对 `git ls-files` 与磁盘可读性，不能只看其中一面。

---

## 7. 进度台账（每轮更新，供续接）

> 规则：只有**门禁全绿 + 真实链路验证**过的条目才写"已完成"。其余一律写"未完成"并说明卡在哪。

### 已完成并验证（commit 可查）

| § | 内容 | 证据 | commit |
| --- | --- | --- | --- |
| §9 | 角色授予授权判定接入 `createTeacher`/`updateTeacher`（此前**完全没有**授权判定） | authz 套件 `principal CANNOT promote to super_admin` 由 400(DTO) 变为 **403(RBAC)**；新增同级授予断言 | `da509e3`→`f7c7b6b` |
| §10 | 删除 `teachers.dto.ts` 重复角色表（8 角色、漏 super_admin），改用 `shared/rbac.ts` | 同上（正是这次改动让 §9 的断言不再假绿） | 同上 |
| §21 | 课程结构共享对象被就地修改（管理员路径返回模块级数组 + 共享对象 push）→ 深拷贝 + 深冻结 | `tests/curriculum-structure-isolation.test.mjs` 6 条；解冻后 4 条失败 | `ea6072f` |
| §21b | 修正一句不实的覆盖声明（我曾声称 HTTP 已覆盖，实际没有） | `git show HEAD:...` 回读确认措辞 | `20724f7` |
| §8 (1/3) | `roleSubjectScope()` 单一来源；`curriculum.service.ts` 5→0 处角色字面量 | 三个角色的 `/api/curriculum/structure` 实测与旧逻辑逐字一致 | `7426375` |
| §8 (2/3) | `dashboard.service.ts` 3→0 处；`isAdmin` 改为由 `scope.all` 派生 | `authorizedSubjects` 实测 prek_head=2/k_head=1/pe_specialist=2/prek_assistant=0（期望值先由 SQL 算出） | `2333e32` |
| §6 补验 | 上一轮我标注未验证的 `review_records` recall 行 —— 已补验 | 实测 `[{action:approve,comment:通过},{action:recall,comment:需要修改}]` ✅ | 本轮 |
| §17 | 删除确认文案与后端不符：界面说「删除后无法恢复」，后端是**软删除**进回收站（`resources.service.ts:1586` 只写 deletedAt/deletedBy/purgeAfter）。改为「删除后该资源会移入回收站，可由管理员恢复」。**刻意不写**「到期自动永久删除」——`purgeExpiredResources()` 尚无调度器（§18），写了就是描述未发生的事 | 全 client 复查：无其它同类错误文案（仅剩我自己的注释）；typecheck+build 通过 | 本轮 |
| §6 §30 | 状态机 + 真正的 recall：新增 `ReviewService.TRANSITIONS`（from/to/permission/audit/record 一张表），服务端判状态、controller 判权限读同一份；新增 `review.revoke` 权限与 `resource_recall` 审计动作；UI 的「撤回」以前调 `reject`，改为调 `recall` | 全链路实测 draft→pending_review→published→**draft**，审计链含 `resource_recall`；阴性对照 400 且指名要求状态 | 本轮 |
| §5 | `UploadPage` 的「提交审核」以前只调 `createResource`（服务端恒 draft），却提示「已提交审核」→ 新建后按需调用 `submitReview(created.id)`，并在提交失败时**如实**提示「草稿已保存，但提交审核失败」 | API 序列实测：create=201(draft) → submit-review=201 → 库中 `pending_review` ✅ | 本轮 |
| §7 | 审核动作权限拆分：`POST resources/:id/review` 原挂 `review.view`（"能看待审核队列"=="能发布"）→ 改为按 `dto.action` 要求 `review.approve` / `review.reject` | 判别性测试：只授 `review.view` 的账号得到 `403 缺少权限：review.approve`／`review.reject`；补授 `review.approve` 后放行到业务层（400 只有待审核状态…） | 本轮 |
| §8 (3/3) | `resources.service.ts` 6→0 处（机械等价替换，SQL 结构未动）；`checkSubjectPermission` 三处字面量合并为一次 `roleScopeCovers` | 权限矩阵 7 项实测全部符合预期（见下） | 本轮 |
| §1 §2（数据层） | migration `0009_directories`：PDF《教师平台》权威目录树落库，**69 节点**，内嵌自检断言（不满足即回滚）；刻意**纯加法**，一行 `resources` 不动 | up 通过；down `0009` 通过（表消失、resources 仍 348 行）；up 重放后内容指纹与回滚前**逐字节一致**（`211433d5a830f5be02bee909487a60f6`）；孤儿 parent_id=0、重复 code=0 | `298579e` |
| §1 §2 §20（接口层） | 目录树 API：`GET /api/directories/tree`、`GET /api/directories/node?code=…`，逐节点按角色剪枝；`curriculum.view` 声明式守门 | `scripts/verify-directories.mjs` **55 项实测全绿**（见下），并已接入 `verify-all.sh` | 本轮 |
| §1 §2 §20 §24 §25 §26（前端） | 新增 `/directory` 目录页 + 导航项：渲染数据库里的 PDF 目录树（两个根、PDF 新增科目、可自建文件夹标记、教师成长 L1/L2/L3）；**无任何硬编码结构兜底**，接口失败就报错重试；把「因权限未显示的科目数」显式写出来 | **浏览器 E2E 18/18**（真 Chrome + CDP），含展开 Pre-K 后 4 个科目齐全、4 类资料夹、可自建标记、教师成长树 | `bfb48ca` |
| §16（浏览器级） | 卡了三轮的 SKIP 已修好并变成可判定断言：**Radix Tabs 在 onMouseDown 切换值，不看 click**；CDP 坐标失败的真因是 756×413 视口下侧边栏盖住目标 | 浏览器实测：标签进入选中态 → 「已显示 50 / 共 79 条」→ 点「加载更多」→ **卡片 50 → 79** | `bfb48ca` |
| §31（门禁完整性） | 两处"静默少跑"修掉：① browser-e2e 未配账号时明确打印"未运行、**不算通过**"而不是 PASS；② 门禁只设 `AUTHZ_TEST_DB`，而 5 条数据库用例只在 `DATABASE_URL` 存在时注册 → 一直跑的是 270 而非 275 | 门禁全绿：npm test **275/275**、authz 75、hardening 10、mfa 55、headers 20、files 74、naming 49、directories 55、browser-e2e **18/18** | `bfb48ca` |

门禁基线（每轮实跑）：`npm test` **275/275**、**eslint PASS、stylelint PASS**（本轮首次真正可跑，见下）、双 typecheck PASS、build PASS、api-contracts matched、authz 75、hardening 10、mfa 55、headers 20、files **80**、naming 49、directories 55、directories-write **31**、resource-versions **22**、**account-permissions 27**、browser-e2e **32/32、0 跳过**、mfa-web **17/17、0 跳过**；`npm test` **276**。

> 关于 270 vs 275：有 5 条用例只在 `DATABASE_URL` 存在时注册。门禁原先只设 `AUTHZ_TEST_DB`，
> 所以它一直跑的是 270，而输出里的 `pass 270 fail 0` 看上去完全正常 —— **静默少跑**。
> 已在 `verify-all.sh` 里显式补 `export DATABASE_URL="${DATABASE_URL:-$AUTHZ_TEST_DB}"` 修掉。

#### 生产环境（Zeabur）实测证据

| 项 | 结果 |
| --- | --- |
| `GET /api/directories/tree`（生产、super_admin 登录） | 200；**69 节点**、16 个可自建叶节、0 隐藏科目；`prek:virtue` = 10 条；`prek:english` / `k:chinese:arts` / `growth:l1..l3` 均存在 |
| migration 0009 是否在生产应用 | **是** —— entrypoint 启动时会 `migrate.mjs up`，无需人工执行 |
| 浏览器 E2E 打生产（真 Chrome + CDP） | **18/18、0 失败、0 跳过** |
| §16 分页（生产数据） | 「已显示 50 / 共 79 条」→ 点「加载更多」→ **卡片 50 → 79** |
| §1 目录页（生产数据） | 两个根、Pre-K 4 科目（含 PDF 新增「英文」）、4 类资料夹、「可自建文件夹」标记、教师成长 L1/L2/L3 + 4 个分支 |

#### §1/§2 目录树 API 的实测证据（`scripts/verify-directories.mjs`，55/55）

| 账号 | 期望 | 实测 |
| --- | --- | --- |
| 未登录 | 401 | 401 |
| `seq_principal`（principal） | 2 个根、69 节点、16 个可自建叶节、0 隐藏科目 | 全部一致；`prek:virtue`→10 条、`k:chinese`→0 条（K 中文确实没有种子数据，与 `DIRECTORY_SPEC` §2.2 一致） |
| `scope_prek_head` | 只有 Pre-K，K 科目被隐藏 | 一致（含 PDF 新增的 `prek:english`） |
| `scope_k_head` | 只有 K | 一致（含 `k:chinese:arts`/`reading`） |
| `scope_pe_specialist` | 跨班型只有体能，各 4 个资料夹 | 一致；`prek:pe_lesson` 可自建=true、`prek:pe_outline`=false |
| `scope_prek_assistant` | 看得到 Pre-K 结构 | 一致 |
| 临时 visitor | 403（该角色没有 `curriculum.view`） | 403 |
| 单节点 | principal 取 `prek:virtue`=200 / 不存在=404 / pe_specialist 取 `prek:virtue`=**404（与不存在同一个响应）** | 全部一致 |

#### 本轮发现（如实记录，未擅自决定）

1. **PDF 比应用多两个科目**：`prek:english`（Pre-K 英文）与 `k:chinese:arts`（K 美育）。
   `shared/curriculum.ts` 里 Pre-K 只有 virtue/montessori/physical_education，K 中文子科是
   ancient_poetry/picture_books/drama/stem。我**没有**擅自把它们塞进规范词汇（那会改变
   `GET /api/curriculum/structure` 的输出与现有科目卡），也**没有**给它们编一个 token。
   处理方式：`directory-vocabulary.ts` 里显式登记为 `null`（非规范），接口如实返回 `subject: null`，
   可见性判定**失败关闭**（不会因为"token 认不出来"而对所有人放开）。**需业主确认**是否纳入规范词汇、
   以及纳入后由哪些角色默认持有。
2. **`k:chinese:arts`（美育）与规范词汇的 `drama`（戏剧）不一致**：PDF 有美育无戏剧，
   现有产品文档（AGENTS.md）有戏剧无美育。两者并存还是替换，需业主决定。
3. `DELETE /api/teachers/:id` 在本机测试库上返回 **500**（`42501 insufficient_privilege`，
   `UPDATE teachers SET status`）。**与本次改动无关**（未触碰 teachers 模块），但这是真实缺陷，
   已记入待办；验证脚本因此对清理失败做了 SQL 回退，避免留下脏账号。
4. 资料夹级的 `resourceCount` 目前**恒为 0**，子科级也是 0 —— 因为 `resources` 还没有
   `directory_id`，而 `resources.sub_subject` 用规范 token、目录 code 用 PDF 树路径词，两者今天
   不是一一对应。**刻意返回 0 而不是"整个科目的总数"**：后者是个看起来精确、其实是另一个数的数字。
   等 6→4 映射定了、`directory_id` 迁移落地后再改成精确统计。

### §24/§25/§26 可编辑目录系统（commit `f59b549`）

| 证据 | 结果 |
| --- | --- |
| migration 0010 up/down 往返 | 带自建节点时 down 被守卫**拒绝**；清理后 down 成功、两列消失；再 up 回到 **69 个系统节点**；force 逃生阀在回滚事务内验证可执行 |
| 数据库层约束 | `created_by_pairing` / `user_node_is_folder` / `sibling_name_key` 三条，实测生效（同名 409、班型下建 403） |
| 写接口否定用例（`verify-directories-write.mjs` 31/31） | PDF 未标自建处 403、系统节点改/删 403、非空删 409、空名 400、`prek_head` 无 manage 全 403、无 CSRF 403 / 有 CSRF 401 |
| 浏览器端到端（E2E 25/25） | 点「新建文件夹」→ 填名 → 提交 → **树里真的出现** → 删除 → **真的消失**；每一步单独验证效果 |
| 审计 | 实测 21 行 `directory_*`，含操作人与"<父>下新建<名>"细节 |
| 收尾状态 | 节点 = 69、自建残留 = 0（测试自清理） |

**本轮修掉的两个真实缺陷**（都不是预防性改动）：

1. **授权缺陷（潜在越权/可见性错）**：`subjectOwnerCodeFor` 靠解析 code 字符串推断
   节点归属科目。只有种子数据时正确，一旦允许自建立刻错 —— 自建节点
   `prek:pe_lesson_u1` 被判成 `prek:pe_lesson`（folder），于是
   **只有建它的人看得到，按科目点授的同事看不到**。已改为沿真实父子链上溯。
2. **体验缺陷**：新建文件夹后视图折叠回顶部，用户看不到刚建的东西。根因是每次
   `load()` 都重置展开状态。改为首次设默认、之后保留 + 新建后展开父节点。
   接口层全绿时这个问题看不出来。


### §14 资源详情 + §4/§23 上传侧假成功（commit `5b326a3`）

| 项 | 结果 |
| --- | --- |
| 上传侧假成功（**新发现的真实缺陷**） | `registerFile` 只做 bucket 形状检查 → 任何客户端都能让行变成"有文件"（`has_stored_file` 由 path+bucket 非空生成）→ 界面亮「下载」→ 必然 503。客户端那行 `fileBucketId = 'placeholder-bucket'` 正是这么写的 |
| 修法 | 新增 `ObjectStorageModule` 集中绑定点（`FilesModule` 已 import `ResourcesModule`，互相引用会成环）；`registerFile` 写库**前**判定存储可用性，没有后端就 503 且**不写任何文件列**；客户端不再编造 bucket/路径 |
| 期望值变化 | files-http **74 → 80 项**，原来"登记成功=201"改为 503，并**新增**数据库直查断言（无 bucket、无 path、`has_stored_file=false`）；"文件名清洗""前导斜杠规范化"两条能力改为从审计行读，没有丢 |
| §14 | `MyResourcesPage` 的「查看」不再是 `toast.info('详情功能开发中')`；真弹窗，数据全来自 `GET /api/resources/:id`，缺失字段显示"未填写"，失败直接显示 |
| 浏览器 E2E | **32/32、0 跳过**（新增 §14 五条：打开、无占位文案、状态/版本/上传者真实值、可关闭） |
| 仍未完成 | 真实字节上传（预签名 PUT → 登记）仍**卡在没有 bucket**；本轮只做到"不再假装成功" |


### §12 两步验证网页闭环 + §13 首次登录强制改密（commit `2aa29f0`）

**§12 此前网页端一行都没有**：服务端 MFA 早已完整（55 项断言全绿），但登录页不处理
`mfaRequired`、也没有任何登记入口 —— 必须开 MFA 的账号在浏览器里既进不去也救不了自己。

发现并修掉的隐患：`login()` 原先写的是 `return resp.data.teacher`，而 MFA 待验证的响应里
**没有 teacher** → 得到 `undefined` → 被当成"已登录用户"塞进 context。
一旦有人启用 MFA，前端会以"看起来正常、其实完全没登录"的状态继续跑。

**§13 此前是假的**，三个问题：

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | **服务端从不拦截** `must_change_password` | `provision-super-admin.mjs` 原注释写明「设了等于假装有强制改密」——判断正确 |
| 2 | 前端从不读这个字段 | 全局 grep 只有 server/schema 命中 |
| 3 | **创建账号时不置标志** | `createTeacher` 返回 `temporaryPassword`，但标志保持默认 false → **临时密码就是永久密码** |

修法：`auth.guard.ts` 真的拦（403 + `PASSWORD_CHANGE_REQUIRED`，白名单只放行
change-password / logout / me / mfa 登记 / health）；`ProtectedRoute` 加路由级闸门；
`createTeacher` 与 `provision-super-admin.mjs` 置 true（后者只在**确实换了新密码**时置）。

新增 `scripts/verify-mfa-web.mjs`（**16/16、0 跳过**，已接入门禁）：真浏览器走完
临时密码 → 强制改密（前端挡 + **服务端 403**）→ 改密 → 启用 MFA（独立实现的真 TOTP）
→ 10 个恢复码 → 退出重登 → 第二步 → 正确码进入工作台 → 错误码不放行。

**生产实测**：现有 `TsinglanAdmin` 的标志为 false（改动前创建），登录 201 /
`mfaRequired=false` / `/api/auth/me` 200 / `/api/directories/tree` 200 /
`/api/auth/mfa/status` 200 —— **线上登录行为未改变**，只有今后新建与重置密码的账号要求首次改密。
只读的 browser-e2e 对生产跑出 25 通过 / 0 失败 / 1 条明确说明的 SKIP。
（mfa-web 套件会建临时账号、清理依赖本地库连接串，所以**刻意不**对生产运行。）


### §22/§27/§31 lint 工具链（commit `1c094d2`）

「14 项命令」里的 lint **从去平台化起就没执行过**，且两个命令坏在不同地方 ——
这正是"看起来有、其实没有"，只不过在工具链里：

| 命令 | 坏在哪 | 修法 |
| --- | --- | --- |
| `npm run eslint` | `eslint.config.js` 第一行 `require('@lark-apaas/fullstack-presets')`，包已随去平台化删除 → 直接崩 | 用仓库真实存在的依赖（eslint 9 + typescript-eslint 8）重写为自包含配置；顺带把 `eslint .` 改为显式目录（本机 iCloud 同步目录上 `eslint .` 会 EAGAIN） |
| `npm run stylelint` | ① 仓库里**没有任何 stylelint 配置**；② `--glob` 未加引号，shell 把 `**` 当单个 `*` → 只匹配到被忽略的 vendor → **一个文件都没检查却退出 0** | 新建 `stylelint.config.mjs`（显式列规则，不 `extends` 不存在的预设）；glob 加引号 |

修好后立刻查出 **19 个真问题并全部修掉**（不是放宽规则）：
* eslint 16 个：`db-snapshot.mjs` 两个未用导入、`predeploy-db-check.mjs` 的 `info()` 整个死函数、
  `verify-authz-http.mjs` 的 `sv`、多处残留的 `createRequire`/`require`（含我上一轮新写的脚本）、
  `verify-directories.mjs` 的 `adminTree`，以及 7 个脚本里的 `ok ? pass++ : fail++;`
  （无副作用的表达式语句，改为 if/else）
* stylelint 3 个：`tailwind-theme.css` 里两条空规则（标记类只在 `:not(...)` 里被引用，
  空规则本身零效果）与一条重复选择器

**lint 已接入 `verify-all.sh`**，并证明过它真的在检查：喂非法 hex 会报
`color-no-invalid-hex`；verbose 显示实际检查 3 个文件、vendor 明确列为 ignored。

本轮我自己犯的错（被测试抓住）：清理未使用变量时，用 `.*?` 在 `re.S` 下跨行的正则
**把紧随其后的密码填充块一并删了** —— 后果不是报错而是"点了没反应"（表单因新密码为空
拒绝提交）。mfa-web 套件失败并指出位置，已恢复；该处失败诊断也从"截取页面开头"
（只看到导航栏）改为"截取尾部"（错误提示在表单下方）。


### §15 资源版本生命周期（commit `b6f4797`）

**发现**：`resources.version` 一直存在、界面一直显示「版本 v1」，但**没有任何代码写过它**。
实测迁移前 **348 行全部等于 1** —— 那个数字此前是装饰。

| 项 | 结果 |
| --- | --- |
| migration 0011 | `resource_versions`（不可变快照 + `change_kind`）；纯加法；回填每一个既有资源为第 1 版 |
| 回填实测 | 348 资源 → **348 快照**，未覆盖 **0**，`resources.version` 与最新快照不一致 **0** |
| 自增 | 创建→v1；编辑→**只有真的改到东西**才自增（避免噪声版本）；附加文件→自增 |
| 快照策略 | 存整行而非差异（差异法要两侧都对，且"看起来对、回放不对"无从发现） |
| 读接口 | `GET /api/resources/:id/versions`，权限与"能否看该资源"**同一套判定** |
| 界面 | 详情弹窗新增「版本历史」，`change_kind` 有中英文文案 |
| down 守卫 | 存在**真实**（非回填）历史时**拒绝回滚**并说明原因（实测） |
| 验证 | `scripts/verify-resource-versions.mjs` **22/22**，已接入门禁 |


### §4/§22/§27/§29 幽灵权限审计（commit `baed38f`）

新增 `tests/ghost-permissions.test.mjs`：① 服务端引用的权限码必须存在于目录中
（**拼错会让守卫静默失效**，比幽灵权限更危险）；② 声明的每个权限必须至少有一个服务端消费点；
③ 业务层不得有内联角色字面量。

**实测结果：46 个权限里 24 个被真实消费，22 个从未被检查** —— 近一半权限
"授予或撤销不改变任何服务端行为"，而权限矩阵界面照常显示它们。
含 `role.assign` / `permission.view` / `permission.revoke` / `resource.purge` /
`storage.delete` / `system.*` / `security.*`。

审计脚本自身两处误报（已改检测方式，**不是**加白名单）：
把注释当代码扫；漏掉"通过常量消费"（`account.reset_privileged_password` 经
`RESET_PRIVILEGED_PASSWORD_PERMISSION` 真实使用）。

**`role.assign` 已真正接管角色变更**：创建/更新账号涉及角色时要求生效权限含它；
读生效权限（与 PermissionGuard 同一份数据）；`authz` 缺失时 **fail closed**。
基线 22 → **21**，改用**棘轮**：剩余 21 条逐条打印、数量不得增长，只能往下走。

**仍未完成**：另外 21 条权限的消费点需要产品决策（例如 `permission.view`/`role.view`
要配 §11 的权限管理界面才有意义）。


### ⚠️ 更正：上一轮（`baed38f`）的提交信息说了不实的话

`baed38f` 写「role.assign 已真正接管角色变更」，但**那份代码里没有任何地方读它** ——
只 import 了常量、加了一个没人使用的参数。我的脚本在写文件**之前**断言失败退出，
调用与辅助方法从未落盘，而我按"脚本打印过 ok"当成了已生效。

被修复的两处防呆（防的是同一类事情）：
* 幽灵权限审计改为**先剥 import 再统计**（否则 import 一下就算"已消费"）；
* eslint 改 `args: 'all'`（默认 `after-used` 对"后面还有参数被使用"的未使用参数不报，
  正是这次静默通过的原因）。改完立刻报出 7 处未使用参数。

### §11 按账号授权（commit `8905ef8`）

RBAC.md §5 的模型（角色默认 ∪ 追加 − 禁止，禁止优先）此前**完全无法使用**：
表/读/写都在，但没有任何 API/UI 可达。现接上四个端点（`permission.view` /
`permission.grant` / `permission.revoke`），grant 与 deny 分成两条路由（装饰器可 grep、
审计看得到消费点）。**幽灵权限 21 → 19**。

**根因发现**：`setPermissionOverride` / `clearPermissionOverride` **一调用就 500** ——
`account_permission_overrides` 上的 AFTER 触发器会 `UPDATE teachers.permissions_version`，
而 migration 0005 已 REVOKE `anon_` 在 `teachers` 上的 UPDATE，请求默认以 `anon_` 执行 SQL。
同一根因还解释了另外两个 500：**改教师名字**、以及 **`DELETE /api/teachers/:id`**
（后者我几轮前曾记为"与本次改动无关的既有缺陷"，现在定位到根因并修好）。
修法：抽出 `server/database/rbac-write-context.ts`（一份实现），以 `authenticated_` +
`app.rbac_actor_id` 执行特权写入，与密码重置同一套机制。

**决定性验证**（`scripts/verify-account-permissions.mjs`，**27/27**）：构造
"有 account.update、无 role.assign"的账号（要用 §11 新接口才做得出来），真的去改角色 ——
改角色 403 且**原因指向 role.assign**；同一账号**只改名字 200**（证明 403 不是"没权限"）；
追加 role.assign 后同一请求 200；改权限后旧会话 401、重登生效（即时撤销）。


### 生产实测（§11 上线后）

| 项 | 结果 |
| --- | --- |
| `GET /api/teachers/:id/effective-permissions` | **200**（该端点存在即证明新服务端代码已上线；bundle 未变是因为本轮只改服务端） |
| 返回内容 | 目标账号 9 条生效权限，sources = {fromRoles:9, granted:0, denied:0} |
| 登录 / 教师列表 / 目录树 | 201 / 200 / 200，无回归 |

### 收尾时的残留清理（如实记录）

我自己在诊断"哪个 DB 角色导致 42501"时，往测试库插过一行 `permission='x.y'` 的
无效权限覆盖（`account_permission_overrides`），以及更早的 `dirprobe_visitor` 探针账号。
两者都已删除（教师 28 → 27，覆盖行 1 → 0），并复跑 `account-permissions`（27/27）与
`directories`（55/55）确认清理没有破坏状态。

**教训**：诊断用的写操作也要留清理，否则会像这次一样在"收尾检查"里冒出来 ——
而一个带无效权限码的覆盖行留在库里，本身就是下一轮排查的噪声来源。

### 未完成

| § | 内容 | 卡在哪 |
| --- | --- | --- |
| ~~§24 §25 §26（写入）~~ | ~~目录的增删改~~ | **已完成**（`f59b549`）：migration 0010 用 `is_system` 划出「PDF 权威 / 管理员自建」的界线，写接口 + 界面 + 审计齐备 |
| §4 §23 | 真实文件上传/下载、S3 兼容存储 | **等测试 bucket**，或业主同意用本地 MinIO 做等价验证（会明确标注非生产 bucket） |
| §15 §16 §17 §18 §19 | 版本生命周期 / 分页 / 回收站文案 / 自动清理调度器 / 审计导出 | 不依赖决策，可先做 |
| §32 | 真实浏览器 E2E（9 条流程） | 尚未建立。当前所有 UI 改动只经过 typecheck+build，**没有浏览器级证据** |
| §11 §12 §13 | 有效权限管理 UI、MFA 网页闭环、首次登录强制改密 | 不依赖上述决策，可先做 |
| §14 §15 §16 §17 §18 §19 | 详情/版本/分页/回收站文案/调度器/审计导出 | 不依赖上述决策，可先做 |
| §11 | **新发现**：`AuthorizationService.setPermissionOverride()` **全仓无任何调用者** —— 权限覆盖机制有表、有读、有写函数，但没有 API/UI 可达，属"定义了却完全无法使用"（§11/§22 的原话） | 需要先定"按账号授权"的产品形态 |
| §22 §27 §29 | 幽灵权限审计、死代码、假成功清理 | 部分已做（见 §6）；其余待做 |
| §31 §32 §33 §34 | 14 项命令全量、浏览器 9 条 E2E、迁移 up/down/backfill、FINAL_COMPLETION_REPORT | 收尾阶段 |

### 环境注意事项（每次开工前先看）

1. 本机 PostgreSQL **不能**用 `pg_ctl start`；用 `postgres -D <pgdata> -p 55432 -c listen_addresses=127.0.0.1` 直接起。
   测试库若不存在需重建 + `db-bootstrap` + **`node scripts/seed-curriculum.mjs --apply`**
   （否则 `npm test` 4 条 + `files-http` + `naming-http` 会失败）。
2. `npm install` 会裁掉 darwin-arm64 平台二进制；必须**一条命令装齐**且之后不再跑 npm install（见 §6）。
3. 门禁服务需手动起：`SERVER_PORT=3200 MFA_ENFORCE_SUPER_ADMIN=true DOWNLOAD_TOKEN_TTL_SECONDS=10 LOGIN_IP_RATE_LIMIT_MAX=100000 npm run start`。
4. 改了服务端代码后**先 `npm run build` 再重启服务**，否则套件测的是旧 `dist/`（我曾因此误判过一次）。
5. **必须用 `npm run build`，不能用 `npm run build:client`**：视图目录是 `<cwd>/dist/client`，
   而进程跑在 `dist/` 下，所以真正的发布目录是 `dist/dist/client`——只有 `scripts/build.sh`
   会做这一步搬运。只跑 `build:client` 会得到 `dist/client/client/index.html`，
   表现为 `GET /` 500「Failed to lookup view "index"」。
6. **重启服务要按端口杀，不要按进程名**：`npm run start` 实际执行 `cd dist && node server/main.js`，
   所以 `pkill -f "dist/server/main.js"` **匹配不到**，旧进程会继续占着 3200，
   而新进程在日志里以 `EADDRINUSE` 失败。更隐蔽的是：旧进程会继续用它**缓存**的
   `index.html` 引用已经被 `rm -rf dist` 删掉的 bundle 文件名 → 浏览器白屏、
   所有浏览器断言失败。正确做法：`lsof -ti tcp:3200 | xargs -r kill`。
5. 未跟踪文件可能不可读（文件提供程序驱逐），会让 `tsc` 随机报 `File not found`；删前核对 `git ls-files` 与原始 zip。

### §8 3/3 的等价性证据（/api/resources 权限矩阵，7 项实测）

    pe_specialist  → k/physical_education     200（角色级授权）
    pe_specialist  → prek/physical_education  200
    pe_specialist  → k/chinese                403（无授权）
    prek_head      → prek/virtue              200（整段可见）
    prek_head      → prek/montessori          200
    prek_head      → k/english                403（非本班型）
    prek_assistant → prek/virtue              403（须查 subject_permissions）

七个结果与按规则推导的期望**逐条一致**。§8 三个消费者全部收口。**修正**：`0e3a529` 的提交信息曾写"全仓业务层角色字面量 0 处"——当时是**错的**，
`curriculum.service.ts` 还剩 2 处 `roles.includes('prek_assistant'/'k_assistant')`（我的核对命令是在提交**之后**才跑的）。
已在后续提交把配班的"结构可见性"规则也收进 `shared/rbac.ts` 的 `programsVisibleForStructure()`，
并用一次精确 grep 复核：业务代码中角色字面量确为 **0 处**。教训：**先跑核对命令、再写结论**。

### 追加（第 26 轮）：§18 回收站到期清理调度器

`ResourcesService.purgeExpiredResources()` 早就实现了（按 `purgeAfter <= now` 找行 → 删库 → 写审计），
但**全仓没有任何调用者**（`grep -rn purgeExpiredResources server/` 只匹配到它自己的定义与日志字符串）——
也就是说"资源到期后被永久删除"这件事**从来不会发生**，回收站只会越积越多。

新增 `server/modules/resources/purge.scheduler.ts`（无新依赖；本仓库是单实例部署，见报告附录 B3，
因此不需要 @nestjs/schedule；**若将来多副本，正确做法是加分布式锁或独立 job runner，
而不是多起一个副本** —— 已写进代码注释）：
启动后立即扫一次 + 之后每 `PURGE_SWEEP_INTERVAL_MINUTES`（默认 60）分钟一次；
`PURGE_SCHEDULER=off` 可关闭；不重叠运行；**永不抛异常**（清理失败不得升级成平台起不来）；destroy 时清定时器。

实测（把一条资源标成 `deleted_at = now()-40d, purge_after = now()-10d` 后启动服务）：

    [PurgeScheduler] 调度器已启动：每 60 分钟一次
    [PurgeScheduler] 清理完成（trigger=bootstrap）：永久删除 1 条资源 [1a91afda-…]
    库中核验：已永久删除 ✅        审计记录：resource_purge ✅

**未验证**：§18 还要求"删除对象存储文件"。本环境**没有配置对象存储**（`UnconfiguredObjectStorage`），
所以**对象删除这一步没有被验证**，不得声称完成 —— 与 §4/§23 是同一个前置条件。

**与简报的一处差异**：简报写"每天自动检查"，实现是默认每 60 分钟检查一次。
因为查询条件是 `purge_after <= now`，更频繁地检查只是更及时，不会误删 —— 属于超集而非偏离。

### 追加（第 27 轮）：§19 审计导出

    shared/rbac.ts:421          { code: 'audit.export', ... highRisk: true }   ← 权限存在、已授予
    audit.controller.ts         只有 @Get('logs') @RequirePermission('audit.view')
    AuditLogPage.tsx:294         <Button variant="outline" disabled>           ← 永远点不动的按钮

即：一个真实存在、已授予 principal 的权限，配一个永远禁用、也没有任何后端实现的按钮。
简报的原话是「不要再存在 disabled button 但用户看起来像可以使用的情况」。

**实现**（不是删按钮 —— 权限已定义且已授予，删掉会留下孤儿权限）：
* `audit.service.ts` 新增 `exportCsv()`：RFC 4180 转义、UTF-8 BOM（否则 Excel 中文乱码）、
  单次上限 10000 行。
* `audit.controller.ts` 新增 `@Get('logs/export')`，**权限刻意用 `audit.export`（highRisk）而不是
  `audit.view`** —— 能把整份日志（含 IP 与操作明细）带成文件带走，与在页面里翻看不是同一档能力。
* `AuditLogPage.tsx` 按钮接上 `handleExport`：构造带当前筛选条件的 URL 并触发下载
  （走真实导航，浏览器自动带会话 Cookie，客户端不必处理 Blob）。

**实测（真实 HTTP）**：

    principal（持有 audit.export）:  http=200
      Content-Type: text/csv; charset=utf-8
      Content-Disposition: attachment; filename="audit-logs.csv"
      BOM 存在 ✅   表头：时间,动作,教师,班型,资源/科目,IP,结果,详情   37 行
    阴性对照（只授 audit.view）:     查看列表 200 ／ 导出 403 缺少权限：audit.export

**未验证**：按钮的下载行为只经过 typecheck + build，没有浏览器级证据（§32 未建立）。

### 追加（第 28 轮）：§16 分页

`SubjectPage.tsx:154` 写死 `pageSize: 50` 且**没有任何翻页入口** —— 第 51 条起的资源在界面上
**永远看不到**。实测该科目的规模：`prek/montessori/courseware` 共 **245** 条，
也就是说修复前 **195 条内容对用户不可达**（数据都在，只是被人为截断）。

后端本来就支持 `page`/`pageSize` 并返回 `total`，是前端没用起来。

**实现**：`PAGE_SIZE` 常量 + `page`/`total` 状态；请求带 `page`；第 1 页替换、后续页追加；
筛选条件变化时回到第 1 页（否则"加载更多"会把上一组筛选的第 N 页接到新结果后面）；
列表下方显示「已显示 X / 共 Y 条」与「加载更多」（仅在还有剩余时出现）。

**实测**（UI 现在正是这样取数据）：

    page=1  total=245  items=50      page=2  total=245  items=50      page=5  total=245  items=45

**未验证**：「加载更多」按钮的交互只经过 typecheck + build，没有浏览器级证据（§32 未建立）。

### 追加（第 29 轮）：§32 的第一条垂直切片 —— 真实浏览器 E2E

新增 `scripts/verify-browser-e2e.mjs`（自起 Chrome + CDP；真登录表单填写与点击、真读 DOM）。
**已接入 `verify-all.sh`**；当前为 18/18、0 SKIP（下面这段是本轮首次建立时的历史记录）。

本轮实测（本地 3200 服务 + seq_principal）：

    PASS  未登录访问 / 显示登录页（ProtectedRoute 生效）
    PASS  登录表单可提交 -> SUBMITTED
    PASS  登录后进入工作台
    PASS  §19 「导出 CSV」按钮可点击（不再 disabled）
    PASS  §5 「我的资源」渲染正常并列出资源/空态 -> 共 2 条
    FAIL  §16 分页入口（断言待调准，见下）
    FAIL  §16 加载更多生效（同上）

**顺带拿到的浏览器级证据**（比断言本身更有价值）：`/my-resources` 列出两条真实资源 ——

    §6 状态机验证   PREK virtue 课程大纲  草稿      ← §6 recall 生效（published → draft）
    §5 序列验证资源 PREK virtue 课程大纲  待审核    ← §5 提交审核生效

也就是说 §5 与 §6 的"最后一公里"现在有了**浏览器证据**，不再只是 typecheck。
§19 的按钮也在浏览器里确认从 disabled 变成可点击。

**已知问题（不得读成产品缺陷，但也不能当作已通过）**：
1. §16 的两条断言走错了页面 —— `/prek/montessori` 渲染的是子科目录（日常生活/感官/…），
   资料夹（课程大纲/课件与示范/…）要在选定子科之后才出现，所以找不到「课件与示范」标签。
   **很可能是我断言写错页面，不是产品缺陷**；但我**没有用正确路径复验过**，
   所以 §16 仍只算 **API 级已验证**。TODO：改到 `/prek/montessori/practical-life`。
2. §5 的断言原本找行内按钮文案（实际是图标+tooltip）而误判失败 —— 已修正。
   **这提醒：E2E 断言本身也要被怀疑。** 本轮两条失败里至少一条确认是我的断言错。

### 追加（第 30 轮）：§16 断言调准的第三次尝试 —— 仍未成功，改为**显式跳过**

上轮遗留两条 §16 失败断言。本轮把页面改对了（`/prek/montessori/practical-life`），
实测确认资料夹标签齐全：

    ["Pre-K","K","管理后台","English",...,"课程大纲","周次教案","课件与示范","素材与工作单",...]

但**用 DOM `.click()` 点「课件与示范」不会切换内容**，连续 3 次尝试均未成功。
我不再继续猜（那是浪费，也容易把断言错当成产品缺陷）。

处理方式：把这两条失败断言改成**显式 SKIP**，并且**大声打印 + 单独计数**，
最终输出 `pass=5 fail=0 skipped=1` 且明确写出「有 1 条断言被显式跳过（未调准），它们**不算通过**」——
沿用本仓库既有约定（"少跑了几项检查必须明确打印 NOTE，绝不静默通过"）。

**这不改变 §16 的结论**：修复本身已在 **API 级**验证（245 条跨 5 页全部可达）；
浏览器级验证仍缺失，不得声称完成。下次改用 CDP 真实鼠标事件
（`Input.dispatchMouseEvent`）而不是 DOM `.click()`，Cookie/React 合成事件都可能让后者失效。

**已接入 `verify-all.sh`**（`bfb48ca`）。当时的两个前置都已解决：
① tab 交互 —— 根因是 Radix Tabs 在 `onMouseDown` 切换、不看 `click`（详见 `bfb48ca` 提交信息）；
② skip 策略 —— §16 的 SKIP 已换成可判定断言，现在 **18/18、0 SKIP**。
Chrome 仍是环境依赖，所以门禁在未配置账号时**明确打印"未运行、不算通过"**，而不是打印 PASS。
