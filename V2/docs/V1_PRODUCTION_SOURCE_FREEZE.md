# V1 生产数据源冻结（Stage 12 前置门禁）

> 业主规则：**正式 V2 生产迁移只允许使用重新导出的生产 V1 快照作为唯一 source of truth**；
> 本机那份"生产等价"数据只能用来交叉核对。
> 本文就是那次导出 + 那次核对的结果。
>
> **判定：`LOCAL_EQUIVALENT_DIFFERS_FROM_PRODUCTION_EXPORT`**
> → 按业主规则 **立即停止生产切换**，先报告（本文件），不自行猜哪份正确。

---

## 1. 生产快照（唯一权威源）

| 项 | 值 |
|---|---|
| 来源 | `https://tsinglankindergarten.zeabur.app`（Zeabur 上的生产 V1） |
| 取数方式 | `POST /api/admin/data-export`（服务端只 SELECT；业务表零写入） |
| 导出开始 | **2026-10-08 11:18:23（北京时间, UTC+8）** / 2026-10-08T03:18:23Z |
| 快照 header | `{"kind":"header","tool":"POST /api/admin/data-export","formatVersion":1,"createdAt":"2026-10-08T03:18:23.765Z","sourceDatabase":"zeabur"}` |
| 文件名 | `prod-export-20261008_031823.ndjson` |
| **sha256** | `b1a2e0e8b3fec3c1b2c24ade483f97aff7810e81bea41786fcdd395c511b708e` |
| 字节数 | 1 414 327 |
| 完整路径 | `V2/.migration/prod-exports/prod-export-20261008_031823.ndjson` |
| 校验文件 | `…/prod-export-20261008_031823.sha256` |
| 证据文件 | `…/prod-export-20261008_031823.evidence.json` |
| 独立校验 | `shasum -a 256 -c prod-export-20261008_031823.sha256` → **OK**（不用脚本自己的值） |
| 文件权限 | `600`（快照含 `sessions.session_hash` 与 `teacher_mfa` 加密材料，视为敏感数据） |
| 自校验 | 14 张表 / 1439 行；table 行 / footer / 实际解析行数**三处口径一致** |
| 生成工具 | `V2/scripts/export-v1-production.mjs`（`--confirm-production`，TOTP 已用 RFC 6238 向量本地自检） |

**它不是 pg_dump 归档**：不含 roles/授权、RLS 策略、索引、触发器、序列状态、WAL/PITR。
迁移只需要业务数据，这一点足够；**灾难恢复不能靠它**（那是另一条路径）。

## 2. 生产各表行数（快照 footer 口径）

| 表 | 行数 |
|---|---:|
| audit_logs | 621 |
| resource_versions | 350 |
| resources | **349** |
| directories | 69 |
| teachers | **24** |
| schema_migrations | 12 |
| mfa_recovery_codes | 10 |
| mfa_challenges | 1 |
| review_records | **1** |
| sessions | 1 |
| teacher_mfa | 1 |
| subject_permissions | 0 |
| account_permissions_overrides（`account_permission_overrides`） | 0 |
| account_scopes | 0 |
| **合计** | **1439** |

生产业务域（从快照直接算出来的）：

* 资源：**349**（published 348 + draft 1），其中**回收站 1 条**（`deleted_at` 非空）
* 带文件元数据的资源：**2**（`has_stored_file=true`；其余 347 条为 false）
* 审计时间范围：**2026-09-26 00:35:46 → 2026-10-08 03:18:23（UTC）**，覆盖真实使用
  （login 141 / upload 53 / download 30 / delete 27 / purge 24 / file_register 17 /
  permission_denied 25 …）—— **生产在被真实使用**，不是空库

## 3. 本机"生产等价"数据的实际身份

| 项 | 生产快照 | 本机 `qls_test_0005` | 一致？ |
|---|---:|---:|---|
| teachers | 24 | 27 | ❌ |
| directories | 69 | 69 | ✅ |
| resources | **349** | **348** | ❌ |
| review_records | 1 | 2 | ❌ |
| audit_logs | **621** | **7651** | ❌ |
| resource_versions | 350 | 348 | ❌ |
| 回收站资源 | 1 | 0 | ❌ |
| 带文件元数据的资源 | 2 | 0 | ❌ |

**最关键的一条**：把两边资源按 id 对比 ——

```
只在生产里：349
只在本机  ：348
两边都有  ：0        ← 没有一个 id 是共同的
```

也就是说：**这不是"同一份数据的增量差异"，而是两套完全不同的数据**。
本机那份是**另建的测试数据集**（目录树 69 条恰好一致，所以看起来像，但资源行没有任何一条相同）。

