# Stage 12C 生产切换预检报告（CUTOVER PREFLIGHT）

> 本轮**没有部署、没有切换、没有删除任何数据**。
> 状态词严格按业主 §12 的定义使用：`PASS`（本次实际执行有证据）、`FAIL`、`UNVERIFIED`、
> `BLOCKED`、`NOT CONFIGURED`、`NOT RUN`。**未运行/被阻断的项目一律不计为通过。**

## 0. 结论先说

```
CODE & BUILD          : PASS（Git/代码核对，见 §1）
MIGRATION 数据准备     : PASS（V2 专用迁移文件已生成，见 §3）
TEST RESOURCES EXCLUDED: PASS（2 条，精确排除，见 §3）
DIRECTORY MAPPING      : PASS（347/347，本轮在新文件上重跑，见 §5）
ACCOUNT & PERMISSIONS  : BLOCKED（矩阵已生成，业务身份/开放目录待业主确认，见 §6）
FILE MIGRATION         : PASS（范围核实：排除后生产**没有业务文件**，见 §7）
SECURITY               : NOT RUN（需在真实部署上验证，见 §8）
ZЕABUR DEPLOYMENT      : BLOCKED（本机无 Zeabur 访问能力，见 §2）
PRODUCTION DOMAIN      : BLOCKED（同上）
BACKUP & RESTORE       : NOT RUN（需在 Zeabur 数据库上执行）
V1 RETIREMENT          : NOT RUN（前置条件未满足，禁止先删）
ROLLBACK READINESS     : NOT RUN
GO-LIVE                : NOT READY
```

## 1. §2.1 代码与 Git（PASS）

| 项 | 实际值 |
|---|---|
| 分支 / HEAD | `main` / `3e5bb65` |
| 工作区 | 干净（`git status --short` 为空） |
| 与远端 | `## main...origin/main`，`git fetch --dry-run` 无输出 → 一致 |
| V2 关键修复是否在 HEAD | 是：目录 resolver（`scripts/lib/resolve-legacy-directory.mjs`）、迁移回归、`allow_files` 修复、多目录浏览器验证均在 |
| V1 源码 | **未被修改**（`git diff` 对 `V2/` 之外为空） |

## 2. §2.2 Zeabur 访问能力：**BLOCKED**

**本次实际检查结果**（不是推测）：

| 检查项 | 结果 |
|---|---|
| `zeabur` / `zb` CLI | ❌ 未安装 |
| `~/.zeabur`（CLI 登录态） | ❌ 不存在 |
| 环境变量中的 Zeabur 凭据 | ❌ 无 |
| 仓库中的 Zeabur API token / 部署密钥 | ❌ 无（只有文档提到平台名） |
| 可访问的部分 | ✅ 生产站点 HTTPS 可达（`https://tsinglankindergarten.zeabur.app`），我正是用它导出快照的 |

因此以下事项**一律 BLOCKED，我不会声称做过**：读取服务名/服务 ID、部署 V2、创建独立 PostgreSQL、
改环境变量、验证/修改域名绑定、退役旧数据库、查看部署记录与镜像摘要。

**需要业主提供其一**（任一即可解除阻断）：
1. 在 Zeabur 控制台把 V2 部署好（我给出确切参数：构建目录 `V2/`、Dockerfile 路径、
   环境变量清单、健康检查路径），并把结果告诉我 → 我在**已部署环境**上跑验收；
2. 或提供 Zeabur API token（放进 gitignored 的 `.env.deploy` 或环境变量）→ 由我执行部署与切换；
3. 或安装并登录 `zeabur` CLI（`npm i -g zeabur` + `zeabur auth login`）→ 同上。

## 3. §3.1/§3.2/§3.3 生产数据与测试资源排除（PASS）

**唯一迁移来源**：`prod-export-20261008_031823.ndjson`
sha256 `b1a2e0e8b3fec3c1b2c24ade483f97aff7810e81bea41786fcdd395c511b708e`
→ 本轮**重新校验通过**（与冻结文档一致；不一致会直接拒绝执行）。

**V2 专用迁移文件**（原快照保持只读，未修改）：

| 项 | 值 |
|---|---|
| 文件 | `.migration/prod-exports/v2-cutover-20261008.ndjson` |
| **sha256** | `11461bd03cad8d16ab9bfddc8c46d264317d9d58229faaac445f04054d1db94b` |
| 字节 | 1 412 663 |
| 生成方式 | `scripts/prepare-v2-cutover-snapshot.mjs`（可重复执行） |
| 排除清单（可审计） | `.migration/prod-exports/v2-cutover-20261008.exclusion.json` |

**精确排除的 2 条测试资源**（三特征同时命中才排除，绝不做 `title LIKE '%test%'` 模糊删除）：

| resource id | 标题 | 状态 | 依据 |
|---|---|---|---|
| `76b60eb6-42ca-4143-a76c-9efd0202ee3e` | `test` | published | 标题字面量 test + smoke 图片 `校服申领登记.png` + **V1 里没有目录归属** |
| `62928bcc-4f63-4626-95b5-19ec0b5b7705` | `test` | draft（V1 回收站内） | 标题字面量 test + 同一文件 + **桶名是 `placeholder-bucket`（占位符）** |

