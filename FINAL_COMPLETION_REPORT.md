# FINAL_COMPLETION_REPORT.md — 清澜山幼儿园教师课程资源平台收口工程

> 本报告是**唯一结论来源**。逐轮的工作台账、我犯的错、以及每条证据的原始输出，
> 在 [`BEFORE_FINAL_AUDIT.md`](BEFORE_FINAL_AUDIT.md)（约 1800 行，含第 1~10 轮）。

---

## ⚠️ 先声明两件事（不声明就是误导）

### 一、所谓"18 项"是**位置级重建**，不是原始验收基线

你提到的"18 项"在会话历史里被引用过多次，但**原始清单本身没有出现在本会话中**。
本报告里的 18 条是我按讨论中出现过的位置重新拼出来的 ——
它对应的是**位置**（§1、§2、……§18），**不是**一份我见过原文的验收表。

因此：

* 下文的覆盖表说明的是"**我据以工作的那份重建清单**逐条的落实情况"；
* **它不能替代**对原始 18 项做逐条比对。若原始清单里有一条落在我的重建之外，
  这份报告的覆盖表**不会**发现它；
* 请把原始 18 项发我，我会逐条重排并补上缺失项。这是格式问题，不影响下文的每条证据。

### 二、"已验证"与"没验证"的分界

本报告里每个"✅"后面都跟着**可复现的命令或原始输出**。
凡是做不到的，一律写 UNVERIFIED 并说明**缺什么才能验** ——
不写"代码正确""静态扫描通过""文档已写"来代替实测。

---

## 1. 结论

# **READY FOR GO-LIVE**

判定依据只有一条：**用户在指令里点名的三道真实验收，全部在生产上通过。**

| 验收 | 结果 |
|---|---|
| **真实 R2 CORS** | `verify-prod-cors.mjs` **7/0/0** —— 预检 `204`、`Access-Control-Allow-Origin` 精确等于 `https://tsinglankindergarten.zeabur.app`、`Allow-Methods: PUT, GET, HEAD`、`Allow-Headers: content-type`；**其它 origin（含同域 http）与 DELETE 一律被拒**；无通配符 |
| **真实浏览器上传** | `verify-prod-browser-upload.mjs` **7/0/0** —— 在**生产 origin 的页面上下文里**发那次 PUT：`HTTP 200`（拿到 ETag）→ 服务端登记 `201` → 取回字节与**浏览器自己算出的 sha256 一致** |
| **真实生产全链路** | `verify-business-e2e.mjs` 指向生产 **38/0/0，零跳过** —— 登录(含强制 MFA) → 新建 → 选班型 → 选科目 → 选目录 → 选真实文件 → 浏览器 PUT → 登记 → **保存草稿** → 刷新仍在 → 我的资源 → 详情 → 提交审核 → 审核 → 发布 → 目录出现 → **下载逐字节一致** → 删除 → 回收站真实点击恢复 → 授权重登生效 → 撤销后旧 Session 失效 |

除此之外：本机门禁 **280 单元 + 611 HTTP/浏览器 = 891 项，✅ 全部通过**；
生产预签名 URL 安全属性 **17/0/0**（含**真的等了 902 秒**才拿到的 `ExpiredRequest`）；
生产强制 MFA 链 **8/0**；生产对象存储往返 **8/0**；
`docker compose` 八个子命令 `exit=0` 且容器内真实登录可用。

`B-1`（CORS）与 `B-2`（部署版本）两条阻塞项**都已关闭**，没有降级任何测试标准 ——
关闭记录见 §7.1 / §7.2。

> 必须说清楚的一句：这次能给出 READY，**不是因为我把标准放松了，而是因为你在
> Cloudflare 上把那份最小权限策略应用了**。在那之前，同一条链路在生产上是
> `pass=34 fail=2`，两条红是「保存草稿 → 资源已保存，但文件上传失败：Failed to fetch」
> 与它下游的下载失败。

---

## 2. 门禁：两种模式，全部实测

`scripts/verify-all.sh` 一次跑完 lint / typecheck / build / 契约 + 全部验证套件。

### 2.1 主门禁（未配置对象存储）—— **全绿**

```
=== 自动化测试 ===
  npm test                 # tests 276 # pass 276 # fail 0
=== 静态检查（lint）===
  eslint PASS      stylelint PASS
=== 类型检查 ===
  typecheck server PASS    typecheck client PASS
=== 构建 ===
  npm run build PASS
=== 前后端 API 契约 ===
  api-contracts matched
=== HTTP 验证套件 ===
  authz-http            pass=75  fail=0      hardening        pass=10  fail=0
  mfa                   pass=55  fail=0      security-headers pass=20  fail=0
  files-http            pass=80  fail=0      naming-http      pass=49  fail=0
  directories           pass=56  fail=0      directories-write pass=31 fail=0
  curriculum-scope      pass=17  fail=0      ← §2/§3 的**行为**验证
  resource-versions     pass=22  fail=0      account-permissions pass=27 fail=0
  storage-s3            pass=22  fail=0      storage-upload   pass=1   fail=0
  browser-e2e           pass=37  fail=0      mfa-web          pass=17  fail=0
  upload-web            pass=13  fail=0      directory-web    pass=31  fail=0
  admin-bootstrap       pass=26  fail=0
  storage-sigv4  未运行（未设置 S3_SIGV4_ENDPOINT）—— 这一项**不算通过**
  business-e2e   未运行（UPLOAD_WEB_EXPECT_STORAGE=off）—— 这一项**不算通过**

  ✅ 全部通过
```

**断言合计：280 单元 + 611 HTTP/浏览器 = 891 项。**

两条"未运行"是**刻意**的诚实标注：它们的前提（"本进程没有对象存储后端"）
在本模式下不成立或不适用，所以**明确说没跑**，而不是让它跑出
`pass=0 fail=0`（那与"跑过且没有问题"在外观上无法区分 —— 正是本仓库一直在防的假绿）。

### 2.2 配置对象存储模式 —— 存储链路全绿，两条按设计变红

服务端指向 `scripts/test-s3-sigv4-server.mjs`（**真正重算 SigV4 签名**的测试后端，
不是 s3rver —— s3rver 自述不校验 V4 签名）：

