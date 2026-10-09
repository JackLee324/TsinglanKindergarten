# Stage 13C：正式切换就绪（Production Cutover Readiness）

> 业主 Stage 13C 的范围是**收尾门禁**，不是加功能：把文档里的矛盾消掉、把最高权限脚本加固、
> 把"缺什么才能切换"变成一张可执行、可核对的清单。
> 状态词只用 `PASS / BLOCKED / NOT RUN / UNVERIFIED`；**没有实际执行过的，一律不计为通过**。
> 本轮**没有部署、没有切换、没有删除任何生产数据**；V1 源码零改动。

## 0. 结论

```
超级管理员唯一化（身份）      : PASS        （TsinglanAdmin 唯一；服务端强制 + 测试盯住）
教师目录授权决策              : BLOCKED     （24 个账号 0 条授权；V1 导出里没有任何可推导数据）
生产账号登录验证              : NOT RUN     （必须在正式环境用真实账号跑）
R2 对象清单                  : BLOCKED     （缺只读凭证 / 控制台导出；工具已就绪且只读）
独立 V2 PostgreSQL           : BLOCKED     （无 Zeabur 访问）
V1 备份 + 恢复演练            : NOT RUN     （前置：独立库）
Zeabur 预发布 + 真实浏览器验收 : NOT RUN     （前置：解除 Zeabur 阻断）
回滚步骤（可执行、经验证）     : NOT RUN
正式切换 / V1 退役            : NOT RUN     （禁止先做）
PRODUCTION CUTOVER           : NOT READY
```

## 1. 本轮做完的四件事

| # | 事 | 产物 | 证据 |
|---|---|---|---|
| 1 | **交接脚本加固**（业主 §4） | `scripts/lib/db-target.mjs`、`scripts/transfer-superadmin.mjs` | 缺 `DATABASE_URL`（含空白值）→ **exit 2 且一个连接都不建**；动作前打印**脱敏**目标（`user@host:port/dbname`）并标明本机/非本机；口令永不回显。测试：`tests/unit/db-target.test.mjs` **9 条** + `tests/integration/account-privileges.test.mjs` **17 条**（含"缺变量不动数据"与"输出里不含口令"） |
| 2 | **权限矩阵状态同步**（业主 §1） | `docs/PRODUCTION_PERMISSION_MATRIX.md` | 拆成三件事：超级管理员 **PASS**（唯一 `TsinglanAdmin`）、教师目录授权 **BLOCKED**、生产登录 **NOT RUN**；删掉"管理员身份仍需逐条确认"的过期文字；新增 §4 数据隔离、§5.3 目录清单（69 个）、§6 决策流程 |
| 3 | **预检报告同步 + 门禁清单**（业主 §1/§3） | `docs/CUTOVER_PREFLIGHT_REPORT.md` | §0 结论块拆开写；§7 重写为"身份 PASS / 授权 BLOCKED / 登录 NOT RUN"；新增 §12.1 **G1–G10 门禁表**；§12 按业主给的五步顺序重排 |
| 4 | **两件只读工具**（业主 §1/§3） | `scripts/propose-directory-grants.mjs`、`scripts/r2-inventory.mjs` | 授权决策清单（不连库、不猜、不覆盖业主填过的表）；R2 对象清单（**源码里没有任何写/删动作**，由 `tests/unit/r2-inventory-safety.test.mjs` 静态盯住） |

## 2. 数据隔离：演练库**不是**迁移来源（业主 §2）

| 数据来源 | 资源 | 账号 | 目录 | 文件记录 | 审计记录 |
|---|---|---|---|---|---|
| **正式迁移文件** `v2-cutover-20261008.ndjson`（sha256 `b01c1fec…`） | **347** | **24** | **69** | **0** | **621** |
| 本机演练库（Stage 13B 验收用，**仅供验收**） | 354 | 26 | 69 | 4 | — |

差异全部来自演练环境自己的测试数据：`349 → 347` 是排除两条已授权的 smoke 测试资源；
`24 → 26` 是验收新建并已停用的 `s13b_ui_teacher` / `s13b_read_teacher`；`0 → 4` 是验收上传的 4 个文件。

**规则（三条，写死）**：

1. 正式切换**只**用经 SHA-256 校验的迁移文件（`node scripts/prepare-v2-cutover-snapshot.mjs --check`）；
2. **不得**从演练库导出、**不得**做"演练库 → 正式库"的复制；测试资源/账号/对象一律不进正式环境；
3. 维护窗口内**重新核验最终生产快照**（sha256 + 计数 + dangling = 0）之后才导入。

## 3. 门禁清单（G1–G10）