**数量变化（其余表一条未动）**：

| 表 / 域 | 迁移前 | 迁移后 | 说明 |
|---|---:|---:|---|
| resources | **349** | **347** | 仅减少被授权的 2 条测试资源 |
| 有效资源 / 回收站 | 348 / 1 | 346 / 1 | 排除的两条里 1 条有效、1 条回收站 |
| 带文件元数据的资源 | 2 | **0** | 见 §7 |
| teachers | 24 | 24 | 未变 |
| directories | 69 | 69 | 未变 |
| review_records | 1 | 1 | 未变 |
| audit_logs | 621 | 621 | **未删除任何审计记录** |

> 原快照里的两条记录**没有被删除**（原文件字节未变）；排除只发生在 V2 专用文件里，
> V1 的历史数据保持完整 —— 符合"不能以删历史数据换迁移成功"。

## 4. （无独立小节，见 §3 与 §5）

## 5. §5 目录映射（PASS，本轮重跑）

在**新的 V2 专用迁移文件**上重跑唯一 resolver（不是引用旧报告）：

```
资源 347 ｜ 精确落位 347 ｜ UNRESOLVED 0 ｜ subject-level fallback 0
```

报告已按新文件重新生成：`docs/PRODUCTION_RESOURCE_DIRECTORY_RESOLUTION.md`（347 行逐条审计）。

## 6. §6 账号与权限（BLOCKED）

`docs/PRODUCTION_PERMISSION_MATRIX.md` 已生成：24 个账号，逐条列出 V1 角色、建议身份、
开放目录、当前权限（**0 条 —— 迁移刻意不发授权**）、状态、证据来源。

**BLOCKED 的三项**：① 谁是管理员（V1 角色名不自动等于 V2 身份，每条 ADMIN 必须人工确认）；
② 每位教师开放哪些目录（无法从数据推断）；③ 口令兼容的**真实登录验证**（必须在生产环境用真实账号跑一次）。

## 7. §7 文件迁移（PASS：范围已核实为 0 业务对象）

| 事实 | 证据 |
|---|---|
| V1 生产 349 条资源里，**只有那 2 条 smoke 测试资源**带文件元数据（`has_stored_file=true`） | 快照逐条统计 |
| 排除后：**0 条资源带文件** | 新迁移文件逐条统计 |
| 其余 347 条的文件列（`file_path`/`file_name`/`file_size`/`type`/`bucket`）全部为 NULL | 快照逐条统计 |

→ **V2 的 R2 业务文件迁移是空活**：没有真实业务对象需要搬运，也就**不存在"覆盖 V1 原对象"的风险**。
V1 存储里的两个 smoke 对象保持原样、不动；V2 采用独立 Bucket/前缀后，
即使将来有上传也落在 V2 自己的位置（配置项：`STORAGE_PROVIDER=s3` + `STORAGE_ENDPOINT/BUCKET/…`）。

## 8. §8 测试门禁（本轮：部分 NOT RUN）

| 门禁 | 状态 | 说明 |
|---|---|---|
| 真实快照 resolver 回归（`tests/integration/migration-directory-resolution.test.mjs`） | **PASS** | 20/20（上一轮），本轮又在**新文件**上重跑报告：347/347 |
| `npm test` / `typecheck` / `lint` / `build` 全量 | **NOT RUN（本轮）** | 本轮只改了测试与文档；**正式切换第一步必须重跑**，我不会把上一轮结果当本轮 PASS |
| 多目录浏览器验证（Pre-K 四类 / K 中文四类 / 教师成长链） | **PASS** | 上轮 7/7；**在生产部署后必须对正式域名再跑一遍** |
| 安全（Cookie/HTTPS/限流/CSRF/响应头/越权/ID 替换） | **NOT RUN** | 需在真实部署上验证 |

## 9. §9/§10/§11（BLOCKED / NOT RUN）

预发布演练、正式切换、V1 退役**全部依赖 Zeabur 访问**，因此本轮：
`ZЕABUR DEPLOYMENT = BLOCKED`、`PRODUCTION DOMAIN = BLOCKED`、
`BACKUP & RESTORE = NOT RUN`、`V1 RETIREMENT = NOT RUN`、`ROLLBACK READINESS = NOT RUN`。

**特别声明**：在备份、恢复演练与 V2 正式验收完成之前，**不得**删除 V1 数据库资源 —— 本轮没有删除任何东西。

## 10. 下一步（解除阻断后立即执行，顺序固定）

1. 业主提供 Zeabur 访问（三选一，见 §2）或按我给的参数在控制台部署 V2；
2. 我重跑 `npm test / typecheck / lint / build`（全量，拿本轮 SHA 的结果）；
3. 创建独立 V2 PostgreSQL → 备份 V1 库并**实际演练恢复**；
4. 用 `v2-cutover-20261008.ndjson`（sha256 `11461bd0…`）导入 V2 库，核对 347/24/69/0/621；
5. 初始化权限（按矩阵逐条确认后执行）；
6. 对正式域名跑浏览器 E2E（桌面 + 移动）；
7. 全部通过后才切换域名与退役 V1；任何一项不过 → 停在安全边界并报告。
