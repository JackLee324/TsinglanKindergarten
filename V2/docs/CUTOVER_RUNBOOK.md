# 正式切换运行手册（CUTOVER RUNBOOK）

> 配套脚本：`deploy/cutover.mjs`（执行器）＋ `deploy/verify.mjs`（部署后自检）＋
> `docs/DISASTER_RECOVERY.md`（灾备）。门禁编号与状态见
> `docs/STAGE13C_CUTOVER_READINESS.md` §3。
> 状态词只用 `PASS / BLOCKED / NOT RUN`；**没实际执行过的一律不计为通过**。

## 0. 一句话现状

**数据链路已在本机演练栈上整条跑通（drill，PASS）；正式环境的执行仍然 BLOCKED**
—— 卡在 Zeabur 环境变量写权限与教师授权决定（两件都不是代码问题）。

2026-10-10 更新（§6）：**生产 R2 已配置并实测通过**（G5 清单门禁 PASS），
**独立 V2 库已存在**；存储侧只剩"CORS 等 V2 域名"这一项，随部署一起做。

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
| 部署后的应用 | **BLOCKED（502）** | `https://tsinglan.zeabur.app/` 与 `/api/health` 连续 3 次探测均 **502 Bad Gateway**（`http://` 会 302 到 https）。同一时刻 V1 站点 200、未受影响。待查：部署是否仍在构建、服务端口是否为 3300、环境变量是否保存成功 |

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