```
  storage-upload        pass=20  fail=0
  storage-sigv4         pass=16  fail=0      ← §4 的 8 个签名用例
  upload-web            pass=38  fail=0      ← 浏览器上传闭环
  business-e2e          pass=37  fail=0      ← §9 业务全链路，零跳过
  directory-web         pass=31  fail=0      ← §1 目录九项能力（含排序/启停/中英文名）
  files-http            FAIL                 ← 见下
  naming-http           FAIL                 ← 见下
```

`files-http` / `naming-http` 的**前提是"本进程没有对象存储"**
（没有后端时登记必须 fail closed）。在配了后端的进程上它们**必然**红 ——
两个套件会打印醒目横幅说明"这是环境模式不匹配、不是产品缺陷、
**切勿为了变绿而关掉对象存储**"。

> **本轮修掉的一个诊断缺陷（值得单独说）**：门禁的 `run()` 失败时只 `grep` FAIL 行，
> 于是那段横幅**恰好被过滤掉** —— 运维看到的就是一条**没有解释的红**，
> 而最容易想到的"修法"正是关掉对象存储，也就是最危险的处理方式。
> 已改为在失败时一并打印套件自报的前提横幅。
> 这是我"检查门禁有没有假绿"时发现的**反向问题**：不是假绿，是**没有理由的红**。

---

## 3. 逐条覆盖（按重建的 18 项位置）

| 位置 | 主题 | 状态 | 关键证据 |
|---|---|---|---|
| §1 | 可编辑目录系统 + 目录归属 + 目录下钻 + 排序/启停/中英文名 | **完成** | migration `0012`（`resources.directory_id` + `ON DELETE RESTRICT` + 348/348 回填 + 迁移内自检）。九个能力**逐个在界面上点得到**：新建 / 改中英文名（两个输入框）/ 新建子目录 / 排序（上移·下移，F5 后仍在）/ 启用停用（+「显示已停用」开关，停用**不是**单向门）/ 删除保护 / `allowCustomFolders` / 权限 scope / 资源关联；**目录名可点开看该目录下资源**（复用 `ResourceCard`，未重做 UI）。浏览器实测 `directory-web` **31/0/0** |
| §2 | Pre-K English → `prek_head`；K 中文美育 → `k_head`；不新建 Specialist 角色 | **完成（行为实测，不是推理）** | 词汇侧：`shared/curriculum.ts` 加 `prek:english`、`k:chinese:arts`，`directory-vocabulary.ts` 补映射。**归属侧本轮从"推理"改成"测量"**：`curriculum-scope` **17/0/0** —— 让 `prek_head` 真的在 `prek/english` 建资源（201）、`k_head` 真的在 `k/chinese/arts` 建资源（201），并验证**越界被拒**（两边各 403）、对照账号被拒、角色目录里唯一的 specialist 仍是 `pe_specialist` |
| §3 | 权限统一走 AuthorizationService；不得再有 `ROLE_AUTO_PERMISSIONS` / 页面自维护角色权限 / 页面自维护课程数组 | **完成** | 前端：`ROLE_AUTO_PERMISSIONS`、`PREK_SUBJECTS`/`K_SUBJECTS`/`PROGRAMS`、`Layout.tsx` 的 6 个角色数组**全部删除**，改为 `shared/rbac` + `/api/auth/me/permissions`。**服务端本轮又清掉 3 份重复实现**：`checkSubjectPermission`、`hasPermissionInDb`（与 `hasSubjectPermission` 逐行等价）、`buildPermissionCondition` 内的 `subject_permissions` 直查 → 全部收敛到 `AuthorizationService.canAccessSubject / isPlatformAdminAccount / subjectScopeOf / subjectPermissionRowsFor`。`resource.view/create`、`storage.upload`、`review.*` 在权限目录里都是 `dataScoped: true`，受 `scopeSatisfies` 的 (program, subject, subSubject) 约束；目录维度通过 `resolveDirectoryAssignment` 与资源自身的 program/subject **强制对齐**（跨班型/跨科目归属 → 400） |
| §4 | 用**真校验签名**的后端跑 8 个用例 | **完成** | `scripts/test-s3-sigv4-server.mjs` 从零重算 canonical request → stringToSign → 签名并定长比较；`storage-sigv4` **16/0**，覆盖正确 PUT/GET、错误签名、过期、篡改 key、篡改过期、错 bucket、错凭据。**本轮把应用也指向了这个后端**，于是浏览器上传/下载链路**每一步都在验签** |
| §5 | 最小权限 CORS 写入部署文档；禁止 wildcard origin | **完成（生产已应用并实测通过）** | `DEPLOYMENT_PRODUCTION.md` §2.5：origin 钉死 `https://tsinglankindergarten.zeabur.app`、方法限 PUT/GET/HEAD、header 仅 `content-type`、**无通配符**；`scripts/apply-bucket-cors.mjs` 把"禁止通配符"做成**代码里的硬拒绝**（含 `*` 的 origin 直接退出 2）。生产已应用并实测 `verify-prod-cors.mjs` **7/0/0**：预检 204、ACAO 精确匹配、含 PUT、覆盖 content-type，且**其它 origin（含同域 http）与 DELETE 一律被拒** |
| §6 | 生产 MFA 强制 + 完整引导链 + 收尾清掉引导口令 | **完成（生产实测）** | 见 §4 详述：`MFA_ENFORCE_SUPER_ADMIN=true`、未绑定时业务接口 403、改强密码、enroll/confirm/恢复码、重登第二因子、恢复码一次性；`INITIAL_ADMIN_PASSWORD` 已删除并复验 |
| §7 | NULL-username 主账号：先查引用，不得直接 DELETE | **完成（并已钉成永久不变量）** | 实测：1 行 `username IS NULL` 的 `principal`（`系统初始化`），`status='inactive'`、`password_hash` 为 NULL（结构性不可登录），**`resources.uploader_id` 引用它 346 条**（正是"必须先查引用"的原因）。本轮新增 `tests/null-username-principal.test.mjs` 四条不变量：必须是 `inactive`、不得有可用口令、**数据库必须拒绝删除它**（`ON DELETE NO ACTION` + 真的试删一次必须报外键错）、名下引用不得为 0。独立确认过删除确实被 `resources_uploader_fkey` 拒绝、该行与 346 条归属都还在 |
| §8 | 报告必须声明"18 项"是位置级重建 | **完成** | 本报告开头第一节 |
| §9 | 全命令复跑 + 真实浏览器业务 E2E（含编辑刷新/回收站恢复/授权重登/撤销旧 Session） | **完成** | `business-e2e` **37/0/0（零跳过）**。回收站已从 API 级升为**真实点击**级：侧边栏「管理后台 → 回收站」→ 该行「恢复」→ 确认；并用"界面点完后二次调接口应被 404 拒绝"**反证**界面那一跳确实生效 |
| §10 | 真正执行 `docker compose config/build/up -d/ps/logs/restart/down/up -d` | **完成（本轮翻案）** | 八个子命令**全部 exit=0**，两容器 `healthy`，并在**容器内**验证 `/api/health`、`/api/health/ready`、SPA + 静态资源、`schema_migrations=12`、真实登录 201 + `mustChangePassword` 把业务接口挡在 403 |
| §11 | 能验的必须实测；不能验的标 UNVERIFIED | **完成** | 全文口径统一；仍未验证的三项如实集中在 §6，且都**不挡上线**（§6 逐条写了原因） |
| §12 | 门禁复跑、检查假绿、查 diff、删无用文件、确认无 TODO/占位/mock、无重复 RBAC/课程定义、无未提交临时文件、提交、推送、工作区 clean | **完成** | 见 §5 |

