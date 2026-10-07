# V2 审核工作流（阶段 7）

> 这份文档回答一个问题：**谁能把一份资源从哪个状态推到哪个状态，以及每次推动留下了什么。**

## 1. 六个状态、六条转换

```
                    ┌──────────────── 提交审核（作者）──────────────┐
                    ▼                                              │
   ┌────────┐   submit    ┌────────────────┐   approve   ┌───────────┴──┐
   │ DRAFT  │────────────▶│ PENDING_REVIEW │────────────▶│  PUBLISHED   │
   │ 草稿   │             │ 待审核          │             │  已发布       │
   └───▲────┘             └───────┬────────┘             └──────┬───────┘
       │                          │ reject（必须写原因）          │ recall（可选原因）
       │                          ▼                             ▼
       │                     ┌──────────┐                 ┌───────────┐
       └────── edit ─────────│ REJECTED │                 │ RECALLED  │
                              │ 已退回   │                 │ 已撤回     │
                              └──────────┘                 └─────┬─────┘
                                       └────── edit ─────────────┘
```

只有这六条。**表里没有的一律 409 `ILLEGAL_TRANSITION`**。业主 §1 点名的五种禁止逐条有测试：

| 禁止 | 为什么 |
|---|---|
| `DRAFT → PUBLISHED` | 跳过审核 |
| `DRAFT → REJECTED` | 还没提交就被"退回" |
| `PUBLISHED → REJECTED` | 已发布的东西不能退回，只能**撤回** |
| `REJECTED → PUBLISHED` | 跳过复审 |
| `RECALLED → PUBLISHED` | 绕过重新审核 |
| `REJECTED → PENDING_REVIEW` | **不经修改直接重新提交**（阶段 7 特意去掉的第七条） |

最后一条值得单独说：退回之后"原样再交一次"，审核员会看到一模一样的内容。
去掉它之后，重新提交这条路上**必然经过一次编辑动作**（编辑把状态变回 DRAFT）。

唯一实现：`shared/resource-status.ts` 的 `TRANSITIONS`。服务、测试、界面文案全部从它派生。

## 2. 「通过」就是「发布」（业主 §14）

不做 `审核通过 → 再点发布` 两步。状态清单里**没有**"审核通过但未发布"这种中间态 ——
对幼儿园教师平台来说那是多余的复杂度。界面上的按钮就叫「通过并发布」。

权限层面仍然分得清：`resource.review` 管"能不能退回"，`resource.publish` 管"能不能发布"，
两个权限都存在，只是通过的那一步同时完成发布。

## 3. 谁不能审谁

| 规则 | 实现位置 | 现象 |
|---|---|---|
| 没有审核权限 → 进不了队列、裁决 403 | `AuthorizationService.can()` | 教师的侧边栏里根本没有「审核工作台」 |
| **不能审自己上传的** | `AuthorizationService.canActOnResource(..., { forbidSelf: true })` | 403，且信息是「不能审核自己上传的资源，请由其他审核员处理」 |
| 管理员也不能自审 | 同上（`forbidSelf` 在 admin 绕过**之后**判断） | 同一个 403 |
| 跨目录 → 403 | `can()` 的子树判定 | 只有 Pre-K 审核权的人审不了 K 的资源 |

自审保护那条**不看角色**：业主的原话是"防止权限扩大后形成自审"。
所以一个既持有 `resource.review` 又是上传者的人，会被明确挡住 ——
而错误信息必须说清是"不能自审"，否则老师会去找管理员要权限，而要到了也没用。

## 4. 并发：只有一个能成

条件是**写进 SQL 的**，不是"先查后写"：

```sql
UPDATE resources SET status = $to, updated_at = now()
WHERE id = $id AND status = $from
RETURNING *
```

受影响行数为 0 → 别人先动了手 → 409。于是两位管理员同时点「通过并发布」：

```
一个 201（真的转换了）
另一个 409 ILLEGAL_TRANSITION
resource_reviews 里只有一条 approve
```

三条并发用例（两个管理员同时通过、一个通过一个退回、三个人同时通过）都是**真的并发请求**，
不是顺序调用 —— 顺序调用测不出竞态。

## 5. 审核时间线 vs 审计日志：分工

业主 §7 要求"多次审核全部保留，不要只存一个 reviewComment"。两处记录，各有分工：

| | `resource_reviews` | `audit_logs` |
|---|---|---|
| 记什么 | **审核流水**：`submit` / `review.approve` / `review.reject` / `review.recall` | 谁在什么时候改了什么，含字段变更与 `statusFrom`/`statusTo` |
| 约束 | 数据库 CHECK 只允许那四个动作 | 动作名来自 `shared/audit-actions.ts` 的白名单 |
| 界面 | 资源详情页的「审核记录」 | 审计页（阶段 8） |

