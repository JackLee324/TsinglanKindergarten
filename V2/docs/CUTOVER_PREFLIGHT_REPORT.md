# Stage 12C 生产切换预检报告（CUTOVER PREFLIGHT）

> 本轮**没有部署、没有切换、没有删除任何生产数据**。
> 状态词严格按业主 §12 的定义使用：`PASS`（本次实际执行且有证据）、`FAIL`、`UNVERIFIED`、
> `BLOCKED`、`NOT CONFIGURED`、`NOT RUN`。**未运行/被阻断的项目一律不计为通过。**

## 0. 结论先说

```
代码与 Git                  : PASS
迁移数据准备（V2 专用文件）    : PASS
两条测试资源排除              : PASS（含从表，引用完整）
目录映射（对最终产物重跑）      : PASS（347/347，0 fallback）
端到端导入（真实流水线演练）    : PASS（347/24/69/0/621，0 孤儿）
超级管理员身份                : PASS（唯一账号 `TsinglanAdmin`，业主 Stage 13B §2 已确认）
教师目录授权                 : BLOCKED（24 个迁移账号 0 条授权；开放目录必须由业务给出）
生产账号登录                 : NOT RUN（须在正式环境用真实账号验证一次）
文件迁移                     : PASS（范围核实：产出 0 个业务文件）
安全（Cookie/HTTPS/限流/CSRF…）: NOT RUN（必须在真实部署上验证）
ZEABUR 部署                  : BLOCKED（本机无 Zeabur 访问能力）
正式域名                     : BLOCKED（同上）
备份与恢复演练                : NOT RUN
V1 退役                      : NOT RUN（前置条件未满足，禁止先删）
回滚材料                     : NOT RUN
GO-LIVE                      : NOT READY
```

## 1. §2.1 代码与 Git（PASS）

| 项 | 实际值 |
|---|---|
| 分支 / HEAD | `main`（12B 提交 `7ac3e6e` 之上，本轮修复后见提交信息） |
| V2 关键修复是否在 HEAD | 是：目录 resolver、迁移回归、`allow_files` 修复、迁移文件生成器 |
| V1 源码 | **未被修改**（本轮只动 `V2/` 内的脚本与文档） |

## 2. §2.2 Zeabur 访问能力：**BLOCKED**

**本次实际检查结果**（不是推测）：

| 检查项 | 结果 |
|---|---|
| `zeabur` / `zb` CLI | ❌ 未安装 |
| `~/.zeabur`（CLI 登录态） | ❌ 不存在 |
| 环境变量里的 Zeabur 凭据 | ❌ 无 |
| 仓库里的 Zeabur API token / 部署密钥 | ❌ 无 |
| 可访问的部分 | ✅ 生产站点 HTTPS 可达（`https://tsinglankindergarten.zeabur.app`）——快照正是用它导出的 |

因此以下事项**一律 BLOCKED，我不会声称做过**：读服务名/服务 ID、部署 V2、创建独立 PostgreSQL、
改环境变量、验证/修改域名绑定、退役旧数据库、查看部署记录与镜像摘要。

**需要业主提供其一**（任一即可解除阻断）：
1. 在 Zeabur 控制台把 V2 部署好（我给出确切参数：构建目录 `V2/`、Dockerfile 路径、
   环境变量清单、健康检查路径），把结果告诉我 → 我在**已部署环境**上跑验收；
2. 提供 Zeabur API token（放进 gitignored 的 `.env.deploy` 或环境变量）→ 由我执行部署与切换；
3. 安装并登录 `zeabur` CLI（`npm i -g zeabur` + `zeabur auth login`）→ 同上。

## 3. §3 生产数据与测试资源排除（PASS）

**唯一迁移来源**：`prod-export-20261008_031823.ndjson`
sha256 `b1a2e0e8b3fec3c1b2c24ade483f97aff7810e81bea41786fcdd395c511b708e`（1 414 327 B）
→ 每次生成都会**重新校验**，不一致直接拒绝执行（退出码 2）。

