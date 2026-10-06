# V2 数据模型

> 目标：**8 张表**（V1 是 13 张，其中 4 张属于被删除的权限/兼容设计）。
> 每张表存在的理由、每个字段的必要性、以及**为什么没有别的表**，都在这里写清楚。

## 1. 总览

```
users ──┬── user_permissions ──┐
        │                      │(directory_id, NULL = 全平台)
        ├── sessions           │
        ├── resources ─────────┴── directories （自引用树）
        │      ├── resource_files
        │      ├── resource_reviews
        │      └── resource_versions（可选）
        └── audit_logs
```

| 表 | 职责 | 一句话理由 |
|---|---|---|
| `users` | 账号与身份 | 只有 ADMIN / TEACHER 两种身份 |
| `user_permissions` | **唯一**授权真相 | 一个权限 + 一个目录范围 |
| `directories` | **唯一**目录真相 | 自引用树 + 能力开关 |
| `resources` | 资源元数据与状态 | 只挂目录，不挂班型/科目 |
| `resource_files` | 文件真相 | 一个资源 0..n 个文件 |
| `resource_reviews` | 审核流水 | 谁在什么时候把状态从 A 改到 B、说了什么 |
| `audit_logs` | 审计 | 谁、何时、做了什么、结果 |
| `sessions` | 会话 | 可即时撤销 |

**可选第 9 张**：`resource_versions`（沿用 V1 的 0011 思路）。第一版可以只用
`resources.version` 整数 + `resource_reviews` 记录，等"编辑已发布资源生成新版本"真正
需要留档时再建。

**V2 明确不存在**（V1 有、此处删除）：`subject_permissions`、
`account_permission_overrides`、`account_scopes`、`teacher_mfa`、
`mfa_recovery_codes`、`mfa_challenges`。

---

## 2. `users`

```sql
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username           text NOT NULL,
  name               text NOT NULL,              -- 中文姓名，界面主显示
  name_en            text,                       -- 英文界面用
  password_hash      text NOT NULL,              -- scrypt，格式与 V1 一致，便于迁移
  role               text NOT NULL DEFAULT 'TEACHER',  -- ADMIN | TEACHER
  status             text NOT NULL DEFAULT 'active',   -- active | inactive
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE INDEX users_status_idx ON users (status);
```

| 字段 | 为什么需要 | 为什么不能省 |
|---|---|---|
| `username` | 登录名 | 大小写不敏感唯一（V1 出现过 `NULL` 用户名的残留账号，V2 直接 NOT NULL + 唯一） |
| `name` / `name_en` | 双语界面显示 | 与目录节点同样的双语约定 |
| `password_hash` | 认证 | scrypt；**任何接口都不返回该字段** |
| `role` | ADMIN / TEACHER | 只有两种。**不存在 roles 数组，不存在第三个平台角色** |
| `status` | 停用账号 | 停用必须能立刻阻止登录（同时撤销该账号的全部会话） |
| ~~`permissions_version`~~ | **不存在** | 业主明确要求不要这个概念。即时生效改由"权限变更时直接撤销该用户会话"实现，见 `PERMISSION_MODEL.md` §6 |
| `created_at` / `updated_at` | 审计与排序 | |

**为什么没有 `email` / `phone` / `wecom_user_id`**：业主从未要求，V1 的
`wecom_user_id` 属于一个从未实现的登录方式。需要时再加列（`ALTER TABLE ADD COLUMN`
是安全操作），不需要时留着只会让人以为有对应功能。

---

## 3. `user_permissions`（唯一授权真相）

```sql
CREATE TABLE user_permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission   text NOT NULL,                    -- 见 PERMISSION_MODEL.md 的权限目录
  directory_id uuid REFERENCES directories(id) ON DELETE CASCADE,  -- NULL = 全平台
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX user_permissions_uniq
  ON user_permissions (user_id, permission, COALESCE(directory_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX user_permissions_user_idx ON user_permissions (user_id);
CREATE INDEX user_permissions_dir_idx  ON user_permissions (directory_id);
```

