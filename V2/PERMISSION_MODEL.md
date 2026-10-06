# V2 权限模型

> 业主的要求有两句，必须同时满足：
> **"教师账号只想填姓名/账号/密码/权限，管理员不需要理解 permission code。"**
> **"虽然 UI 很简单，但后端仍必须检查。不能因为按钮隐藏，就认为没有权限。"**

## 1. 只有两种身份

```
ADMIN   —— 管理整个系统（账号、权限、目录、审核、审计）
TEACHER —— 能做管理员授予的事，对管理员指定的目录
```

一列 `users.role` 就够。**没有角色表、没有角色数组、没有第三个平台角色。**

| V1 | V2 | 处置理由 |
|---|---|---|
| 7 种角色 + `super_admin` | 2 种身份 | 7 种角色里，实际差异全部可以表达为"哪些权限 + 哪些目录" |
| `teachers.roles` 数组 | `users.role` | 数组可以同时持有互斥角色，判定顺序依赖代码细节 |
| `ROLE_PERMISSIONS` 角色→权限映射表 | 无 | 这层映射是"第二份授权真相"：改了权限目录要同时改映射表，容易分叉 |

## 2. 权限目录（代码里的常量，12 项）

```ts
// shared/permissions.ts —— 权限目录是代码常量，与"谁被授予了它"（数据库）分离
export const PERMISSIONS = {
  // —— 资源 ——
  'resource.view':          { label: '查看资源',       scope: 'directory' },
  'resource.create':        { label: '上传资源',       scope: 'directory' },
  'resource.update.own':    { label: '编辑自己的资源', scope: 'directory' },
  'resource.delete.own':    { label: '删除自己的资源', scope: 'directory' },
  'resource.download':      { label: '下载资源',       scope: 'directory' },
  'resource.submit':        { label: '提交审核',       scope: 'directory' },
  // —— 审核 ——
  'resource.review':        { label: '审核资源',       scope: 'directory' },
  'resource.publish':       { label: '发布资源',       scope: 'directory' },
  // —— 管理 ——
  'directory.manage':       { label: '管理目录',       scope: 'directory' },
  'directory.create_folder':{ label: '新建文件夹',     scope: 'directory' },
  'user.manage':            { label: '管理教师',       scope: 'global' },
  'audit.view':             { label: '查看审计',       scope: 'global' },
} as const
```

**12 项，不再增加**（要加必须先证明现有 12 项表达不了）。

### 与业主最终清单的两处差异（**需要你确认**）

你这次给的勾选框清单是 10 项：查看资源 / 上传资源 / 编辑自己的资源 / **下载资源** /
提交审核 / 审核资源 / 发布资源 / 管理目录 / 管理教师 / 查看审计。
我按你的清单加入了「下载资源」（原来我把它并进了"查看资源"，现在改回独立一项）。

但你这 10 项里**没有**下面两个，而它们被其它要求绑定了，所以我先保留并标出来：

| 我保留的项 | 被哪条要求绑定 | 如果去掉会怎样 |
|---|---|---|
| `resource.delete.own` 删除自己的资源 | §21 回收站要求"教师只能看到自己的删除内容""支持恢复" | 教师就**不能删除自己的资源**，回收站对教师永远是空的 |
| `directory.create_folder` 新建文件夹 | §14/PDF 要求"教学详案 / 教学资源允许自建文件夹"；§17 要求教师能"新建文件夹 → 环境创设 → 上传" | 教师就**不能自建文件夹**，PDF 里标注的自建能力无法落地 |

如果你的意思是"教师不应该能删除自己的资源 / 不应该能自建文件夹"，说一句我就把这
两项从界面与后端一起去掉（**保留权限码但不给任何账号勾选**，或彻底删除，两种都能做）。

> 另外一点：**"编辑自己的资源"里的 ".own" 不是范围概念**，它只是权限码名字里的后缀，
> 管理员界面上显示的中文永远是"编辑自己的资源"这五个字，看不到 `.own`。

### 与 V1 的对照

| V1 | V2 | 理由 |
|---|---|---|
| `resource.download` + `storage.download`（两个权限 AND） | 只留 `resource.download` | 存储权限是**实现细节**，不该成为业务权限 |
| `review.view` + `resource.review` + `resource.publish` | `resource.review`（看+审）+ `resource.publish`（发） | 真实分工：有人只能看、有人能审、有人能发 |
| `curriculum.view` / `curriculum.manage` | `directory.manage` | 目录就是课程结构，不需要两组权限 |
| `directory.create_child` | `directory.create_folder` | 名字与界面文案「新建文件夹」一致 |

### `resource.update.own` 里的 "own" 是什么

它不是范围（scope），而是**所有权约束**：

