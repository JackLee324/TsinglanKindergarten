# Stage 13C / 13C.1 / 13C.2 / 13C.3 / 13C.4 / 13C.5：正式切换就绪（Production Cutover Readiness）

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

## 1. 本轮做完的九件事（13C 四件 + 13C.1–13C.5 工具加固）

| # | 事 | 产物 | 证据 |
|---|---|---|---|
| 1 | **交接脚本加固**（业主 §4） | `scripts/lib/db-target.mjs`、`scripts/transfer-superadmin.mjs` | 缺 `DATABASE_URL`（含空白值）→ **exit 2 且一个连接都不建**；动作前打印**脱敏**目标（`user@host:port/dbname`）并标明本机/非本机；口令永不回显。测试：`tests/unit/db-target.test.mjs` **9 条** + `tests/integration/account-privileges.test.mjs` **17 条**（含"缺变量不动数据"与"输出里不含口令"） |
| 2 | **权限矩阵状态同步**（业主 §1） | `docs/PRODUCTION_PERMISSION_MATRIX.md` | 拆成三件事：超级管理员 **PASS**（唯一 `TsinglanAdmin`）、教师目录授权 **BLOCKED**、生产登录 **NOT RUN**；删掉"管理员身份仍需逐条确认"的过期文字；新增 §4 数据隔离、§5.3 目录清单（69 个）、§6 决策流程 |
| 3 | **预检报告同步 + 门禁清单**（业主 §1/§3） | `docs/CUTOVER_PREFLIGHT_REPORT.md` | §0 结论块拆开写；§7 重写为"身份 PASS / 授权 BLOCKED / 登录 NOT RUN"；新增 §12.1 **G1–G10 门禁表**；§12 按业主给的五步顺序重排 |
| 4 | **两件只读工具**（业主 §1/§3） | `scripts/propose-directory-grants.mjs`、`scripts/r2-inventory.mjs` | 授权决策清单（不连库、不猜、不覆盖业主填过的表）；R2 对象清单（**源码里没有任何写/删动作**，由 `tests/unit/r2-inventory-safety.test.mjs` 静态盯住） |
| 5 | **R2 工具加固**（业主 Stage 13C.1 审查发现的 3 个问题） | `scripts/lib/{csv,inventory-source,r2-target}.mjs` | ① **默认只允许 HTTPS**（http 仅限 `--allow-http-local` + 本机地址，远端 http 永远拒绝）；② CSV 改走 **RFC 4180** 解析（引号/内嵌逗号/CRLF/BOM/带引号换行），坏行**报错**而不是跳过；③ 产物带**完整性元数据**（`complete` / `usableForProductionComparison` / `scope`），`--compare` 拒绝不完整清单与范围不一致 |
| 9 | **API 端点非空校验**（业主 Stage 13C.5 复核发现的最后边界） | `scripts/lib/r2-target.mjs` | `api-list` 清单的 `scope.endpointHost` 与 `storageIdentity.endpointHost` 现在必须**都非空、都合法、规范化后一致** —— 只比「两个字段是否相等」的话，把两者**一起**改成 `null`/空串就能混过自洽校验；端点规范化抽成 `normalizeEndpointHost()`，与 `resolveR2Config()` **共用同一套规则**（完整 URL 或 `host[:port]`、大小写归一、端口范围校验），`console-export` 的空端点不受影响 |
| 8 | **身份类型自洽**（业主 Stage 13C.4 复核发现的最后一道缺口） | `scripts/lib/r2-target.mjs` | 自洽校验现在也管身份：`api-list` 清单**必须**是 `api-endpoint-fingerprint`（指纹格式合法、`storageIdentity.endpointHost` 与 `scope.endpointHost` 一致）——把身份块改成 `operator-declared` + 一个标签、或改成 `unknown`，都不再能让比较改走标签匹配从而绕过指纹；控制台导出**只能**是 `operator-declared`（标签非空、指纹为空）或诚实的未知（不带任何标签/指纹），**不许伪装成 API 指纹清单**；`assertComparable` 在输出任何差异之前对**两份**清单都跑完整自洽校验 |
| 7 | **参数解析与来源身份**（业主 Stage 13C.3 复核发现的 2 个边界） | `scripts/r2-inventory.mjs`、`scripts/lib/r2-target.mjs` | ① **`--max` 严格解析**：判据是"参数有没有出现"而不是"数值是不是 0" —— `--max 0` / 负数 / 小数 / 非数字 / 缺少数值一律退出码 2（以前会被静默变成 0，**绕过"只要用了 `--max` 就不完整"这条门禁**）；② **存储身份**：产物带 `storageIdentity`（实时列举 = `sha256(端点\|AccessKey)` 指纹，只落指纹不落凭据；控制台导出 = `--storage-id <标签>` 操作者声明；都不给 = 未知），**桶名相同不再足以证明是同一个存储** → 身份未知/不同一律拒绝比较；③ **旧清单自洽校验**：`readOnly`/`complete`/`usableForProductionComparison`/`verification`/`reason`/计数/`summary.count`/`scope` 必须互相印证，被手改或旧版本写的产物直接拒绝 |
| 6 | **完整性最后一道门禁**（业主 Stage 13C.2 复核发现的 3 个边界） | `scripts/r2-inventory.mjs`、`scripts/lib/{inventory-source,r2-target}.mjs` | ① **只要用了 `--max` 就恒不完整**（空桶 / 未触顶 / 刚好等于上限都不例外，两个来源统一）；② **控制台导出不再自动算完整**：必须 `--expect-count <控制台对象数> --expect-source <来源>` 且工具核对一致才标 `complete=true`（产物分开记录「操作者声明」与「工具验证」）；文件自带 `IsTruncated` / 下一页令牌 / 总数不符 → 直接失败；③ **声明的 Prefix 真的过滤对象集合**（不再只改元数据），前缀下没有对象直接拒绝 |

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
| G5 | R2 对象清单 | `node scripts/r2-inventory.mjs --out .migration/r2-inventory.json`（或 `--from-console <导出> --bucket <桶名> --expect-count <控制台对象数> --expect-source <来源> --storage-id <标签>`） | 有一份**`complete=true`、`verification` 非 `none`、字段自洽**的清单（`--max` 产物恒不算证据，未核对数量的控制台导出也不算）+ 前缀分布 + 范围声明（桶/前缀/是否过滤）+ **存储身份**（指纹或操作者声明）；据此说明"有无需要迁移的文件" | **BLOCKED（缺只读凭证/导出）** |
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