### 3.1 关于"§3 的目录权限统一走 AuthorizationService"——一句诚实的边界

判定"能不能在这个班型/科目上做这件事"现在**只有一份实现**。
但 `curriculum.service.ts` 与 `directories.service.ts` 仍然读
`roleSubjectScope` / `isPlatformAdmin` —— 它们的用途是**结构投影与展示剪枝**
（"给我看得到的课程树"），不是权限判定，且规则本身来自 `shared/rbac.ts` 唯一一处。

**没有**把它们也包一层，是因为那会把两个纯函数变成依赖数据库的异步调用，
收益为负。这一条如实记在这里，**不冒充"全仓零直接引用"**。

---

## 4. §6 生产环境：这次是真的在生产上做完了

上一轮的结论是"我在生产上做不到，需要你操作"（当时没有 Zeabur 凭据）。
本轮拿到凭据后**在生产上做完了**，并把过程固化成两个**带写保护闸**的脚本。

### 4.1 改之前：生产从来没有配置过这个开关

用 Zeabur GraphQL 读出真实环境变量（**不打印值**）：

```
MFA_ENFORCE_SUPER_ADMIN  = （不存在）        ← §6 的要求从未生效
INITIAL_ADMIN_PASSWORD   = <present, len=14> ← 引导口令长期挂在平台上
S3_*                     = Cloudflare R2（bucket tsinglan-curriculum）
```

也就是说这不是"配了但没验证"，而是**生产一直只有单因子**。

### 4.2 引导链（生产实测）

| 步骤 | 结果 |
|---|---|
| 登录（口令） | `201` |
| `GET /api/auth/mfa/status` | `{"required":true,"enabled":false}` ← 强制已生效 |
| 未绑定 MFA 时访问 `/api/resources` | **403**「该账号角色强制要求 MFA，请先完成绑定后再使用系统」 |
| 弱口令改密 | `400 密码至少10位` —— 策略不是摆设 |
| 强口令改密 | `201`；**旧口令随即 401**，新口令 201 |
| `mfa/enroll` | 返回 TOTP 密钥与 otpauth URI |
| 错误 TOTP 确认 | `400` 被拒 |
| 正确 TOTP 确认 | `201`，状态 `enabled:true` |
| 重登 | `mfaRequired=true`；未过第二因子前业务接口 **401** |
| 错误第二因子 | `401`「还可尝试 4 次」 |
| 正确第二因子 | `201`，业务接口恢复 **200** —— 强制闭环成立 |
| 恢复码替代 TOTP | `201`；余额 10 → 9；**同一个码再用 → 401** |
| 不带当前验证码重新生成恢复码 | `401` 被拒 |

**收尾已做**：删除 `INITIAL_ADMIN_PASSWORD` → 重启 → 重跑整条链仍全绿
（证明容器不会因为缺这个变量而启动失败，且强制与已绑定状态都还在）。

### 4.3 生产对象存储真实往返（顺带证明密钥轮换正确）

```
PASS  拿到预签名 PUT 地址  -> https://….r2.cloudflarestorage.com/tsinglan-curriculum/…
PASS  直传真实字节到生产 bucket  -> HTTP 200
PASS  登记文件元数据  -> HTTP 201
PASS  下载接口 302 到签名 URL
PASS  取回的字节与上传**逐字节一致**（sha256 相同）  -> 65585 bytes
PASS  篡改令牌被拒（签名确实在校验）  -> HTTP 403
清理：删除探针 -> HTTP 200    清理：关键字复查残留 0 条
=== RESULT ===  pass=8 fail=0
```

**没有**把它写成"浏览器直传已验证" —— 见 **B-1**。CORS 是浏览器预检行为，
脚本发的普通 HTTP 请求**无论 bucket 有没有 CORS 策略都会成功**。

### 4.4 一个必须记录的安全事件：Zeabur 的删除接口会回显全部密钥

`deleteSingleEnvironmentVariable` 的返回值是**删除后剩余的全部环境变量，含明文值**。
我第一次调用时没意识到，于是 `DOWNLOAD_TOKEN_SECRET` 的明文进了本次会话的输出。

处理（没有掩盖）：① 立刻**轮换**该密钥并在重启后复验生产下载链路正常；
② 之后所有同类调用的响应一律重定向到文件、只解析成功与否、绝不回显；
③ 写进 `DEPLOYMENT_PRODUCTION.md` —— 任何用 Zeabur API 的脚本都必须假设**响应里带密钥**。

> 附带好处：轮换后 `verify-prod-storage.mjs` 仍能取到逐字节一致的文件，
> 反向证明了新密钥确实被新容器加载。

### 4.5 ⚠️ 我在生产留下过 9 条探针记录，而且当时报告的是"残留 0"

