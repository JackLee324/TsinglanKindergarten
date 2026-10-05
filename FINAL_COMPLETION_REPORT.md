# FINAL_COMPLETION_REPORT.md — 清澜山幼儿园教师课程资源平台收口工程

> 生成时间：本轮（goal round 34）
> 代码：`main` @ `36fa104` 之后（详见文末「交付物与提交」）
> 生产：https://tsinglankindergarten.zeabur.app

## ⚠️ 关于本报告的 18 项结构 —— 先声明一件事

你 §34 要求本报告「逐项对应 18 条要求」，但**那 18 条的原文不在本会话的可见记录里**
（会话前半段已被压缩，`BEFORE_FINAL_AUDIT.md` 里只留下「逐项对应你 §34 要求的 18 条」这一句
指路，没有清单本身）。我不会凭印象编一份 18 条出来假装对上了。

下面是我按本工程**必须交代的内容**重建的 18 节。如果与你手里的清单有出入，
把那 18 条发我，我逐条重排并补上缺失项 —— 这是格式问题，不影响下面每一条的证据。

---

## 1. 结论

# **NOT READY FOR GO-LIVE**

不是"没做完所以不给结论"，而是有**具体的、指名道姓的**未达成项，且其中两项卡在你尚未回复的决策上：

| # | 阻塞项 | 为什么它挡上线 |
| --- | --- | --- |
| 1 | **真实文件字节上传未实现**（只做到"不再假装成功"） | 平台的核心功能之一。当前上传会**明确拒绝**并说明原因（503 `STORAGE_NOT_CONFIGURED`），这比原来"行里声称有文件、下载却必然失败"诚实，但老师仍然传不了课件 |
| 2 | **资料夹 4 种 vs 6 种未定** | 挡 `resources.directory_id` 迁移（§1/§2 的最后一段）与资料夹级资源统计 |
| 3 | **PDF 新增科目的授权归属未定** | `prek:english`、`k:chinese:arts` 已如实落库并可见性失败关闭，但「由哪些角色默认持有」是产品决定 |
| 4 | **§11「按账号授权」的产品形态未定** | `setPermissionOverride()` 有表、有读、有写函数，但**没有任何 API/UI 可达** |
| 5 | 生产管理员口令曾在会话里明文出现，**尚未轮换** | 属运维动作，需你执行 |

"能不能上线"取决于这 5 条怎么处理，而不是取决于代码质量 —— 代码侧的门禁是**全绿**的（下节）。

## 2. 交付物与提交

本轮（含前几轮收口）主要提交：

```
b6f4797  feat(versions): 资源版本生命周期真的存在了（§15）
1c094d2  fix(toolchain): 让 lint 真正能跑（§22/§27/§31）
2aa29f0  feat(auth): 两步验证网页闭环 + 首次登录强制改密（§12/§13）
5b326a3  fix(upload): 关掉"行里声称有文件、下载却必然失败"的假成功 + 资源详情（§14）
f59b549  feat(directory): 可编辑目录系统（migration 0010 + 写接口 + 界面）
298579e  feat(db): 0009 directories 目录树迁移（PDF 权威结构落库）
```

新增/重写的关键产物：

| 产物 | 作用 |
| --- | --- |
| `server/database/migrations/0009..0011*.sql(+.down.sql)` | 目录树 / 可编辑目录 / 版本快照 |
| `server/modules/directories/**` | 目录树读写（读按角色剪枝，写有 `is_system` 保护） |
| `client/src/pages/Directory/DirectoryPage.tsx` | 数据库驱动的目录页（无硬编码兜底） |
| `client/src/pages/AccountSecurity/AccountSecurityPage.tsx` | MFA 网页闭环 |
| `client/src/components/resource-detail/ResourceDetailDialog.tsx` | 资源详情 + 版本历史 |
| `scripts/verify-directories.mjs` / `-write` / `verify-mfa-web.mjs` / `verify-resource-versions.mjs` | 新增的 4 个验证套件（共 125 项断言） |
| `eslint.config.js` / `stylelint.config.mjs` | 重建的 lint 配置（原先都不可用） |