### G5 R2 对象清单（BLOCKED：缺只读凭证或控制台导出）

**优先用完整 JSON 导出**（没有歧义）；只有 CSV 时才依赖 RFC 4180 解析器。
两种方式都**只读**：工具只调用 List/Head，源码里没有任何写/删动作。

```bash
# 方式 A：只读凭证（走环境变量，不要写进命令行历史、不要贴到聊天里）
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
R2_BUCKET=<桶名> R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
node scripts/r2-inventory.mjs --out .migration/r2-inventory.json

# 方式 B：没有只读凭证 —— 从 R2 控制台导出清单，完全不连网（**优先 JSON**）
node scripts/r2-inventory.mjs --from-console ~/Downloads/r2-objects.json \
  --bucket <桶名> --expect-count <控制台显示的对象数> --expect-source "R2 控制台 <时间>" \
  --storage-id <存储身份标签，例如 cf-account-tsinglan> \
  --out .migration/r2-inventory.json

# 逐次对比（两次都必须是完整清单；桶/前缀**以及存储身份**都必须一致）
node scripts/r2-inventory.mjs --from-console ~/Downloads/r2-objects-2.json \
  --bucket <桶名> --expect-count <新数字> --expect-source "R2 控制台 <时间>" \
  --storage-id cf-account-tsinglan --compare .migration/r2-inventory.json
```

**核心规则（Stage 13C.1 + 13C.2 加固后）**：

| 情形 | 产物 | 能否用于正式对账 |
|---|---|---|
| 实时列举，未用 `--max` | `complete=true`，`verification=tool-listed-all-pages` | ✅ 可以 |
| **任何用了 `--max` 的清单**（空桶 / 未触顶 / 刚好等于上限都一样） | `complete=false`，`reason=truncated-by-max` | ❌ 不可以 |
| 控制台导出，**没有** `--expect-count` | `complete=false`，`reason=console-export-unverified` | ❌ 不可以（格式正确 ≠ 覆盖整个桶） |
| 控制台导出 + `--expect-count` 与解析结果**一致** | `complete=true`，`verification=tool-verified-count-match`，`declaredBy=operator:--expect-count` | ✅ 可以（数量核对通过） |
| 控制台导出 + 数量**不一致** | 退出码 **9**，**不产出产物** | — |
| 导出文件自称 `IsTruncated: true` / 带下一页令牌 / 自带总数与行数不符 | 退出码 **8** | — |
| 两份清单**存储身份不同**（跨账号同桶名） | 退出码 **7**，且不输出差异 | — |
| 两份清单**身份无法确认**（控制台导出没给 `--storage-id`） | 退出码 **6**，且不输出差异 | — |
| 前一份清单**字段不自洽**（被手改 / 旧版本产物） | 退出码 **6**，且不输出差异 | — |
| 清单**身份类型与来源不符**（API 清单自称"操作者声明"、控制台清单自称指纹） | 退出码 **6**，且不输出差异 | — |
| API 清单**指纹缺失 / 格式不合法 / 端点与 scope 不一致** | 退出码 **6**，且不输出差异 | — |
| API 清单**两个端点被一起改成 null / 空串 / 纯空白 / 非法格式** | 退出码 **6**，且不输出差异 | — |

