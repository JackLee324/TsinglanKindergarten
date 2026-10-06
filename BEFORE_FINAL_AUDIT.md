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

门禁基线（每轮实跑）：`npm test` **275/275**、**eslint PASS、stylelint PASS**（本轮首次真正可跑，见下）、双 typecheck PASS、build PASS、api-contracts matched、authz 75、hardening 10、mfa 55、headers 20、files **80**、naming 49、directories 55、directories-write **31**、resource-versions **22**、**account-permissions 27**、**storage-s3 28（+2 如实跳过）**、**storage-upload**、browser-e2e **37/37、0 跳过**、mfa-web **17/17、0 跳过**；`npm test` **276**。

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


### §11 管理界面（commit `948955c`）

加在既有的「权限管理」页里（不新开页面、不动既有布局）：选中账号后出现「生效权限」面板 ——
摘要（生效 N / 追加 M / 禁止 K）、单独覆盖项各自一条「恢复为角色默认」、
以及按分组列出的**全部 46 条**权限（含当前没有的；看不见"缺什么"就谈不上追加），
每行两个动作（追加授权 / 显式禁止）与命中徽章。

**浏览器端到端（browser-e2e 32 → 37、0 跳过）**：进入页 → 选中账号 → 面板加载 46 条 →
点追加 → 该项出现「追加」徽章（服务端 `sources` 真的变了）→ 点恢复 → 徽章消失、
覆盖行清零。**用例自清理，不留残留。**

过程中三个"假失败"都是我的用例写错，不是产品问题：
1. 直接找 `[data-perm-row]`，但账号列表是 `<button>` 不是 `<table>`，且面板只在选中后才渲染；
2. 改成等"面板容器"→ 容器先到、数据后到，读到的是"加载中"（**异步渲染必须等目标内容出现**）；
3. 选中列表第一项 = 当前登录账号，而"管理自己"被等级规则正确拒绝（**这条 403 是对的，我没有去修它**）。


### 生产实测：§11 界面（本轮）

对生产跑只读为主的 browser-e2e（`pass=30 fail=0 skipped=1`，SKIP 仍是"该账号名下没有资源"）：

    选中账号「体能教师04」→ 生效权限面板加载 46 条 → 点「追加授权」system.manage
    → 出现「追加」徽章（服务端 sources 已更新）→ 点恢复 → 覆盖清零（用例自清理）

**如实标注**：这一条会**写**生产（给一个账号加一条 grant 再清除）。跑完我逐个账号核对过：
检查 22 个账号，**带权限覆盖的 = 0**，即确实自清理干净。将来若要"完全不写生产"，
应把这一条从生产运行中排除（或用专门的只读断言替代）。


### §4/§23 S3 兼容对象存储后端（commit `8be0c56`）

**为什么手写 SigV4**：本机不能再跑 `npm install`（会裁剪掉 darwin-arm64 二进制，
构建已因此坏过一次）；Docker Hub 在本环境**不可达**（`pull access denied`），MinIO 起不来。
而预签名 URL 本身就是确定性的哈希/HMAC 链，`node:crypto` 足够。

`server/modules/files/s3-object-storage.ts`：path-style、支持 STS 会话令牌、
TTL 夹到 [1, 7 天]、**bucket 不匹配拒绝签名**。`ObjectStorageModule` 按"四项配置是否齐全"
选择后端；缺项一律退回 `UnconfiguredObjectStorage`，日志不打凭据。

**验证（`scripts/verify-storage-s3.mjs`，28 通过 / 0 失败 / 2 跳过）**

做到了：**真实字节往返逐字节一致（2649/2649）**（对象键含空格/中文/`+`/`!`/括号）；
过期 URL 被拒；不存在对象 404；空格必须 `%20`、`!` 必须编码、规范查询串升序；
改键/方法/TTL/密钥/区域签名都变；会话令牌参与签名。

**没做到（如实标注，未当作通过）**：
1. **签名正确性未被验证** —— 用 `aws4` 交叉比对时，它的预签名入口始终用自己的时钟与
   默认过期时间，两边没在签同一个输入；这是**我的脚手架问题**，既不能说签名错、也不能说对。
2. **"篡改签名被拒"无法判定** —— s3rver 源码自述「V4 signatures have incomplete support」，
   实测篡改后仍返回 200，它不校验 V4。所以"PUT 被接受"证明链路可用，**不是**签名正确。

需要**严格校验 V4 的端点**（真实 bucket / MinIO / 装了 SDK 的环境）才能验证这两条。

**仍未完成**：客户端接线（预签名 PUT → 传字节 → 登记）；`registerFile` 在存储未配置时仍 503。


### §4/§23 真实上传链路（commit `8747536`）

新增 `POST /api/resources/:id/upload-url`（预签名 PUT）。三条取舍各自对应一个真实失败模式：
**对象键由服务端生成**（`uploads/<resourceId>/<时间戳>-<清洗后的名字>`；客户端能选键
就等于能覆盖任意对象）；**没有直传能力就 503**，不退回"假装上传成功"；
**直传拿到 URL 不等于被信任**，仍须 `registerFile` 做清洗/类型/大小/魔数校验。

**配好 S3 时 20 通过 / 0 失败 / 0 跳过**：建资源 → 申请直传地址 → **PUT 3099 字节** →
登记 201 → 第一跳 302 拿下载令牌 → 第二跳 302 拿**对象存储签名直链** → 取回字节 →
**逐字节一致（3099/3099）**；顺带验到 §15 联动（最新版为 `file_attached`）。
服务端**未配置** S3 时如实跳过（`pass=1 fail=0 skipped=1`）—— 那时 503 是正确行为，
当成通过就是假成功。

**三个"假失败"都是我的用例写错**：`fetch` 默认自动跟随重定向（把"重定向正确"误报成
"没重定向"）；下载是两跳且第一跳是相对路径、第二跳还要带会话 cookie（令牌绑定账号）；
`bucketId` 断言拿了脚本自己的 `S3_BUCKET`（那个变量只设在服务端进程上）。

