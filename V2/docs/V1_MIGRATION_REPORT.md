# V1 → V2 迁移报告（自动生成）

> ⚠️ **这份报告的数据源不是生产数据。** 它记录的是阶段 9 的一次**预演**：
> 源库是本机测试库 `qls_test_0005`。2026-10-08 用真实生产快照交叉核对后确认，
> 本机数据与生产**资源 id 零重叠**（不是同一套数据）。
> 因此**不要**把本报告的数字当成生产迁移记录；生产迁移的源与差异见
> `docs/V1_PRODUCTION_SOURCE_FREEZE.md`。报告里的**规则与计数口径**仍然有效。


- 源：`v1@127.0.0.1:55432/qls_test_0005`
- 目标：`qls_v2_staging`
- 时间：2026-10-07T13:14:03.331Z

## 搬运计数

| 表 | 新增 | 跳过（已存在） |
|---|---|---|
| directories | 0 | 69 |
| users | 27 | 0 |
| resources | 348 | 0 |
| resource_reviews | 4 | 0 |
| audit_logs | 7651 | 0 |

## 目标库核对

```json
{
  "counts": {
    "users": 27,
    "directories": 69,
    "resources": 348,
    "resource_files": 0,
    "resource_reviews": 4,
    "audit_logs": 7651,
    "user_permissions": 0
  },
  "dangling": [],
  "duplicateReviewKeys": 0
}
```

## 目录对齐

- 匹配：69
- 新建（V1 独有）：0
- V2 独有（保留）：0

## 需要人工处理

- 无法登录（V1 没有口令）：1
  - RBAC 守护账号（__rbac_keeper）
- 未能自动映射的授权来源：0
- 资源无目录归属：0
- 其他需要确认：1
  - user 4ed315b3-79a5-46b1-9e83-2d896d2f0be9：V1 没有用户名 → 导入为停用账号 v1-no-username-4ed315b3

## 角色 → 建议授予（管理员照着点即可）

| 老师 | 用户名 | V1 角色 |
|---|---|---|
| Pre-K主教01 | prek-head01 | prek_head |
| 教学主任/教研主管 | qlsdirector | curriculum_director |
| K教师04 | k-teacher04 | k_assistant |
| Pre-K教师04 | prek-teacher04 | prek_assistant |
| K主教02 | k-head02 | k_head |
| Pre-K教师01 | prek-teacher01 | prek_assistant |
| K主教01 | k-head01 | k_head |
| 范围探针k_head | scope_k_head | k_head |
| 范围探针pe_specialist | scope_pe_specialist | pe_specialist |
| Pre-K教师03 | prek-teacher03 | prek_assistant |
| 范围探针prek_head | scope_prek_head | prek_head |
| K教师02 | k-teacher02 | k_assistant |
| 体能教师03 | pe-teacher03 | pe_specialist |
| K教师03 | k-teacher03 | k_assistant |
| Pre-K主教03 | prek-head03 | prek_head |
| K主教03 | k-head03 | k_head |
| 体能教师04 | pe-teacher04 | pe_specialist |
| 体能教师01 | pe-teacher01 | pe_specialist |
| 范围探针prek_assistant | scope_prek_assistant | prek_assistant |
| 体能教师02 | pe-teacher02 | pe_specialist |
| Pre-K主教02 | prek-head02 | prek_head |
| Pre-K教师02 | prek-teacher02 | prek_assistant |
| K教师01 | k-teacher01 | k_assistant |

## 只存在于审计里的提交事件

- 29 条 `resource_submit_review` 指向的 V1 资源并不存在（造数据留下的）。
  它们照原样搬进了审计表（一条不丢），但**没有**变成审核记录 —— 那是它们的真实身份。

## 文件

- V1 声称有文件的资源：0