**三条保证（Stage 13C.1 加固后）**：

| 项 | 行为 |
|---|---|
| 端点安全 | 默认**只接受 `https://`**；`http://` 必须显式 `--allow-http-local` **且**指向本机（`127.0.0.1` / `::1` / `localhost`），远端 http 任何情况下都拒绝；缺配置/空白配置在**创建 S3 客户端之前**就失败；报错里不含 Access Key / Secret Key |
| 解析健壮性 | JSON 支持数组 / `objects` / `Contents`；CSV 走 RFC 4180（引号、字段内逗号、双引号转义、CRLF、UTF-8 BOM、带引号的换行）；**空 key / 非法 size / 列数不符 / 重复 key / 结构无法解释 → 明确报错并带行号**，不静默跳过（CSV 尤其重要：对象键里本来就可能有逗号） |
| 完整性 | 默认走完全部分页 → `complete=true`；**只要用了 `--max` → `complete=false`**（无论是否触顶）且 `usableForProductionComparison=false`；控制台导出必须 `--expect-count` 核对一致才算完整；`--compare` 遇到任一份不完整 → 拒绝（退出码 6）；桶/前缀/endpoint 主机不一致 → 拒绝（退出码 7）；`--max` 与 `--compare` 同用 → 直接拒绝（2） |
| 范围一致性 | 声明的 `--prefix` **真的过滤对象集合**（`prefixFilterApplied=true`），过滤后为空则拒绝产出；没有声明前缀时不会替你把子集说成整桶（只给一句提示）；对比时桶 / 前缀 / endpoint 主机必须完全一致 |
| 参数解析 | `--max` 只接受**正整数**；`--max 0` / 负数 / 小数 / 非数字 / 缺少数值 → 退出码 **2**（判据是"参数有没有出现"，绝不静默退化成"全量"）；`--max` 与 `--compare` 同用 → 退出码 2 |
| 端点非空与格式 | `api-list` 清单的两个端点字段必须都非空、符合现有端点规范（`normalizeEndpointHost` 与 `resolveR2Config` 同一套规则）、规范化后一致；`null` / 空串 / 纯空白 / 非法格式 / 只改一侧 → 一律拒绝。`console-export` 的空端点按设计保留 |
| 身份类型自洽 | 身份类型必须与来源匹配：`api-list` → 必须是指纹（格式合法 + 端点与 `scope` 一致，补 `declaredId` 也没用）；控制台导出 → 只能是"操作者声明（有标签、无指纹）"或"诚实的未知（无标签无指纹）"，伪装成指纹直接拒绝；**身份块被手改的清单进不了比较** |
| 旧清单自洽 | 对比前逐字段核对 `readOnly` / `complete` / `usableForProductionComparison` / `verification` / `reason` / `expectSource` / `expectedCount` / `observedCount` / `summary.count` / `scope`；**缺字段、互相矛盾、或来源身份不明 → 拒绝**，不接受"补一下元数据再放行" |

**退出码**：0 成功 / 2 参数或配置不合法（含默认拒绝 http、`--max` 取值无效、`--max`+`--compare` 同用）/
3 列举失败 / 4 产物已存在（拒绝覆盖）/ 5 对比发现对象消失（**交人工判断**）/
**6 对比里有不完整 / 字段自相矛盾 / 来源身份无法确认的清单** /
**7 对比范围不同或存储身份不同** /
8 清单来源解析失败（CSV/JSON 坏行、缺 key、非法 size、分页未走完、自带总数不符）/
9 预期数量与实际解析结果不一致（不产出可对账的完整清单）。

**通过判据（G5 才能从 BLOCKED 转 PASS）**：产物里 `complete=true`；范围（桶 + 前缀）明确；
对象数与总字节数有记录；与数据库记录核对过；并且**在清单核实之前不删除、不覆盖任何生产对象**。

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
   **也不为了"本地能跑"放宽生产默认安全规则** —— http 只对本机模拟器、且要显式开关；
6. 不用"文档里写了"代替"实际执行过" —— 状态词按 §3 的判据填写。

