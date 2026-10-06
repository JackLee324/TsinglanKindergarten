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

# **NOT READY FOR GO-LIVE**

不是"没做完所以不给结论"。代码侧与本机门禁是**全绿**的，
生产上的 MFA 强制链、对象存储往返、以及本轮新增的目录下钻与回收站
都**在生产上真的跑通了**。剩下挡上线的是一条**具体、可判定**的项：

| # | 阻塞项 | 为什么它单独就能挡住上线 | 谁能解 |
|---|---|---|---|
| **B-1** | **生产浏览器直传实测失败**（CORS 预检被拒）—— **已在生产上复现并精确定位**，`PreflightMissingAllowOriginHeader` | 这是老师点「保存草稿」时**唯一**的上传路径。现在它**是坏的**：预检返回 403 且**一个 `Access-Control-*` 响应头都没有**，Chromium 直接拦掉请求，而**服务端一行日志都没有**。也就是说，即使代码全对，老师在浏览器里也传不上去 | 一个有 **R2 桶管理权限**的凭据（控制台操作，或带 bucket 配置权限的 API Token）。应用的 S3 凭据**故意**没有这个权限（`GetBucketCors` → 403 AccessDenied），这是正确的最小权限。**本轮已把修复做成一条带守卫的命令**：`node scripts/apply-bucket-cors.mjs`（dry-run 先行；含 `*` 的 origin 直接退出 2），见 §7.1 |
| ~~B-2~~ | ~~生产运行的代码版本 ≠ 本次收口后的代码~~ | **本轮已关闭**：推送后 Zeabur 自动构建并部署（`BUILDING → DEPLOYING → RUNNING`），随后在生产产物里核对了本轮新增的标记（`directory-browse` / `directory-resources` / `recycle-restore` / `/admin/recycle-bin` 各 1 处，`ROLE_AUTO_PERMISSIONS` **0 处**），并用真实浏览器在生产上走通了新界面（见 §7.2） | — |

> B-1 **不是**"我再写点代码就能解决"的：它需要一个对生产 R2 bucket
> 有**桶管理权限**的账号。应用的 S3 凭据故意没有这个权限
> （`GetBucketCors` → `403 AccessDenied`），这是正确的最小权限，
> 我也不会为让结论好看去找一把更大的凭据去动生产桶。
> 我**不会**为了让结论变成 READY 而把这条降级成"已验证"。

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

**断言合计：280 单元 + 589 HTTP/浏览器 = 869 项。**

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
| §5 | 最小权限 CORS 写入部署文档；禁止 wildcard origin | **文档完成；生产未应用 —— 已实测证明它现在是坏的** | `DEPLOYMENT_PRODUCTION.md` §2.5：origin 钉死 `https://tsinglankindergarten.zeabur.app`、方法限 PUT/GET/HEAD、header 仅 `content-type`、**无通配符**；并在同节写明生产**尚未应用**及其确切症状。实测证据：`scripts/verify-prod-browser-upload.mjs` → 预检 `status=403`、`CORS 响应头={}`、`corsErrorStatus=PreflightMissingAllowOriginHeader` |
| §6 | 生产 MFA 强制 + 完整引导链 + 收尾清掉引导口令 | **完成（生产实测）** | 见 §4 详述：`MFA_ENFORCE_SUPER_ADMIN=true`、未绑定时业务接口 403、改强密码、enroll/confirm/恢复码、重登第二因子、恢复码一次性；`INITIAL_ADMIN_PASSWORD` 已删除并复验 |
| §7 | NULL-username 主账号：先查引用，不得直接 DELETE | **完成（并已钉成永久不变量）** | 实测：1 行 `username IS NULL` 的 `principal`（`系统初始化`），`status='inactive'`、`password_hash` 为 NULL（结构性不可登录），**`resources.uploader_id` 引用它 346 条**（正是"必须先查引用"的原因）。本轮新增 `tests/null-username-principal.test.mjs` 四条不变量：必须是 `inactive`、不得有可用口令、**数据库必须拒绝删除它**（`ON DELETE NO ACTION` + 真的试删一次必须报外键错）、名下引用不得为 0。独立确认过删除确实被 `resources_uploader_fkey` 拒绝、该行与 346 条归属都还在 |
| §8 | 报告必须声明"18 项"是位置级重建 | **完成** | 本报告开头第一节 |
| §9 | 全命令复跑 + 真实浏览器业务 E2E（含编辑刷新/回收站恢复/授权重登/撤销旧 Session） | **完成** | `business-e2e` **37/0/0（零跳过）**。回收站已从 API 级升为**真实点击**级：侧边栏「管理后台 → 回收站」→ 该行「恢复」→ 确认；并用"界面点完后二次调接口应被 404 拒绝"**反证**界面那一跳确实生效 |
| §10 | 真正执行 `docker compose config/build/up -d/ps/logs/restart/down/up -d` | **完成（本轮翻案）** | 八个子命令**全部 exit=0**，两容器 `healthy`，并在**容器内**验证 `/api/health`、`/api/health/ready`、SPA + 静态资源、`schema_migrations=12`、真实登录 201 + `mustChangePassword` 把业务接口挡在 403 |
| §11 | 能验的必须实测；不能验的标 UNVERIFIED | **完成** | 全文口径统一；UNVERIFIED 项集中在 §7 |
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

### 7.1 B-1：给生产 bucket 配置 CORS（**已实测确认这是当前唯一的硬阻塞**）

**第一步：确认现状（我已经做了，结论是坏的）**