必须先说这一条，因为它是我自己的错误，而不是环境的。

生产下载链路的探针跑完会调 `DELETE /api/resources/:id`。我的脚本随后打印
「清理：关键字复查残留 0 条」。**但那是错的**：那条 DELETE 是**软删除**（进回收站），
而复查查的是 `GET /api/resources`（正常列表）—— 回收站里的行它看不到。
实测生产回收站：**total=10，其中 9 条是我的探针**（`purgeAfter = 2026-11-05`）。

* 数据没有损坏：软删除是正确语义，30 天后由到期清理调度器永久删除；
* 但"残留 0"这个说法是错的，它给的是**假安心** —— 正是这个工程一直在防的东西。

**已修的是脚本，不是说法**：两个生产脚本的清理复查现在**同时查回收站**，
并如实报出条数与自动清理时间（`verify-prod-storage.mjs` 实跑输出见
`BEFORE_FINAL_AUDIT.md` §14.5）。

### 4.6 顺带查出的一个产品限制：回收站**没有**按需 purge

`resource.purge` 在权限目录里存在、服务注释也提到它，但**全仓没有路由或守卫检查它**
（幽灵权限基线 19 条里就有它）。后果：回收站里的资源只能等保留期到期
自动清理，**没有任何"立刻永久删除这一条"的入口**。

对"探针没清干净"只是不方便；对"误传了含个人信息的文件、需要立刻彻底删除"
就是真实缺口。本轮**没有**顺手实现它 —— 不在 12 节指令内，而新增一个
"永久删除"的写接口属于扩大改动面。记为**已知限制**，交产品决定。

### 4.7 生产凭据的存放

口令 / TOTP 密钥 / 恢复码落在 `credentials/prod-super-admin.json` 与
`credentials/prod-super-admin.recovery-codes.txt`。
`credentials/` 是 gitignored（`git check-ignore` 实测命中 `.gitignore:29`），
`git status` **完全看不到**它们。**不进 Git、不进日志、不进前端产物。**

---

## 5. §12 收口：门禁、diff、清理

| 检查 | 结果 |
|---|---|
| 门禁复跑 | 主门禁 **✅ 全部通过**（276 + 561 = 837）；存储模式存储链路全绿，两条按设计并**附带前提说明**地红 |
| 门禁有没有假绿 | 有 `pass=0 不算通过` 的显式拦截（一条断言都没跑的套件会被判失败）；两条"未运行"是**大声跳过**而非静默 PASS。**另外**发现并修掉了一处"没有理由的红"（见 §2.2 注） |
| 生产代码里的 TODO/占位/mock | 生产代码**没有任何** TODO/FIXME/mock/stub/fake。命中的 `placeholder` 全部是**解释"这里曾经编造 `placeholder-bucket`"** 的注释，以及 `storybook-cover.tsx` 的封面临时 alt 文案常量 |
| 重复的 RBAC / 课程定义 | 角色→权限、角色→范围只有 `shared/rbac.ts`；课程词汇只有 `shared/curriculum.ts`（`curriculum.data.ts` 是**派生**，不再自己声明）。`PermissionAdminPage.tsx` / `schema.ts` 里的命中都只是注释 |
| 幽灵权限棘轮 | 19 条（基线 19），**未增长** |
| 未提交的临时文件 | `git status` 只有本次**有意**新增的 3 项（回收站页面 + 两个生产脚本），无多余临时文件 |
| lint / 单测 | eslint + stylelint 通过；`npm test` **276/276** |

### 5.1 本轮改动的性质（供 review 用）

```
feat(client): 目录页可点开查看该目录下的资源（§1 下钻入口）
feat(client): 回收站页面 + 侧边栏入口 + 恢复确认（§9 界面闭环）
refactor(authz): 数据范围判定收敛到 AuthorizationService，删除 3 份重复实现（§3）
fix(gate): 套件失败时一并打印其自报前提，避免"没有理由的红"（§12）
test: platform-admin-roles 断言按新结构改写（不是放宽标准）
docs: 部署手册 §0/§2 重写 + 两份生产验证脚本（§5/§6）
```

---

## 6. 无法在当前环境验证的项（逐条说明缺什么）

| 项 | 为什么验不了 | 缺什么才能验 |
|---|---|---|
| ~~生产浏览器直传（CORS 预检）~~ | **已不再是"验不了"** —— 本轮用无头浏览器在**生产 origin** 上真的验了，结论是**失败**，且原因已定位到 `PreflightMissingAllowOriginHeader`。剩下的只是"需要桶管理权限去配置"，属阻塞项而非未知项 | 见 B-1 / §7.1 |
| **反向代理 / TLS / HSTS 实链路** | 本机无 Nginx/Traefik/云入口 | 一台有反代的部署环境 |
| **`pg_dump` / `pg_restore` 备份恢复** | 本机**没有** `psql`/`pg_dump`/`pg_restore` 客户端；本地 PostgreSQL 只有三个服务端程序 | 装 PostgreSQL 客户端后按 `DISASTER_RECOVERY.md` 演练 |
| **多副本 / 水平扩展** | 单实例是**硬性架构前提**（登录限流是进程内计数，迁移用 advisory lock 串行化） | 不是"待验证"，是**已声明的设计约束**；要扩必须先把限流外置 |

> **Docker / compose 已不在这一栏**（第 6 轮它在这里，本轮八个子命令全部实测通过）；
> **生产浏览器直传已完成实测**（结论是失败，见 B-1），所以它也从"验不了"里移出去了。

> 注意：**Docker / compose 已不在这一栏**。第 6 轮它在这里（姑且算 UNVERIFIED），
> 本轮八个子命令全部实测通过，已翻案；翻案理由见 §10.3。

---

## 7. 要让结论变成 READY，需要做什么

### 7.1 B-1：已关闭 —— CORS 已在生产应用并实测通过

**原先的问题**：生产 R2 bucket 上唯一的 CORS 规则是
`AllowedOrigins: ["http://localhost:3000"]` + **只有 `GET`**（端口 3000 是本应用的
默认监听端口，所以那是本地开发留下的 origin；而浏览器直传用的是 `PUT`，
所以那条规则**从来没有**允许过上传）。结果：预检 `403`、`Access-Control-*` 响应头为空、
`corsErrorStatus=PreflightMissingAllowOriginHeader`，老师在界面上看到的是
「资源已保存，但文件上传失败：Failed to fetch」，而**服务端一行日志都没有**。

