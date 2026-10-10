# Stage 14A：教师账号名额 + 扫码收款 + 账单/发票 —— 只读检查与设计

> 本阶段**只读**：没有改数据库、没有建表、没有创建或绑定任何账号、没有连生产库、没有改正式域名。
> 状态词只用 `PASS / BLOCKED / NOT RUN / DECISION_REQUIRED`；**没实际执行过的不计为通过**。
> 相关证据：`.migration/teacher-slot-difference.md`（39 名额 vs 24 账号差异报告，由
> `node scripts/report-teacher-slots.mjs` 只读生成）。

## 0. 结论先说

```
39 个名额的规格与编号规则        : PASS（确定性生成，已在报告里逐条列出）
24 个迁移账号 vs 39 名额差异      : PASS（报告已生成：0 自动绑定 / 14 可对应 / 10 岗位无对应 / 25 名额待绑定）
岗位权限矩阵（主班可上传、助教不可）: PASS（设计完成，服务端判据明确；实现与测试在 Stage B）
名额不是可登录账号                : PASS（状态机：UNASSIGNED → PENDING_SETUP → ACTIVE / DISABLED）
微信/支付宝扫码收款的**真实收款**   : BLOCKED（没有商户号/appid/证书/密钥 —— 见 §7、§9）
账单 / 支付订单 / 发票的数据模型    : PASS（设计完成，见 §6；实现与迁移在 Stage C/D）
Cloudflare 新依赖                 : 无（§2 列出既有依赖与替代方案）
V1 源码 / 现有数据 / 正式环境       : 零改动、未触碰
```

## 1. 现状核对（先看架构，再动手）

| 项 | 现状（实测） |
|---|---|
| 后端 | NestJS 10 + Express + `postgres.js` **裸 SQL**；schema 唯一真相是 `database/migrations/0001–0003`（含 `.down.sql`） |
| 数据表 | `users` `user_permissions` `sessions` `directories` `resources` `resource_files` `resource_reviews` `audit_logs` `upload_tickets` `storage_orphans` `v1_import_runs` `v1_migration_map` |
| 账号模型 | `users.role` 只有 `ADMIN` / `TEACHER`；`status` 只有 `active` / `inactive`；**没有**岗位、学段、班级字段 |
| 权限模型 | `shared/permissions.ts` 12 个权限码；授权按**目录**（`user_permissions.directory_id`）或全平台；唯一判定点是 `server/authz/authorization.service.ts`（`ADMIN` 字面量只允许出现在它与 `shared/permissions.ts`） |
| 目录 | `directories` 表 + `GET /api/directories/tree`；`allow_files=true` 只出现在 4 类叶目录；**没有"班级"这个维度** |
| 存储 | `server/storage/{local,s3}.provider.ts` 同一套接口；S3 后端兼容 R2 / AWS S3 / MinIO |
| 前端 | React 19 + Vite + Tailwind v4；页面在 `client/src/pages/*`，路由 `client/src/App.tsx`，导航 `client/src/components/Sidebar.tsx` |
| 支付/账单/发票 | **完全不存在**（`grep -i "payment|invoice|billing|alipay|wechatpay"` 在 `server/ shared/ client/src/ database/` 零命中）→ 全部是新增，不涉及改造既有表 |

## 2. Cloudflare 依赖清单（业主原则 2）

| 位置 | 依赖程度 | 风险 | 替代方案 |
|---|---|---|---|
| `server/storage/s3.provider.ts`（生产用 R2 的 S3 兼容端点） | **只是"一个 S3 端点"**，代码里没有任何 Cloudflare 专有 API | 低：R2 若不可用，上传/预览/下载会失败（但走的是标准 S3 协议） | 换成 AWS S3 / MinIO / Backblaze B2 / 自建 SeaweedFS，**只改配置**（`STORAGE_ENDPOINT/BUCKET/KEY`）；本地 provider 用于测试 |
| `scripts/r2-inventory.mjs` + `scripts/lib/r2-target.mjs` | 只调用 `ListObjectsV2` / `HeadBucket` | 低 | 同一个脚本可指向任何 S3 兼容存储（连接串是配置项） |
| 前端 / 后端业务代码 | **无** | — | — |