- `directory_id IS NULL` → 该权限对整个平台生效。
- `directory_id = D` → 对 **D 及其整棵子树**生效。
- **没有 deny、没有 override、没有 scope kind。**
  业主点名的四种形态（ALL / OWN / PROGRAM / SUBJECT）全部由这一个字段表达：
  - ALL → `directory_id IS NULL`
  - PROGRAM/SUBJECT → `directory_id =` 那个节点
  - OWN → 不是范围，而是**资源所有权**规则，写在权限目录的语义里
    （`resource.update.own` / `resource.delete.own` 只对 `uploader_id = 自己` 的资源有效），
    **不需要一个 scope 形态**

> 这条是 V1 → V2 最关键的简化。V1 的 `account_scopes.kind` 有 `account_scopes_shape_check`
> 约束，还有"ALL/OWN 不能带 program/subject、PROGRAM 必须带 program、SUBJECT 必须带两者"
> 的形状规则，以及把非法形状从 500 改成 400 的一次修复。V2 用**一个可空外键**让非法形状
> 在结构上不可能出现。

---

## 4. `directories`（唯一目录真相）

```sql
CREATE TABLE directories (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id            uuid REFERENCES directories(id) ON DELETE RESTRICT,  -- NULL = 一级栏目
  slug                 text NOT NULL,             -- 不可变；URL 用；同级唯一
  name                 text NOT NULL,             -- 可编辑
  name_en              text,                      -- 可编辑
  description          text,                      -- 可编辑
  type                 text NOT NULL DEFAULT 'SECTION', -- ROOT|CATEGORY|SECTION|FOLDER（仅影响展示）
  sort_order           integer NOT NULL DEFAULT 0,
  enabled              boolean NOT NULL DEFAULT true,
  allow_children       boolean NOT NULL DEFAULT true,   -- 允许在其下继续建子目录
  allow_files          boolean NOT NULL DEFAULT false,  -- 允许直接放资源
  allow_custom_folders boolean NOT NULL DEFAULT false,  -- 允许普通教师自建子文件夹
  icon                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX directories_slug_uniq ON directories (COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX directories_parent_idx ON directories (parent_id, sort_order, name);
CREATE INDEX directories_enabled_idx ON directories (enabled);
```

字段级理由与用法见 **`DIRECTORY_MODEL.md`**。这里只强调三条结构决定：

1. `parent_id ON DELETE RESTRICT` —— 数据库自己拒绝"删掉还有子节点的目录"。
2. `slug` 不可变 —— 改名不破坏任何 URL 与历史链接。
3. **没有 `program` / `subject` / `sub_subject` / `is_system` 列** ——
   V1 有这四个，它们把树锁死在课程场景里，也是"子科目与资料夹后缀共用一个 code 段"
   那类 bug 的来源。

---

## 5. `resources`

```sql
CREATE TABLE resources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  directory_id  uuid NOT NULL REFERENCES directories(id) ON DELETE RESTRICT,
  title         text NOT NULL,
  title_en      text,
  description   text,
  status        text NOT NULL DEFAULT 'DRAFT',   -- 见 RESOURCE_LIFECYCLE.md
  version       integer NOT NULL DEFAULT 1,
  uploader_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at  timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resources_directory_idx ON resources (directory_id) WHERE deleted_at IS NULL;
CREATE INDEX resources_uploader_idx  ON resources (uploader_id, status) WHERE deleted_at IS NULL;
CREATE INDEX resources_status_idx    ON resources (status) WHERE deleted_at IS NULL;
CREATE INDEX resources_search_idx    ON resources USING gin (to_tsvector('simple', title || ' ' || coalesce(description,'')));
```

| 字段 | 说明 |
|---|---|
| `directory_id` | **唯一**分类方式。NOT NULL + RESTRICT：资源不会因为没有目录而"消失"，也不能靠删目录带走 |
| `status` | 5 个值，**没有更多**。V1 的 `folder_type` / `semester` / `week_number` / `theme` 不再是必填分类 |
| `version` | 编辑已发布资源时自增，配合 `resource_versions` 留档 |
| `uploader_id` | `ON DELETE SET NULL` —— **删账号不得删掉历史资源**（V1 用 `NO ACTION` 保护，V2 用 SET NULL + 审计保留归属文字，语义更清楚） |
| `deleted_at` | 软删除 = 回收站。硬删除必须显式 purge 权限 |