**V2 专用迁移文件**（原快照全程只读，未被修改）：

| 项 | 值 |
|---|---|
| 文件 | `.migration/prod-exports/v2-cutover-20261008.ndjson` |
| **sha256** | `b01c1fec5a9ac74908df5f38d178f1bf0543cad284b3a540181a941b70778476` |
| 字节 | 1 410 558 |
| 生成方式 | `scripts/prepare-v2-cutover-snapshot.mjs`（可重复执行，**同输入必得同 sha**） |
| 复核方式 | `node scripts/prepare-v2-cutover-snapshot.mjs --check` → ✅ PASS |
| 排除清单（可审计） | `.migration/prod-exports/v2-cutover-20261008.exclusion.json` |

**精确排除的 2 条测试资源**（ID + 标题字面量 `test` + 同一个 smoke 文件三特征同时命中才排除，
绝不做 `title LIKE '%test%'` 模糊删除）：

| resource id | 标题 | 状态 | 依据 |
|---|---|---|---|
| `76b60eb6-42ca-4143-a76c-9efd0202ee3e` | `test` | published | 标题字面量 test + smoke 图片 `校服申领登记.png` + V1 里没有目录归属 |
| `62928bcc-4f63-4626-95b5-19ec0b5b7705` | `test` | draft（V1 回收站内） | 标题字面量 test + 同一文件 + 桶名 `placeholder-bucket`（占位符） |

**并按 V1 自己的 `ON DELETE CASCADE` 语义，同时排除其从表行 4 条**（见 §4）：

| 从表 | 条数 | 为什么必须一起排除 |
|---|---:|---|
| `resource_versions` | 3 | V1 `0011_resource_versions.sql:36`：`resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE` |
| `review_records` | 1 | V1 `init.sql:184`：`resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE` |

**数量变化（逐表核对，其余表一条未动）**：

| 表 / 域 | 迁移前 | 迁移后 | 说明 |
|---|---:|---:|---|
| resources | **349** | **347** | 仅减少被授权的 2 条测试资源 |
| 有效资源 / 回收站 | 348 / 1 | 346 / 1 | 排除的两条里 1 条有效、1 条在回收站 |
| resource_versions | 350 | 347 | 被排除资源的 3 条版本行（CASCADE） |
| review_records | 1 | **0** | 生产**唯一**的审核记录就挂在那条被排除的测试资源上（CASCADE） |
| audit_logs | 621 | **621** | **一条未删**；其中 7 行的 `resource_id` 指向被排除资源，**原样保留不改值** |
| teachers / directories | 24 / 69 | 24 / 69 | 未变 |
| 带文件元数据的资源 | 2 | **0** | 见 §7 |

> `audit_logs.resource_id` 里留着已排除资源的 id 是**允许且刻意的**：V1 的
> `audit_logs` 定义里这一列**没有外键**（`init.sql` 中 `resource_id uuid`），V2 对应的
> `audit_logs.target_id` 也是自由文本（`0001_init.sql`）。所以删资源本来就不会动审计行 ——
> 这正是 V1 自己的行为。审计历史不删、不改。
>
> ⚠️ **必须向业主披露的后果**：由于生产**只有 1 条审核记录**、且它属于被排除的测试资源，
> 迁移后 V2 的**审核流水为空**（`resource_reviews = 0`）。资源的 `status`（已发布）不受影响。

## 4. 本轮发现并修复的缺陷：排除**引用不完整**（已修复并有证据）

**问题**：第一版生成器只排除 `resources` 那 2 行，没有处理从表 —— 产出的文件里
**3 条 `resource_versions` + 1 条 `review_records` 指向不存在的资源**。
这样的文件在真实 V1 库里**不可能存在**（外键会级联删掉它们），等于"用一份不忠实的数据换迁移成功"。