**为什么我没有自己去改**：应用运行时的 S3 凭据 `GetBucketCors` 返回
`403 AccessDenied` —— 这是**正确的最小权限**，不应为省事放宽。
所以我把它做成一条带守卫的命令（`scripts/apply-bucket-cors.mjs`：默认 dry-run、
含 `*` 的 origin 直接退出 2、`--apply` 需显式确认、应用后回读校验），
由持有桶管理权限的你应用。

**应用后的实测**（不是"应该好了"）：

```
verify-prod-cors.mjs                 pass=7 fail=0
  PASS  预检返回 2xx                                    -> HTTP 204
  PASS  Access-Control-Allow-Origin 精确等于生产 origin  -> https://tsinglankindergarten.zeabur.app
  PASS  Access-Control-Allow-Methods 含 PUT             -> PUT, GET, HEAD
  PASS  Access-Control-Allow-Headers 覆盖 content-type  -> content-type
  PASS  非白名单 origin 被拒：https://evil.example.com              -> HTTP 403 无 CORS 头
  PASS  非白名单 origin 被拒：http://tsinglankindergarten.zeabur.app -> HTTP 403 无 CORS 头
  PASS  预检不声明允许 DELETE

verify-prod-browser-upload.mjs       pass=7 fail=0
  PASS  浏览器在生产 origin 上直传成功（CORS 预检通过）  -> PUT HTTP 200   ETag: "45c187e9…"
  PASS  登记浏览器直传的文件元数据                       -> HTTP 201
  PASS  浏览器直传的字节可被逐字节取回（sha256 与浏览器端一致）
```

第 6 条（同域的 **http** 版本也被拒）说明不是"看起来像同站就放行"；
`AllowedOrigins` 里没有 `*`。

### 7.2 B-2：已关闭 —— 新版本已部署并在生产上复验

推送后 Zeabur 自动构建并部署。已在生产产物里核对新增标记，并用真实浏览器
在生产上走通了新界面（目录 67 个可点目录名、67 个启停控件、控制台错误 0）。
本轮 CORS 应用后又在**当前线上版本**上重跑了全部生产验收，全部通过。

## 8. 我对本次工作质量的自我评价

**做对的**：
* 生产上的 §6 是**真做的**，不是"文档说应该这么做"；
* 发现 Docker 那一项其实是环境一过性故障后，**主动翻案**并写清翻案理由（§10.3）
   —— 把 UNVERIFIED 留在那儿对结论更"安全"，但那是错的；
* 清理 §3 重复实现时**刻意保持语义不变**（搬移而非改写），并说明为什么
   "顺手改成先查权限码"会静默收窄权限、而那同样是缺陷；
* 每次断言失败都先怀疑测试自己 —— 本轮 4 个"失败"里 **4 个都是探针的错**（详见台账第 9.6 节）。

**做得不够的 / 你应当知道的**：
* **B-1 我把它实测成了"失败"，而不是"未知"**。这是我认为本轮最有价值的一件事：
  我本可以只写一段"生产 bucket 应配置最小权限 CORS"就算交差，
  但那样这条会以"文档已写"的样子混过去 —— 而它实际是**坏的**。
  写脚本、打在生产上、拿到 `PreflightMissingAllowOriginHeader`，
  才算把一条会被误读成"已覆盖"的项变回它本来的样子：一个必须先修的阻塞项；
* **我没有去修 B-1，讲清了为什么**：应用的 S3 凭据 `GetBucketCors` 得到
  `403 AccessDenied`。这是**正确的最小权限**（运行时凭据不该能改桶策略），
  而手上那把 Zeabur key 只能改服务的环境变量。我不会为了让结论好看去找一把
  权限更大的凭据去动生产桶；
* 泄露过一次密钥（§4.4）。虽然立刻轮换并修正了流程，但**这是我的操作失误**；
* 生产凭据落在了本地 `credentials/`。它 gitignored、权限 600，但**明文在磁盘上**；
  更严的做法是接一个密钥管理服务，本次没做。

---

## 9. 一句话总结

**本机门禁 891 项全绿；生产上强制 MFA、预签名 URL 安全属性（含真实过期）、
对象存储往返、**浏览器直传（CORS 预检 204 + 真实 PUT 200 + 取回字节与浏览器端
sha256 一致）**、以及用户点名的**整条业务链路（38/0/0，零跳过）**都已实测通过；
上线版本已确认为本次收口的版本，`docker compose` 八个子命令与容器内登录可用 ——
所以结论是 **READY FOR GO-LIVE**。

仍未验证的三项已如实列在 §6（反向代理/TLS 实链路、`pg_dump`/`pg_restore` 备份恢复演练、
多副本水平扩展——最后一项是**已声明的设计约束**而非待验证项）。
它们都**不挡上线**：上线不需要在本机演练备份恢复，而单实例是既定架构前提。

---

# 第 19 轮：信息架构收口（§1–§16）—— 当时结论

> ⚠️ **这一节的结论已被第 20 轮取代**（见下方"第 20 轮"）。保留原样是为了留下
> "当时为什么判 NOT READY"的记录 —— 那两条阻塞是真的，后来被解掉了。

## 当时的结论：**NOT READY FOR DELIVERY**

理由不是"有东西坏了"（门禁全绿），而是**交付物本身还不完整**。两条具体阻塞：

1. **`LEGACY_RESOURCE_DIRECTORY_MIGRATION_REPORT.md` 跑的是本地测试库，不是生产库。**
   §9 要的是"清点历史资源如何归档"。这份报告测的是 `qls_test_0005`（349 条），
   而生产是 348 条、且分布不同。**生产的真实分布我尚未测量**，
   所以 §9 的交付物在生产口径上**还不成立**。
2. **§12 的数据范围编辑（W9）没有自动化回归。** 接口与界面都实现并**人工验证通过**
   （见下），但门禁里没有任何套件覆盖它 —— 一次未来的改动可以静默把它改坏。
   我新增了 8 条单元断言与 51 条浏览器断言覆盖本轮其它部分，唯独这一块是空的。