**顺带修**：`storage-s3` 写死端口 9200，被我自己上一轮遗留的 s3rver 顶成 EADDRINUSE
（环境问题长得像代码问题）→ 改为自动挑选 9200-9204。

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

---

### 追加（第 31 轮）：把"客户端上传"真正跑通 —— 途中挖出 4 个真实缺陷

本轮起点：上一轮把**服务端**三步接口（申请直传地址 → PUT 字节 → 登记）跑通了，
但**客户端**（老师真正点的那个按钮）一行都没有被验证过。补上浏览器闭环后，
连续暴露出 4 个此前完全没有被发现的问题。全部已修并验证。

#### 缺陷 1：编辑页**永远存不了档**，而且一声不吭（严重）

`UploadPage` 里两段"清空下级选择"的 effect 是无条件的：

```tsx
useEffect(() => { form.setValue('subject',''); form.setValue('subSubject',''); }, [programValue])
useEffect(() => { form.setValue('subSubject',''); }, [subjectValue])
```

编辑页加载时 `form.reset()` 会把 `program` 从 `''` 变成资源真实的班型，这个**变化**
同样触发第一段，于是刚预填进去的 `subject` 立刻被清空。后果不是报错，而是：

    点「保存草稿」→ form.trigger 校验失败 → `if (!ok) return;` → 既不保存也不提示

实测证据（编辑 prek/virtue 的资源，点保存后）：路径仍停在 `/upload?id=…`，
页面只多出一行 `upload.subjectRequired`，**没有任何 toast**。也就是说
「编辑资源」这个功能此前是不可用的，且完全静默。

修复：只在"用户真的换了班型、且原科目在新班型里不存在"时才清空（用 ref 记录前值，
首次落值不清）；并且**校验失败必须说出来**（新增 toast，原来是无条件 `return`）。

#### 缺陷 2：`not_configured` 分支从写下那天起就不可能进入（死分支）

`UploadPage` 里判断"服务端没接对象存储"用的是**错误文本**匹配：

```ts
/STORAGE_NOT_CONFIGURED|未接入|未配置/.test(msg)
```

但 `handleApiError` 对非 401/403 是 `throw error`（原样抛 axios 错误），
于是 `msg` 永远是 `Request failed with status code 503` —— 那段正则**永不匹配**。
实测：服务端未配存储时，老师看到的是笼统的「资源已保存，但文件上传失败：…503」，
而不是那条专门写好、双语齐全的「文件没有上传：服务端当前没有配置对象存储」。

修复：新增 `extractApiErrorCode()`（`client/src/api/client.ts`）从
`error.details`（服务端把具体的码放在这里）取**机器可读**的 code，
按 code 判定；文本匹配只作为响应体被代理剥掉时的兜底。

#### 缺陷 3（真实部署前提）：bucket 没配 CORS，浏览器直传必然 "Failed to fetch"

客户端上传是**浏览器直接 PUT 到对象存储**（跨域，且带 `Content-Type` ⇒ 有预检）。
bucket 没有 CORS 策略时：

* Chromium 的 `corsErrorStatus` 实测为 `PreflightMissingAllowOriginHeader`；
* 浏览器拦掉请求，页面显示 `Failed to fetch`；
* **服务端一行错误日志都没有**（请求根本没到对象存储）—— 极易误判成"签名算错了"。

这不是代码缺陷（预签名 URL 本身正确：实测 201 + 带 `X-Amz-Signature`），
而是**部署前提**，已写入 `DEPLOYMENT_PRODUCTION.md` §2.5 与 §12 发布前检查清单。
同时本机测试 bucket 已配 CORS（`/tmp/qls-s3server/cors.xml`）。

#### 缺陷 4：`DELETE /api/teachers/:id` 是"停用"语义，而清理代码以为它删了

`verify-directories.mjs` 用该接口清理临时 visitor 探针，并把 200/204 当成"已删除"。
但服务端执行的是 `UPDATE teachers SET status='inactive'`（有意的软删除，保留审计）。
于是每跑一次门禁就在库里留下一个 `dirprobe_visitor`，而输出一直宣称"删除…HTTP 200"。

修复：输出如实说明该接口是"停用"语义；真正的清理由 SQL 完成，并**复查残留为 0**。
实测：`SQL 硬删除完成（影响 1 行；复查残留 0 行）`，复查 `dirprobe_visitor` = 0 行。

#### 新增门禁项：`upload-web`（真实浏览器上传闭环）

`scripts/verify-upload-web.mjs`，两种模式：

| 模式 | 断言 | 实测 |
|---|---|---|
| `EXPECT_STORAGE=on`（配了 S3） | 成功提示明确说"文件也保存了"；`hasFile=true`；**从签名直链取回的字节与浏览器上传的字节逐字节一致**；另加"服务端会拒绝的文件必须报上传失败、不得报成功" | **21 通过 / 0 失败** |
| `EXPECT_STORAGE=off`（没配 S3） | 必须出现"文件没有上传"的**警告**；不得出现绿色成功提示；不得伪造 bucket/path；下载被拒（404 无文件 / 503 存储未配置）且不给签名直链 | **13 通过 / 0 失败 / 1 显式跳过** |

#### 门禁全绿（本轮，未配置存储模式）

```
npm test 276/276 · eslint PASS · stylelint PASS · typecheck server/client PASS · build PASS
api-contracts matched
authz-http 75 · hardening 10 · mfa 55 · security-headers 20 · files-http 80 · naming-http 49
directories 55 · directories-write 31 · resource-versions 22 · account-permissions 27
storage-s3 28 · storage-upload 1 · browser-e2e 37 · mfa-web 17 · upload-web 13
✅ 全部通过        （276 单元 + 520 HTTP/浏览器 = 796）
```

#### 顺带修正：门禁有两种模式，之前没人说明

`files-http` / `naming-http` 有一组断言的前提**就是**"本进程没有对象存储后端"，
而生产**要求**必须配后端。在配了 S3 的进程上跑整个门禁，那两组会红 ——
那是环境模式不匹配，不是产品缺陷。**最危险的处理方式是"为了把门禁弄绿去关掉对象存储"。**