**证据（旧逻辑 vs 新逻辑，同一套真实流水线各跑一遍）**：

| 检查 | 旧逻辑（只排 resources） | 现在的文件 |
|---|---|---|
| 还原出的 V1 库里孤儿 `resource_versions` | **3** | **0** |
| 还原出的 V1 库里孤儿 `review_records` | **1** | **0** |
| 导入报告里"需要人工确认"的条数 | **2** | **1** |
| — 其中那条由本缺陷造成的 | `review fd8b6431-…：对应资源没有迁移（资源被跳过）` | 不存在 |
| 最终 V2 库 resources | 347 | 347 |

> 诚实说明：这条缺陷**不会让导入崩溃**（导入脚本对"资源被跳过"的审核行有兜底，会记一条
> review 级问题），但它让**迁移来源不忠实**，并在交付报告里多出一条**假问题**。
> 两类后果都不该带到生产切换里。

**修复**：
1. 生成器新增 `CASCADE_DEPENDENTS`（按 V1 的 `ON DELETE` 语义排除从表行）与
   `ALLOWED_KEPT_REFS`（显式豁免、并写清理由：审计历史无外键）；
2. 新增 **§引用完整性闸门**：扫**源快照每一行的每一个字段**，任何指向被排除资源、
   却"既没被处理也没被豁免"的引用 → **拒绝出文件**（退出码 7）。这条闸门正是本缺陷的通用解；
3. `--check` 独立复核：对**产物**重新扫描（本次 1 433 行 / 28 394 个字段，未豁免残留引用 **0**）、
   核对 footer 计数、并做**逐表差额守恒**（每张表只允许少掉被授权的那几条）；
4. 产物去掉生成时间 → **同输入必得同 sha256**，sha256 才能当"这份数据没被人动过"的凭证；
5. footer 计数按"被排到 0 行的表也要写 0"修正（否则 footer 与文件内容不符）；
6. 落位报告脚本里写死的 `349/349` 改为**按实际计算值输出**（原本表里写 347、结论行却写 349）。

## 4b. 本轮发现并修复的缺陷（二）：迁移链路（含一条**产品缺陷**）

跑全量门禁时暴露了 4 个问题，全部已修并有前后对比证据：

| # | 问题 | 性质 | 证据 |
|---|---|---|---|
| 1 | `tests/helpers/s3-backend.mjs` 的 S3 端口写的是 **18443**，与 `deploy/rehearsal-storage.mjs`（线上演练栈的存储后端）**同一个端口** | 测试工具缺陷 | 演练栈在跑时，测试的 S3 请求被**演练实例**接走 → 报 “The access key ID you provided does not exist in our records.”，9 个 S3 用例全红；改成 18444 后 **18/18 通过** |
| 2 | 端口空闲检测只 `listen('127.0.0.1')`（只探 IPv4），而 SeaweedFS 绑的是 IPv6 通配 `*:18443` | 测试工具缺陷 | 于是"端口空闲"判定为真、实际请求落到别人的服务上；现在 IPv4/IPv6 四个地址都探 |
| 3 | **`import-v1.mjs` 里 `unassigned` 是一个从未被写入的空数组**，落位失败时数据进的是另一个数组 `resolutionFailures` | **产品缺陷** | 后果：导入因"资源落不下去"整批中止时，交给运营的**未归属清单是空的**（写着"（本机三个 V1 库里都没有这种资源。）"），报告里也永远写"资源无目录归属：0" —— **最需要这份清单的时刻它恰好是空的**。已让两者指向同一个数组，测试从 FAIL 变 PASS |
| 4 | 合成夹具（`tests/helpers/v1-fixture.mjs`）建模的 V1 形态与**实测生产形态不符**：`resources.subject` 写成拼好的 code `prek:virtue`、`directory_id` 指向叶资料夹、缺 `教学详案`（`_lesson`）目录 | 测试数据缺陷 | 生产实测：347 条资源的 `subject` 是**纯科目名**（`virtue`/`english`）、`directory_id` **一律指向科目层**节点、叶资料夹由 `folder_type` 决定。夹具不改就会让落位器正确地拒绝落位（UNRESOLVED）；改齐之后 `migration-v1` 30/30、`browser.stage9` 12/12 |