## 3. 14 项命令实测（`scripts/verify-all.sh` 一次跑完）

```
=== 自动化测试 ===
  npm test                 # tests 276 # pass 276 # fail 0
=== 静态检查（lint）===
  eslint                   PASS
  stylelint                PASS
=== 类型检查 ===
  typecheck server         PASS
  typecheck client         PASS
=== 构建 ===
  npm run build            PASS
=== 前后端 API 契约 ===
  api-contracts            matched
=== HTTP 验证套件 ===
  authz-http               pass=75  fail=0
  hardening                pass=10  fail=0
  mfa                      pass=55  fail=0
  security-headers         pass=20  fail=0
  files-http               pass=80  fail=0
  naming-http              pass=49  fail=0
  directories              pass=55  fail=0
  directories-write        pass=31  fail=0
  resource-versions        pass=22  fail=0
  browser-e2e              pass=32  fail=0   （真 Chrome + CDP）
  mfa-web                  pass=17  fail=0   （真 Chrome + CDP）
  ✅ 全部通过
```

合计 **276 单测 + 446 HTTP/浏览器断言 = 722 项**。

### lint 那一项此前是"挂着但从不执行"

这是本轮发现的问题，值得单独说，因为它属于同一类"看起来有、其实没有"：

* `npm run eslint` 的第一行 `require('@lark-apaas/fullstack-presets')` —— 该包**已随去平台化删除**，
  命令直接崩。去平台化那天起 lint 就没跑过。
* `npm run stylelint` 更彻底：仓库里**没有任何 stylelint 配置**，
  而且 glob 没加引号（shell 把 `**` 当单个 `*`），只匹配到被忽略的 vendor 目录 ——
  **一个文件都没检查却退出 0**。

两个都修好后立刻查出 **19 个真问题**并全部修掉（死代码、无副作用的表达式语句、
两条空 CSS 规则、一条重复选择器）。证明确实在检查：喂一个非法 hex 会报
`color-no-invalid-hex`；verbose 显示实际检查 3 个文件。

## 4. 真实浏览器 E2E（非"再跑一次接口"）

两个套件都是自起 Chrome + CDP，读真实 DOM、真实点击、真实验证效果：

`verify-browser-e2e.mjs`（32/32）— 未登录守卫、登录、§16 分页（**已显示 50 / 共 79 条 → 点「加载更多」→ 卡片 50 → 79**）、
§1 目录树（两个根、Pre-K 4 科目含 PDF 新增的「英文」、4 类资料夹、「可自建文件夹」标记、教师成长 L1/L2/L3 + 4 分支）、
§24 新建文件夹全流程（点→填→提交→**树里真的出现**→删除→**真的消失**）、§14 详情弹窗、§19 导出按钮、§5 我的资源。

`verify-mfa-web.mjs`（17/17）— 临时密码登录 → **强制跳到改密页** → 未改密前其它路由被挡 →
**服务端也拦**（受保护接口 403 + `PASSWORD_CHANGE_REQUIRED`，而 `/api/auth/me` 仍 200）→
改密 → `/account/security` 用**独立实现的 TOTP** 启用两步验证 → 拿到 10 个恢复码 →
退出重登 → 出现第二步 → 正确码进入工作台 → 错误码不放行并显示原因。

## 5. Docker

```
docker build --platform linux/amd64 -t qls:gate .        → BUILD EXIT=0（镜像 119MB 压缩 / 677MB）
docker run -d qls:gate                                    → 容器启动
  /api/health       200
  /api/health/ready 200
  /api/directories/tree 401（未登录，符合预期）
  /api/auth/me          401（同上）
  GET /  →  渲染出 SPA 并注入 window.csrfToken
浏览器 E2E 打容器（:3400）→ pass=32 fail=0 skipped=0
```

不止"能构建"：**构建产物真的跑起来了，并且通过了浏览器级验证**。

（注：本机 Docker daemon 起初没运行，我启动了 Docker Desktop 才做的构建 —— 如实记录，
因为"docker build 通过"这句话依赖这个前提。）