已在 `verify-all.sh` 头部写明两种模式的跑法，并在两个套件里加了**前提不成立时的醒目横幅**
（用另一条代码路径 `upload-url` 探测模式，不拿被测接口自证）。

#### 本轮我自己犯的错（如实记录）

1. 新增的两个断言**是我写错的**，不是产品错：
   * 「被拒后下载应返回 503」—— 资源压根没有文件时正确返回 **404**（先判有无文件，
     再去存储），503 是"存储未配置"。已改成断言"被拒绝"这个事实 + "不给签名直链"。
   * 两个阶段共用一条探针资源 → 阶段 1 已挂上文件，阶段 2 的 `hasFile=false` 必然失败。
     已改为每阶段独立资源。
2. 探针标题有两处拼接，加了后缀后只改了一处 → 「编辑页已预填」假失败一次。已收敛为单一来源。
3. 用 `assert count == 1` 做锚点，但 `'upload.storageNote':` 在 zh/en 各出现一次（count=2）
   → 脚本中止。教训与第 24 轮同源：**锚点必须验证唯一性**，不能假设。

#### 第 31 轮收尾：两处小修（都属于"修错"，不属 UI 改版）

1. **面向用户的文案里混进了 markdown**。`upload.storageNotConfigured`
   原文是 `…但**文件没有上传**：…`。这条要经 sonner 的 toast **原样渲染**，
   而 sonner 不解析 markdown（产物里 0 处 markdown/HTML 渲染）—— 老师看到的会是
   字面的星号。**这条文案之所以"以前没人发现"，恰恰因为它此前是死分支**（见缺陷 2）；
   我把它修活之后，这个瑕疵才第一次变成可见的。已去掉星号（强调靠措辞，不靠语法糖）。
   全仓库 `client/src/i18n/translations.ts` 里已无面向用户的 `**`（其余 `**` 都在注释或 Tailwind 类里）。
   实测复跑：未配置存储模式下提示为
   「资源信息已保存为草稿，但文件没有上传：服务端当前没有配置对象存储。请让管理员接入存储后端后重试。」

2. **数据库里有一行 `username IS NULL` 的 `principal` 账号**（`name='系统初始化'`，
   `password_hash` 为空）。它**无法登录**（没有口令哈希），因此不是可利用的入口；
   但一个"无用户名、角色为主管、却拿不到口令"的行本身就是可疑的历史残留。
   本轮**没有动它**（不在本次范围内，且删除账号属运维/数据决策），在此如实登记，
   建议上线前由你确认它的来历，并考虑连同 `__rbac_keeper` 一起做一次账号盘点。

#### 第 31 轮最终门禁（干净重跑两次，结论一致）

```
npm test 276/276 · eslint PASS · stylelint PASS · typecheck server/client PASS · build PASS
api-contracts matched
authz-http 75 · hardening 10 · mfa 55 · security-headers 20 · files-http 80 · naming-http 49
directories 55 · directories-write 31 · resource-versions 22 · account-permissions 27
storage-s3 28 · storage-upload 1 · browser-e2e 37 · mfa-web 17 · upload-web 13
✅ 全部通过                      （276 单元 + 520 HTTP/浏览器 = 796）
```

配置存储模式下的两个套件（另起一个设了 S3_* 的进程）：

```
node scripts/verify-storage-upload-flow.mjs            → 20 通过 / 0 失败 / 0 跳过
EXPECT_STORAGE=on node scripts/verify-upload-web.mjs   → 21 通过 / 0 失败 / 0 跳过
```

探针卫生复查（两轮门禁 + 两轮存储套件之后）：`dirprobe_visitor` 残留 **0 行**、
未删除的探针资源 **0 条**、未删除且有文件的资源 **0 条**。
（回收站里另有 44 条**已软删除**的探针资源 —— 那是软删除的正确行为，不是脏数据。）

---

### 追加（第 40 轮，收官）：把"新建资源"这条最常用的路也真的走了一遍

第 31 轮修掉"编辑页静默存不了档"之后，还剩一条**没被任何浏览器测试覆盖**的路：
**新建资源**（`/upload`，不是 `/upload?id=`）。老师平时点的就是这条 ——
要自己选班型/科目/资料夹/学期、自己填标题。而第 31 轮修的那个缺陷
（选完班型把科目清空）恰恰出在这个表单的联动上，所以必须真的走一遍。

#### 卡住的技术点：DOM 合成事件驱动不了 Radix Select

Radix 的 `SelectItem` 在 pointer 处理器里用
`document.elementFromPoint(clientX, clientY)` 判断"指针是否落在内容区上"，
而 `new MouseEvent('click')` 的 `clientX/clientY` 默认是 **0,0** ——
`elementFromPoint(0,0)` 拿到的是页面左上角的元素，判定"不在内容区"，
**选择被丢弃**。

实测症状极具误导性：下拉**会正常关闭**，但值不设置。表现为

    点 "Pre-K" → 下拉关闭 → combobox 文案仍为空 → 科目下拉仍是 disabled

看起来完全像"点了没反应"的产品缺陷。换成 **CDP `Input.dispatchMouseEvent`**
（真实输入管线、真实坐标）后，四个下拉一次全部选中：

```
选班型 = Pre-K      PASS
选科目 = 美德        PASS
选资料夹 = 周次教案   PASS
选学期 = 第一学期     PASS
四个下拉的值都**保留住了**（选班型没有把科目清掉）  -> Pre-K / 美德 / 周次教案 / 第一学期
```

> 这与第 30 轮 §16 的结论一致（那次改成 CDP 真实鼠标事件才解决）：**凡是
> 依赖真实指针位置的库组件，合成事件都不可靠。** 这一条值得写进入库须知。

#### 半路又踩了一个"看起来像产品缺陷"的坑（我的选择器写错了）