| # | 门禁 | 怎么验（命令 / 动作） | 通过判据 | 状态 |
|---|---|---|---|---|
| G1 | 迁移文件完整性 | `node scripts/prepare-v2-cutover-snapshot.mjs --check` | 退出码 0；347/24/69/0/621；引用完整 | PASS（Stage 12C） |
| G2 | 迁移来源隔离 | 本文件 §2 + 矩阵 §4 | 演练数据不进正式库（规则 + 计数对照） | PASS（规则已写死） |
| G3 | 超级管理员唯一 | `tests/integration/account-privileges.test.mjs`；`scripts/transfer-superadmin.mjs` | 只能有一名有效 `ADMIN`；换人走交接脚本；缺 `DATABASE_URL` 不动数据 | PASS（本轮） |
| G4 | 教师目录授权决策 | `node scripts/propose-directory-grants.mjs` → 业主填写 → `/admin/permissions` 初始化 | 24 个账号逐条有明确决定（含"暂不开放"）；**不是**全站开放 | **BLOCKED（等业务）** |
| G5 | R2 对象清单 | `node scripts/r2-inventory.mjs --out .migration/r2-inventory.json`（或 `--from-console <导出>`） | 有一份对象清单 + 前缀分布；据此说明"有无需要迁移的文件" | **BLOCKED（缺只读凭证/导出）** |
| G6 | 独立 V2 PostgreSQL | Zeabur 控制台建库（与 V1 完全分离） | 连接串可达；`node scripts/migrate.mjs status` = 0 pending | **BLOCKED（无 Zeabur 访问）** |
| G7 | V1 备份 + **恢复演练** | 备份 V1 → 在**另一个库**恢复 → 行数/关键表核对 | 恢复出来的行数与备份源一致；演练有记录 | **NOT RUN** |
| G8 | 预发布部署 + 真实浏览器验收 | `deploy/verify.mjs --base <预发布域名>`；`tests/production/*`（桌面 + 移动） | 全部通过；样式真的生效；上传/预览/下载哈希一致 | **NOT RUN** |
| G9 | 回滚步骤（可执行、经验证） | `docs/DISASTER_RECOVERY.md` + 实际演练记录 | 演练过一遍并写下耗时与判定点 | **NOT RUN** |
| G10 | 正式切换 + V1 退役 | 维护窗口；G1–G9 全 PASS 后才允许 | 域名切换 + 生产浏览器验收通过；V1 **只读保留**一段时间 | **NOT RUN（禁止先做）** |

## 4. 每个未完成门禁的操作手册

### G4 教师目录授权（BLOCKED）

```bash
# ① 只读生成决策清单（从冻结的迁移文件读 24 个账号 + 69 个目录；不连数据库）
node scripts/propose-directory-grants.mjs
#   → .migration/production-grant-decision-sheet.md（业主填）
#   → .migration/production-grant-decision-sheet.json（机器可读）
# 全程不连数据库；产物已存在时会拒绝覆盖（业主填过的表不能被抹掉）
```

1. **业主**在决策表上逐个账号填写"开放哪些目录"（可写"暂不开放"）；
2. **管理员**在正式环境 `/admin/permissions` 上按账号勾选初始化（**唯一**会写 `user_permissions` 的地方）；
3. 初始化后，用**真实账号**各登录一次（≥1 管理员 + 1 教师），结果回填矩阵 §3；
4. 全部完成后，矩阵里"教师目录授权"才从 `BLOCKED` 改成 `PASS`。

> ⚠️ **不得**给所有教师开放全部目录；**不得**按 V1 角色名批量换算 ——
> 那会把"角色制"换成"人人全站可见"，是权限降级，不是初始化。

### G5 R2 对象清单（BLOCKED）

```bash
# 方式 A：只读凭证（走环境变量，不要写进命令行历史、不要贴到聊天里）
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
R2_BUCKET=<桶名> R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
node scripts/r2-inventory.mjs --out .migration/r2-inventory.json

# 方式 B：没有只读凭证 —— 从 R2 控制台导出清单，完全不连网
node scripts/r2-inventory.mjs --from-console ~/Downloads/r2-objects.csv \
  --out .migration/r2-inventory.json

# 之后可以逐次对比（有对象"消失"时退出码 5，交给人工判断）
node scripts/r2-inventory.mjs --from-console ~/Downloads/r2-objects-2.csv \
  --compare .migration/r2-inventory.json
```

工具的三条保证：**只有 List/Head**（无任何写/删，静态测试盯着）；**缺配置就退出**（不猜桶）；
**产物只有 key/size/etag/时间**（不含凭证）。
**在清单核实之前，不删除、不覆盖任何生产对象。**

### G6 独立 V2 PostgreSQL（BLOCKED）

在 Zeabur 控制台新建一个**与 V1 完全分离**的库，拿到的连接串只放进密钥管理；
建好之后的第一件事是 `node scripts/migrate.mjs status`（期望 0 pending）与
`node scripts/migrate.mjs verify`。

