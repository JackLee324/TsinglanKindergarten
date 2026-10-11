# 正式切换运行手册（CUTOVER RUNBOOK）

> 配套脚本：`deploy/cutover.mjs`（执行器）＋ `deploy/verify.mjs`（部署后自检）＋
> `docs/DISASTER_RECOVERY.md`（灾备）。门禁编号与状态见
> `docs/STAGE13C_CUTOVER_READINESS.md` §3。
> 状态词只用 `PASS / BLOCKED / NOT RUN`；**没实际执行过的一律不计为通过**。

## 0. 一句话现状

**V2 已在临时网址上正常运行**（`https://tsinglan.zeabur.app`，部署 `36ba9207`，
`deploy/verify.mjs` 退出码 0、真实浏览器桌面 + 移动 9/9）；**正式域名仍然不切**，
因为教师名额管理界面、支付/账单/发票尚未实现，且 24 个账号的目录授权仍未决定（§6）。

2026-10-11 更新（§6）：构建失败（exit 127）、502（端口不匹配）、安全头与登录限流
三个线上问题均已定位并修复，前两个在线上验证通过；存储侧全部 PASS。
剩下卡在"人"的条件：教师授权决定与管理员凭据（用于登录后的验收）。

## 1. 切换那天怎么走（三条命令）

```bash
# ① 演练：不碰任何既有库，在本机嵌入式 Postgres 上建两个临时库跑完整链路，跑完自删
export V2_TEST_DATABASE_URL='postgresql://<user>:<pw>@127.0.0.1:55432/qls_v2_test'
node deploy/cutover.mjs --drill --keep-drill-dbs     # 想留着临时库人工翻看时加 --keep-drill-dbs

# ② 预演：只做前置检查 + 打印将要执行的每一步与回滚清单（不连库）
node deploy/cutover.mjs --plan

# ③ 正式执行（需要真实目标；缺确认字面量会在建立任何连接之前退出）
node deploy/cutover.mjs --production \
  --target "postgresql://<v2 用户>@<主机>:5432/<独立 V2 库>" \
  --v1     "postgresql://<v1 用户>@<主机>:5432/<V1 库>" \
  --confirm CUTOVER-PRODUCTION
```

`--production` 的硬前置（脚本自己会拒）：

| 前置 | 不满足时 |
|---|---|
| `--confirm CUTOVER-PRODUCTION` 字面量 | 退出码 2，**不建立任何连接** |
| `--target` 显式给出 | 退出码 2（脚本不接受任何默认库，尤其不接受本机开发库） |
| 目标**不是本机地址** | 退出码 2（本机目标请用 `--drill`） |
| 教师授权已决定（决策表里没有 `DECISION_REQUIRED`，且授权数 > 0） | 退出码 4；确实要先空着上线时必须显式 `--accept-zero-grants`（后果写进日志） |
| 目标库存在且可达 | 退出码 2，并提示"在 Zeabur 控制台单独新建 V2 库"（脚本不会替你建生产库） |

## 2. 执行器做了什么（顺序固定，失败即停）

| 步 | 动作 | 判据 |
|---|---|---|
| S1 | `prepare-v2-cutover-snapshot.mjs --check` | 冻结迁移文件（sha256 与清单一致、引用完整） |
| S2 | （drill）`load-v1-snapshot.mjs` 还原受控 V1 库 | 14 张表逐张与 footer 计数一致 |
| S3 | `migrate.mjs up` 在目标库跑 0001/0002/0003 | 退出码 0 |
| S4 | `migrate.mjs status` | 0 pending |
| S5 | `import-v1.mjs --admin-usernames TsinglanAdmin` | 退出码 0；报告落在 `deploy/logs/import-*.md` |
| S6 | **直接查库**核对不变量 | 见下表 |
| S7 | 部署 + 预发布验收（外部动作，脚本只打印命令） | `deploy/verify.mjs` + `tests/production/*` 全绿 |
| S8 | 回滚清单 | 见 §4 |

**S6 的不变量**（不看导入脚本自述，直接 `SELECT`）：

```
users=24  directories=69  resources=347  resource_files=0  audit_logs=621
user_permissions=0
唯一有效管理员 = 1（TsinglanAdmin）
资源悬空目录引用 = 0
落在 allow_files=false 目录上的资源 = 0      ← "迁完了但老师一条都看不到"的门闩
title='test' 残留 = 0
```

任何一条不满足 → 停在原地、**不切域名**。

## 3. 本机演练（drill）实际跑出来的结果（本轮）

```
✔ 迁移文件完整性 sha256 b01c1fec5a9a…（与清单一致，排除 2 条已授权测试资源）
✔ V1 受控库：qls_v1_cutover_drill_* ← 冻结快照还原，14 张表逐张与 footer 一致
✔ V2 目标库：qls_v2_cutover_drill_* ← 全新空库（drill 拒绝复用既有库）
✔ S1–S5 退出码全部 0
✔ S6 十条不变量全部 ✓（347 / 24 / 69 / 0 / 621，管理员恰好 1 名 TsinglanAdmin，悬空 0）
✔ 收尾删掉本次自己建的两个临时库
✔ 全程未触碰演练应用库（复核：resources 354 / users 26 / files 4 / admins 1，与 drill 前一致）
```