**本次新增的教师名额、账单、支付、发票模块一律不引入 Cloudflare 依赖**：
发票/凭证附件走**现有** `StorageService` 抽象（不新增第二套存储），支付走微信/支付宝官方接口，
依赖的是 HTTPS + 签名验签，与 Cloudflare 无关。

## 3. 39 个教师账号名额的设计

### 3.1 规格（唯一一份真相：`scripts/report-teacher-slots.mjs` 的 `SLOT_SPEC`）

| 学段 | 岗位 | 名额 | 编号 | 查看 | 上传 |
|---|---|---|---|---|---|
| K | 中方主班 | 5 | `K-01` … `K-05` | 允许 | 允许 |
| K | 外方主班 | 5 | `K-01-F` … `K-05-F` | 允许 | 允许 |
| K | 助教 | 5 | `K-01-A` … `K-05-A` | 允许 | **不允许** |
| Pre-K | 中方主班 | 8 | `PK-01` … `PK-08` | 允许 | 允许 |
| Pre-K | 外方主班 | 8 | `PK-01-F` … `PK-08-F` | 允许 | 允许 |
| Pre-K | 助教 | 8 | `PK-01-A` … `PK-08-A` | 允许 | **不允许** |
| | | **39** | | | |

### 3.2 表结构（Stage B 的 `0004_account_slots.sql`）

```sql
CREATE TABLE teacher_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,                       -- K-01 / K-01-F / PK-03-A（内部编号）
  track         text NOT NULL,                       -- K | PREK
  class_no      text NOT NULL,                       -- K-01 / PK-03（班级位，可改名）
  class_label   text,                                -- 真实班级名（如 "K1 班"），业主填
  position      text NOT NULL,                       -- LEAD_CN | LEAD_INTL | ASSISTANT
  status        text NOT NULL DEFAULT 'UNASSIGNED',  -- UNASSIGNED|PENDING_SETUP|ACTIVE|DISABLED
  bound_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT teacher_slots_code_unique   UNIQUE (code),
  CONSTRAINT teacher_slots_track_check  CHECK (track IN ('K','PREK')),
  CONSTRAINT teacher_slots_position_check CHECK (position IN ('LEAD_CN','LEAD_INTL','ASSISTANT')),
  CONSTRAINT teacher_slots_status_check CHECK (status IN ('UNASSIGNED','PENDING_SETUP','ACTIVE','DISABLED'))
);
-- 一个账号只能占一个名额；一个名额只能绑一个账号（并发下由唯一索引保证，不靠应用层判断）
CREATE UNIQUE INDEX teacher_slots_bound_user_unique ON teacher_slots (bound_user_id) WHERE bound_user_id IS NOT NULL;
```

**名额与账号必须分开**（业主 §2.2）：

| 状态 | 能不能登录 | 有没有口令 | 权限 |
|---|---|---|---|
| `UNASSIGNED` | **不能** | 无（`password_hash` 为空 → 服务端直接拒登；见下） | 无 |
| `PENDING_SETUP` | 不能 | 无 | 无 |
| `ACTIVE` | 能 | 有（scrypt 哈希） | 按岗位初始化（§5） |
| `DISABLED` | 不能 | 保留 | 会话立即撤销 |

> 实现要点：`users.password_hash` 现在是 NOT NULL。Stage B 的迁移会把它放宽为
> "允许空串占位 + 登录时显式拒绝空哈希"，**不新增默认口令**；这条要有测试钉住
> （空哈希账号用任何口令登录都必须失败，且不泄露"账号存在"）。

### 3.3 24 vs 39 差异（报告已生成）

`node scripts/report-teacher-slots.mjs` → `.migration/teacher-slot-difference.{md,json}`：