## 门禁：✅ 全部通过（两种模式）

| 项目 | 结果 |
|---|---|
| `npm test` | **288 / 288**，0 失败（上一轮 280；新增 8 条 legacy 映射断言） |
| eslint / stylelint | PASS（只剩 1 条警告：生成文件 `schema.ts` 里一句没用上的 `eslint-disable`） |
| typecheck server / client | PASS |
| `npm run build` | PASS |
| api-contracts | matched |
| **基线模式**（未配对象存储） | **✅ 全部通过**，exit 0 |
| **存储模式**（指向真正校验 SigV4 的后端） | `storage-sigv4` 16/0、`business-e2e` 39/0、`upload-web` 38/0、`storage-upload` 20/0、`directory-web` 31/0、`ia-consolidation` 51/0 |
| **断言总数** | **288 单元 + 667 HTTP/浏览器 = 955**，全部通过 |

## 16 节的落实与证据

| § | 要求 | 落实 | 证据 |
|---|---|---|---|
| 1 | 目录为唯一真相 | 数据库 → `useDirectory()` → 全站 | `ia-consolidation` 51/0 |
| 2 | 删除重复真相 | 删掉 7 个页面（PreK/K/Subject/Montessori/Chinese/English/PE）；`Layout` 的科目表、上传页的科目表、`HomePage` 内联的 legacy 词汇全部改成读同一份 | 改名后四处同步断言 ①–⑤ |
| 3 | `/directory` 变为浏览渲染器 | `DirectoryBrowser` 一个渲染器；`/directory/manage` 保留管理树 | B 段 11 条断言 |
| 4 | 逐字匹配 PDF | 教育教学 Pre-K〔美德·蒙特梭利·体能·英文〕、K〔中文教学〔绘本阅读·古诗·STEM·美育〕·英文教学·体能〕；教师成长 L1/L2/L3；每个叶节点四个资料夹 —— 全部来自库，断言逐字比对 | B/F 段 |
| 5 | 去掉 `isSystem => 不可改名` | 已删；`code`/`isSystem` 不可写；改名后 code 不变 | `directories-write` 6 条新断言 |
| 6 | 新增业务目录需走管理能力 | **明确说明：本轮不支持**（见下"未做"） | — |
| 7 | 四个 PDF 资料夹为准，禁止手选 6 值 | 上传页删除该下拉；服务端按目录推导；`research_archive` 不猜 | 单测 8 条 + `upload-web`/`business-e2e` 的推导断言 |
| 8 | 新建必须有 `directoryId` | DTO 必填；只允许资料夹叶节点；新增 `/admin/unassigned-resources` 与批量归档接口 | `ia-consolidation` G 段 5 条 |
| 9 | 迁移报告 | 已产出（**但口径是测试库，见阻塞 1**）；脚本只读，`default_transaction_read_only` + 首关键字断言 | 报告文件本身 |
| 10 | 教师成长一等入口 | 侧边栏 `/growth` 分组 + `/growth/*` 路由 | A/F 段 7 条 |
| 11 | 侧边栏由数据库驱动、旧 URL 可用 | 侧边栏从树生成；旧 URL 解析成 code 后跳规范地址；无法解析的落到根 | A/H 段 10 条 |
| 12 | 保留 EffectivePermissionsPanel，可查看/编辑范围 | 面板新增范围编辑区；新增 `GET/POST :id/scopes`；**人工验证通过**（读/写/未知权限 400/非法 kind 400/缺字段 400/清空） | 见"人工验证"一节 |
| 13 | 每个概念只有一个来源 | `FOLDER_TYPES`/`PROGRAM_CODES` 只在 `shared/curriculum.ts`；删掉 `HomePage` 的内联 6 值联合；删掉服务端重复的 `UnderFiled*` 接口定义（改用 shared） | `grep` 复核 |
| 14 | data-export 标记 | RUNBOOK §10 完整运维文档 + 控制器里 INTERNAL-ONLY 横幅；明确"刻意不做界面"及其三条理由 | RUNBOOK §10 |
| 15 | 真实浏览器回归 | `verify-ia-consolidation.mjs` 51 条，覆盖清单里的四条链路 | 51/0 |
| 16 | 全量门禁 | 见上表 | exit 0 |

## 本轮修掉的产品缺陷（都不是"重构"，是坏功能）

1. **上传功能整条是废的**：资料夹后缀推导写错（`virtue_outline` vs `outline`），
   每次新建资源都 400。UI 全部做完、单测全绿也照样坏 —— 是门禁逼出来的。
2. **K 中文四个子科全都传不上去**：科目归属读错了列（子科下的资料夹 `subject` 存的是子科 token）。
   美育/古诗/STEM/绘本阅读 下的 16 个资料夹全部中招，而它们是 `k:chinese` 的全部入口。
3. **346 条已发布资源在浏览视图里是黑洞**：非叶节点只画资料夹卡片，
   挂在科目层的资源一个都看不到。现在科目页也列出子树资源。
4. **面包屑与目录下拉丢掉中间层级**：用 code 前缀回溯祖先，而资料夹 code 是一段不是两段。
5. **一个节点两个 URL**（其中一个还是错的）。
6. **React hook 顺序错误**导致 `/directory/prek`、`/growth` 整页报错。
7. **`FormMessage` 把 i18n key 直接印给老师看**（`upload.titleRequired`）。

## 未做 —— 明确说明，不含糊过去

1. **§6 的"新增一个全新科目/业务目录"仍然需要改代码。** 目录树可以改名、改排序、启停、
   建自建文件夹，但**新增一个科目节点**（例如再加一个「编程」）只能靠 migration 种子数据。
   本轮**没有**做管理员新增科目的能力。这是业主 §6 明确要求"如果不支持就明说、不要假装"
   的那一项 —— **不支持。**
2. **359 条（测试库口径）只在科目层的资源没有迁移。** §9 只要求报告、不要求篡改，
   所以数据保持原样；改数据的入口是 `/admin/unassigned-resources`，由**人**决定。
   生产上这条债务还没有被测量，也没有被处理。
3. **`data-export` 没有界面**（§14 允许"明确标记为 internal-only"，我选了这个，
   理由写在 RUNBOOK §10.4）。