标题框填不进去，报 `NOT_FOUND`，于是提交被"必填项"校验拦下 ——
**看上去就是产品缺陷**。真相：shadcn 的 `<Input>` 渲染出来**没有 `type` 属性**，
而属性选择器 `input[type=text]` 匹配的是 **attribute**，不是 `el.type` 属性值。
周次框因为显式写了 `type="number"` 所以能填，标题框就匹配不到。
改成 `input:not([type=file]),textarea` 后正常。

顺带说明：**第 31 轮新加的"请先补全必填项"toast 在这里立了功** ——
它把"点了没反应"变成了"明确告诉我缺什么"，所以我一眼就知道是标题没填上，
而不是又去猜表单逻辑。这正是那条改动的价值。

#### 新建流程的完整证据（`upload-web` 阶段 5，真实浏览器）

```
填标题 / 填周次 / 四个下拉 / 选中文件            PASS
点「提交审核」                                   PASS
新建后提示"资源与文件均已保存"                     PASS
新建的资源在「我的资源」里查得到                    PASS
状态真的是 pending_review（提交审核生效）           PASS   -> pending_review
库里标记为有文件                                  PASS   -> hasFile=true
新建流程上传的字节也能逐字节取回                     PASS   -> 193B
```

合计 **35 通过 / 0 失败 / 0 跳过**（阶段 1/2/3 全跑）。

这条同时证明了 §3/§5/§6/§7/§30 的状态机在**真实 UI 操作**下是通的：
表单 → 建资源（draft）→ 上传字节 → 登记 → `submit-review` → `pending_review`。

#### 第 40 轮门禁与 docker（收官证据）

```
# 未配置存储模式（主门禁全绿基线）
npm test 276/276 · eslint PASS · stylelint PASS · typecheck server/client PASS · build PASS
api-contracts matched
authz-http 75 · hardening 10 · mfa 55 · security-headers 20 · files-http 80 · naming-http 49
directories 55 · directories-write 31 · resource-versions 22 · account-permissions 27
storage-s3 28 · storage-upload 1 · browser-e2e 37 · mfa-web 17 · upload-web 13（+1 跳过）
✅ 全部通过

# 配置存储模式
node scripts/verify-storage-upload-flow.mjs            → 20 通过 / 0 失败 / 0 跳过
EXPECT_STORAGE=on node scripts/verify-upload-web.mjs   → 35 通过 / 0 失败 / 0 跳过

# docker（用本轮最终代码重建）
docker build --platform linux/amd64 -t qls:r40 .       → BUILD EXIT=0，镜像 119MB

# 迁移
node scripts/migrate.mjs status                        → 11 applied，✓ No checksum drift
```

探针卫生：`dirprobe_visitor` 0 行、未删除探针资源 0 条、新建流程的三条探针资源全部删除。
库里另有 1 条**早于本轮**的 `pending_review` 资源（`§5 序列验证资源`，`hasFile=false`），
为既有套件的夹具，**本轮未动它**（删除可能打断依赖它的套件），在此如实登记。

---

## 收官指令执行台账（按用户 12 节指令，逐节记录）

> 本节只记录**已经做到并有证据**的；未完成的在最后单列，绝不写成"已完成"。

### §7 username IS NULL 的 principal —— 已完成（按指令，不删除）

**先查引用关系（指令要求的第一步）**，实测结果：

| 引用 | 行数 |
|---|---|
| `resources.uploader_id` | **346** |
| `resources.reviewer_id` / `deleted_by` | 0 / 0 |
| `review_records.reviewer_id` | 0 |
| `sessions.teacher_id` | 0 |
| `account_permission_overrides.teacher_id` / `granted_by` | 0 |
| `account_scopes.teacher_id` | 0 |
| `subject_permissions.teacher_id` | 0 |
| `audit_logs.teacher_id` / `teacher_name='系统初始化'` | 0 / 0 |

结论：它是 `scripts/seed-curriculum.mjs` 有意创建的**内容归属账号**（种子 347 条资源挂在它名下），
**没有 username、没有 password_hash**。实测用 `''` / `'系统初始化'` / `'null'` / `'__null__'`
登录**全部 401**，即**不可登录**。

处理（严格按指令）：**不 DELETE**，只置 `status='inactive'`，保留记录与全部历史关联。
证据：归属资源 `346 → 346`（不变）；处理后 `GET /api/resources` 仍 `200 total=348`；
**全库 348 条未删除资源一条不少**。
同时把 `seed-curriculum.mjs` 的插入改为 `status='inactive'`，让新装环境的初始状态与之一致
（否则这个"改了活库、没改种子"的差异会随时间漂移）。

### §2 PDF 新增科目 —— 已完成

之前的状态：`prek:english` 与 `k:chinese:arts` **只存在于目录表**，规范词汇里没有，
因此 `canonicalSubjectOfDirectoryCode()` 返回 `null` → 目录树这两个节点的 `subject = null`
→ **既挂不上资源、也不受任何 scope 约束**（整棵树 69 节点里只有这两个是 null）。

按决策做的三件事：
1. `shared/curriculum.ts`：prek 新增科目 `english`（英文）；
   k/chinese 新增子科 `arts`（美育）——**刻意不映射到已有的 `drama`**（两门不同的课）。
2. `server/modules/directories/directory-vocabulary.ts`：两条 `null` 改为真实 token。
3. i18n：新增 `subject.arts` / `subject.artsDesc`（zh + en）。

角色归属**不需要写任何映射**：`roleSubjectScope` 已给 `prek_head` 整个 prek、
`k_head` 整个 k —— 科目一进规范词汇就自动被覆盖，**未新增任何 Specialist 角色**。

实测：`prek:english → subject="english"`、`k:chinese:arts → subject="arts"`，
**全树已无解析不出 subject 的科目/子科节点**。

⚠️ 三处**按决策更新**的测试期望（不是为变绿放宽断言，规格变了）：
`scripts/verify-directories.mjs` 1 处、`tests/curriculum-tokens.test.mjs` 2 处，
均已在代码注释里写明"旧期望对应的是未决策缺口，已按决策补上"。

