# 正式切换运行手册（CUTOVER RUNBOOK）

> 配套脚本：`deploy/cutover.mjs`（执行器）＋ `deploy/verify.mjs`（部署后自检）＋
> `docs/DISASTER_RECOVERY.md`（灾备）。门禁编号与状态见
> `docs/STAGE13C_CUTOVER_READINESS.md` §3。
> 状态词只用 `PASS / BLOCKED / NOT RUN`；**没实际执行过的一律不计为通过**。

## 0. 一句话现状

**数据链路已在本机演练栈上整条跑通（drill，PASS）；正式环境的执行仍然 BLOCKED**
—— 卡在 Zeabur 访问、生产 R2 清单与教师授权决定（三件都不是代码问题）。

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

| # | 缺的东西 | 谁提供 | 提供方式（**不要贴到聊天里**） |
|---|---|---|---|
| 1 | Zeabur 访问（CLI 登录态或 API token） | 业主 | 在 Zeabur 控制台生成 token，放本机 `~/.zeabur` 登录态或 `ZEABUR_TOKEN` 环境变量 |
| 2 | 生产 R2 只读凭证（或控制台导出的完整对象清单 JSON） | 业主 | 只读 Access Key/Secret 放本机环境变量；或从 R2 控制台导出 JSON 交给 `scripts/r2-inventory.mjs --from-console` |
| 3 | 24 个账号的教师开放目录（业务决定） | 业主 | 在 `.migration/production-grant-decision-sheet.md` 上填写（本机文件，gitignore） |
| 4 | 独立 V2 PostgreSQL | 业主（Zeabur 控制台） | 建库后把连接串交给 `--target` |
| 5 | V1 备份 + **独立恢复演练** | 执行者（部署环境有 `pg_dump`） | 见 `docs/STAGE13C_CUTOVER_READINESS.md` §G7 |

上面 1–4 到位后，切换是**一条命令**（§1 的 ③）；5 完成前不得退役 V1。