## 6. 数据库迁移 up / down / 回填

11 个迁移全部 applied，`✓ No checksum drift`。本轮三个新迁移都是**纯加法**且逐个验过往返：

| 迁移 | up | down（含守卫） | 回填校验 |
| --- | --- | --- | --- |
| `0009_directories` | 69 节点，内嵌断言 2 根/3 层级/16 可自建/40 资料夹 | 通过；`resources` 一行未动 | 往返后内容指纹**逐字节一致** `211433d5…` |
| `0010_directories_editable` | 加 `is_system`/`created_by` + 3 条约束与唯一索引 | 有自建节点时**拒绝回滚**；清理后成功；再 up 回到 69 个系统节点 | 69 行全部标为系统节点 |
| `0011_resource_versions` | 建表 + 回填**每个**既有资源为第 1 版 | 存在**真实**（非回填）历史时**拒绝回滚**并说明原因（实测） | 348 资源 → 348 快照，未覆盖 **0**，版本号不一致 **0** |

三个 down 都有逃生阀（`SET LOCAL qls.directories_force_down = 'on'`），同一套约定；
0011 的 force 分支在回滚事务里验证过可执行而不污染状态。

## 7. 本轮清掉的"假成功 / 死代码"（这是本工程的主线之一）

| 什么 | 之前的真相 | 现在 |
| --- | --- | --- |
| 上传 | 客户端写死 `fileBucketId='placeholder-bucket'`；服务端只查 bucket 形状 → 行里立刻声称"有文件"，界面亮「下载」，下载必然 503 | 服务端写库**前**判定存储可用性，没后端就 503 且**一个文件列都不写**；客户端不再编造 |
| 强制改密 | 标志一直被写进 AuthUser、管理员重置密码也置 true，但**没有任何地方据此拦截**；前端也从不读它；且**创建账号时压根不置**（临时密码就是永久密码） | 网关真的拦（`PASSWORD_CHANGE_REQUIRED`，白名单只放行改密所必需端点）；前端加路由闸门；创建与重置都置 true |
| MFA | 服务端完整（55 项断言全绿），**网页端一行都没有**：登录页不处理 `mfaRequired`，`login()` 用 `resp.data.teacher` 取值（该响应里没有 teacher）→ 得到 `undefined` 被当成已登录 | 判别联合 + 登录第二步 + `/account/security` 完整闭环 |
| 资源详情 | 「查看」只弹 `toast.info('详情功能开发中')` | 真弹窗，数据全来自 API，缺失字段显示「未填写」，失败直接显示 |
| 资源版本 | 界面一直显示「版本 v1」，但**没有任何代码写过它** —— 迁移前 348 行全部等于 1 | 版本真的会动（1→2→3），无实质变化的保存不产生版本；详情弹窗显示历史 |
| 界面上的开发计划 | `TODO: 后续接入 dataloom storage SDK` 直接印给老师看 | 删除，改为说明当前能力边界 |
| lint | 见第 3 节：两个命令都不可执行，且门禁里从没跑过 | 自包含配置 + 19 个真问题修完 + 接入门禁 |
| 幽灵权限 | 46 个权限里 **22 个从未被任何服务端代码检查** —— 权限矩阵会照常显示它们，授予/撤销却不改变任何行为 | 新增审计（拼错权限码 = 守卫静默失效，这条也一并检查）；`role.assign` 真正接管角色变更；其余 21 条登记棘轮基线、逐条打印、不得增长 |
| 门禁本身 | ① 未配浏览器账号时静默当作通过；② `npm test` 因缺 `DATABASE_URL` 一直跑 270 而非 275 | ① 改为明确打印"未运行、**不算通过**"；② 显式补环境变量 |

## 8. 范围覆盖总表

| § | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| §1 §2 §20 §24 §25 §26 | PDF 目录树 / 可编辑目录 / 自建文件夹 | **读+写均完成**；`directory_id` 关联未做 | migration 0009/0010，`directories` 55 + `directories-write` 31 + 浏览器 12 条 |
| §3 | 上传（前端） | 不再假成功；**真实字节上传未实现** | files-http 80（含"行里不留文件痕迹"的直查断言） |
| §4 §23 | S3 兼容对象存储 | **未接入**（需 bucket） | 下载路径 503 且不伪造 URL 已被 20 项断言钉住 |
| §5 §6 §7 §30 | 状态机 + recall + 事务 + 审计 + 权限 | **完成** | authz 75、files 80，浏览器 §5 证据 |
| §8 §9 §10 §21 | RBAC 单一真相 | **完成**：0 处业务层 `roles.includes` 角色字面量 | 4 个专项单测（17+12+6+10 条） |
| §11 | 有效权限管理 UI | **未做**（产品形态待定） | `setPermissionOverride()` 仍无调用者 |
| §12 §13 | MFA 网页闭环 / 强制改密 | **完成** | mfa-web 17/17 |
| §14 | 资源详情 | **完成** | 浏览器 7 条 |
| §15 | 版本生命周期 | **完成** | resource-versions 22/22 |
| §16 | 分页 | **完成**（含浏览器级） | 「已显示 50 / 共 79 条」→ 卡片 50→79 |
| §17 | 回收站文案 | **完成** | 界面文案与后端软删除语义一致 |
| §18 | 到期自动清理调度 | **完成** | `PurgeScheduler`，启动即跑 + 周期跑 |
| §19 | 审计导出 | **完成** | RFC 4180 + UTF-8 BOM + 10000 行上限 |
| §22 §27 §29 | 幽灵权限 / 死代码 / 假成功 | **已量化并建立防线**：审计扫出 22 条幽灵权限（46 条中的近一半），`role.assign` 已接上消费点，其余 21 条登记为棘轮基线、逐条打印、不得增长 | `tests/ghost-permissions.test.mjs` |
| §28 | 运行时仍依赖 @lark-apaas | **已推翻**；但发现配置层残留（`eslint.config.js`）已清理 | — |
| §31 | 14 项命令 | **完成**（见第 3 节） | — |
| §32 | 9 条浏览器流程 | **超出**：32 + 17 项断言，覆盖 §1/§5/§14/§16/§19/§24/§12/§13 | — |
| §33 | 迁移 up/down/回填 | **完成**（见第 6 节） | — |
| §34 | 本报告 | 见开头声明 | — |

## 9. 已如实标注的"无法在当前环境验证"的项

遵守你的约束：**没有能力验证的，明确输出，不假装成功**。

| 项 | 现状 | 需要什么才能验证 |
| --- | --- | --- |
| 对象存储字节读写 | **从未验证**（没有 bucket）。下载返回 503 且不含任何伪造 URL，这一点是**被验证过的** | 一个 S3/R2/MinIO 测试 bucket（或同意用本地 MinIO，我会明确标注非生产桶） |
| 数据库字节级备份 | 本机**没有 `pg_dump`**，做不了真正的备份 | 部署环境提供的备份命令；当前替代做法是记录迁移前状态指纹（`backups/pre-0011-resources-state.json`） |
| 生产库直连 | 我只有 HTTP 层观察，没有生产库连接串 | 生产 `DATABASE_URL`（若要我做库级核对） |
| 生产者密码轮换 | 未做 | 你执行 |

## 10. 需要你决定的 4 件事（这 4 条挡住"完成"）

1. **资料夹 4 种（PDF）vs 6 种（现有 `folder_type`，347 行在用）** —— 选 (a) 迁移成 4 种，还是 (b) 保留 6 种、把 PDF 的 4 个名字当显示分组。
2. **PDF 新增科目是否纳入规范词汇**：`prek:english`（Pre-K 英文）、`k:chinese:arts`（K 美育）。
   注意 `shared/curriculum.ts` 里 K 中文子科是 `drama`（戏剧），而 PDF 是「美育」——
   是并存还是替换？纳入后哪些角色默认持有？