> 第 3 条是**产品缺陷**，不是测试问题：它让一份"给人去执行的清单"在最关键的时候是空的。
> 它此前一直没被发现，正是因为夹具与生产形态不符（第 4 条）让这条路径从未真正跑到。

## 5. §5 目录映射（PASS，对**最终产物**重跑）

```
资源 347 ｜ 精确落位 347 ｜ UNRESOLVED 0 ｜ subject-level fallback 0
```

报告已按最终产物重新生成：`docs/PRODUCTION_RESOURCE_DIRECTORY_RESOLUTION.md`（347 行逐条审计，
含 `resource_id → 旧元组 → V2 directory code → V2 路径 → 为什么`）。

## 6. 端到端导入验证（PASS，本轮用真实流水线跑通；证明 §3/§5/§7 的数据真能进 V2）

不是"读代码推断"，而是把最终产物**真的**灌进一套真实 schema、再**真的**跑一次迁移：

```
最终产物(v2-cutover) → 还原成真实 V1 库(用 qls_test_0005 的真实 V1 schema 克隆) → import-v1.mjs → 全新建的 V2 库(0001/0002/0003 三个 migration)
```

| 核对项 | 结果 |
|---|---|
| 搬运计数 | directories 69 ｜ users 24 ｜ resources **347** ｜ audit_logs **621** |
| 目标库核对 | users 24 ｜ directories 69 ｜ resources 347 ｜ resource_files 0 ｜ resource_reviews 0 ｜ audit_logs 621 ｜ user_permissions 0 |
| **悬空引用（dangling）** | **`[]`（0）** |
| 重复审核键 | 0 |
| 目录对齐 | 匹配 69 ｜ 新建 69 ｜ V2 独有 0 |
| 资源无目录归属 | **0** |
| 未映射的授权来源 | 0 |
| 无法登录（V1 没有口令） | 0 |
| 其他需要确认 | 1 —— V1 里那个没有用户名的初始化账号，按规则导入为**停用**账号 `v1-no-username-749e5d41` |
| 被排除资源的残留 | `title='test'` 的残留 **0** |
| **落在 `allow_files=false` 目录上的资源** | **0** —— 这条是"迁完了但老师一条都看不到"的门闩 |
| 资源无目录归属 | **0**（这条数字此前因为 §4b 第 3 条的产品缺陷**永远是 0**，现在报的是真实值） |

> 注意：迁移**刻意不发权限**（`user_permissions = 0`），与 §7 的设计一致 —— 上线当天必须由
> 管理员按矩阵确认后初始化；在此之前老师能登录但看不到内容。

## 7. §6 账号与权限（身份 PASS / 授权 BLOCKED / 登录 NOT RUN）

`docs/PRODUCTION_PERMISSION_MATRIX.md` 已生成并**在 Stage 13C 同步**：24 个账号，
逐条列出 V1 角色、建议身份、开放目录、当前权限（**0 条**）、状态、证据来源。

| 子项 | 状态 | 说明 |
|---|---|---|
| 谁是超级管理员 | **PASS** | 业主 Stage 13B §2 已确认：唯一账号 `TsinglanAdmin`。服务端强制唯一（`POST /api/users` 只建教师；`PATCH` 升管理员 → 400 `SUPERADMIN_TRANSFER_REQUIRED`；换人只走 `scripts/transfer-superadmin.mjs`）。**这一项不再需要"逐条确认"**。 |
| 每位教师开放哪些目录 | **BLOCKED** | 24 个账号当前 **0 条**授权。V1 导出里 `subject_permissions` / `account_scopes` / `account_permission_overrides` **都是 0 行** —— 没有任何可推导的数据，必须由业务给出。**不得**给所有教师开放所有目录，**不得**按 V1 角色名直接换算成"全班型全科目可见"。 |
| 生产账号登录 | **NOT RUN** | V1 哈希（`scrypt$16384$8$1…`）与 V2 校验逻辑兼容，但必须在**正式环境**用**真实账号**各登录一次才算通过；在演练库登录成功不算。 |