- 持有 `resource.update.own` 且目录范围覆盖目标资源所在目录 → 还能编辑；
- **但只对 `resources.uploader_id = 自己` 的资源有效**。

所以教师管理界面里勾选"编辑自己的资源"就够了，管理员不需要再理解"OWN 这种 scope 形态"。

管理员要改别人的资源 → 由 `resource.publish` 或 ADMIN 身份覆盖（见 §5）。

## 3. 授权 = 权限 + 目录

```sql
user_permissions(user_id, permission, directory_id NULL)
```

| `directory_id` | 含义 |
|---|---|
| `NULL` | 全平台（所有目录） |
| 某个节点 id | 该节点**及其整棵子树** |

判定函数只有两个：

```ts
// server/authz/index.ts
hasPermission(user, permission): boolean            // 是否持有（忽略范围）
can(user, permission, targetDirectoryId): boolean    // 是否对**这个目录**有效
```

`can()` 的算法：

```
role === 'ADMIN'                          → true
存在 (permission, NULL)                    → true
存在 (permission, D) 且 target ∈ subtree(D) → true
否则                                        → false
```

`subtree(D)` 用**一个**递归 CTE 查询，缓存在请求上下文（同一次请求只查一次）。

### 这如何覆盖 V1 的四种 scope 形态

| V1 形态 | V1 表达 | V2 表达 |
|---|---|---|
| `ALL` | `kind='ALL'` | `directory_id IS NULL` |
| `PROGRAM`（某班型） | `kind='PROGRAM', program='prek'` | `directory_id = <Pre-K 节点>` |
| `SUBJECT`（某科目） | `kind='PROGRAM'+'SUBJECT'` | `directory_id = <美德 节点>` |
| `OWN`（只看自己的） | `kind='OWN'` + 权限码里的 `.own` | 权限码里的 `.own`（不需要范围字段） |

V1 的 `account_scopes` 还有一条 `account_scopes_shape_check` 约束
（ALL/OWN 不能带 program/subject、PROGRAM 必须带 program、SUBJECT 必须两者都带），
以及把非法形状从 500 改成 400 的一次修复。**V2 用一个可空外键让非法形状在结构上不存在。**

## 4. 后端怎么强制（不能只靠隐藏按钮）

每个接口**必须**显式声明：

```ts
@Get(':id')
@RequirePermission('resource.view')     // ← 声明式
async getResource(@Param('id') id: string, @CurrentUser() user: AuthUser) { … }
```

守卫（`AuthzGuard`，全局注册）执行：

```
1. 解析会话 → user（失效则 401）
2. 读路由元数据 @RequirePermission
   ├─ 没有声明？ → 403 + 审计 denied（fail closed）
   └─ 有声明   → 继续
3. 目标目录从哪来？（@DirectoryScope('param'|'body'|'resource') 声明）
   ├─ 直接给了 directoryId（创建资源/建目录）→ 用它
   ├─ 给了资源 id → 查该资源的 directory_id
   └─ 给了目录 id → 用它
4. can(user, permission, targetDirectoryId) → 通过 / 403
5. 所有权类权限（.own）额外校验 uploader_id === user.id
```

**fail closed 是核心。** V1 的默认是"没声明就放行"，后果是新增接口忘记加注解时
所有测试仍然全绿（测试用的是管理员）。V2 把默认反过来，并且加一条测试：

```ts
// tests/authz-declaration.test.mjs
// 扫描所有 @Get/@Post/... 处理方法，凡是缺少 @RequirePermission 的，测试失败。
// 只有显式标了 @Public() 的（登录、健康检查）才允许没有权限声明。
```

### 管理员绕过：只允许一处

```ts
// server/authz/index.ts —— 全仓库唯一的 ADMIN 绕过点
if (user.role === 'ADMIN') return true
```

V1 的缺陷清单里有"管理员角色可以绕过权限系统"。V2 的处理**不是**假装没有绕过，
而是：

1. 绕过**只有这一行**（`tests/authz-admin-bypass.test.mjs` 静态断言 `role === 'ADMIN'`
   在全仓库只出现在这一个文件里）；
2. 绕过发生时**照样写审计**（`result: 'success', detail.via: 'admin'`）；
3. **ADMIN 不能绕过业务不变量**：目录删除保护、状态机合法性、文件必须真实存在
   —— 这些是业务规则，不是权限。

## 5. 教师账号创建（业主 §26）

界面（管理员视角）：