teachers 的用户名集合也不重叠：

* 只在生产里（3）：`biz_probe_405561`、`biz_probe_413492`、`TsinglanAdmin`
* 只在本机（6）：`seq_principal`、`__rbac_keeper`、`scope_prek_head`、
  `scope_prek_assistant`、`scope_pe_specialist`、`scope_k_head`

> **如果照本机数据做生产迁移，结果是：348 条假资源进 V2，而 349 条真实生产资源一条都没进来。**
> 这正是业主坚持"必须重新导出、本机只能交叉核对"要防的事 —— 现在它被证明是真的。

## 4. 生产那 2 条带文件的资源（Stage 12 必须做决定）

两条都是 smoke 测试留下的（`title = "test"`）：

| id | 标题 | 状态 | 文件 | 桶 | 路径 | 说明 |
|---|---|---|---|---|---|---|
| `76b60eb6-42ca-4143-a76c-9efd0202ee3e` | test | published | `校服申领登记.png`（1 618 105 字节, image/png） | `tsinglan-curriculum` | `uploads/76b60eb6…/1791293126057-校服申领登记.png` | **真桶**，2026-10-06 上传 |
| `62928bcc-4f63-4626-95b5-19ec0b5b7705` | test | draft | `校服申领登记.png`（同上） | `placeholder-bucket` | `uploads/1791168275313/校服申领登记.png` | **在回收站**（deleted 2026-10-05），桶名就是占位符 |

需要业主在 Stage 12 决定（因为 R2 桶要沿用 V1 的）：

1. 这两条要不要搬（对象是否真的还在 `tsinglan-curriculum` 里，需要 R2 凭据才能 HEAD 验证）；
2. 还是作为 smoke 痕迹**不搬**（只保留资源元数据、文件留空），并在上线说明里写清。

无论哪种选择，**迁移都必须明确记录**，不能默默丢掉。

## 5. 结论与门禁

```
生产快照成功        ✅
sha256 成功         ✅（含系统 shasum 独立校验）
本机交叉核对一致    ❌  LOCAL_EQUIVALENT_DIFFERS_FROM_PRODUCTION_EXPORT
未知差异            ❌  8 项，且资源 id 零重叠
────────────────────────────────────────────
判定：NOT READY FOR PRODUCTION MIGRATION（按业主规则：立即停止，先报告）
```

**本机数据从此失去资格**：它不能作为生产源，也不能用来"核对生产是否搬全"，
因为两边的 id 集合不相交 —— 它只能作为"迁移机制是否工作"的功能验证素材
（阶段 9 的那次预演就是这个用途，结论仍然有效：机制是好的）。

**唯一可信的迁移源**是本文 §1 那份带 sha256 的生产快照。
**或**在生产切换当天重新导出一份更新的（推荐：cutover 当天再导一次，减少窗口期差异）。

## 6. 生产 V1 commit（待业主确认）

运行时拿不到：`GET /api/health` 的 `version` 返回 `"unknown"`（容器里没有
`npm_package_version` / `APP_VERSION`）。已知的候选：

| 来源 | 值 |
|---|---|
| 本仓库版本 | `1.3.0`（`qls-kindergarten-resource-platform-v1.3.0`） |
| 本机 `.env.deploy` 的 `APP_VERSION` | `1.3.0-compose-verify`（**本机文件**，未必等于 Zeabur 当前值） |

→ 请在 Zeabur 控制台确认生产 V2 切换前 V1 实际部署的 commit，并写回本文件。

## 7. 下一步（未执行，等业主确认）

1. 业主确认：本机数据作废、以生产快照（或 cutover 当天的新快照）为唯一源；
2. 确认 §4 那两条 smoke 文件资源的处理方式；
3. 补齐 §6 的生产 V1 commit；
4. 之后才进入 **Stage 12 的真实部署 + 生产迁移**，并在生产库上核对
   "迁移前后 users / directories / resources / resource_files / reviews / audit
   与迁移报告一致、测试探针为 0"。

**复现命令**（任何人都能在本机重跑这两个工具）：

```bash
cd V2
node scripts/export-v1-production.mjs --selftest          # 先验 OTP 实现（不碰生产）
node scripts/export-v1-production.mjs --confirm-production  # 取生产快照（只读）
node scripts/crosscheck-v1-production.mjs \
  --snapshot .migration/prod-exports/prod-export-20261008_031823.ndjson \
  --out /tmp/crosscheck.md --json .migration/prod-exports/crosscheck-20261008.json
```