决策材料（只读生成，不写库）：`node scripts/propose-directory-grants.mjs`
（从已校验的迁移文件里读 24 个账号 + 69 个目录，产出决策清单，业主填写后再由管理员在
`/admin/permissions` 上初始化）。**确认唯一管理员 ≠ 完成教师权限初始化。**

## 8. §7 文件迁移（PASS：范围核实为 0 业务对象）

| 事实 | 证据 |
|---|---|
| V1 生产 349 条资源里，**只有那 2 条 smoke 测试资源**带文件元数据 | 快照逐条统计 |
| 排除后：**0 条资源带文件** | 最终产物逐条统计 + 导入报告 `resource_files 0` |
| 其余 347 条的文件列（`file_path`/`file_name`/`file_size`/`type`/`bucket`）全为 NULL | 快照逐条统计 |

→ **V2 的 R2 业务文件迁移是空活**：没有真实业务对象要搬，也就**不存在"覆盖 V1 原对象"的风险**。
V1 存储里的两个 smoke 对象保持原样、不动；V2 采用独立 Bucket/前缀后，将来的上传落在 V2 自己的位置。

## 9. §8 测试门禁（业主门禁清单）

| 门禁 | 状态 | 说明 |
|---|---|---|
| `npm run lint` | **PASS** | eslint 0 error（本轮修复了生成器的 2 处 unused） |
| 迁移落位回归 `tests/integration/migration-directory-resolution.test.mjs` | **PASS** | 20/20（真实快照 fixture + sha256 校验 + 11 个命名映射 + 4 个反例） |
| 迁移文件自检 `--check` | **PASS** | 见 §3/§4 |
| 端到端导入演练 | **PASS** | 见 §6 |
| `npm run build`（SWC + Vite + 产物完整性核对） | **PASS** | 退出码 0 |
| `npm run test:unit` | **PASS** | **206 / 206** |
| `npm run typecheck`（server + client） | **PASS** | 退出码 0 |
| `npm run test:integration` | **PASS** | **582 / 582，0 失败**（修完 §4b 的 4 个缺陷后重跑；修前 554 通过 / 28 失败，失败全部集中在迁移与 S3 套件） |
| 多目录浏览器验证（Pre-K 四类 / K 中文四类 / 教师成长链） | **PASS（上一轮 7/7）** | **在生产部署后必须对正式域名再跑一遍** |
| 安全（Cookie/HTTPS/限流/CSRF/响应头/越权/ID 替换） | **NOT RUN** | 需在真实部署上验证 |

## 9.1 缺陷修复后的复跑结果

| 套件 | 结果 |
|---|---|
| `tests/integration/migration-v1.test.mjs` | **30 / 30 PASS**（修前：3 个顶层 / 20 个嵌套失败） |
| `tests/integration/browser.stage9.test.mjs` | **12 / 12 PASS**（修前：7 个失败） |
| `tests/integration/storage-s3.integration.test.mjs` | **18 / 18 PASS**（修前：9 个失败） |
| `npm run test:integration` 全量 | 修复后重跑：**582 / 582 PASS，0 失败**（见提交信息；未修前是 554 通过 / 28 失败） |

## 10. 依赖审计（本轮实跑 `npm audit`）