```
管理 → 教师 → [+ 新建账号]

  姓名     [ 张老师        ]
  用户名   [ zhanglaoshi   ]
  密码     [ ••••••••      ]
  确认密码 [ ••••••••      ]

  权限
  ☑ 查看资源      ☑ 上传资源     ☑ 编辑自己的资源   ☑ 下载资源
  ☐ 删除自己的资源 ☐ 提交审核     ☐ 审核资源         ☐ 发布资源
  ☐ 管理目录      ☐ 新建文件夹   ☐ 管理教师         ☐ 查看审计

  开放范围
  ☑ 教育教学
      ☑ Pre-K
          ☑ 美德
          ☐ 蒙特梭利
          ☐ 体能
          ☐ 英文
      ☐ K
  ☐ 教师成长

  [ 创建 ]
```

背后一次请求：

```http
POST /api/users
{
  "name": "张老师",
  "username": "zhanglaoshi",
  "password": "……",
  "permissions": [
    { "permission": "resource.view",         "directoryId": "<Pre-K id>" },
    { "permission": "resource.download",     "directoryId": "<Pre-K id>" },
    { "permission": "resource.create",       "directoryId": "<美德 id>" },
    { "permission": "resource.update.own",   "directoryId": "<美德 id>" },
    { "permission": "resource.submit",       "directoryId": "<美德 id>" }
  ]
}
```

**管理员从头到尾没有看到 `permission code`、`role`、`scope`、`grant`、`deny`、`override`。**
他看到的只是中文勾选框和一棵目录树。

> 树上的选择会自动"向上收敛"：勾了 Pre-K 就等于勾了 Pre-K 及其全部子节点。
> 服务端在写入时**不展开**成逐节点行（那样 100 个目录会产生 100 行），
> 只写一条 `directory_id = Pre-K` —— 判定时走子树查询。

## 6. 即时生效（**不引入 permission version**）

业主要求"不要 permission version"，同时要求"权限改完必须立刻生效"。
两者可以同时满足 —— **不去比对版本号，直接把会话踢掉**：

```
任何权限 / 角色 / 状态变更
  → UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL
  → 该用户下一次请求：会话已撤销 → 401
  → 界面提示「权限已更新，请重新登录」
  → 重新登录即拿到新权限
```

- **数据库里没有任何 version 列**，`users` 与 `sessions` 上都没有；
  这个概念不存在，因此也不可能泄漏到界面或 API 里。
- 撤销是**立即**的（下一次请求就生效），不是"等会话过期"。
- 变更自己的权限时不会把自己踢掉之外——管理员改**别人**的权限只踢别人；
  管理员改**自己**的权限时同样会被踢（保持一致，避免"管理员永远有效"的暗规则）。
- 停用账号走同一条路径（`status = 'inactive'` + 撤销全部会话）。

> V1 用的是 `teachers.permissions_version` 自增 + 会话比对版本号。机制有效，
> 但它把一个纯实现细节做成了账号表上的一列，并且在多轮迭代中被写进过文档与
> 排查手册，成为"需要理解的概念"。V2 用"撤销会话"表达同一件事，概念更少。

## 7. 审计

以下动作必须写审计（`result` 为 `success` / `denied` / `failed`）：

- 登录成功 / 失败、退出、改密
- 创建 / 修改 / 停用 / 删除账号
- **修改任何账号的权限**（记录 before/after 的权限集合摘要）
- 目录创建 / 改名 / 改说明 / 排序 / 停用 / 删除 / 移动
- 资源上传 / 编辑 / 提交 / 审核 / 发布 / 撤回 / 删除 / 恢复 / 永久删除 / 下载
  （**列表以 `PRODUCT_REQUIREMENTS.md` §14 为准**；"预览"不单独记审计 ——
  它读的就是资源内容，记下载即可，逐次预览入审计只会把真正的操作淹掉）
- **所有被拒绝的请求**（403），记录 `permission` + `targetDirectoryId` + 原因

审计里**绝不写入**：口令、`password_hash`、session token、签名 URL、storage key、密钥。

## 8. 本模块的验收清单

1. 教师只勾"查看 + 上传 + 范围=Pre-K/美德" → 能看到 Pre-K/美德，看不到 K 与其他科目。
2. 同一教师**直接调 API** 访问 K 的资源 → 403（业务流程 9 必须真的用 curl/HTTP 验，而不是只看界面）。
3. 管理员改该教师权限（取消上传）→ 该教师**下一次请求即被拒**，无需等待。
4. 新建的接口若忘记声明权限 → `tests/authz-declaration.test.mjs` 变红（fail closed 的证明）。
5. `resource.update.own` 对别人的资源返回 403；对自己的资源返回 200。
6. ADMIN 能改任何资源，且审计里能看到 `via: 'admin'`。
7. 审计里搜不到任何口令/token/签名字符串（静态 + 运行时断言）。
8. 全仓库 `role === 'ADMIN'` 只出现一次（静态断言）。