**编辑不写进 `resource_reviews`。** 我第一版往里插了一条 `'update'`，被 CHECK 约束当场拦下
（接口 500）—— 约束是对的，是分工想错了：`resource_reviews` 是"审核流水"，
字段变更属于审计日志。教师的编辑（`REJECTED → DRAFT`）能在审计里查到
`statusFrom: REJECTED, statusTo: DRAFT`。

## 6. 审计动作名（业主 §20）

状态机内部的动作名与审计动作名之间，只允许有**一个**映射（`ACTION_AUDIT_NAME`）：

| 状态机动作 | 审计动作 | 界面标签 |
|---|---|---|
| `submit` | `resource.submit_review` | 提交审核 |
| `review.approve` | `resource.approve` | 审核通过并发布 |
| `review.reject` | `resource.reject` | 审核退回 |
| `review.recall` | `resource.recall` | 资源撤回 |

状态机里那三个 `review.*` 名字**必须互相区分**（业主从阶段 2 起就强调"审核操作不要混用"），
所以映射是必要的；散着写字符串迟早会出现"改了状态机、审计还在记旧名字"，而审计断了查不出来。

**撤回绝不写 reject。** 否则教师的「我的资源」里会出现一条**假的退回原因**，
他会以为自己被否了 —— 这正是 V1 那个缺陷的根因。

## 7. 界面：一个详情页，不是两个

业主 §22 明确要求不要做 `ReviewDetail` + `ResourceDetail` 两套页面。
审核员和教师看到的是**同一个资源详情页**，动作由服务端的 `capabilities` 决定：

```json
{ "canEdit": true, "canSubmit": false, "canApprove": false, "canReject": false,
  "canRecall": true, "canDelete": true, "reviewDeniedReason": null }
```

能力位**不是安全边界**：每个动作的接口都会用同一套授权再拒一次。
它只负责"不要把必然失败的按钮摆出来"。前端没有任何 `role === 'ADMIN'`
或 `roles.includes(...)`。

## 8. 可见性（业主 §17 / §18）

| 谁 | 目录浏览 | 我的资源 | 审核队列 | 单条读取（详情/文件/下载） |
|---|---|---|---|---|
| 普通教师 | 只看**已发布** | 自己上传的全部状态 | ✗ | 已发布 ∪ 自己的 |
| 审核 / 发布岗 | 只看已发布 | 自己上传的全部 | ✓（已提交的） | 上面那些 + 别人已提交的（不含草稿） |
| 管理员 | 只看已发布（**列表里**也一样） | 自己上传的 | ✓ | 全部 |

两件事要分清：

* **目录浏览默认只看已发布**（阶段 7 §17）：老师自己那份还没发布的草稿在「我的资源」里管理，
  目录里看到的永远是"大家都能用的东西"。
* **别人**的草稿 / 待审 / 已退回 / 已撤回，无论从哪个入口都够不到 ——
  列表、搜索、单条读取共用同一个 `AuthorizationService.canViewResource()`。
  搜索曾经是最容易长出"第二条查询路径"的地方，所以它和列表**走的是同一个查询**。

## 9. 回收站里的资源（§30）

进了回收站就不能提交、不能审核、不能发布、不能下载 —— 除非先恢复。
实现上不需要额外判断：`requireResource()` 一律过滤 `deleted_at IS NULL`，
所以这些入口统统 404。

## 10. 测试怎么证明

| 套件 | 证明什么 |
|---|---|
| `tests/unit/review-state-machine.test.mjs` | 六条转换、五种禁止、通过=发布、退回必须写原因、动作↔审计映射唯一 |
| `tests/unit/resource-state-machine.test.mjs` | 状态机本身 + "编辑去哪"与转换表不许分叉 |
| `tests/integration/review.integration.test.mjs` | 队列的搜索 / 目录过滤 / 排序白名单 / 服务端分页 / 范围过滤 |
| `tests/integration/review-permission.test.mjs` | 谁能审、自审保护（含管理员）、跨目录、重复审核 409、退回必填原因、时间线完整 |
| `tests/integration/review-concurrency.test.mjs` | 真并发：一个 201 一个 409、只写一条流水、条件更新真的生效 |
| `tests/integration/review-visibility.test.mjs` | 非发布状态对别人不可见、搜索不越权、回收站资源不可操作 |
| `tests/integration/review-audit.test.mjs` | 四个动作的审计、撤回不写 reject、非法转换留痕、凭据禁区 |
| `tests/integration/browser.stage7.test.mjs` | 真浏览器走完三条路（通过 / 退回→重提交 / 撤回），每步同时核对**界面与数据库** |