### G7 V1 备份 + 恢复演练（NOT RUN）

**必须做的是"恢复演练"，不是"备份完成"。** 两件事分开准备：

1. **逻辑往返演练（本机可以跑，已存在）**：V1 仓库里的
   `scripts/backup-rehearse.mjs`（逐表导出 → 新建空库 → 重跑迁移 → 导入 → 逐表行数 + 校验和比对）。
   它自己会声明**不能**替代 `pg_dump`/PITR（不含角色、序列、WAL、RLS 定义等）。
   本机的嵌入式 PostgreSQL 只带 `initdb/pg_ctl/postgres`，**没有 `pg_dump`** ——
   脚本会明确打印"没有执行 pg_dump 备份"，不会假装跑过。
2. **生产备份 + 恢复（部署环境执行）**：

```bash
# 备份（在能访问生产集群的地方执行；口令走环境变量，不要写进命令行历史）
pg_dump --format=custom --no-owner --no-privileges \
  --file=qls_$(date +%Y%m%dT%H%M%S).dump "$PRODUCTION_DATABASE_URL"

# 恢复演练（**另一个**库，绝不覆盖生产库）
createdb qls_restore_verify
pg_restore --no-owner --no-privileges --dbname=qls_restore_verify qls_*.dump
psql -d qls_restore_verify -c "SELECT count(*) FROM resources;"
```

通过判据：恢复出来的**行数与备份源一致**（关键表逐表核对），并且演练有时间、有判定人、有记录。
在此之前，**不得**退役或只读化 V1。

### G8 / G9 预发布部署与回滚

按 `docs/CUTOVER_PREFLIGHT_REPORT.md` §11–§12 与 `docs/DISASTER_RECOVERY.md` 执行：
预发布域名上跑 `deploy/verify.mjs` + `tests/production/*`（桌面 + 移动）；
回滚步骤要**实际演练一遍**并写下耗时与判定点。
每一步都要留下**命令 + 输出 + 判定**，写回预检报告，不允许"跑了但没记"。

## 5. 负面清单（本轮明确不做）

1. 不给所有教师开放全部目录、不按角色名批量授权；
2. 不删除、不覆盖任何生产对象（R2 清单核实之前尤其如此）；
3. 不把演练库当作迁移来源，不做"演练 → 正式"的数据复制；
4. 不重新部署 V1、不退役 V1（前置门禁未满足）；
5. 不把 R2 Secret / 数据库口令贴到聊天、命令行历史或仓库里（工具只从环境变量读）；
6. 不用"文档里写了"代替"实际执行过" —— 状态词按 §3 的判据填写。

## 6. 本轮实际执行的证据

| 命令 | 结果 |
|---|---|
| `node --test tests/unit/db-target.test.mjs` | **9 / 9 PASS** |
| `node --test tests/unit/r2-inventory-safety.test.mjs` | **9 / 9 PASS** |
| `node --test tests/unit/grant-decision-sheet.test.mjs` | **4 / 4 PASS** |
| `node --test tests/integration/account-privileges.test.mjs` | **17 / 17 PASS**（含"缺 `DATABASE_URL` 不动数据"、"输出不含口令"） |
| `node scripts/transfer-superadmin.mjs`（不设 `DATABASE_URL`） | 退出码 **2**，提示"不接受任何默认库"，**未建立连接** |
| `node scripts/propose-directory-grants.mjs` | 生成 24 账号 / 69 目录 / 11 项可授予权限的决策清单；**未连数据库** |
| `node scripts/r2-inventory.mjs --from-console …` | 清单 + 前缀分布；重复写同一产物 → 退出码 **4**（拒绝覆盖）；对比有对象消失 → 退出码 **5** |
| `npm run build` / `npm run typecheck` / `npm run lint` | 全部退出码 0 |
| `npm run test:unit` | **228 / 228 PASS**（Stage 13B 是 206，本轮 +22：db-target 9、r2-inventory-safety 9、grant-decision-sheet 4） |
| `npm run test:integration` | **615 / 615 PASS**（Stage 13B 是 614，本轮 +1：交接脚本"缺 `DATABASE_URL` 就不动数据"） |
| `npm run test:safari`（桌面 1440×900） | **10 / 10 PASS** |
| `SAFARI_VIEWPORT=mobile npm run test:safari` | **10 / 10 PASS** |

> ⚠️ Safari 那两条有一个**环境前提**：`safaridriver` 在跑之外，
> **Safari 应用本身也要开着**（关掉时 10 条会全部因会话建不起来而"cancel"，
> 报错里已经写明"先执行一次 `open -a Safari`"）。本轮第一次跑就撞上了这个前提，`open -a Safari` 后立刻 10/10。