**V2 没有的列（相对 V1）**：`folder_type`、`program`、`subject`、`sub_subject`、
`semester`、`week_number`、`theme`、`file_name`、`file_size`、`file_type`、
`has_stored_file`、`file_path`、`bucket`。

- 前 7 个是分类字段：V2 只用目录表达分类。学期/周次若以后需要，作为**可选标签**加回来，
  并且**不允许**成为上传必填项。
- 后 6 个是文件字段：拆进 `resource_files`。

---

## 6. `resource_files`

```sql
CREATE TABLE resource_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  file_name    text NOT NULL,        -- 原始文件名，用于显示与下载名
  storage_key  text NOT NULL,        -- 对象存储里的 key（前端永不接触）
  mime_type    text NOT NULL,
  size         bigint NOT NULL,
  sha256       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX resource_files_key_uniq ON resource_files (storage_key);
CREATE INDEX resource_files_resource_idx ON resource_files (resource_id, created_at);
```

- `resource_id ON DELETE CASCADE`：资源被**硬删除**时文件行一起走（软删除不动它们）。
- `storage_key` 唯一：同一个对象不能被两个资源行同时登记（防止登记接口被重放）。
- `sha256` 必填：登记时服务端下载/HEAD 校验后写入，用于去重与完整性证明。

---

## 7. `resource_reviews`

```sql
CREATE TABLE resource_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,        -- submit | approve | reject | recall | resubmit
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  comment      text,                 -- 退回时必填
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_reviews_resource_idx ON resource_reviews (resource_id, created_at);
```

`from_status` / `to_status` 都落库：这样"审核历史"是一次查询就能渲染的时间线，
而不是靠推断当前状态反推过去（V1 的审核历史只能显示结果，看不出中间被退回几次）。

---

## 8. `audit_logs`

```sql
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name  text NOT NULL,          -- 冗余保存：账号被删后审计仍可读
  action      text NOT NULL,
  target_type text NOT NULL,          -- user | directory | resource | file | session
  target_id   text,
  result      text NOT NULL,          -- success | denied | failed
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx  ON audit_logs (target_type, target_id);
```

- `actor_name` 冗余：`ON DELETE SET NULL` 之后审计行仍然能读出"当时是谁"。
- `detail` 用 jsonb 而不是一堆列：审计动作会增长，加动作不应该要改表。
- **`detail` 里绝不写入**：口令、`password_hash`、session token、签名 URL、storage key、
  任何密钥。由 `tests/audit-redaction.test.mjs` 静态 + 运行时双重保证。

---

## 9. `sessions`

```sql
CREATE TABLE sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash           text NOT NULL,        -- 只存 hash，不存 token 本身
  ip                   text,
  user_agent           text,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz           -- 权限/状态变更时立即置为 now()
);
CREATE UNIQUE INDEX sessions_token_uk ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);
```

**没有 `permissions_version` 列。** 即时生效由"权限变更 → 撤销该用户全部会话"实现
（`PERMISSION_MODEL.md` §6），不需要在会话上比对版本号。

`ON DELETE CASCADE`：删账号时会话一起消失（安全侧），而 `audit_logs.actor_name`
保留了历史（审计侧）。

---

## 10. 约束与索引的取舍说明

| 决定 | 理由 |
|---|---|
| 所有 `id` 用 `uuid` | 目录/资源的 id 会出现在 API 与日志里，自增整数会泄露规模并便于枚举 |
| 所有时间用 `timestamptz` | V1 用 `timestamptz`；不要混入无时区的 `timestamp` |
| 外键**全部**显式声明 `ON DELETE` | "默认行为"是最容易静默造成数据损失的角落。V1 有专门测试钉住 `resources.uploader_id` 必须是 `NO ACTION` |
| 部分索引带 `WHERE deleted_at IS NULL` | 回收站里的行不参与常规查询，索引不该为它们付费 |
| 不建触发器维护 `updated_at` | 触发器对批量写与迁移是隐形的，V2 在 service 层显式维护，便于测试 |
| 搜索用 GIN + to_tsvector | 目标数据量（几千条资源）下 `ILIKE` 也够，但用 tsvector 可以顺带支持文件名与目录名，且不引入搜索中间件 |

## 11. 迁移策略