### §1 目录模型（进行中）

已完成并验证的部分：
* **migration 0012**（`resources.directory_id`）：加列 + `ON DELETE RESTRICT` 外键 + 部分索引 +
  按既有 (program, subject) 回填 + 迁移内自校验。
  - 迁移**前**已取快照 `backups/pre-0012-snapshot.json`（含 fingerprint）。
  - **up**：348/348 归属成功，program 不一致 **0**，悬空引用 **0**。
  - **down**：干净回滚（列/外键/索引全消失），348 条资源一条不少。
  - **再 up**：幂等，348/348 重新回填。
  - 顺带验证了 0011 的 down 守卫会正确拒绝（存在 138 条真实版本历史）。
* **两个维度并存**：`folder_type` 原样保留（347 行历史数据一字未改），
  `directory_id` 是新维度；**刻意没做** folder_type→PDF 资料夹的语义猜测。
* **服务端写入/读取闭环**：实测建资源带目录 → `directoryId` 落库并能在详情与列表读回；
  不传 → `null`；跨班型 / 跨科目 / 目录不存在 → 三者均 **400**（§3 的
  "目录归属与 program/subject scope 同受约束"由此落地：无法靠挑别的目录绕开科目授权）。

**尚未完成**（不得声称已完成）：目录页查询"属于该目录的资源"、
上传界面选目录、目录树 `resourceCount` 改为按 `directory_id` 精确统计、目录排序/停用的界面入口。

### 本轮门禁

`npm test` 276/276（两条金标准按决策更新后）；15 个 HTTP/浏览器套件全绿；
`directories` 由 55 增至 **56**（新增 prek:english 断言）。

### 第 2 轮追加：§1 目录模型读写两侧闭环

**精确计数**：`resourceCount` 之前**只有科目节点的数字是真的**（按 (program, subject) 聚合，
子科与资料夹恒为 0，注释里写明"等 directory_id 落地后改为精确统计"）。现在改为按
`resources.directory_id` 聚合，并在内存里累加成**子树计数** —— 老师在科目页看到
「美德 10」时，意指"这个科目下总共 10 份"，含进了资料夹里的那些。

**目录查资源**：`GET /api/resources?directory=<code>`（另有 `/api/resources/mine`
同样支持）。code → 「该节点 + 全部子孙」的 id 集合；未知 code 返回 **404**（绝不
返回"全部"）。过滤条件加在权限条件**之后**，因此它只能收窄、永远不能放宽 ——
"目录归属"不可能被用来绕过科目权限。实测：

    prek:virtue            -> 200 total=12
    prek:virtue_outline    -> 200 total=0
    prek:montessori        -> 200 total=292
    prek                   -> 200 total=304
    root:edu               -> 200 total=348
    no:such:code           -> 404

**排序 / 启用停用**：`UpdateDirectoryNodeDto` 加 `sortOrder`、`enabled`，
审计新增动作 `directory_update`（**刻意不复用** `directory_rename`：改名与停用
是完全不同的事）。系统节点仍**禁止改名**（来自 PDF），但**允许排序与启停** ——
"这一学期不开这门课"应当靠停用表达，而不是去改 PDF。

#### 途中发现并修掉的一个真实设计缺陷

`loadAll()` 一律带 `enabled = true`。写路径 `updateNode()` 也用它查找目标节点 ——
于是**一旦停用，就再也找不到它，"重新启用"永远返回 404**。停用会变成一次性、
不可逆的操作，而界面上却会摆着一个"启用"按钮。
修法：`loadAll(includeDisabled)`，写路径传 `true`。实测：

    1) 新建文件夹 -> 201 k:chinese:arts_lesson_u1
    2) 设置排序 -> 200 sortOrder=15
    3) 停用 -> 200 enabled=false
    4) 停用后还在树上吗 -> false（应 false）
    5) 重新启用 -> 200 enabled=true   ← 修复前这里永远 404
    6) 恢复后回到树上吗 -> true（应 true）
    7) 自建节点改名 -> 200
    8) 系统节点改名 -> 403（保护生效）
    9) 系统节点排序 -> 200（允许）

#### 上传页目录选择器

`UploadPage` 新增「目录归属」下拉，候选**全部来自** `GET /api/directories/tree`
（服务端已按角色 scope 剪枝），页面既不复刻权限规则也不预置目录名；
留空 = 尚未归属（服务端存 NULL），不猜默认目录。与 legacy「资料夹」**并存**。

浏览器实测（`upload-web` 扩到 **38/38**）：

    PASS  选目录归属 = Pre-K / 美德
    PASS  目录归属已落库且指向 prek:virtue  -> f7cc3cea-…
    PASS  按目录查询能查到这条新资源（?directory=prek:virtue）
    PASS  状态真的是 pending_review
    PASS  新建流程上传的字节也能逐字节取回  -> 193B

#### 本轮我自己犯的两个测试错误（都属"看起来像产品缺陷"）

1. **点错下拉项**：目录下拉有 69 个候选、列表可滚动，我只取了目标项的
   `getBoundingClientRect` 中心去点，结果点中了**别的**行
   （点 "Pre-K / 美德" 实际选中 `prek:montessori_lesson`），服务端随即正确地以
   400「资源与所选目录不属于同一科目」拒绝 —— 看起来完全像产品缺陷。
   修法：坐标取"目标项矩形 ∩ 下拉可视区矩形"的交集中心；并**新增自校验**：
   点完必须复核 combobox 上的文案是否真的是期望值，否则返回 `WRONG_PICK`。
   没有这个自校验，它会静默地一直错下去。
2. 同类的第十次教训：**断言必须验证"实际发生了什么"**，不能只验证"我做了这个动作"。

**门禁**：全绿 —— `npm test 276/276`、双端 typecheck、lint、build、api-contracts，
15 个套件（`directories` 56、`upload-web` 13/off 模式）。

### 第 3 轮追加：§1 的三项硬要求有了浏览器级证据（新增 `directory-web`）