| 范围 | 结果 |
|---|---|
| **生产依赖**（`--omit=dev`，与镜像里实际安装的一致） | **2 HIGH ｜ 0 CRITICAL ｜ 4 MODERATE ｜ 1 LOW** |
| 全部依赖（含 devDeps） | 13 HIGH ｜ 0 CRITICAL —— **devDeps 不进镜像**（Dockerfile 运行阶段 `npm ci --omit=dev`） |

两条 HIGH 来自同一条链：

- `multer`（受影响范围 `<=2.2.0`）：多个 multipart DoS 公告
  （GHSA-xf7r-hgr6-v32p、GHSA-v52c-386h-88mc、GHSA-5528-5vmv-3xc2、GHSA-72gw-mp4g-v24j、
   GHSA-wc9g-mqfw-jrwm、GHSA-535w-7cp7-47q4）；
- `@nestjs/platform-express`（`<=11.1.14`）：因为传递依赖上面的 multer 而被标同级。

**可达性判定（本轮实际核查，不是推测）**：V2 **没有任何 multipart 入口** ——
`server/` 下搜不到 `FileInterceptor` / `FilesInterceptor` / `UploadedFile` / `multer` 的使用；
上传走的是**预签名 URL**（`POST /api/files/upload-url` → 客户端用原始字节 `PUT` 到存储），
本地驱动那侧还要求 HMAC 令牌并**重算 sha256 比对**（`server/storage/storage.controller.ts`）。
也就是说：**有漏洞的那条代码路径（multipart 解析）没有被激活**。

**处置建议**：修复版本是 `@nestjs/platform-express@12.1.2`，属于**跨大版本**升级（Nest 10 → 12）。
**不建议在切换窗口里做**；切换完成后单独排期升级并跑全量回归。
这里记录的是「**已定位 + 已判定不可达 + 有明确下一步**」，**不是「已修复」**。

## 10.5 Stage 13B 更新：超级管理员唯一化（**只有 `TsinglanAdmin`**）

业主在 Stage 13B §2 明确：**生产里只有 `TsinglanAdmin` 可以是有效 `ADMIN`**，
业务身份仍然只有 `ADMIN` / `TEACHER` 两种。据此落实为：

| 项 | 内容 |
|---|---|
| 迁移身份 | 用 `--admin-usernames TsinglanAdmin` **显式点名**；`DEFAULT_ADMIN_ROLES` 为**空**，不再按 V1 岗位名自动提升 |
| 其他 V1 管理员岗位 | `qlsadmin`（principal）→ **TEACHER**；无用户名的`系统初始化` → 按迁移规则**停用**教师 |
| 服务端唯一性 | `POST /api/users` 只建教师；`PATCH /api/users/:id` **拒绝**升管理员（`SUPERADMIN_TRANSFER_REQUIRED`）；`bootstrap-admin.mjs` 只在没有管理员时创建；换人只能走 `scripts/transfer-superadmin.mjs`（同一事务一降一升 + 两条审计 + 撤销双方会话） |
| 数据处置 | **不删账号、不删审计**；只改身份 |
| 矩阵 | `docs/PRODUCTION_PERMISSION_MATRIX.md` 已更新：全表只有 `TsinglanAdmin` 一行是 `ADMIN` |

> 本阶段**没有执行正式迁移**（仍为 BLOCKED）。以上是代码与文档层面的准备 + 在本地演练环境上的验证。

## 11. §9/§10/§11（BLOCKED / NOT RUN）

预发布演练、正式切换、V1 退役**全部依赖 Zeabur 访问**，因此：
`ZEABUR 部署 = BLOCKED`、`正式域名 = BLOCKED`、`备份与恢复 = NOT RUN`、
`V1 退役 = NOT RUN`、`回滚材料 = NOT RUN`。

**特别声明**：在备份、恢复演练与 V2 正式验收完成之前，**不得**删除 V1 数据库资源 —— 本轮没有删除任何东西。

## 12. 下一步（Stage 13C 的顺序，业主指定）