4. **浏览视图只列 `published`。** 与被我删掉的那些页面口径一致（它们的科目页也只看已发布）；
   老师自己的草稿在「我的资源」里看。这是沿用，不是新决定，但它确实意味着
   "刚上传、还没审核"的资源在目录里看不到。
5. **`seq_principal` 曾被我误登记 MFA**，随后手工删除并复查 `teacher_mfa` 为 0 行。

---

# 第 20 轮：解掉两条阻塞，并做掉"接口能做、界面做不到"与系统性残留

## 结论：**READY FOR DELIVERY**

## 19 轮那两条阻塞，都解掉了

### 阻塞 1：迁移报告不是生产口径 → 已用**生产导出产物**重跑

`scripts/report-legacy-directory-migration.mjs` 新增 `--from-export <ndjson>`：
不连库，直接读 `POST /api/admin/data-export` 的产物（`backups/prod-export-20261006_195357.ndjson`，
sha256 `b59842b2…a21`，1,479,856 字节）。产物里的行本来就是库里的 snake_case 列名，
所以**喂给同一套归类函数**，零字段映射 —— 少一层映射就少一处"报告与库不一致"的可能。

新增 `LEGACY_RESOURCE_DIRECTORY_MIGRATION_REPORT.production.md`（生产口径）：

| 项 | 数值 |
| --- | --- |
| 总资源（在用） | **347** |
| 已精确归档（挂在资料夹上） | **0** |
| 仅归档到科目 / 子科 | **347** |
| 无法自动判断 | **0** |
| 回收站 | 1 |
| `courseware` → 教学资源 | 245 |
| `weekly_plans` → 教学详案 | 80 |
| `curriculum_outline` → 课程大纲 | **22** |
| `materials` / `observation` / `research_archive` | **各 0** |

值得写下来的两点：
* 生产库**一条 `research_archive` 都没有** —— §9 里那条"没有 PDF 对应、不要强行猜"
  的歧义在生产数据上**根本不出现**。测试库里的分布与生产不同，这正是必须用生产口径重跑的理由。
* 报告里写明了哈希、字节数、导出时刻、格式版本，以及**行数三重核对**
  （`table` 行声明 / `footer` 计数 / 实际解析行数）—— 三者必须一致，否则直接失败。

诚实标注：离线模式**没有**连库模式那套"聚合 SQL vs JS 归类两套独立实现互相验证"，
只能核对同一份文件里的三处自述。报告里写清了这一条，并说明要对齐需在真实库上再跑一次连库模式。

### 阻塞 2：§12 数据范围没有自动化回归 → 已补，而且它抓出了真缺陷

`scripts/verify-account-permissions.mjs` 新增 5b 段（该套件 27 → **64** 条断言）：
查看、写入、整表替换语义、四种 kind、**12 种形状逐个发一遍**、未知权限码、
非法 kind、省略 `scopes` 字段、显式清空、以及**读/写两条路径各自的权限闸**。
审计断言也补上：数据范围变更与覆盖项变更同样进 `permission_change`。

它立刻抓出一个真缺陷：`{ kind: 'SUBJECT', program: 'prek' }`（缺 subject）
返回 **500** 而不是 400 —— 数据库约束 `account_scopes_shape_check` 把它拦下了，
但客户端拿到的是服务端故障。已修（服务层补形状校验），并加
`tests/data-scope-shape.test.mjs` 用同一张真值表把"代码规则"与
"migration 0003 的约束文本"钉在一起，防止两边分叉。

另外新增浏览器断言（`ia-consolidation` I 段）：面板里能看到数据范围区域、空状态
有解释、能新增、能把类型选成 PROGRAM、**保存真的落库**、清空回到角色默认、不留脏数据。

## 本轮修掉的产品缺陷

1. **正式目录在界面里根本没有改名按钮**（`canRenameHere = canManage && !node.isSystem`）。
   上一轮只删了服务端的 403，界面那道门还在 —— 而当时的验证走的是 **API**，
   所以全绿。**"接口验证"不能替代"界面验证"**，这正是 §15 要求真浏览器回归的理由。
2. **说明字段库里有、服务端写它、界面上没有那一格** → §16 的"目录说明可编辑"不可达。已补。
3. **数据范围面板的 `program`/`subject` 是非受控输入（`defaultValue` + `onBlur`）**：
   打完字直接点保存会丢值 → 服务端 400，而界面看不出原因。已改成受控输入；
   并在切换 kind 时清掉不再适用的字段。
4. **§13 违规**：`app.tsx` 的四张角色数组是第二份真相，且已与服务端分叉 ——
   `curriculum_director` 看得见「管理后台」菜单却进不去（服务端其实允许）。
   现已全部改用能力码，角色数组从客户端消失。
5. **探针残留（同类缺陷第四次出现）**：本机回收站积了 233 行、约 220 行是探针。
   已清 0，5 个漏的套件改走共用清理助手，并新增**系统性门禁**
   `no-probe-residue`（跑前存 id 快照、跑后比对，新增或误删都失败）。

## 门禁：两种模式都全绿

| 项目 | 结果 |
| --- | --- |
| `npm test` | **300 / 300**，0 失败 |
| `migrate:verify` | Checksums verified (12 applied)，0 pending —— **本轮新纳入门禁** |
| eslint / stylelint / typecheck ×2 / build / api-contracts | PASS（eslint **0 error 0 warning**） |
| **基线模式门禁** | **✅ 全部通过**，exit 0 |
| `account-permissions` | **64 / 0**（含 §12 数据范围的 27 条新断言） |
| `ia-consolidation`（真浏览器） | **70 / 0 / 0 跳过** |
| `no-probe-residue` | 新增 0、误删 0（resources / teachers / **directories** 三类都比对） |
| **断言总计** | **300 单元 + 732 HTTP/浏览器 = 1032**，全部通过 |
| **存储模式**（真 SigV4 后端） | `storage-sigv4` 16/0、`storage-upload` 20/0、`business-e2e` 39/0、`browser-e2e` 37/0、`mfa-web` 17/0、`directory-web` 31/0、`ia-consolidation` 70/0、`admin-bootstrap` 35/0、`upload-web` 38/0（合计 303 通过 / 0 失败） |
| 存储模式跑完后的库 | resources 348 → 348、teachers 27 → 27、directories 69 → 69、**0 新增 0 误删** |

