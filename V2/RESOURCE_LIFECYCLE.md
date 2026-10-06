# V2 资源生命周期

> 状态机只有**一份实现**（`server/modules/resources/state-machine.ts`），
> Service、测试、界面文案全部从它派生。
> V1 的经验是：状态规则散落在 service 的 if 里，于是"提交审核成功但状态没变"
> 这类缺陷不会被任何接口测试发现 —— 因为测试也只看它自己的 if。

## 1. 五个状态，不再多

```ts
export const RESOURCE_STATUS = {
  DRAFT:          '草稿',
  PENDING_REVIEW: '待审核',
  PUBLISHED:      '已发布',
  REJECTED:       '已退回',
  RECALLED:       '已撤回',
} as const
```

V1 的状态枚举也是这五个，但 `recalled` **没有独立接口**（靠通用 PATCH 改状态），
导致"已发布资源被误撤回"成为已知缺陷。V2 给每个转换一个显式动作。

## 2. 状态转换表

| # | 从 | 到 | 动作 / 接口 | 谁能做 | 前置条件 | 副作用 |
|---|---|---|---|---|---|---|
| 1 | — | `DRAFT` | 创建 `POST /api/resources` | `resource.create` | 目标目录 `allow_files = true` 且在授权范围内 | 审计 `resource.create` |
| 2 | `DRAFT` | `PENDING_REVIEW` | 提交 `POST /:id/submit` | 本人 + `resource.submit` | **至少有一个文件** | `resource_reviews` + 审计 |
| 3 | `REJECTED` | `DRAFT` | 编辑 `PATCH /:id` | 本人 + `resource.update.own` | — | 审计 |
| 4 | `REJECTED` | `PENDING_REVIEW` | 重新提交 `POST /:id/submit` | 本人 + `resource.submit` | 至少一个文件 | `resource_reviews`（`from_status=REJECTED`） |
| 5 | `PENDING_REVIEW` | `PUBLISHED` | 通过 `POST /:id/review {action:'approve'}` | `resource.publish` | — | `published_at = now()`、审计 |
| 6 | `PENDING_REVIEW` | `REJECTED` | 退回 `POST /:id/review {action:'reject', comment}` | `resource.review` | **`comment` 必填** | 审计（含原因） |
| 7 | `PUBLISHED` | `RECALLED` | 撤回 `POST /:id/recall` | 本人（`resource.submit`）或 ADMIN | — | 审计 |
| 8 | `RECALLED` | `DRAFT` | 编辑并重新开始 | 本人 | — | `version += 1`（见 §5） |
| 9 | 任意（非 `deleted_at`） | 软删除 | `DELETE /:id` | 本人 + `resource.delete.own`，或 ADMIN | — | `deleted_at = now()`、审计 |
| 10 | 软删除 | 恢复 | `POST /:id/restore` | 所有人 + `resource.delete.own` 或 ADMIN | **原目录仍存在且启用** | `deleted_at = NULL`、审计 |
| 11 | 软删除 | 永久删除 | `POST /:id/purge` | `resource.purge`（仅 ADMIN） | — | 删数据库行 + **删对象存储文件** + 审计 |

**表里没有的转换一律返回 409 `ILLEGAL_TRANSITION`**，并写审计（`result: 'failed'`）。
例如 `DRAFT → PUBLISHED`（跳过审核）、`PUBLISHED → PENDING_REVIEW`（绕过撤回）。

### 撤回**不能**调用 reject

业主明确要求："发布资源可以撤回；**撤回不能调用 reject**。"

两条实现约束：

1. 撤回是**独立动作** `POST /api/resources/:id/recall`，独立权限判定
   （本人 + `resource.submit`，或 ADMIN），**不经过审核裁决接口**。
2. 撤回**不写 `resource_reviews.action = 'reject'`**，而是
   `action = 'recall'`（`from_status = 'PUBLISHED'`，`to_status = 'RECALLED'`）。
   否则"我的资源"里会显示一条**假的退回原因**，教师会以为自己的东西被别人否了 ——
   这正是 V1"published 资源被误撤回"缺陷的根源。

审核裁决接口 `POST /:id/review` 只接受 `action ∈ {approve, reject}`，
**不接受 `recall`**；撤回接口也不接受 `comment` 之外的裁决语义。

## 3. "不允许假成功"（业主 §24）