- `database/migrations/NNNN_name.sql` + `NNNN_name.down.sql`，**应用后永不修改**。
- `scripts/migrate.mjs` 记录每个文件的 SHA-256；`verify` 发现漂移即拒绝继续。
- V2 的迁移从 `0001` 重新开始。**不继承** V1 的 12 个迁移文件 ——
  它们包含了已被删除的表与列的演进史，继承过来只会让 V2 的 schema 说 V1 的故事。
- V1 → V2 的数据搬迁由 `scripts/import-v1.mjs` 完成（阶段 10），它读 V1 的库（只读），
  写 V2 的库。

## 12. 种子数据（**已确认：严格按 PDF**）

`database/seeds/001_directory_tree.sql` 按 PDF《教师平台》初始化。
**权威版本是 `PRODUCT_REQUIREMENTS.md` §7 的那棵树**，逐字照做，不得自行增删：

```
教育教学
├── Pre-K
│   ├── 美德 → 课程大纲 / 教学详案 / 教学资源 / 考核评估
│   ├── 蒙特梭利 → （同上四类）
│   ├── 体能 → （同上四类）
│   └── 英文 → （同上四类）
└── K
    ├── 中文教学 → 绘本阅读 / 古诗 / STEM / 美育（各自四类）
    ├── 英文教学 → （四类）
    └── 体能 → （四类）
教师成长
├── L1 基础规范
│   ├── 职业道德规范
│   ├── 安全施教规范 → 应急预案 → 传染病识别与防治 / 意外伤害预防与处置
│   ├── 专业知识
│   └── 专业技能 → 一日生活规范 / 与幼儿建立联系 / 游戏化教学
├── L2 独立胜任
└── L3 卓越引领
```

**必须存在的节点（不得自行删除）**：`Pre-K → 英文`、`职业道德规范 → 师风师德建设`。
业主已明确点名这两个。

### 节点的能力开关（seed 里就要写对）

| 节点层级 | `allow_children` | `allow_files` | `allow_custom_folders` |
|---|---|---|---|
| 一级栏目（教育教学 / 教师成长） | ✅ | ❌ | ❌ |
| 班型层（Pre-K / K） | ✅ | ❌ | ❌ |
| 科目层（美德 / 中文教学 / L1 …） | ✅ | ❌ | ❌ |
| **课程大纲** | ✅ | ✅ | ❌ |
| **教学详案** | ✅ | ✅ | ✅ ← PDF 标注允许自建 |
| **教学资源** | ✅ | ✅ | ✅ ← PDF 标注允许自建 |
| **考核评估** | ✅ | ✅ | ❌ |

于是"上传资源"按钮只出现在真正能放文件的四个资料夹上；
"新建文件夹"只出现在 PDF 标注允许的 `教学详案` / `教学资源` 上。
（PDF 只是**初始**目录，之后管理员可以随意改这些开关。）

**这份 seed 不是凭 PDF 猜出来的。** 我逐行打印了 V1 测试库 `directories` 表的全部 69 个节点，
确认 V1 的树与上面这份结构**逐字一致**：`prek:english`（Pre-K 英文）存在、
`k:chinese:{reading,poetry,stem,arts}` = 绘本阅读 / 古诗 / STEM / **美育**、
每个末级科目下正好是 `outline/lesson/resource/assessment` = 课程大纲 / 教学详案 /
教学资源 / 考核评估、`growth:l1:safety:plan:{disease,injury}` 两个子项都在。
逐项比对表见 `V1_FUNCTION_MAPPING.md` 的"附"一节。

因此：

- **seed 可以直接由 V1 的树生成**，不需要重新设计；
- **迁移是一对一映射**：`code` 的 `:` 分隔正好对应 slug 路径层级
  （`prek:virtue_outline` → `教育教学/prek/virtue/课程大纲`），
  69 个节点可无损搬迁，`import-v1.mjs` **不需要猜**。

**「师风师德建设」业主已确认是真实业务，保留**（这一条在 V1 库与 PDF 之间曾经看起来
不一致，核对后确认 V1 的库才是对的 —— 这也是"先查数据再改设计"的一次实例）。

seed 只负责**初始内容**，不是权限或代码的一部分；任何一行都可以被管理员改名、移动、
停用、删除。`seeds` 与 `migrations` 分开，重跑 seed 不会与迁移的 checksum 冲突。