3. **测试 bucket**（或同意用本地 MinIO 做等价验证，我会标注）。
4. **§11「按账号授权」的产品形态** —— 是按账号勾权限，还是按"账号 + 数据范围"？

## 11. 复现方式（照抄即可）

```bash
# 1) 数据库（本机不能用 pg_ctl start，直接起进程）
postgres -D <pgdata> -p 55432 -c listen_addresses=127.0.0.1
DATABASE_URL=postgresql://…/qls_test_0005 node scripts/migrate.mjs up

# 2) 构建（必须用 npm run build：它会把 client 发布到 dist/dist/client，
#    而进程跑在 dist/ 下，视图目录是 <cwd>/dist/client）
npm run build

# 3) 起服务（必须用 npm run start —— 它会 cd dist；直接 node dist/server/main.js 会因
#    cwd 不同而找不到视图，表现为 GET / 500 "Failed to lookup view"）
SERVER_PORT=3200 NODE_ENV=production MFA_ENFORCE_SUPER_ADMIN=true \
DOWNLOAD_TOKEN_TTL_SECONDS=10 LOGIN_IP_RATE_LIMIT_MAX=100000 \
DOWNLOAD_TOKEN_SECRET=$(openssl rand -base64 32) \
MFA_ENCRYPTION_KEY=$(openssl rand -hex 32) SESSION_SECRET=<32+ 字符> \
npm run start

# 4) 门禁
AUTHZ_TEST_DB=postgresql://…/qls_test_0005 \
BROWSER_E2E_USER=seq_principal BROWSER_E2E_PASS='…' \
bash scripts/verify-all.sh
```

### 容易踩的环境坑（都实测过，写在 `BEFORE_FINAL_AUDIT.md` 的环境注意事项里）

1. `pkill -f "dist/server/main.js"` **匹配不到** `npm run start`（它执行的是 `cd dist && node server/main.js`），
   旧进程会继续占着端口并**用它缓存的 index.html 引用已被删除的 bundle** → 浏览器白屏。
   按端口杀：`lsof -ti tcp:3200 | xargs -r kill`。
2. 只跑 `npm run build:client` 不够 —— 必须 `npm run build`。
3. `npm install` 会裁掉 darwin-arm64 平台二进制；本机不能再跑 `npm install`。
4. `eslint .` 在本机 iCloud 同步目录上会 EAGAIN；门禁里已改为显式目录。

## 12. 我对本次工作质量的自我评价（含我犯的错）

**做得好的**：把"看起来有、其实没有"这一类问题当成主线，并且每一条都留下可复现的证据；
新增的 4 个套件共 125 项断言，都是"断言精确值"而不是"大于 0"。

**我犯过的错**（都已修，且都是测试/工具抓出来的，不是我自省的）：

1. 断言读错元素：§1 的浏览器断言读整页 innerText，实际读到的是**左侧导航栏** ——
   「Pre-K 下有美德/蒙特梭利/体能」被侧边栏满足、看起来通过了，真正要断言的目录树根本没被检查。
2. 点击函数不验证效果：第一版只判断"元素存在"就返回成功，于是 `§16 能点到标签` 是一条**假 PASS**。
3. SQL 记录变量遮蔽（`f` 同时用于两种 VALUES 形状）→ 迁移报 `record "f" has no field "code"`。
4. down 守卫写成了注释里声称、代码里没有（假声明），补上后又忘了排除自引用。
5. 用 `.*?` + `re.S` 的正则清理一个未使用变量，**把紧随其后的密码填充块一起删了** ——
   后果不是报错而是"点了没反应"。
6. 多处 `\d` / `\"` 在 Python 字符串里被双重转义，写进 JS 后正则永远匹配不到。

这些没有被藏起来，都写在对应提交的信息里。

## 13. 一句话总结

**代码侧的门禁是全绿的（722 项、含真实浏览器、含容器内运行），并且这一轮把平台里
多处"看起来有、其实没有"的东西变成了"真的有"或"明确没有"；
离可上线还差 4 个产品决策 + 一个对象存储 bucket + 一次口令轮换。**