用户对 §1 提了三条明确、可判定、**此前完全没被覆盖**的要求：

1. 目录修改后**刷新浏览器仍然存在**；
2. 新增目录**无需修改代码**即可在网页出现；
3. **目录页面能够查询到属于该目录的资源**。

`verify-browser-e2e.mjs` 的 §24 建过文件夹，但**建完就删、从不刷新** ——
所以第 1 条一直是裸奔的：一个"只活在 React state 里、刷新就没"的实现也能通过。
新增 `scripts/verify-directory-web.mjs`（已接入门禁），实测 **13/13**：

```
PASS  展开目录树后找到父节点 prek:english_lesson 的「新建子目录」按钮
PASS  提交后新目录出现在树里  -> 刷新探针-567739
PASS  F5 硬刷新后新目录仍在（不是内存里的假象）  -> 刷新探针-567739
PASS  服务端目录树里也确实存在该节点  -> prek:english_lesson_u1
PASS  先选班型 = Pre-K（目录下拉此时才可用）
PASS  新目录出现在上传页的「目录归属」候选里（没有改过任何代码）
PASS  按该目录查询能查到归属其中的资源  -> prek:english_lesson_u1
PASS  资源行上的 directoryId 正是该目录  -> bd7769ab-…
```

#### 途中发现并修掉的真缺陷：删除目录返回 500

`ON DELETE RESTRICT` 是我在 0012 里加的（删除保护的数据库兜底）。但 `deleteNode()`
**只检查了子目录、没检查资源**，于是数据库抛出的外键冲突以 Postgres 原始错误冒上来，
用户看到的是 **500「服务器内部错误」** —— 既不知道原因，也不知道该怎么办。
实测就是这样：删一个刚放过资源的自建目录 → 500。

修法：删除前先查引用数，给出**可执行的 409**；并且**不过滤 `deleted_at`** ——
回收站里的行还在，外键照样拦得住它，判断必须与数据库的真实约束一致，
否则又会出现"接口说能删、数据库说不能"。实测：500 → **409**，消息说明还有几份资源、
含回收站里的、以及该怎么办。

顺带把 `deleteNode` 的查找也改成 `loadAll(true)`（与 `updateNode` 同类问题：
停用过的节点会永远找不到，"停用即不可删"）。

#### 本轮我自己犯的三个测试错误（都是"读了自己过期的数据/误判"）

1. **深层节点根本没渲染**：目录页是可折叠树，`prek:english_lesson` 在祖先收起时
   不进 DOM，直接 `querySelector` 得到 NOT_FOUND，于是 4 条断言全部误报失败。
   修法：新增 `expandUntil()` 逐层展开再查找。
2. **在禁用控件上点击**：「目录归属」下拉在未选班型时是 disabled 的（有意的设计），
   不先选班型就点它什么都不会发生 —— 误报成"新目录没出现"。
3. **用了建目录之前的目录树快照**去取新目录的 id，`find()` 返回 undefined、
   `.id` 得到 undefined，资源被建成"未归属"，查询自然是 0。
   **这是同类错误的第三次**（前两次：探针标题两处拼接、复用过期变量）。

另外还有一个**差点造成破坏**的错误：清理残留时写了 `code LIKE '%_u%'` ——
`_` 在 SQL LIKE 里是**单字符通配符**，于是 `root:edu`（含字母 u）也被选中，
差一步就删掉根节点（外键挡住了）。改用锚定正则 `'_u[0-9]+$'`。
**又一个"锚点必须先证明唯一"的实例，这次是在 SQL 里。**

#### 门禁

**全绿，16 个套件**：276 单元 + 534 HTTP/浏览器 = **810 项**。
`directory-web` 13 已接入；`directories` 56。探针卫生复查：目录总数回到 **69**、
探针目录残留 0、未删除探针资源 0。

### 第 4 轮追加：§4 用**真正校验签名**的后端跑完 8 个用例；§5 落成最小权限 CORS

#### 为什么 s3rver 不算数

`s3rver` **不校验 V4 签名**（其源码自述 "V4 signatures have incomplete support"）。
于是"PUT 返回 200"**完全不能证明签名是对的** —— 一个 canonical request 拼错、
签名算错的实现，在 s3rver 上照样通过。本项目客户端直传完全依赖预签名 URL，
这一条不能靠"看起来能用"。

#### 新增 `scripts/test-s3-sigv4-server.mjs`（真的重算签名）

按 AWS 文档**从零重算**，每一层独立拒绝，并返回**不同的 S3 错误码**，
让测试能断言"因为哪个原因被拒"而不是只断言"403 了"：

1. `X-Amz-Algorithm` 必须是 AWS4-HMAC-SHA256；
2. `X-Amz-Credential` 的 AccessKeyId 必须匹配 → 否则 **InvalidAccessKeyId**；
3. credential scope 自洽（date/region/service）；
4. **未过期**（X-Amz-Date + X-Amz-Expires ≥ now）→ 否则 **AccessDenied**；
5. 重算 canonical request → stringToSign → 签名，**定长比较** → 否则 **SignatureDoesNotMatch**。

#### 8 个用例实测（`scripts/verify-storage-sigv4.mjs`，**16/16 通过 / 0 跳过**）

```
1) 正确签名的 PUT 被接受                                    PASS  200
2) GET 取回的字节与 PUT 的逐字节一致                          PASS  33B
3) 错误签名被拒（SignatureDoesNotMatch）                     PASS  403
4) 过期签名被拒（AccessDenied: Request has expired）         PASS  403
5) 篡改对象键被拒（签名覆盖了 URI）                            PASS  403
6) 篡改有效期被拒（签名覆盖了 query）                          PASS  403
7) 换成别的 bucket 被拒（bucket 在签名覆盖的 URI 里）           PASS  403
8) 用错的 secret 签名被拒                                    PASS  403
   用错的 AccessKeyId 被拒（InvalidAccessKeyId）              PASS  403
```

**外加两条"防止自己骗自己"的断言**：