三条实现规则：

```ts
// 1. 所有变更接口返回**变更后的真实状态**，不是"操作成功"四个字
return { id, status: updated.status, version: updated.version, updatedAt: updated.updatedAt }

// 2. 状态更新必须是条件更新，无法更新就是失败（并发下的两个审核员）
UPDATE resources SET status = 'PUBLISHED'
WHERE id = $1 AND status = 'PENDING_REVIEW'   -- ← 带上 from_status
RETURNING *                                    -- 影响 0 行 → 409，不是 200

// 3. 前端渲染服务端返回值，不做乐观更新
onSuccess: (server) => setStatus(server.status)   // 绝不用 setStatus('PUBLISHED')
```

第 2 条是 V1 教训的直接落地：V1 的 `resource.purge` 曾在数据库层影响 0 行，
而对应审计却写了 success。**条件更新 + `RETURNING` 行数校验**让这种情况不可能静默。

## 4. 文件与状态的耦合

| 规则 | 理由 |
|---|---|
| 提交审核要求**至少一个文件** | 没有文件的"教学资源"是空壳；V1 允许这种行存在，于是资源列表里有 347 条点了下载必失败的记录 |
| `has_file` 不是存储列，而是由 `EXISTS (SELECT 1 FROM resource_files …)` 派生 | 存储列会与实际不符（V1 因此引入 `has_stored_file` + 迁移 0008 补救） |
| 登记文件前必须 `HEAD` 对象成功 | 防止"数据库说有、对象存储里没有" |
| 永久删除必须删对象 | 否则 R2 上留下永远无法回收的孤儿文件 |

### 一个资源多个文件（**已确认**）

```
Resource「大班教学活动」
├── 教案.pdf        2.3 MB
├── 课件.pptx       8.1 MB
└── 工作单.docx     0.4 MB
```

- **数据模型支持 0..n**（`resource_files`）。
- **界面保持简单：一次上传一个文件**，用 **[ + 添加文件 ]** 逐个加。
- **不做**多文件批量选择、不做拖拽整批、不做上传队列进度面板 ——
  业主明确说"不要实现复杂的多文件批量上传界面"。
- 每个文件独立走"申请上传地址 → PUT → 服务端 HEAD 校验 → 登记"四步；
  一个失败不影响已登记成功的其他文件，界面按文件显示各自的状态。

## 5. 已发布资源不可直接覆盖（业主 §44）

```
PUBLISHED 资源被编辑
  → 不允许直接改这一个资源的文件
  → 必须"编辑并创建新版本"：resources.version += 1，
     旧版本快照写入 resource_versions（若该表已启用）
  → 状态回到 DRAFT，需重新提交审核
```

第一阶段的最简实现：`resources.version` 整数 + `resource_reviews` 记录
（谁在第几版做了什么）。`resource_versions` 表按需启用，**不提前建**。

## 6. 回收站（业主 §38）

| 角色 | 能看到什么 |
|---|---|
| 教师 | 只有自己的已删除资源 |
| 管理员 | 全部已删除资源 |

- 到期自动清理：默认保留 30 天（V1 是 `MAX_RESOURCE_RETENTION_DAYS`），
  由启动时 + 每日定时任务执行。
- **永久删除是唯一会真的删对象存储文件的操作**，且需要独立权限 `resource.purge`。
- 恢复时若原目录已被删除或停用 → 409，并提示"请先恢复/启用目标目录"，
  而不是把资源恢复到一个看不见的地方（V1 的 `RestoreOutcome` 枚举已经证明这个分支是必要的）。

## 7. 通知（FUTURE，但接口先留好）

第一阶段不做消息系统。页面内提醒已经足够：

| 事件 | 提醒 |
|---|---|
| 提交审核 | 审核台出现待办条目 |
| 退回 | 「我的资源」对应条目显示原因（`resource_reviews.comment`） |
| 发布 | 资源状态徽章变化 |

`resource_reviews` 表本身已经是完整的事件流，将来接通知不需要改数据模型。

## 8. 界面必须呈现的信息（业主 §17 / §21）

资源详情弹窗：

```
标题 / 英文标题
所属目录      教育教学 / Pre-K / 美德 / 教学资源      ← 完整路径，来自目录树
描述
文件列表      PDF 教学详案.pdf   2.3 MB   [预览] [下载]
              PPT 课件.pptx      8.1 MB   暂不支持在线预览 [下载]
上传者 / 状态 / 创建时间 / 更新时间
审核意见（若被退回）
版本
```