```
名额 39（自动绑定 0）
迁移账号 24：可对应名额 14（k_head 3 / k_assistant 4 / prek_head 3 / prek_assistant 4）
              岗位无对应 10（qlsadmin、qlsdirector、4 名体能专科、2 个探针、无用户名占位、TsinglanAdmin）
仍需绑定/补充的名额 25
主班名额需业主定"中方/外方" 26
```

**这份报告不替业主做决定**，也**不会**自动删号或强行映射（业主 §2.3 的硬要求）。

## 4. 岗位权限矩阵（含服务端判据）

| 岗位 | 查看资源 | 上传资源 | 删除/审核/发布/建目录/管账号 |
|---|---|---|---|
| 中方主班 / 外方主班 | `resource.view`（按目录授权） | `resource.create`（按目录授权） | **不给**（需要时单独授予并写审计） |
| 助教 | `resource.view`（按目录授权） | **不给** `resource.create` | **不给** |

服务端判据（不是界面显隐）：

1. 上传接口（`POST /api/resources`、`…/files/upload-url`、`…/files/register`）都要过
   `@RequirePermission('resource.create')` + 目录级授权检查；
2. **助教手动构造上传请求必须 403**（Stage B 的集成测试直接调 API，不看界面）；
3. 目录范围：名额本身**不授予任何目录** —— 目录授权仍走 `user_permissions`，
   由超级管理员按现有 `docs/PRODUCTION_PERMISSION_MATRIX.md` 的流程确认（**不得**因为生成名额就全体开放）。

## 5. 新增权限码（仍走现有 `AuthorizationService`）

| 权限码 | 中文 | 谁需要 |
|---|---|---|
| `finance.bill.view` | 查看账单 | 财务负责人 |
| `finance.bill.manage` | 创建/修改账单 | 财务负责人（超级管理员默认有） |
| `finance.payment.create` | 发起支付 | 付款人（可含财务负责人） |
| `finance.invoice.manage` | 录入/关联发票 | 财务负责人 |
| `finance.invoice.download` | 下载发票/凭证 | 账单归属人 + 财务负责人 |

普通教师**不会**因为新增支付页而获得任何财务权限（默认零授权）。

## 6. 数据模型（Stage C 的 `0005_finance.sql`）

```sql
CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no text NOT NULL,                  -- 唯一、可追踪（如 OP-202610-0001）
  item_code text NOT NULL,                -- server_hosting | domain | other（可配置字典）
  item_label text NOT NULL,
  description text,
  amount_cents bigint NOT NULL,           -- 分；币种单独一列，绝不用浮点
  currency text NOT NULL DEFAULT 'CNY',
  period_start date, period_end date,     -- 费用周期（可选）
  status text NOT NULL DEFAULT 'UNPAID',  -- UNPAID|PROCESSING|PAID|PARTIAL|CANCELLED|REFUNDED
  paid_cents bigint NOT NULL DEFAULT 0,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT bills_no_unique UNIQUE (bill_no),
  CONSTRAINT bills_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT bills_paid_range CHECK (paid_cents >= 0 AND paid_cents <= amount_cents),
  CONSTRAINT bills_currency_check CHECK (currency IN ('CNY'))
);

CREATE TABLE payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no text NOT NULL,                 -- 我方订单号（对渠道唯一）
  bill_id uuid NOT NULL REFERENCES bills (id) ON DELETE RESTRICT,
  provider text NOT NULL,                 -- WECHAT | ALIPAY
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CNY',
  status text NOT NULL DEFAULT 'PENDING', -- PENDING|PROCESSING|PAID|FAILED|CANCELLED|EXPIRED
  qr_payload text,                        -- 渠道返回的 code_url / qr_code（**不是**个人收款码）
  qr_expires_at timestamptz,
  provider_txn_id text,                   -- 渠道交易号（回调核验后写入）
  paid_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_orders_no_unique UNIQUE (order_no),
  CONSTRAINT payment_orders_provider_check CHECK (provider IN ('WECHAT','ALIPAY')),
  CONSTRAINT payment_orders_amount_positive CHECK (amount_cents > 0)
);

CREATE TABLE payment_transactions (       -- 每一条渠道通知/查询结果都留档（幂等的依据）
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES payment_orders (id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_event_key text NOT NULL,       -- 渠道通知的唯一标识（用于幂等）
  provider_txn_id text,
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CNY',
  signature_verified boolean NOT NULL DEFAULT false,
  applied boolean NOT NULL DEFAULT false, -- 是否已作用到订单/账单
  raw_payload jsonb NOT NULL,             -- 原样留档（含验签结果），便于事后核对
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_transactions_event_unique UNIQUE (provider, provider_event_key)
);

CREATE TABLE invoice_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills (id) ON DELETE RESTRICT,
  kind text NOT NULL,                     -- INVOICE（税务发票） | PAYMENT_VOUCHER（付款凭证）
  file_name text NOT NULL,
  storage_key text NOT NULL,              -- 复用现有存储抽象
  mime_type text NOT NULL,
  size bigint NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'ISSUED',  -- PENDING|ISSUED|VOID
  issued_at timestamptz,
  uploaded_by uuid REFERENCES users (id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_attachments_kind_check CHECK (kind IN ('INVOICE','PAYMENT_VOUCHER')),
  CONSTRAINT invoice_attachments_sha_format CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX payment_orders_provider_txn_unique
  ON payment_orders (provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
```