日志与导入报告：`deploy/logs/cutover-drill-*.log`、`deploy/logs/import-*.md`（该目录已 gitignore）。

## 4. 回滚（任何一步失败都适用；数据层不做任何删除）

1. **不要动数据**：V2 库与 V1 库都原样保留（执行器全程没有 `DROP` / `TRUNCATE` / 删除对象；
   drill 的临时库例外，它们由本次运行自己创建、自己删除）。
2. **域名回指 V1**：在 Zeabur 把正式域名切回 V1 服务（或把 DNS/CNAME 恢复指向 V1）。
3. **确认 V1 仍然可用**：`curl -s -o /dev/null -w '%{http_code}' https://<正式域名>/` 期望 200，
   并用一个真实 V1 账号登录一次。
4. **V2 降级为预发布**（保留，不删）：便于继续排查，也保留数据。
5. **留痕**：把失败步骤、日志路径、决定写进 `docs/CUTOVER_PREFLIGHT_REPORT.md`。

## 5. 现在还差什么才能真的切

| # | 缺的东西 | 谁提供 | 状态（2026-10-10） |
|---|---|---|---|
| 1 | Zeabur **可写环境变量**的 API token（或业主在控制台代填） | 业主 | **仍缺**：现有 token 调 `createEnvironmentVariable` 返回 `FORBIDDEN`，7 个变量全被拒；连读服务端口也被拒 |
| 2 | 生产 R2 凭据（只读即可做清单，读写用于部署） | 业主 | **已到位**：读写权限实测通过，见 §6 |
| 3 | 24 个账号的教师开放目录（业务决定） | 业主 | 仍缺：在 `.migration/production-grant-decision-sheet.md` 上填写（本机文件，gitignore） |
| 4 | 独立 V2 PostgreSQL | 业主（Zeabur 控制台） | **已到位**：`postgresql-triket`，已建 39 个名额，与 V1 库完全独立 |
| 5 | V1 备份 + **独立恢复演练** | 执行者（部署环境有 `pg_dump`） | 仍缺，见 `docs/STAGE13C_CUTOVER_READINESS.md` §G7 |

上面 1–4 到位后，切换是**一条命令**（§1 的 ③）；5 完成前不得退役 V1。

## 6. 存储（R2）配置现状（2026-10-10 实测）

