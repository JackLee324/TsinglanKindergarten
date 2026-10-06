# V2 架构

> 目标不是"技术上复杂"，而是"用户一看就会用，开发者一看就看懂"。
> 本文的每一条选型都给出**理由**与**被否决的替代方案**，避免后来者按自己的偏好改回去。

## 1. 三层 + 一条硬规则

```
浏览器（React SPA）
   │  只认 JSON；不认 bucket / key / token / permission code 的内部含义
   ▼
API（NestJS）
   │  身份 → 权限 → 目录范围 → 业务 → 审计     ← 全部授权判定只在这里
   ▼
PostgreSQL（业务真相）        Object Storage（文件真相）
```

**一条硬规则：业务真相只在数据库和对象存储里。**

任何"这份数据还有第二个地方也在维护"的设计，都会在多轮迭代后分叉。
V1 的四个教训（两套目录、四套权限、两套组件库、两套分类字段）全部源于违反这条规则。

## 2. 技术选型

| 层 | 选型 | 理由 | 被否决的方案 |
|---|---|---|---|
| 前端 | React 19 + Vite + TypeScript | 与 V1 一致，团队与业主已认可其表现 | Next.js：本项目不需要 SSR/SEO，引入 route/server 概念只会增加复杂度 |
| 样式 | Tailwind v4 + shadcn/ui | **视觉基准来自 V1**，组件是"复制进仓库的代码"而不是黑盒依赖 | antd：V1 同时用了 antd 与 shadcn/ui，两套设计语言在同一页面上打架；V2 只留 shadcn/ui |
| 数据获取 | TanStack Query | 缓存/失效/重试内建，服务端状态不需要手写 store | Zustand/Redux：会把服务端状态复制进客户端，制造"第二真相" |
| 表单 | react-hook-form + zod | 前端校验与后端 DTO 可以共享 schema 形状 | 手写受控表单（V1 出现过 `defaultValue` + `onBlur` 导致保存丢值） |
| 后端 | NestJS 10 + Express | 与 V1 一致；Guard 机制天然适合"声明式权限" | 手写中间件：授权判定会散落在各处 |
| ORM | Drizzle + postgres.js | SQL 可见、迁移可校验（checksum） | Prisma：迁移会 reset 数据库的风险不可接受（业主的生产库是唯一真相） |
| 数据库 | PostgreSQL 16 | 递归查询、约束、事务都需要 | MongoDB：目录树 + 权限范围查询不适合文档模型 |
| 对象存储 | S3 兼容（生产 Cloudflare R2） | 生产必需；本地用文件系统适配器保证开发者不必配云 | 只做本地存储：生产不可用。只做云：本地测试无法离线跑 |
| 会话 | HttpOnly Cookie + 服务端 session 表 | 可即时撤销（权限变更即失效） | JWT：无法即时撤销，与"权限修改后立即生效"冲突 |
| 校验 | class-validator + class-transformer | 与 Nest 的 Pipe 集成 | 手写校验：会漏 |

## 3. V2 的目录结构

```
V2/
├── client/                     # React SPA
│   ├── src/
│   │   ├── api/                # 唯一 HTTP 出口（cookie/CSRF/错误统一处理）
│   │   ├── directory/          # ★ 目录数据层 + 浏览渲染器 + 路由
│   │   ├── components/
│   │   │   ├── ui/             # shadcn/ui（视觉基准）
│   │   │   └── resource/       # 资源卡片、详情、文件区
│   │   ├── pages/              # 页面（每个页面只做编排，不写业务规则）
│   │   ├── auth/               # 会话 context + 能力判定 hook
│   │   └── i18n/
│   └── public/
├── server/
│   ├── modules/
│   │   ├── auth/               # 登录、会话、改密
│   │   ├── users/              # 账号 + 权限分配
│   │   ├── directories/        # ★ 通用目录树
│   │   ├── resources/          # 资源 + 文件
│   │   ├── review/             # 审核状态机
│   │   ├── audit/              # 审计
│   │   ├── storage/            # StorageAdapter（local | s3）
│   │   └── health/
│   ├── common/                 # Guard、拦截器、异常过滤器
│   └── authz/                  # ★ 唯一的授权判定实现
├── shared/                     # 前后端共享：类型、权限目录、状态机常量
├── database/
│   ├── schema.ts
│   ├── migrations/             # 0001_*.sql（应用后永不修改）
│   └── seeds/                  # PDF 目录初始 seed
├── scripts/                    # migrate / seed / import-v1 / 备份 / 门禁
├── tests/                      # 单元 + API + 浏览器 E2E
├── docs/
└── public/
```

标 ★ 的三个位置是 V2 的"唯一真相"所在，其余代码只允许**消费**它们：