## 6. 本轮实际执行的证据

| 命令 | 结果 |
|---|---|
| `node --test tests/unit/db-target.test.mjs` | **9 / 9 PASS** |
| `node --test tests/unit/r2-inventory-safety.test.mjs` | **15 / 15 PASS**（含端点安全 6 条：默认拒绝 http、远端 http 即使开了本地开关也拒绝、本地模拟器放行、https 放行、其它协议拒绝、loopback 判定） |
| `node --test tests/unit/r2-inventory-parsing.test.mjs` | **16 / 16 PASS**（业主点名的 10 种情形 + 表头别名 + JSON 三种形状 + 结构错误 + 缺 key/非法 size/重复 key） |
| `node --test tests/unit/r2-inventory-completeness.test.mjs` | **24 / 24 PASS**（`--max` 三种边界 + **真起本机 S3 后端**验证"显式 `--max` 未触顶仍不完整"、控制台导出的四种完整性情形、`--expect-count` 一致/不一致（退出码 9 且不产出）、`IsTruncated`/下一页令牌/自带总数不符（退出码 8）、前缀过滤、对比拒绝不输出差异、退出码 2/4/5/6/7） |
| `node --test tests/unit/grant-decision-sheet.test.mjs` | **4 / 4 PASS** |
| `node --test tests/integration/account-privileges.test.mjs` | **17 / 17 PASS**（含"缺 `DATABASE_URL` 不动数据"、"输出不含口令"） |
| `node scripts/transfer-superadmin.mjs`（不设 `DATABASE_URL`） | 退出码 **2**，提示"不接受任何默认库"，**未建立连接** |
| `node scripts/propose-directory-grants.mjs` | 生成 24 账号 / 69 目录 / 11 项可授予权限的决策清单；**未连数据库** |
| `node scripts/r2-inventory.mjs --from-console …` | 清单 + 前缀分布 + 完整性标记；**带逗号的对象键**（`uploads/x/校服申领登记,副本.png`）+ BOM + CRLF 的 CSV 解析后 key 完整保留（`split(',')` 会把它劈成两列）；重复写同一产物 → 退出码 **4**；对比有对象消失 → 退出码 **5** |
| `R2_ENDPOINT=http://…`（默认） | 退出码 **2**，提示"必须是 https"并说明本地开关；**未创建 S3 客户端** |
| `--from-console`（整桶导出）+ `--prefix uploads/` | 输出"前缀过滤：保留 3 个"，产物 `prefixFilterApplied=true`、`objects` 只剩前缀内对象（元数据与实际集合一致） |
| `--max 10`（4 个对象）/ `--max 4`（刚好等于上限）/ 空清单 + `--max 10` | 三者产物都是 `complete=false`、`usableForProductionComparison=false` |
| `npm run build` / `npm run typecheck` / `npm run lint` | 全部退出码 0 |
| `npm run test:unit` | **329 / 329 PASS**（Stage 13B 是 206，本轮 +123：db-target 9、r2-inventory-safety 15、r2-inventory-parsing 16、r2-inventory-completeness 24、**r2-inventory-args 17**、**r2-inventory-identity 38**、grant-decision-sheet 4） |
| `npm run test:integration` | **615 / 615 PASS**（Stage 13B 是 614，本轮 +1：交接脚本"缺 `DATABASE_URL` 就不动数据"）。<br>⚠️ 13C.3 那一轮第一次跑出现过 **1 条偶发红**（`browser.stage4` 的"教师成长"导航）：单独跑 **16 / 16**、紧接着的全量 **615 / 615** 全绿；与 13C.1 时观察到的 stage11 偶发红同类，**尚未定位到根因** —— 若再出现请保留完整输出再查，不要当偶发忽略 |
| `npm run test:safari`（桌面 1440×900） | **10 / 10 PASS**（13C.3 轮） |
| `SAFARI_VIEWPORT=mobile npm run test:safari` | **10 / 10 PASS**（13C.4 轮单独跑；见下面的两条前提） |

> ⚠️ Safari 那两条有**两个环境前提**：① `safaridriver` 在跑之外，**Safari 应用本身也要开着**
> （关掉时 10 条会全部因会话建不起来而"cancel"，报错里已写明"先执行一次 `open -a Safari`"）；
> ② 桌面与移动**不要背靠背连着跑**——Stage 13C.2 那一轮连着跑时，移动那条在"② 全靠点击进目录"
> 上偶发红了 4 步，单独重跑（先 `open -a Safari`）立刻 **10 / 10**。
> 这两条都记在这里，避免下次把环境问题误读成产品问题。
