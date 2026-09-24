# RBAC.md — 角色 / 权限 / 数据范围 设计

> 本文档描述**已实现**的授权模型。
> 契约的**唯一来源**是 [`shared/rbac.ts`](shared/rbac.ts)；本文档解释设计意图，
> 若与代码不一致，**以代码为准**，并应把本文档改正。
>
> 状态：模型与契约已实现并通过类型检查。**执行层（AuthorizationService /
> PermissionGuard / 数据库表）在阶段 5 实现**，落地进度见
> [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) §N。

---

## 1. 要解决的问题

改造前的授权是三类碎片拼起来的：

| 问题 | 改造前 | 后果 |
|---|---|---|
| 角色定义漂移 | 5 处各写一份（8 / 7 / 7 / 5 …） | `ROLE_DEFINITIONS` **漏 `k_assistant`**，权限矩阵无法显示该角色 |
| 授权逻辑分散 | 控制器与 service 里到处 `roles.includes('x')` | 新增接口容易漏检查；同一规则多份实现 |
| 无数据范围 | 只有"能不能做"，没有"能对哪些数据做" | 无法表达"只能看 Pre-K""只能改自己的资源" |
| 无权限即时生效 | 权限存在会话里 | 撤销权限后旧会话仍可用 |
| 无系统级最高权限 | `principal` 既是业务管理员又是事实上的最高权限 | 园长账号被盗即等于系统沦陷，没有更高一级的护栏 |

---

## 2. 三层模型：角色 + 权限 + 数据范围

```
        角色 (Role)              权限 (Permission)           数据范围 (Scope)
   = 默认权限的集合          = 能执行的动作（原子）      = 该动作作用于哪些数据

   super_admin ─────┐
   principal ───────┤
   curriculum_dir ──┼──►  ROLE_PERMISSIONS[role]  ──┐
   prek_head ───────┤                               │
   k_head ──────────┤                               ├──► 有效权限
   pe_specialist ───┤      account_permission_      │    = (角色默认 ∪ 追加授权) − 显式禁止
   prek_assistant ──┤      overrides (DB)  ─────────┘    ← 禁止永远优先
   k_assistant ─────┤         grant / deny
   visitor ─────────┘
                                  +
                          account_scopes / subject_permissions (DB)
                                  │
                                  ▼
                    对具体数据行做 scopeSatisfies() 判定
```

**关键原则：不把"角色更高"直接翻译成"什么都能做"。**
角色等级（`ROLE_RANK`）**只**用于一条规则——"管理员不能授予不低于自己等级的角色"。
一个动作是否允许，只看它需要的权限是否在有效权限集合里。

---

## 3. 角色

| 角色 | 中文名 | 等级 | 保护 | 说明 |
|---|---|---|---|---|
| `super_admin` | 系统超级管理员 | 100 | ✅ | 系统最高权限，持有**全部**权限，仅超级管理员可管理超级管理员 |
| `principal` | 园长/平台管理员 | 80 | | 业务最高管理者；有账号/权限/审计，但**无系统级安全与配置权限** |
| `curriculum_director` | 教学主任/教研主管 | 60 | | 审核发布、全部课程查看 |
| `prek_head` | Pre-K 主教 | 40 | | Pre-K 上传与提交审核 |
| `k_head` | K 主教 | 40 | | K 上传与提交审核 |
| `pe_specialist` | 体能专科教师 | 40 | | 体能类科目（跨班型） |
| `prek_assistant` | Pre-K 配班/代课 | 20 | | 默认只读，可按科目单独授权上传 |
| `k_assistant` | K 配班/代课 | 20 | | 同上 |
| `visitor` | 普通访客/家长 | 0 | | 可登录，但不获得任何课程或系统权限 |

### 3.1 `super_admin` 的特别保护

设计要求（对应原始需求"super_admin 自己不能被普通 principal 修改"）：

1. **授予**：`canGrantRole()` 规定只有 `super_admin` 能授予/撤销 `super_admin`。
   非超级管理员尝试授予 → 拒绝并写审计。
2. **管理**：`canManageAccount()` 规定目标是 `super_admin` 时，操作者也必须是
   `super_admin`。（改资料、停用、重置密码、强制下线都走这条）
3. **数据库层**：阶段 5 将加触发器，禁止非超级管理员写入 `super_admin` 行，
   防止应用层出现 bug 时被绕过。
4. **数量上限**：`RBAC_INVARIANTS.maxSuperAdmins = 2`。
5. **不可删除最后一名**：删除/停用后必须至少还剩一名 `super_admin`。

### 3.2 防提权（需求第二十七条）

`canGrantRole()` 还禁止"授予不低于自己等级的角色"，因此：

- `curriculum_director` **不能**创建 `prek_head`（同级）；
- `principal` **不能**创建另一个 `principal` 或 `super_admin`；
- 普通账号**无法**通过 `PATCH /api/teachers/:id` 修改自己的 `roles` 提权——
  该接口在阶段 5 会改为必须携带 `role.assign` 权限且经过 `canGrantRole()` 校验。

---

## 4. 权限目录

44 条权限，分为 11 组（分组仅用于 UI 与批量操作，**不参与鉴权判定**）：