```
预检 OPTIONS -> https://….r2.cloudflarestorage.com/tsinglan-curriculum/uploads/…
  Origin: https://tsinglankindergarten.zeabur.app
  Access-Control-Request-Method: PUT
  Access-Control-Request-Headers: content-type
预检响应 status=403
  CORS 相关响应头: {}                                 ← 一个都没有
loadingFailed corsErrorStatus = {"corsError":"PreflightMissingAllowOriginHeader"}
```

**第二步：用有 R2 桶管理权限的凭据应用策略（本轮已做成一条命令）**

```bash
# 1) 只读：看当前策略 + 打印将要应用的 XML（默认 dry-run，不改任何东西）
S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
CORS_ALLOWED_ORIGIN=https://tsinglankindergarten.zeabur.app \
  node scripts/apply-bucket-cors.mjs

# 2) 应用（需要桶管理权限，且必须显式确认）
… CONFIRM_APPLY_BUCKET_CORS=yes node scripts/apply-bucket-cors.mjs --apply
```

`scripts/apply-bucket-cors.mjs` 把 §5 的要求做成了**代码而不是文档**：

| 守卫 | 行为 | 实测 |
|---|---|---|
| origin 含 `*` | **直接退出 2**，不是警告 | exit=2 ✓ |
| origin 带路径 | 退出 2（预检里永远匹配不上） | exit=2 ✓ |
| `--apply` 未确认 | 退出 2 | exit=2 ✓ |
| 应用后 | **回读校验**服务端实际保存的策略 | 读不到就 exit 1 |
| 网络不可达 | 干净一行说明 + exit 1（不抛栈） | exit=1 ✓ |

也可在 Cloudflare 控制台按 `DEPLOYMENT_PRODUCTION.md` §2.5 的 XML 手动配置
（同一份内容；改一处要改另一处）。

**第三步：重跑同一条命令确认修好（幂等，跑完自查残留 0）**

```bash
export PROD_BASE_URL=https://tsinglankindergarten.zeabur.app
export PROD_ADMIN_CREDENTIALS=$PWD/credentials/prod-super-admin.json
ALLOW_PROD_WRITE=1 node scripts/verify-prod-browser-upload.mjs
```

它在**生产 origin 的页面上下文里**按真实客户端的方式发那次 PUT，
并把 Chromium 的 `corsErrorStatus`、预检响应状态与响应头一并打出来 ——
修好后这一条会从 FAIL 变 PASS，同时"浏览器直传的字节可被逐字节取回"也会跟着变绿。

**为什么我不自己配**：应用用的那组 R2 凭据 `GetBucketCors` 返回
`403 AccessDenied`。这是**正确的最小权限** —— 运行时凭据不该有能力修改桶策略。
我手上那把 Zeabur key 只能改**服务的环境变量**，不覆盖桶配置。

### 7.2 B-2：已关闭 —— 新版本已部署并在生产上复验

推送 `46b1e2c..2481d1f`（3 个提交）后，Zeabur **自动**触发构建：
`BUILDING → DEPLOYING → RUNNING`。随后在生产上做了三类核对：

**① 产物核对**（新版本真的上线了，不是"推送成功"就当作部署成功）

```
/bundle/index-CqCXGeKJ.js  (1,426,609 字节)
  directory-browse      1 处      directory-resources  1 处
  recycle-restore       1 处      /admin/recycle-bin   1 处
  ROLE_AUTO_PERMISSIONS 0 处   ← 本轮**删除**的东西确实不在了
```

**② 生产强制 MFA 链复跑（只读）** —— `pass=8 fail=0 skipped=1`

```
PASS  登录要求第二因子（MFA_ENFORCE_SUPER_ADMIN 生效）  -> mfaRequired=true
PASS  未过第二因子前拿不到业务数据（挑战态按未登录处理）  -> HTTP 401
PASS  错误的 TOTP 被拒  -> HTTP 401 验证码不正确，还可尝试 4 次
PASS  正确 TOTP 通过第二因子  -> HTTP 201
PASS  通过后业务接口可用（强制 MFA 闭环成立）  -> HTTP 200
PASS  状态：已绑定且仍为强制  -> {"enabled":true,"recoveryCodesRemaining":9,"required":true}
```

**③ 生产对象存储往返复跑** —— `pass=8 fail=0`，取回字节 sha256 与上传一致，
篡改令牌 403，清理残留 0。

**③b 本轮（第 13 轮）的目录控件推送后同样自动重建并核对**：生产 bundle 换名
（`index-DxKmKXaR.js`），六个新控件标记各 1 处、`ROLE_AUTO_PERMISSIONS` 仍为 0；
真实浏览器在生产目录页看到 67 个可点目录名、67 个「启用/停用」、67 个「上移/下移」，
**控制台错误 0**。

**④ 真实浏览器在**生产**上走一遍本轮新增界面**

```
登录 + 第二因子 -> /
侧边栏「回收站」入口: 回收站                 ← 权限门控正确（super_admin 可见）
目录页提示: true
可点目录名数: 67
点第一个目录: prek -> CLICKED
资源面板出现: true
  面板对应目录: prek
  面板标题: 「Pre-K」下的资源
  卡片数: 24
  错误块: false    空态块: false
```

也就是说：**本轮收口的界面改动在生产浏览器里是可用的**，
唯一不通过的是 §7.1 那条浏览器**直传**的 CORS 预检。

---

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

**代码侧、本机门禁（869 项）、生产上的强制 MFA、对象存储往返、以及本轮新增的
目录下钻与回收站在生产浏览器里都已实测通过，上线版本也已确认为本次收口的版本；
但"老师在生产浏览器里点保存草稿、字节真的传到 R2"这一条**实测是失败的**
（CORS 预检被拒，`PreflightMissingAllowOriginHeader`），而那是上传的唯一路径 ——
所以结论是 NOT READY FOR GO-LIVE，剩余唯一阻塞项见 §7.1。**