- `client/src/directory/` —— 前端唯一持有目录树的地方
- `server/modules/directories/` —— 后端唯一修改目录树的地方
- `server/authz/` —— 后端唯一的授权判定函数

## 4. 一次请求的完整路径

```
请求 → CORS/安全头 → 会话解析（cookie → sessions 表 → users）
     → AuthzGuard：查 users.role + user_permissions
        ├─ 该路由声明了所需 permission？ 没声明 → 拒绝（fail closed）
        ├─ ADMIN？→ 放行（唯一一处绕过，集中在此函数）
        ├─ user_permissions 里有该 permission？
        │    ├─ directory_id IS NULL → 全平台，放行
        │    └─ directory_id = D → 目标资源所在目录 ∈ D 的子树？放行 : 拒绝
        └─ 拒绝 → 403 + 审计（记录被拒原因，不记录敏感值）
     → DTO 校验 → Service（业务 + 状态机）→ 审计写入 → 响应真实状态
```

**为什么"没声明就拒绝"**：V1 的经验是，一个新增接口忘记加权限注解时，
它是**默认放行**的，而所有测试仍然全绿（因为测试用的是管理员账号）。
V2 把这个默认反过来，并用一条测试保证"新增接口必须显式声明权限"。

### 权限变更如何即时生效（不需要 permission version）

```
管理员改了某人的权限
  → 删除/重建 user_permissions 行
  → UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL
  → 该用户下一次请求：会话已撤销 → 401 → 界面提示"权限已更新，请重新登录"
```

**没有版本号列、没有比对逻辑。** 撤销会话本身就是"立即生效"，
而且它是一个真实存在的动作（退出登录也用它），不是为"权限变更"发明的第二套机制。

## 5. V2 放在哪里、由谁管理版本

```
TsinglanKindergarten/                    ← V1 项目根目录（唯一 Git 仓库）
├── client/  server/  shared/  ...       ← V1 的代码，V2 一个字节都不改
└── V2/                                  ← V2 在这里，由父项目统一管理版本
    ├── client/  server/  shared/  database/  scripts/  tests/  docs/
    └── *.md                             ← 设计基线（当前阶段）
```

- **V2 不是独立 Git 仓库**，也不在项目之外。它由 V1 的仓库统一跟踪。
- 等 V2 真正完成、测试通过、准备发布时，再单独创建
  `JackLee324/TsinglanKindergarten-V2`（届时用 `git subtree` 或复制历史切出）。
- **V1 不得被 V2 修改**。已验证：V1 的全部工具都是按目录限定的，看不到 V2 ——
  `eslint client server shared tests scripts`、`tsc -p tsconfig.{app,node}.json`
  （include 只有 `client/**`、`shared/**`、`server/**`）、
  `node --test tests/*.test.mjs`、vite 的 `input: client/index.html`、
  Dockerfile 逐目录 `COPY`。V2 存在时 V1 门禁仍然全绿（见本文件末尾的验证记录）。
- V2 自己的 `.gitignore` 负责忽略它将来产生的 `node_modules/`、`dist/`、`.env`、
  `storage-local/`，这些不会污染 V1 的仓库。

## 6. 本地开发与生产

| 能力 | 本地开发 | 生产 |
|---|---|---|
| 数据库 | 嵌入式 PostgreSQL（独立端口、独立数据目录） | 托管 PostgreSQL（**不对公网开放**） |
| 对象存储 | `LocalStorageAdapter`（写 `.devdata/storage/`） | `S3StorageAdapter`（Cloudflare R2） |
| 会话密钥 / 签名密钥 | `.env.local`（gitignored） | 平台环境变量 |
| HTTPS | 无（`http://localhost`） | 反向代理终止 TLS |

两个适配器实现同一个 `StorageAdapter` 接口：

```ts
interface StorageAdapter {
  presignPut(key, opts): Promise<{ url, headers }>
  presignGet(key, opts: { disposition: 'inline' | 'attachment', ttlSeconds }): Promise<string>
  head(key): Promise<{ size, contentType, etag } | null>
  get(key): Promise<Readable>
  delete(key): Promise<void>
}
```

**为什么一定要有 head()**：V1 出现过"数据库说文件存在、对象存储里却没有"的假成功。
登记文件之前必须真的能 HEAD 到对象，否则拒绝登记。

## 7. 把 V1 的教训写成架构约束