**不允许出现**"开发中""Coming Soon"。做不到的能力就不渲染那个按钮。

**「我的资源」必须支持的动作**（业主 §17，一个都不能少）：

| 动作 | 说明 |
|---|---|
| 查看 / 详情 | 打开详情弹窗 |
| 编辑 / 保存草稿 | `resource.update.own`（仅本人） |
| 提交审核 | `resource.submit` |
| 查看退回原因 | 读 `resource_reviews.comment`（**不显示"已退回"却不给原因**） |
| 重新提交 | `REJECTED → PENDING_REVIEW` |
| 删除 / 恢复 | 软删除 → 回收站 → 恢复 |
| 查看文件 / 预览 / 下载 | 文件列表里的每个文件 |

分栏：全部 / 草稿 / 待审核 / 已发布 / 已退回 / 已撤回 / 回收站
（V1 缺"已撤回"这一栏，V2 必须补上）。

上传成功后的反馈（业主 §15：资源位置必须一目了然）：

```
✔ 上传成功
  资源：大班教学活动
  文件：教学详案.pdf（2.3 MB）
  位置：教育教学 / Pre-K / 美德 / 教学资源
  状态：已上传
  [ 保存草稿 ]
```

保存后**刷新页面**，从该目录仍然能找到这条资源 —— 这是浏览器测试的硬断言。

## 8.5 列表：搜索、筛选、分页

| 能力 | 要求 |
|---|---|
| 搜索 | 标题、描述、**文件名**、**目录名** |
| 筛选 | 目录、状态、班型（若目录结构中存在对应层级） |
| 分页 | **不允许固定只显示 50 条**。分页或"加载更多"，且显示总数（"已显示 20 / 共 348"） |

"共 348 条"这句话本身也是验收项：它证明分页不是把结果截断后当作全部。

## 9. 预览策略（业主 §14 / §19）

| 类型 | 行为 |
|---|---|
| **PDF** | 网页内预览 |
| **JPG / PNG**（以及 JPEG / WEBP / GIF） | 网页内预览 |
| **TXT** | 网页内预览 |
| DOCX / XLSX / PPTX | **不预览**。显示文件信息 + 下载 |
| ZIP | **只下载** |
| 其他 | 只下载 |
| 预览失败（签名过期、对象缺失） | 明确错误提示 + 重试，**绝不静默** |

不支持预览时必须显示**这句话**（业主指定的原文）：

> **此文件类型暂不支持在线预览，请下载查看。**

**禁止点击后无反应。** 也就是说：预览按钮只在白名单类型上渲染；
非白名单类型渲染的是"暂不支持在线预览，请下载查看"文字 + 下载按钮，
而不是一个点了没反应的预览按钮。

服务端 `GET /api/resources/:id/preview`：
- 白名单外的类型返回 `409 { code: 'PREVIEW_UNSUPPORTED', mimeType }`，
  让前端能区分"这个类型不能预览"与"预览坏了"；
- 授权与下载**完全同一套判定**（`resource.download` + 目录范围）；
- 不存在可猜测的公开路径（V1 也没有，V2 保持并写测试）。

## 10. 本模块的验收清单

1. 草稿 → 提交 → 状态真的变成 `PENDING_REVIEW`；**刷新后仍是** `PENDING_REVIEW`。
2. 跳过审核直接发布 → 409（表里没有这条转换）。
3. 退回不带原因 → 400；带原因 → 教师能看到原因。
4. 已发布资源被编辑 → `version += 1` 且回到 `DRAFT`，原发布内容未被覆盖。
5. 两个审核员同时通过同一资源 → 一个 200，一个 409（条件更新）。
6. 删除 → 回收站可见 → 恢复 → 回到原目录；原目录已删时恢复返回 409 且提示清楚。
7. 永久删除 → 数据库行消失 **且对象存储里 HEAD 返回 404**。
8. 没有文件的资源不能提交审核。
9. PDF 在 Chrome 与 Safari 中真实打开并加载（浏览器测试，不是"点了按钮"）。
10. 白名单外类型：界面显示"暂不支持在线预览，请下载"，且**没有**预览按钮。
