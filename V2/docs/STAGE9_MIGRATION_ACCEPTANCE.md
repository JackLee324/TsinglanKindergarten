# V2 数据迁移验收（阶段 9）—— 证据包

> 业主在进入 Stage 12 前明确要求：**先确认阶段 9 有正式证据**，不要因为阶段 10 的
> 业务 E2E 通过就默认迁移已完成。本文就是那份证据 —— 每一条都能在**本机原样重跑**，
> 命令、数字、sha256 全部给出。
>
> **一句话结论**：迁移的**工具 / 规则 / 验证**完整且有据；**生产切换本身尚未执行**，
> 它需要生产 V1 的连接（本机够不到）与一个生产 V2 库（Stage 12 才建）。
> 详见 §7「尚未完成的事」—— 这一节不许跳过。

---

## 1. 提交与产物

| 项 | 值 |
|---|---|
| 阶段 9 提交 | `99dd261` V2 阶段 9：V1 → V2 数据迁移（只读源库 / 幂等 / 可追溯） |
| 改动规模 | 23 个文件，+4550 / −28 |
| 迁移脚本 | `scripts/import-v1.mjs`（1242 行）、`scripts/v1-census.mjs`、`scripts/v1-snapshot.mjs` |
| 结构迁移 | `database/migrations/0003_v1_migration.sql`（+ `.down.sql`） |
| 规则书 | `docs/V1_MIGRATION.md`（418 行） |
| 盘点 | `docs/V1_RESOURCE_CENSUS.md` |
| 报告 | `docs/V1_MIGRATION_REPORT.md` |
| 待补齐清单 | `UNASSIGNED_RESOURCES.md` |
| 自动用例 | `tests/integration/migration-v1.test.mjs`（30）、`tests/integration/browser.stage9.test.mjs`（12）、`tests/unit/{password-v1-compat,v1-mapping}.test.mjs` |

## 2. 数据数量（源 → 目标）

源：`qls_test_0005`（**生产等价数据**，见 §6 的比对）
目标：全新 V2 库（本机 `qls_v2_idem_probe`，只应用 `0001/0002/0003` 三个 migration）

| 表 | 源 | 目标（导入后） |
|---|---:|---:|
| users（V1 `teachers`） | 27 | **27** |
| directories | 69 | **69** |
| resources | 348 | **348** |
| resource_reviews（V1 `review_records` = 2） | 2 | **4** |
| audit_logs | 7651 | **7651** |
| resource_files | **0** | **0** |
| user_permissions | 0 | **0**（设计如此，见 §5） |
| `v1_migration_map`（逐行可追溯表） | — | **448** |

复现命令：

```bash
cd V2
node scripts/import-v1.mjs \
  --source postgresql://…/qls_test_0005 \
  --target postgresql://…/<空库> \
  --v1-storage none --report /tmp/run1.md
```

## 3. 审核历史

* V1 `review_records` 有 2 行 → V2 里落成 **4** 条 `resource_reviews`
  （迁移把"提交 / 通过"这条状态机流水按 V2 的 6 条转换重新表达，规则见
  `docs/V1_MIGRATION.md`）。
* V1 审计里有 **29 条 `resource_submit_review` 指向并不存在的资源**（当年造数据留下的）。
  它们**照原样留在审计表里**，**没有**被伪造成审核记录 —— 那是它们的真实身份。
  报告里单独列了这一节，而不是把它们混进"已迁移"。

## 4. 文件数量 = 0（这是**正确**结果，不是漏迁）

V1 的文件列**一个字节都没有**，这是源库自己的记录：

```
V1 resource_file_totals（V1 自己的视图）: total=348, with_file=0, without_file=348
V1 resources 文件列非空行数：
  file_bucket_id = 0    file_path = 0    file_name = 0
  file_size      = 0    file_type = 0    has_stored_file = false × 348
```

所以：

* V2 里 `resource_files = 0` 与源库一致；
* **没有历史文件需要搬**（也就没有"文件搬丢了"这种可能）；
* 生产 V2 上线后对象存储是**空的**，老师看到的所有历史资源都是**只有元数据**的资源
  —— 这一点必须写进上线说明，否则会被误认为"文件丢了"。

> 迁移脚本仍然**支持**文件搬运（`--v1-storage local:DIR|s3`），
> 并有 `browser.stage9` 的真实文件用例（预览 → 下载 → sha256 一致）覆盖这条路径，
> 只是这批数据没有文件可搬。

## 5. 权限：0 条授权是**设计**，不是漏

V1 是"角色制"（`teachers.roles` 数组 + `subject_permissions`，本库两个都是 0 行），
V2 只有**一个**权限真相：`user_permissions`。迁移**刻意不代替管理员发授权**。

`docs/V1_MIGRATION_REPORT.md` 因此给出一份**照点即可**的清单：
23 位老师的「V1 角色 → 建议授予」，管理员在「权限」页照着勾。

> ⚠️ 上线注意：迁移完成后老师**能登录但看不到任何目录**，直到管理员按清单授权。
> 这是唯一一处"迁移之后还需要人工动作"的地方，必须在 cutover 清单里。

## 6. 源库为什么算"生产等价"

本机没有生产 V1 库（它在 Zeabur 内网 `postgres:5432/qls_prod`，本机够不到），
但可以证明手里的这份数据与生产口径一致：