审计复用现有 `audit_logs`（单一审计源，不新建第二套）：新增动作
`finance.bill_create` / `finance.bill_update` / `finance.order_create` /
`finance.payment_notify` / `finance.payment_confirmed` / `finance.payment_mismatch` /
`finance.invoice_upload` / `finance.invoice_download` / `teacher_slot.bind` / `teacher_slot.status`。

## 7. 微信 / 支付宝扫码支付接入方案

两条链路都遵循同一套**服务端为准**的流程（业主 §3.3 的 11 条）：

```
用户点"支付" → 服务端建 payment_order（PENDING，写审计）
            → 调渠道下单（Native / precreate）拿 qr_payload + 有效期
            → 前端只展示二维码与金额（订单号/金额来自服务端响应，前端不参与计算）
            → 渠道异步通知 → 服务端：①验签 ②解密 ③核对 out_trade_no/金额/币种/商户号
                             ④幂等落库（payment_transactions 唯一键）⑤改订单与账单
            → 前端轮询我方接口（只读自己那笔订单）刷新状态
```

| 渠道 | 下单接口 | 二维码 | 异步通知核验 |
|---|---|---|---|
| 微信支付 v3（Native 扫码） | `POST /v3/pay/transactions/native`（`out_trade_no`、`amount.total` 分、`notify_url`） | 响应里的 `code_url` → 前端渲染二维码 | `Wechatpay-*` 头 + 平台证书/公钥验签；`resource` 用 APIv3 密钥 AES-256-GCM 解密；核对 `trade_state=SUCCESS`、`amount.total`、`out_trade_no`、`mchid` |
| 支付宝（当面付 `alipay.trade.precreate`） | 同上（`out_trade_no`、`total_amount`、`notify_url`） | 响应里的 `qr_code` | 表单回调 RSA2 验签（支付宝公钥）；核对 `trade_status=TRADE_SUCCESS`、`total_amount`、`out_trade_no`、`app_id`/`seller_id` |

**幂等与防重复入账**：渠道通知键 `(provider, provider_event_key)` 唯一；订单状态机只允许
`PENDING → PROCESSING → PAID`（或 `FAILED / CANCELLED / EXPIRED`），
`UPDATE … WHERE status = 'PENDING'` 这类**带条件的 SQL** 是唯一的状态推进方式；
金额/币种不符 → 记 `finance.payment_mismatch` 审计并**不改账单**。