* **第三方实现交叉验证**：让 `aws4`（第三方库）自己签一个 PUT URL，
  交给我们的后端 —— **被接受（200）**，且同一 URL 被篡改后立刻被拒（403）。
  这排除了"我的签名器和我的校验器共享同一个 bug、自己和自己达成一致"。
* **走应用的真实链路**：应用自己签发 URL → PUT 到严格后端（**200**）→ 登记 →
  两跳签名下载 → 逐字节一致。**这一条才真正证明应用签出的签名是对的。**

#### §5 最小权限 CORS（已写入 `DEPLOYMENT_PRODUCTION.md` §2.5）

只允许 `https://tsinglankindergarten.zeabur.app` 一个来源（**明确禁止 `*`**）、
只开放 `PUT/GET/HEAD`、只允许 `content-type` 一个请求头、只暴露 `ETag`。
每一项都在文档里写了"为什么是这个值"。

> 这份策略是**实测可用**的，不是照文档抄的：本机严格校验签名的测试后端用的就是
> 同一份最小权限策略（只允许 `http://127.0.0.1:3200`），
> `verify-upload-web.mjs` 在**真实浏览器**里对着它跑通了 **38/38**。

#### 本轮我犯的两个错（都是"把环境问题当成结论"）

1. **凭据解析只取了两段**：`const [key, scope] = credential.split('/')` ——
   `X-Amz-Credential` 是 5 段，于是 region/service 全是 undefined，
   每个请求都被判成 "invalid credential scope"，**连正确的 PUT 都过不去**。
   症状是所有 8 个用例一起变红，看起来像"签名算法错了"。
2. **`aws4` 的两个用法错误**：`signQuery` 属于**请求对象**而不是第二个参数
   （第一次传错位置，aws4 悄悄退回去签 Authorization 头，签名自然是 null）；
   `import()` 也不能指向包目录（ESM 不接受目录路径），要指向 `aws4.js`。

#### 一个只有真跑才会暴露的坑：测试后端也得配 CORS

严格后端一开始**没有任何 CORS 头**，于是浏览器直传在预检就被拦掉 ——
`upload-web` 报 4 条 `Failed to fetch`，而**后端一行日志都没有**（请求根本没到）。
这与 §5 要说的完全是同一件事，只是换了个位置发生。加上最小权限 CORS 后 38/38。

#### 门禁

新增 `storage-sigv4` 一项（未设置 `S3_SIGV4_ENDPOINT` 时**明确打印"未运行、
不算通过"**，不静默放过）。配置存储模式下：`storage-sigv4` **16/16**、
`storage-upload` **20/20**、`upload-web` **38/38**。
（该模式下 `files-http` / `naming-http` 会因"本进程没有存储后端"这一前提不成立而红 ——
那是环境模式不匹配，两个套件都会打印醒目横幅说明，已在前文记录。）

### 第 5 轮追加：§9 业务全链路 E2E —— 33 通过 / 0 失败 / 1 显式跳过

新增 `scripts/verify-business-e2e.mjs`（已接入门禁），在**真实浏览器**里把用户点名的
整条链一次走完，而不是逐个接口各测一遍 —— **单点都对、串起来断掉**是这类系统最常见
也最难发现的一类缺陷。

```
2) 新建 → 选班型 → 选科目 → 选目录 → 上传真实文件 → 保存草稿
   填标题 / 选班型=Pre-K / 选科目=美德 / 选资料夹=周次教案 / 选学期=第一学期
   选目录归属=Pre-K / 美德 / 选中真实文件 / 保存草稿 → 提示"资源与文件均已保存"
3) 编辑 → 保存 → F5 硬刷新 → 数据仍在（草稿阶段）
   编辑页由接口预填原标题 / 改标题 / 刷新后新标题仍在 / 接口也确认标题已改
4) 我的资源 → 查看详情                      详情弹窗打开并显示该资源
5) 提交审核                                 状态 = pending_review
6) 审核工作台 → 通过审核                     状态 = published
7) 目录页面：该目录下能看到这条资源            徽标「美德 12 条资源」= 接口 published 计数
8) 下载 → 字节一致                          逐字节一致 69B
9) 删除 → 回收站 → 恢复 → 再出现              列表消失 / 进回收站 / 恢复后 deletedAt 为空
10) 授权→重登生效；撤销→旧 Session 失效
    visitor 授权前被拒 403 / 授予 resource.delete / 重登后权限列表含它 /
    撤销 / **旧 Session 立刻 401**（permissionsVersion 生效）
```

#### 为让 E2E 可靠，给图标按钮加了 `data-testid`（纯属性，不改 UI）

`MyResourcesPage` / `ReviewPage` 的操作按钮是**纯图标、没有文案**，"查看"按钮还在两处
重复出现。按坐标点等于靠猜。加了 `data-testid`（并给共享的 `ConfirmDialog` 增加可选
`testId`），**没有改任何视觉或行为** —— 属于允许范围内的最小改动。

#### ⚠️ 一个真实缺口：回收站**没有前端界面**

`client/src` 里**没有任何** `recycleBin` / `restoreResource` 的引用：
老师删掉资源后，只有管理员能通过 API 恢复。§9 要求的
"删除→回收站→恢复→再出现"因此**只能验证到 API 层**，界面部分属**未实现**。
已用显式 SKIP 记录（"属未实现，不是未验证"），并列入剩余阻塞项 —— 不掩盖。

#### 本轮我犯的错（5 个，全部是测试自己的问题）

1. **`pageSize=200` → 400**：上限是 100。于是"按目录查资源"和"回收站查询"两条一起变红，
   看起来像功能坏了。
2. **测试做了 UI 不允许的事**：把"编辑→保存"放在**发布之后**，而界面对已发布资源的
   编辑按钮是 `disabled` 的 —— 保存被服务端正确拒绝，却像是"编辑坏了"。
   修法：把这一段挪到**草稿阶段**。
3. **拿旧标题去比对**：编辑之后资源标题变了，但校验弹窗内容时仍用**原标题**做
   `includes`，必然失败。加诊断打印出弹窗真实内容后一眼看出 ——
   **断言失败时把"实际值"打出来**，不然只能靠猜。