| V1 实际发生过的事故 | V2 的架构性防范 |
|---|---|
| 七个页面各自维护课程数组，改名后界面不同步 | 前端只有一个 `DirectoryProvider`；用测试禁止第二处 |
| 四套权限模型并存，谁生效说不清 | 只有 `user_permissions` 一张表；权限目录是**代码里的常量**，与数据库里的授予分离 |
| "提交审核成功"但状态没变 | 状态机只有一份实现；所有变更接口返回变更后的真实状态；UI 不做乐观成功 |
| "资源声称有文件、实际没有" | 登记前必须 `head()` 成功 |
| 删除只是软删除，界面却说"无法恢复" | 状态与文案由同一个状态机常量生成 |
| 新增审计动作忘加界面标签 → 类型检查失败 | 审计动作与界面标签**同源生成**，不手工同步 |
| 迁移文件被改动导致环境漂移 | 迁移 checksum 校验，`verify` 不通过就拒绝启动 |
| 测试探针残留进数据库 | 每个套件自带清理 + 门禁结束做**前后 ID 集合比对**（新增和删除都算脏） |
| 门禁需要的环境变量与生产不同，长期分叉 | 门禁在**默认配置**下必须全绿；需要特殊配置的项必须显式声明为"未运行"，不算通过 |

## 8. 明确不做的事

| 不做 | 原因 |
|---|---|
| 数据库层 RLS / 角色切换 | 会让"授权"出现两个真相（应用层 + 数据库层）。V1 因此出现过"审计说成功、实际影响 0 行"。V2 第一阶段只做应用层强制，并如实写进 `docs/KNOWN_LIMITATIONS.md` |
| 平台 runtime / 私有脚手架依赖 | 业主明确要求独立运行；V1 其实也早已移除该依赖 |
| MFA | 业主明确要求教师与管理员都用"账号 + 密码"，不增加日常步骤（FUTURE） |
| 微服务 / 消息队列 | 单实例、单数据库足够；引入只会增加部署面 |
| SSR | 内部工具，登录后使用，没有 SEO 与首屏要求 |
| 图表仪表盘 | 业主从未要求；V1 的 echarts/recharts 是未使用的依赖 |
| 第二套组件库 | 一个设计语言 |
| "开发中" 占位按钮 | 做不到的能力就不放按钮 |
| 公开的永久文件 URL | 文件预览与下载必须经过授权 |

## 9. 可观测性与运维

- 结构化日志（请求 ID 贯穿），敏感值（口令、token、密钥、签名 URL）**永不入日志**。
- `/api/health`：进程存活；`/api/health/ready`：数据库可达 + 对象存储可达。
- 审计覆盖所有写操作与所有被拒绝的请求。
- 备份：`pg_dump` + 对象存储同步，脚本化 + 文档化 + **在测试库上真实演练一次恢复**。

## 10. 已确认的设计决策（不再有"待确认"项）

业主已逐条确认。这些是**锁定**的，实现阶段不得自行更改：

| # | 决策 | 结论 |
|---|---|---|
| 1 | V2 位置 | `TsinglanKindergarten/V2/`，**在 V1 项目根目录内部**，由父项目统一管理版本；暂不建第二个 Git 仓库 |
| 2 | 目录 URL | **不可变 `slug` 路径**：`/directory/prek/virtue/teaching-resources`。改 `name` 不改 `slug` |
| 3 | 一个资源多个文件 | **支持**；界面**一次传一个** + 「+ 添加文件」，不做批量上传界面 |
| 4 | 权限模型 | 只有 `user_permissions(userId, permission, directoryId)`。**没有** deny / grant / override / role ceiling / 多套 Scope / permission version |
| 5 | 身份 | 只有 **ADMIN** 与 **TEACHER** |
| 6 | 初始目录 | **严格按 PDF**，含 `Pre-K → 英文` 与 `职业道德规范 → 师风师德建设`，不得自行删除 |
| 7 | 自建文件夹 | 只在 PDF 标注的 **教学详案 / 教学资源** 上开放 |
| 8 | 预览 | PDF / JPG / PNG / TXT 网页内预览；DOCX/XLSX/PPTX 只下载；ZIP 只下载；不支持时显示「此文件类型暂不支持在线预览，请下载查看」 |
| 9 | 撤回 | 独立动作 `POST /:id/recall`，**不得调用 reject** |
| 10 | 管理员绕过 | 只有 `role === 'ADMIN'` 一处，集中在一个函数里，且有静态断言 |

## 11. 验证记录：V2 存在时 V1 不受影响

把 V2 放进 V1 仓库之后，V1 的完整门禁在**没有修改任何 V1 文件**的前提下重新跑过一次：

- `npm test` 323 / 323
- `eslint`、`stylelint`、`typecheck server`、`typecheck client`、`npm run build`、`api-contracts`、`migrate:verify` 全部 PASS
- 全部 HTTP 与浏览器套件绿（详见 V1 仓库的 `FINAL_COMPLETION_REPORT.md`）

结论：**V1 的工具链是按目录限定的，看不到 `V2/`。** V2 的加入不会改变 V1 的任何行为。