**测试环境隔离**（业主 §3.4）：没有商户配置时
`GET /api/finance/payment-capability` 返回 `{ wechat: 'NOT_CONFIGURED', alipay: 'NOT_CONFIGURED' }`，
页面显示"待配置"，**不允许**用模拟回调改真实账单；测试环境的假通知必须带
`X-Test-Signature` 且只在 `PAYMENT_TEST_MODE=1` 下被接受，落库时标 `raw_payload.test = true`。

## 8. Stage B–E 计划

| Stage | 内容 | 关键门禁 |
|---|---|---|
| B | `teacher_slots` 迁移 + 39 名额生成 + 管理员绑定/启停/编辑 + 审计 | 助教上传 403（服务端）；不可自提权；重复绑定被唯一索引拒；空哈希账号登不进 |
| C | 账单页 / 支付页 / 账单模型 / 订单创建接口 / 附件下载授权 | 前端改不了金额；未授权者看不到别人的账单与发票；无真实发票不冒充发票 |
| D | 微信、支付宝适配器（下单/二维码/通知/验签/幂等/超时） | 成功、失败、重复回调、金额不符、过期、二维码失效六种场景在测试环境全过；**真实收款 BLOCKED** |
| E | 全量门禁 + 桌面/移动浏览器验收 | 见 §10 清单；任何一项未运行/被阻断都不得标 PASS |

## 9. 还缺的配置与业务决定（`DECISION_REQUIRED`）

| # | 缺什么 | 谁来定 | 影响 |
|---|---|---|---|
| 1 | 微信支付：商户号 `mchid`、AppID、APIv3 密钥、商户证书序列号与私钥、平台证书/公钥 | 业主（本机安全配置，**不要贴聊天**） | 没有 → 微信真实收款 `BLOCKED` |
| 2 | 支付宝：AppID、应用私钥、支付宝公钥、`seller_id` | 同上 | 没有 → 支付宝真实收款 `BLOCKED` |
| 3 | 收费对象与规则：谁付（学校？教师？）、收什么（服务器/域名/其他）、周期、是否允许部分支付/预付款 | 业主 | 决定账单模型与 `bill_items` 是否需要多行 |
| 4 | 账单查看范围：谁看全校账单、谁只看自己的 | 业主（超管可维护） | 决定 `finance.bill.view` 的授予范围 |
| 5 | 39 名额的中方/外方归属 + 真实班级名 + 花名册 | 业主 | 26 个主班名额待定；10 个现有账号的去留 |
| 6 | 教师目录开放范围（现有 `BLOCKED` 项） | 业主 | 名额不解决目录授权，仍需要这份决定 |
| 7 | 发票：是否已能取得真实税务发票；只能给付款凭证时如何标注 | 业主 | 决定 `kind` 的默认值与页面文案 |

## 10. Stage E 门禁清单（本轮尚未执行，实现后逐项跑）

```
39 名额数量与岗位分布正确                : NOT RUN（Stage B）
账号资料仅超级管理员可编辑                : NOT RUN
助教上传被服务端拒绝（含手工构造请求）      : NOT RUN
未授权者看不到他人账单/发票               : NOT RUN
真实支付状态不能被前端伪造                : NOT RUN
重复通知不重复入账                       : NOT RUN
账单金额与实付一致 / 金额不符不改账单      : NOT RUN
无真实发票时不冒充发票                    : NOT RUN
页面兼容现有 UI 与移动端                 : NOT RUN
现有账号/资源/目录/文件引用不受影响        : NOT RUN
无 Cloudflare 新依赖                    : PASS（设计层面；实现时用静态检查兜住）
V1 零改动、无凭据泄漏                    : PASS（本轮只读）
```

## 11. 本轮边界声明

* V1 源码零改动；未连接生产数据库；未改正式域名；未创建/修改任何生产资源。
* 只读了：现有仓库代码与迁移、本机冻结迁移文件（生成差异报告）。
* **没有**用 Zeabur API 做任何写操作（只用了只读查询确认项目/服务清单）。
* 真实收款、正式部署、域名切换都**未执行**。