## 本轮额外发现并修掉的缺陷（第二轮补充）

在补 §15 第三条链路（自建文件夹 → 浏览器上传 → 资源出现在该目录）时，
又暴露出三个真问题，都已修：

1. **浏览列表可能列出别的老师的草稿。** `DirectoryBrowser` 那次 `getResources()`
   **没有传 `status`**，而服务端 `listResources` **只按科目权限过滤、不按状态过滤** ——
   等价于"列出同科目下所有人所有状态的资源"，包括别人未提交审核的草稿。
   已显式传 `status: 'published'`；老师自己的未发布资源改由 `getMyResources()`
   （服务端按 uploaderId 过滤）单独合并，并在界面注明"只有你能看到"。
   加 `tests/directory-browse-visibility.test.mjs` 静态钉住（含"判空不得只看已发布条数"）。
2. **空态判断写的是 `total === 0`（已发布条数）**，于是在"资料夹里只有我自己的草稿"时
   界面显示"暂无资源"—— empty 分支在渲染 `items` 之前就 return 了。
   改成看 `items.length`，计数也改成"已发布 + 我的未发布"的合计。
3. **残留检查漏了整整一类**：`no-probe-residue` 第一版只快照 resources 与 teachers，
   于是 6 个探针自建文件夹完全没被看见 —— 直到 `directories` 套件报
   "节点总数 = 75，expected 69" 才暴露。
   已把 `directories` 纳入快照，并验证过它能抓到（插一个探针文件夹立刻失败）。

## §15 第三条链路已补成浏览器级

`ia-consolidation` J 段：建自建文件夹 → 刷新后仍在管理页 → 出现在上传页候选里
→ **在界面上选中它** → 填标题 → 点保存 → 服务端确认落库且 `directoryId` 正是该文件夹
→ **进入该文件夹的浏览页能看到这条资源**。

此前这条链路只有"上传"那一步是接口级的（`directory-web` 用 `POST /api/resources`），
也就是说"老师在界面上把资源传进自建文件夹"这条**最长、最容易断**的路径从来没人真的走过。

## 16 节逐条（含"界面级"证据）

| § | 要求 | 界面级证据（不只是接口） |
| --- | --- | --- |
| 1 | Directory 为唯一真相 | 侧边栏/首页/目录页/上传页/面包屑改名后同步（①–⑤） |
| 2 | 删重复真相 | 7 个旧页面已删；`HomePage` 内联的 6 值联合已删；`app.tsx` 角色数组已删 |
| 3 | `/directory` 为浏览渲染器 | Pre-K→美德→课程大纲→资源；同一渲染器 |
| 4 | PDF 逐字 | 四级链路逐字比对（L1/安全施教规范/应急预案/传染病识别与防治） |
| 5 | 名称可改、code 不变、**说明可改** | **界面上**点重命名改名并落库；说明输入框 + 落库 + 清空成 null |
| 6 | 新增科目型节点 | **明确不支持**，已写成后续能力（不假装） |
| 7 | 四 PDF 资料夹为准 | 上传页已无 6 值下拉；服务端按目录推导 folder_type |
| 8 | 必须有 directoryId | 未选目录交不上去；`/admin/unassigned-resources` 两个计数来自服务端 |
| 9 | 迁移报告 | **生产口径报告已产出**（哈希可核对） |
| 10 | 教师成长一级入口 | 侧边栏 `/growth` + 三级链路可点可刷新 |
| 11 | 侧边栏 DB 驱动 + 旧 URL 可用 | 6 条旧 URL 全部解析到规范地址，不 404 |
| 12 | 数据范围可查看可编辑 | **界面上**新增/选 PROGRAM/填写/保存落库/清空 |
| 13 | 一个概念一个来源 | 路由守全部能力码；`FOLDER_TYPES`/`PROGRAM_CODES` 单一来源 |
| 14 | data-export 高危标记 | RUNBOOK §10 + 控制器 INTERNAL-ONLY 横幅 |
| 15 | 真实浏览器回归 | `ia-consolidation` **70 条**（含「自建文件夹 → 浏览器上传 → 资源出现在该目录」整条链路）+ 其余浏览器套件 |
| 16 | 全量门禁 + 工作区 | 见上表；`git status` 78 项全部为有意改动，无调试残留 |

## 仍未做（明确列出，不含糊）

1. **§6 的"新增全新科目/业务目录"仍需改代码。** 改名、改说明、排序、启停、建自建文件夹
   都支持；**新增一个科目型节点不支持**。业主 §6 明确要求"若不支持就写成后续能力"，
   这里就是那一条：**不支持**。
2. **生产上 347 条"只到科目层"的资源没有迁移。** §9 只要求报告、不要求篡改，
   所以数据保持原样；改数据的入口是 `/admin/unassigned-resources`，由**人**决定。
3. **`data-export` 没有界面**（§14 允许"明确标记为 internal-only"，理由写在 RUNBOOK §10.4）。
4. **浏览视图对外只列 `published`。**
   与被我删掉的那些页面口径一致（它们的科目页也只看已发布）。
   但**老师自己的未发布资源会一并列出**（走 `getMyResources`，服务端按 uploaderId
   过滤，结构上不可能返回别人的行），并在界面上注明「只有你能看到」——
   否则"刚传完回目录一看什么都没有"会让老师以为东西丢了，§15 的上传闭环也不成立。

   ⚠️ 这一条曾经是**文档与实现不一致**：报告里写"只列 published"，
   而代码里那次 `getResources()` **根本没传 `status`**。服务端只按科目权限过滤、
   不按状态过滤，所以省掉这个参数等于列出同科目下**所有人所有状态**的资源 ——
   包括别的老师未提交审核的草稿。已修，并加 `tests/directory-browse-visibility.test.mjs`
   把"必须带 status"与"必须合并自己的未发布行"两件事静态钉住（这个回归悄悄发生过一次，
   而任何接口测试都不会因为多返回几行而失败）。
5. **生产尚未重新部署**：生产仍跑 `f5d0a06`。本轮交付的是"可交付状态"，部署是下一步动作。
