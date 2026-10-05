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