| 项 | 结果 | 证据 |
|---|---|---|
| 端点 | `https://<accountid>.r2.cloudflarestorage.com`（账号 ID 与密钥只在本机 `.env.production.local`，600 权限、gitignore） | `ListBuckets` 返回该账号**恰好 2 个桶**：`tsinglan-curriculum`、`tsinglan2` |
| 写入桶（V2） | `tsinglan2`（2026-10-10 新建，空桶） | 清单：0 对象 |
| 历史桶（V1） | `tsinglan-curriculum` | 清单：20 对象 / 2,295,707 字节 |
| G5 只读清单门禁 | **PASS** | `.migration/r2-inventory-{tsinglan2,tsinglan-curriculum}.json`，两份都 `complete=true`（`reason=listed-all-pages`，可用于正式对账） |
| 应用自检 | 驱动 `s3` / 已配置 **是** / 可访问 **是**（"对象存储可访问"） | `node scripts/check-storage.mjs` |
| 写权限 | **通过**：探针对象写入 → 读回 sha256 一致 → 删除 → 桶回到 0 对象 | 探针只写 `_preflight/…`，不留残留 |
| 生产配置块能否启动 | **通过**：用最终生产环境变量在本机起进程，`/api/health` 200、`/api/health/ready` 200（`database:ok`，即生产库连接串可用）、`/` 200（SPA） | 端口 3399 本地冒烟，跑完即停 |
| 桶 CORS | **已配置并回读确认** | `V2_PUBLIC_ORIGIN=https://tsinglan.zeabur.app node scripts/configure-bucket-cors.mjs` → 回读 `GetBucketCors`：`AllowedOrigins=[https://tsinglan.zeabur.app]`，方法 `PUT/GET/HEAD`，无通配符；`scripts/check-storage.mjs` 退出码 **0** |
| 浏览器直传链路 | **通过（对生产桶实测）** | 用 `dist` 里的 `S3StorageProvider.presignPut` 签名 → `OPTIONS` 预检 **204** 且 `allow-origin=https://tsinglan.zeabur.app`、`allow-methods=PUT, GET, HEAD` → 带 `Origin` 真发 `PUT` **200** → 读回 sha256 与上传一致 → 删除探针，桶回到 0 对象 |
| 部署后的应用 | **RUNNING（200）** | 部署 `36ba9207`（BUILDING → DEPLOYING → RUNNING，finished `2026-10-11T02:00:59Z`）。`/api/health` **200**、`/api/health/ready` **200**（`database:ok`）；`deploy/verify.mjs --base https://tsinglan.zeabur.app --skip-compose --skip-db` → **退出码 0（9 项通过，1 项未验证：需要管理员凭据的服务端存储检查）**；真实浏览器（Chrome/CDP）桌面 + 移动 9/9 通过；V1 站点同期 200、未受影响 |
| 部署触发 | **可用（自动部署）** | `v2-app` 绑定了 `JackLee324/TsinglanKindergarten` 的 `main`：**push 即自动构建部署**（部署历史逐条对应 commit）。业主提供的令牌可读项目/服务/部署/构建日志，但 **`updateServicePorts` 与 `updateSingleEnvironmentVariable` 均为 FORBIDDEN** —— 平台配置改不了，只能改代码 |
| 构建失败根因（已修） | **修好并本机复现** | 平台把服务变量带进 Docker 构建（日志里可见 `RUN --mount=type=secret,…`）→ deps 阶段 `npm ci` 静默跳过 devDeps → `nest`/`vite` 不存在 → `npm run build` **exit 127**（对应部署 `273467f` FAILED）。复现：`NODE_ENV=production npm ci` = 166 包、无 `.bin/nest`；加 `--include=dev` = 624 包、`.bin/nest` 在。修复后部署日志 `Successfully compiled: 54 files with swc` + 镜像 digest 已推送 |
| 502 根因（已修） | **修好并线上验证** | 服务端口配置 `ports:[{id:"web",port:8080}]` —— 边缘路由到 **8080**，而应用只听 `SERVER_PORT=3300`：构建成功、容器活着、站点 502。端口由平台说了算，所以改成 `resolveServerPort()`：**生产跟随平台 `PORT`**，其余环境仍用 `SERVER_PORT`（本地/测试/演练行为不变）。本机模拟 Zeabur 环境实测：日志 `listening on …:8080（端口来源：PORT）`，`:8080` 200、`:3300` 连不上 |
| 审计序列落后（线上事故，已修） | **数据已修 + 根因已堵 + 已进门禁** | `audit_logs.id` 序列停在 5、表内最大 621（搬运型导入带着显式 id，序列不会自己前进）→ **每次审计写入都主键冲突**，而 `audit.service` 刻意"不让业务失败"→ **静默丢审计**（登录成功却查不到记录）。是"离线重置口令时事务回滚"才暴露的。已 `setval` 到 621 并复核；`push-v2-rows.mjs` 搬完自动修序列；`scripts/check-sequences.mjs`（只读检查 / `--fix`）随时可查；`deploy/cutover.mjs` 的 S6 增加"序列不得落后"硬不变量 |
| 整卡可点（业主 2026-10-11 要求） | **已修并线上实测** | 修前只有标题可点。改为铺满式链接（`ResourceCard`：卡片 `relative` + 标题 `<a>` 的 `after:inset-0`；卡片内按钮容器 `relative z-10`，防止点按钮被整卡链接吞掉）。线上真实鼠标验证：点卡片**中心空白**、**底部空白**、**移动端 390px** 三处都能打开详情。`tests/integration/browser.resource-card-click.test.mjs` 4 条锁住（含「点击点必须在标题文字框之外」这条判据）。顺带修了测试助手盲点：`browser.click()` 发的是合成事件，**绕过浏览器命中测试**，测不出「整卡可点」与「按钮被浮层盖住」这两类缺陷 → 新增 `browser.realClick()`（CDP 真实鼠标）。 |
| 线上登录后验收 | **PASS（15/15）** | 用重置后的 `TsinglanAdmin` 实测：`deploy/verify.mjs` **10/10 退出码 0**（含服务端存储 `reachable=true`）；浏览器真实登录 → 首页/目录（2 个顶层、卡片渲染）/教师账号（20 行，第一行 TsinglanAdmin）/审计（50 行，最新「登录」）；移动端无横向溢出；控制台与网络 0 问题 |
| 安全响应头 / 登录限流（已修） | **线上实测通过** | 六个头（HSTS/XCTO/Referrer-Policy/X-Frame-Options/CSP/Permissions-Policy）线上齐全，CSP 放行生产 R2 origin；登录失败限流线上序列 `401,401,401,429,…`。均为应用自己提供（先前只由演练栈 Nginx 提供） |

### V1 的历史文件要不要搬？——**不需要**（这就是 `resource_files=0` 是对的）

1. 送进 V2 的 347 行资源快照里，`file_path` / `file_bucket_id` **全为 NULL**（逐行统计 = 0）。
2. `tsinglan-curriculum` 里唯一被数据库引用的对象
   （`uploads/76b60eb6-…/1791293126057-校服申领登记.png`，1,618,105 字节）属于
   被排除的 smoke 资源 —— `.migration/prod-exports/v2-cutover-20261008.exclusion.json`
   按业主授权规则排除（ID + 标题字面量 `test` + 同一张 smoke 图，三条同时命中）。
3. 其余 19 个对象是 V1 开发期的探针残留（`prod-probe` / `browser-probe` / `sig` /
   `全链路-…`，含 0 字节与 69 字节的失败上传），数据库里早已没有任何行引用它们。

**结论：桶里的东西一条都不该进 V2；不得为了"看起来有文件"把 smoke 数据搬进生产桶。**
`tsinglan-curriculum` 保持只读、原样保留（回滚仍可能需要它）。