4. **`stamp` 没提升到模块作用域**：`finally` 里的兜底清理看不到 `main()` 的局部变量，
   于是"按本次运行标记兜底删除"根本没生效（失败运行各留一行残留）。
5. **`process.exit()` 截断管道中的 stdout**：用 `| grep`/`tail` 看输出时清理日志整段消失，
   一度让我以为清理没跑。改成写文件后一切正常 —— 以后看长输出用文件，不要用管道。

#### 门禁（两种模式，都如实标注）

* **基线（未配置存储）**：全绿。`storage-sigv4` 与 `business-e2e` 都**明确打印
  "未运行…这一项不算通过"** —— 而不是跑出 `pass=0 fail=0`（那和"跑过且没有断言"
  在外观上无法区分，正是本仓库一直在防的假绿）。
* **配置存储**：`business-e2e` **33/0**、`upload-web` **38/0**、`storage-upload` **20/0**、
  `storage-sigv4` **16/0**。（该模式下 `files-http`/`naming-http` 因"本进程没有存储后端"
  这一前提不成立而红，属环境模式不匹配，两个套件均打印醒目横幅。）

断言合计：基线 **810**；配置存储模式 **903**。

### 第 6 轮追加：§10 docker compose —— **部分实测**，并发现一个真实缺陷

#### 先更正一条我此前说过的不准确结论

我此前写"**Docker Hub 不可达**"。实际重测：`docker pull postgres:16` **成功**
（digest `sha256:1a6ab3f5…`），Docker Desktop 的镜像仓库可用。
真正拉不到的是 **`minio/minio`**（`repository does not exist or may require 'docker login'`）
—— MinIO 已迁移镜像仓库，不是网络不通。这条更正对 §4 有影响：
"拿不到 MinIO"依旧成立，但**原因与我先前说的不同**，且我用自建严格校验后端 +
`aws4` 交叉验证覆盖了那 8 个用例（见第 4 轮）。

#### 发现并修掉一个真实缺陷：compose 只钉了构建平台，没钉运行平台

`docker-compose.yml` 的 `app.build.platforms` 钉了 `linux/amd64`（因为
`package-lock.json` 是 linux/x64 专用），但 **service 上没有 `platform:`**。
在 Apple Silicon 宿主上实测的后果非常难查：

* `docker compose up -d` **一直卡住不返回**；
* `docker compose ps` 里 app 永远停在 **`Created`**；
* `docker logs` **一行都没有**；
* 只有一行极易忽略的 warning：
  `app The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8)`；
* 随后连 `docker start` / `docker rm -f` 都会挂住，把守护进程一起拖住。

已修：给 app service 加 `platform: linux/amd64`（与 `build.platforms` 一致，
在 x86_64 宿主上是无害的同架构声明），并把**文件头那句"无法在本机验证"改成实测结论**。

#### 八个子命令的实测结果（如实分列）

| 子命令 | 结果 | 证据 |
|---|---|---|
| `docker compose config` | ✅ **通过** | exit 0；修 platform 后再次 `config -q` exit 0 |
| `docker compose build` | ✅ **通过** | exit 0；产出 `linux/amd64` 镜像 677,721,144 字节 |
| `docker compose ps` | ✅ **命令可用** | 正确列出 app / postgres 两行及健康状态 |
| `docker compose logs` | ✅ **命令可用** | postgres 日志完整可取（`database system is ready`） |
| `docker compose down` | ✅ **通过** | 容器 / 网络 / 具名卷 `pgdata` 全部移除 |
| `docker compose up -d` | ❌ **app 容器起不来** | app 永远停在 `Created`；postgres 正常 `Up (healthy)` |
| `docker compose restart` | ❌ 同上被阻断 | 依赖 app 容器能起 |
| 第二次 `up -d` | ❌ 同上被阻断 | — |

**为什么说这不是本仓库的问题**（逐项排除，都做了对照实验）：

* 配置本身有效：`config` 与 `build` 都 exit 0；
* 同一套 compose 里 **postgres 服务能正常起来并 healthy** —— 说明 compose 本身能起容器；
* **镜像本身能跑**：前台 `docker run --platform linux/amd64 <镜像> node -e …`
  真的执行了，并且 entrypoint 按设计**拒绝启动**并打印
  `缺少必需的环境变量: MFA_ENCRYPTION_KEY`（fail-closed，正确行为）；
* **不是 bind mount**：用一个只去掉 `volumes` 的覆盖文件重试，同样停在 `Created`；
* **不是端口发布**：再去掉 `ports` 重试，同样停在 `Created`；
* **不是宿主模拟**：全量重启 Docker Desktop 后，amd64 模拟已恢复正常
  （前台 `docker run` 可跑）；而且**原生 arm64 构建**的镜像经 compose 起来时同样停在 `Created`；
* 更广的对照：该状态下**任何 detached 容器启动都会挂**
  （`docker run -d … node -e "setTimeout(...)"` 直接超时），
  而前台 `docker run --rm` 正常。

结论：**本机 Docker Desktop 在"由 compose/分离模式启动容器"这条路径上不可用**，
是宿主环境问题，不是仓库缺陷。因此以下项目**在本机无法验证**，如实标 **UNVERIFIED**：

* app 容器在 compose 中的实际运行；
* 容器内 entrypoint 自动执行迁移（`migrate up`）；
* compose healthcheck（`/api/health`）与端口映射 `127.0.0.1:3400:3000`；
* 容器内登录 / 接口冒烟。

> 注意：**镜像能在容器里跑**这一条在此前轮次已经验证过（`qls-e2e` 容器内跑通
> 浏览器 E2E），但那**不能**代替 compose 栈的验证 —— 这里我没有把两者混为一谈。
>
> 需要一台 Docker 正常的机器（或 x86_64 宿主）复跑：
> `docker compose --env-file .env.deploy up -d && docker compose ps`
> 期望 app 在 `start_period 20s` 后转为 healthy。