| 指标 | V1 生产盘点报告（离线导出 2026-10-06，sha256 `b59842b2…`） | 本机 `qls_test_0005` |
|---|---|---|
| 资源总量 | 348（在用 347 + 回收站 1） | **348**（在用 348，回收站 0） |
| `courseware` | 245 | **245** |
| `weekly_plans` | 80 | **80** |
| `curriculum_outline` | 22（+1 回收站） | **23** |
| `materials` / `observation` / `research_archive` | 0 / 0 / 0 | **0 / 0 / 0** |
| 有文件的资源 | 0 | **0** |

> **一处差异要说清楚**：生产盘点是"在用 347 + 回收站 1"，本机这份是"348 全部在用"。
> 同一批数据的**状态**略有不同（那一行在本地没被软删），导入逻辑不受影响，
> 但**生产 cutover 必须以生产库当时的真实状态为准**，不能拿本地这份当准。

## 7. 尚未完成的事（**不许跳过这一节**）

> 阶段 9 的**工具与验证**完整；**生产切换没有执行**。

1. **没有任何一行进过生产 V2 库。** 上面所有数字都来自本机的一次完整重跑。
   生产 V2 库要等 Stage 12 建起来（`docker compose up` + `migrate up`）才有地方可写。
2. **生产 V1 的连接本机够不到**：Zeabur 内网别名 `postgres:5432`，不是公网地址。
   阶段 9 当时用的离线导出产物 `prod-export-20261006_195357.ndjson`
   （sha256 `b59842b2b24030f0593e7eb9b034d48d111c69a473ede9a8225c776d0c0ad79a21`，
   1 479 856 字节）**本机已经没有了**。
   → 要么给一个新的导出产物（带 sha256），要么给一个从本机可达的**只读**连接串。
3. **counts 必须在 cutover 时再核一次**：业主 Stage 12 §26 要求
   "迁移前后 users / directories / resources / resource_files / reviews / audit
   必须与迁移报告一致，且测试探针为 0"。这一步只能在生产环境上做。

**结论**：`99dd261` 的迁移能力**已验收**；生产数据切换**待执行**，
它是 Stage 12 部署流程里的一步（从干净服务器 → env → database → migration → docker up），
**不是**一件可以在本机提前做完的事。

## 8. 幂等：两次导入的双跑证明（本次新增）

命令：同一个源、同一个（空）目标库**连跑两次**，每次跑完取逐表 sha256 指纹。

| 表 | 第 1 次 | 第 2 次 | 结果 |
|---|---:|---:|---|
| directories | 新增 69 | **新增 0**，跳过 69 | ✅ |
| users | 新增 27 | **新增 0**，跳过 27 | ✅ |
| resources | 新增 348 | **新增 0**，跳过 348 | ✅ |
| resource_reviews | 新增 4 | **新增 0**，跳过 4 | ✅ |
| audit_logs | 新增 7651 | **新增 0**，跳过 7651 | ✅ |
| **业务表指纹** | — | — | **逐字节相同**（sha256 相等） |
| `v1_import_runs` | 1 行 | 2 行 | 预期：它是**运行日志**，每次跑记一条（第二次的 `counts` 里 inserted 全是 0、skipped 全是全量） |

**源库只读证明**：导入前后对 V1 取指纹，`teachers` / `resources` / `audit_logs` /
`sessions` / `review_records` / `subject_permissions` / `account_scopes` / `teacher_mfa`
逐表 **sha256 完全相同** —— V1 一个字节都没被改。

指纹文件（阶段 9 当时留下的）在 `V2/.migration/`：
`v1-before.json`、`v1-after.json`、`v2-before.json`、`v2-after.json`。

## 9. 自动用例（本次重新跑过）

```
node --test tests/integration/migration-v1.test.mjs tests/integration/browser.stage9.test.mjs
# tests 42 / pass 42 / fail 0 / skipped 0
```

覆盖：真实 V1 库（348 资源 / 7651 审计）导入后的形态、真实文件的迁移
（预览 → 下载 → sha256 一致）、合成夹具逐条规则、拒绝路径（宁可停下也不猜）、
口令兼容（V1 scrypt 摘要长度分支）、V1 角色 → V2 权限的能力映射。

## 10. 需要人工处理的三件事（源库自己带来的，不是迁移缺陷）

| 项 | 数量 | 处理方式 |
|---|---:|---|
| V1 没有口令、无法登录的账号 | 1 | `__rbac_keeper`（RBAC 守护账号）：导入后停用，需要时由管理员重置口令 |
| V1 没有用户名的账号 | 1 | 导入为停用账号 `v1-no-username-4ed315b3`（保留历史，不让人登录） |
| 资源没有目录归属 | 0 | 无（348 条全部落到了资料夹，浏览页看得见） |

## 11. 复现清单（照抄即可）

```bash
cd V2
# 1) 空库 + 三个 migration
DATABASE_URL=postgresql://…/<空库> node scripts/migrate.mjs up
# 2) 导入（源库只读；V1 有文件时去掉 --v1-storage none）
node scripts/import-v1.mjs --source postgresql://…/qls_test_0005 \
  --target postgresql://…/<空库> --v1-storage none --report /tmp/run1.md
# 3) 指纹（源库 before/after 必须相同）
node scripts/v1-snapshot.mjs --url postgresql://…/qls_test_0005 --out /tmp/v1-before.json
node scripts/v1-snapshot.mjs --url postgresql://…/<空库>      --out /tmp/v2-after.json
# 4) 幂等：再跑一次，报告里"新增"必须全是 0
node scripts/import-v1.mjs --source … --target … --v1-storage none --report /tmp/run2.md
```