| 组 | 权限 |
|---|---|
| `system` | `system.manage` `system.health` `system.config` `system.maintenance` `system.backup` `system.restore` `system.migration` `system.error_log` |
| `security` | `security.manage` `security.events` `mfa.manage_self` `mfa.reset_other` |
| `account` | `account.view` `account.create` `account.update` `account.disable` `account.reset_password` `account.force_logout` |
| `role` | `role.view` `role.assign` |
| `permission` | `permission.view` `permission.grant` `permission.revoke` |
| `session` | `session.view` `session.revoke` |
| `audit` | `audit.view` `audit.export` |
| `curriculum` | `curriculum.view` `curriculum.manage` |
| `resource` | `resource.view` `resource.create` `resource.update` `resource.delete` `resource.download` `resource.submit_review` `resource.publish_without_review` `resource.restore` `resource.purge` |
| `review` | `review.view` `review.approve` `review.reject` |
| `storage` | `storage.upload` `storage.download` `storage.delete` |

每条权限带两个元数据：

- `dataScoped` —— 是否受数据范围约束（`resource.*`、`review.*`、`curriculum.view`、`storage.*` 为 true）。
- `highRisk` —— 授予/执行时是否需要重新认证（需求第二十八条）。

**注意 `resource.publish_without_review`（免审核发布）是独立权限**，而不是"管理员自动拥有"。
这样"管理员能否绕过审核"是一个**显式、可审计**的决定，默认只给 `super_admin`
（需求第五十三条）。

---

## 5. 有效权限与"追加 / 撤销"

```
有效权限 = ( 角色默认权限的并集  ∪  追加授权 )  −  显式禁止
```

- **角色默认**：`ROLE_PERMISSIONS[role]`（代码内定义，见 §6）。
- **追加授权 / 显式禁止**：存在数据库 `account_permission_overrides`
  （阶段 5 建表），支持"给这个配班主任单独开上传"这类需求。
- **禁止永远优先**：即使角色默认包含某权限，一条 `deny` 记录即可收回。

这套结构直接支撑需求第七条"角色默认权限 + 单独追加权限 + 单独撤销权限"。

---

## 6. 为什么目录写在代码里而不是数据库

权限目录与角色默认权限放在 `shared/rbac.ts`，数据库**只存每个账号的差异**：

| | 放在代码 | 放在数据库 |
|---|---|---|
| 新增一条权限 | 改一个文件，前端后端同时生效 | 需要 migration + 两端同步 |
| 目录漂移 | 不可能（单一来源） | 极易发生（本项目已发生过 5 处漂移） |
| 审计"某权限何时出现" | git history | 需要额外表 |
| 每个账号的差异 | — | ✅ 必须落库 |

`assertRbacCatalogIntegrity()` 在启动与测试时校验：
权限码不重复、角色引用的权限都存在、`super_admin` 覆盖全部权限、等级定义完整。
**违反即抛错**，不静默修复。

---

## 7. 数据范围（Scope）

四种范围：

| 范围 | 含义 | 例子 |
|---|---|---|
| `ALL` | 不限 | `super_admin` 全部；`principal` 的业务权限 |
| `PROGRAM` | 限定班型 | `prek_head` → 只能作用于 `program='prek'` |
| `SUBJECT` | 限定班科（可细分到子科目） | 某配班只被授权 `montessori/sensorial` |
| `OWN` | 仅本人拥有的数据 | `resource.update` + `OWN` = 只能改自己上传的 |

判定函数 `scopeSatisfies(binding, target, actorId)` 是**纯函数**，因此可被服务和测试共用。

**向后兼容**：没有 scope 记录时，教学角色仍按既有 `subject_permissions` 表约束——
现有 20 个账号的行为**不变**。这一点很重要：数据范围是**在现有
`subject_permissions` 之上叠加**，不是替换，避免迁移风险。

---

## 8. 权限即时生效（`permissions_version`）

会话里不缓存"这个人能做什么"，而是缓存一个**版本号**：

```
任意授权变更（改角色 / 追加 / 撤销 / 改 scope / 停用）
        ↓
teachers.permissions_version += 1
        ↓
每个请求 AuthGuard 比较 session.permissions_version 与当前值
        ↓
不一致 → 401 要求重新认证（而不是继续用旧权限）
```

好处：撤销权限**不需要扫描并逐个撤销会话**，也不存在"撤销了但旧会话还能用几小时"
的问题（需求第三十四、三十五条）。

---

## 9. 与现有代码的衔接（阶段 5 待办）

| 事项 | 现状 | 阶段 5 |
|---|---|---|
| 角色契约 | ✅ 已统一到 `shared/rbac.ts` | — |
| 有效权限计算 | ✅ `roleDefaults()` 已实现 | 叠加 DB 覆盖项 |
| 统一授权入口 | ❌ 仍是各处 `roles.includes(...)` | `AuthorizationService.requirePermission()` + `PermissionGuard` |
| 数据范围执行 | ⚠️ 仅 `subject_permissions` | 接入 `ScopeTarget` 判定 |
| 覆盖项表 | ❌ 无 | migration 0003 |
| `permissions_version` | ❌ 无 | migration 0003 + 写入点 |
| super_admin DB 保护 | ❌ 无 | migration 0003 触发器 |
| MFA | ❌ 无 | migration 0005 |

---

## 10. 验收方式

- **单元**：`assertRbacCatalogIntegrity()`、`roleDefaults()`、`canGrantRole()`、
  `canManageAccount()`、`scopeSatisfies()` 的边界用例。
- **矩阵测试**（阶段 8）：对 9 个角色 × 44 条权限断言允许/拒绝，形成
  `rbac.security.spec.ts`，防止后续改动悄悄放宽权限。
- **越权测试**：普通账号直接调用管理员 API 必须 401/403 且写审计；
  `principal` 提权为 `super_admin` 必须被拒。