0. **文档与脚本收尾**（本轮已做）：矩阵/预检报告状态同步、`transfer-superadmin.mjs`
   要求显式 `DATABASE_URL` 并打印脱敏目标、只读的 R2 清单工具与授权决策清单工具。
1. **账号处理方式与教师开放目录**：业主在决策清单上填写 → 管理员在 `/admin/permissions` 初始化；
   全程保持 `TsinglanAdmin` 为唯一超级管理员。
2. **取得 R2 对象清单**：用只读凭证或控制台导出对象清单（`scripts/r2-inventory.mjs`），
   明确文件迁移范围。**未核实以前，不删除、不覆盖任何生产对象。**
3. **解除 Zeabur 阻断**：建立**独立 V2 PostgreSQL** → 对 V1 库做备份并**实际演练恢复** →
   在隔离环境完成导入（核对 **347 / 24 / 69 / 0 / 621**，dangling = 0）与部署验证。
4. **最后才是**正式域名切换、V1 退役与生产浏览器验收（桌面 + 移动，真实账号）。
   任何一项不过 → 停在安全边界并报告；**目前不重新部署、不删除 V1**。

### 12.1 Stage 13C 门禁（每一项都要"实际执行 + 证据"才算通过）

| # | 门禁 | 命令 / 动作 | 状态 |
|---|---|---|---|
| G1 | 迁移文件完整性 | `node scripts/prepare-v2-cutover-snapshot.mjs --check` | PASS（Stage 12C） |
| G2 | 迁移来源隔离（不得用演练库） | 见 `docs/PRODUCTION_PERMISSION_MATRIX.md` §4 | PASS（文档规则 + 计数器对照） |
| G3 | 超级管理员唯一 | `scripts/transfer-superadmin.mjs` 加固 + `account-privileges.test.mjs` | PASS（Stage 13C 本轮） |
| G4 | 教师目录授权决策 | `node scripts/propose-directory-grants.mjs` → 业主填写 → 界面初始化 | **BLOCKED**（等业务） |
| G5 | R2 对象清单 | `node scripts/r2-inventory.mjs --out …`（只读；需业主给只读凭证或控制台导出）。**Stage 13C.1/13C.2/13C.3 加固**：默认只接受 https（http 仅限本机模拟器 + 显式开关）、CSV 走 RFC 4180、`--max` 严格解析（`0`/负数/小数/非数字/缺值 → 退出码 2，不再静默退化成全量）且产物恒标 `complete=false`、控制台导出必须 `--expect-count` 核对一致才标完整（`IsTruncated`/下一页令牌/总数不符直接失败）、声明的 Prefix 真的过滤对象集合、**对比还要求存储身份一致**（实时列举=端点+凭据指纹；控制台导出=`--storage-id` 声明；未知或不同一律拒绝，桶名相同不算证据）、**身份类型必须与来源匹配**（API 清单必须是指纹且端点与 scope 一致，控制台清单不许伪装成指纹）、**旧清单逐字段自洽校验且两份都在输出差异前校验**，`--compare` 拒绝不完整/矛盾/身份不明的清单 | **BLOCKED**（无凭证）；工具侧已加固并复测 |
| G6 | 独立 V2 PostgreSQL | Zeabur 控制台建库 | **BLOCKED**（无访问） |
| G7 | V1 备份 + 恢复演练 | 备份 → 在**另一个**库恢复 → 行数核对 | **NOT RUN** |
| G8 | Zeabur 预发布部署 + 真实浏览器验收 | `deploy/verify.mjs` + `tests/production/*`（桌面 + 移动） | **NOT RUN** |
| G9 | 回滚步骤（可执行、经验证） | `docs/DISASTER_RECOVERY.md` + 演练记录 | **NOT RUN** |
| G10 | 正式切换 + V1 退役 | 维护窗口，前置条件全部 PASS | **NOT RUN（禁止先做）** |
