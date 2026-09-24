# 清澜山幼儿园教师课程资源平台

Pre-K / K 双轨课程资源管理平台：资源上传、审核发布、权限控制、审计留痕，中英双语。
部署形态为字节跳动 **妙搭（miaoda）aPaaS** 应用（NestJS 服务端 + React 前端），
同时支持独立部署（需正确配置反向代理与环境变量）。

> **生产就绪状态：NOT READY。** 上线前必须完成 `PRODUCTION_RELEASE_REPORT.md`
> 中列出的阻塞项，尤其是**生产库备份/恢复演练**——该演练从未执行过。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · Vite 8 · Tailwind CSS v4 · shadcn/ui · react-router-dom 7 |
| 后端 | NestJS 10（Express adapter）· Drizzle ORM 0.44 · postgres-js |
| 数据库 | PostgreSQL（平台托管；本地可用内置实例） |
| 认证 | 用户名 + 密码（scrypt N=16384,r=8,p=1,keylen=32）· HttpOnly Cookie 会话 · TOTP MFA |
| 平台 | `@lark-apaas/*`（fullstack-nestjs-core、nestjs-datapaas、file-service、dataloom…） |

## 环境要求

| 项 | 要求 | 依据 |
|---|---|---|
| Node.js | **>= 22.0.0**（实测 `v22.23.2`） | `package.json` `engines.node` |
| npm | **>= 10.0.0**（实测 `10.9.8`） | `package.json` `engines.npm` |
| PostgreSQL | **>= 13**（迁移用内置 `gen_random_uuid()`；本地实测 **16.14**） | migration `0003` / `0006` |
| 反向代理 + TLS | 生产必需 —— 生产环境**强制** Cookie `Secure`，纯 HTTP 下无法登录 | `session.service.ts:47-51` |
| Docker | **不需要，也不可用** —— 仓库中没有 Dockerfile / docker-compose / CI / IaC | `ls` 实测 |

> ⚠️ **`npm ci` 在 macOS/arm64 上会破坏本地依赖树**：
> `package-lock.json` 的平台门控条目 **12 条全部是 `linux | x64`，`darwin-*` 为 0 条**
> （实测 `npm ci --dry-run` 会**移除** `@swc/core-darwin-arm64`、
> `@rolldown/binding-darwin-arm64`、`lightningcss-darwin-arm64`、
> `@napi-rs/nice-darwin-arm64`、`@tailwindcss/oxide-darwin-arm64`，之后构建 `MODULE_NOT_FOUND`）。
> 该 lockfile 是为 **linux-x64（aPaaS 目标）**准备的，**不要盲目重新生成**
> （重新生成会反过来丢掉 linux 条目）。macOS 开发者请用 `npm install`。
> 详见 `DEPLOYMENT_PRODUCTION.md` §6.5。

## 快速开始

```bash
npm ci                       # postinstall 会修复平台 CLI 缺失导致的安装失败
bash scripts/dev-postgres.sh start   # 本地 PostgreSQL（默认 127.0.0.1:55432）
bash scripts/db-bootstrap.mjs --url "$DATABASE_URL"   # 从零建库（见下方说明）
npm run dev                  # 前端 + 后端
```

> **从零建库必须用 `scripts/db-bootstrap.mjs`。**
> `init.sql` 与版本化迁移**互为前提**：`init.sql` 需要 `user_profile` 类型和
> `anon_`/`authenticated_`/`service_role_` 角色（只有迁移 `0001` 创建），
> 而 `0001` 又需要 `init.sql` 建的表。单独执行任何一个都会失败。
> 妙搭平台预先提供好数据库，因此这个缺陷只在**换机器重建/恢复**时才会暴露。

本地开发的两个已知坑（都写在脚本注释里）：

1. 平台的 CSRF cookie 被硬编码为 `Secure; SameSite=None; Partitioned` →
   **纯 HTTP 下浏览器拒收** → 本地**所有写操作 403**（生产 HTTPS 下正常）。
   解决：通过服务端口访问（服务端会渲染已构建的 client），或走本地 HTTPS。
2. `SERVER_PORT` 默认 `3000`，可能被其他进程占用，先确认：
   `lsof -nP -iTCP:3000 -sTCP:LISTEN`。

> 旧 README 的 `psql <your_database_url> -f server/database/init.sql` **不要用**：
> `<...>` 在 shell 中是重定向符，**语法非法**；且 `init.sql` 在原生 PostgreSQL 上
> 根本执行不了（`42704 type "user_profile" does not exist`）、重复执行会报
> `42710 policy ... already exists`、并**缺 6 个认证列**。

## npm 脚本（`package.json` 全量，含不在表内的辅助脚本）

| 脚本 | 实际命令 | 用途 |
|---|---|---|
| `dev` | `./scripts/dev.sh` | 前后端同时启动（concurrently） |
| `dev:server` | `NODE_ENV=development nest start --watch` | 仅后端（watch） |
| `dev:client` | `NODE_ENV=development vite --config vite.config.ts` | 仅前端 |
| `build` | `./scripts/build.sh` | **完整生产构建**（6 步，产物在 `dist/`） |
| `build:prod` | `npm run build:server && npm run build:client` | 顺序构建（不走 build.sh） |
| `build:server` | `NODE_ENV=production nest build` | 仅后端 |
| `build:client` | `NODE_ENV=production vite build --config vite.config.ts` | 仅前端 |
| `start` | `cd dist && NODE_ENV=production node server/main.js` | 以生产模式启动 |
| `start:prod` | `npm run start` | 同上（别名） |
| `migrate` | `node ./scripts/migrate.mjs` | 迁移（默认 `up`；亦支持 `down <ver>` / `verify` / `baseline <ver>`） |
| `migrate:status` | `node ./scripts/migrate.mjs status` | 迁移状态（**只读**） |
| `db:snapshot` | `node ./scripts/db-snapshot.mjs` | 迁移前后数据/结构指纹快照与比对 |
| `test` | `node --test tests/*.test.mjs` | 单元测试（Node 内置 runner，需 PostgreSQL） |
| `type:check` | `concurrently … type:check:server type:check:client` | 服务端 + 前端类型检查 |
| `type:check:server` | `tsc --noEmit --project tsconfig.node.json` | 仅后端 |
| `type:check:client` | `tsc --noEmit --project tsconfig.app.json` | 仅前端 |
| `lint` | `npm run eslint && npm run stylelint && npm run type:check` | 全量静态检查 |
| `eslint` | `eslint . --quiet` | — |
| `stylelint` | `stylelint client/src/**/*.css --quiet` | — |
| `predeploy` | `bash ./scripts/predeploy-check.sh` | ⚠️ **该文件当前不存在**（见「已知限制」） |
| `gen:db-schema` | `npx -y @lark-apaas/db-schema-sync@latest …` | 从平台库**反向生成** `server/database/schema.ts`（联网） |
| `gen:openapi` | `echo 'UNSUPPORTED, SKIP'` | 占位 |
| `postinstall` | `node ./scripts/postinstall.mjs` | 受控的平台插件初始化（无 `capabilities/` 时跳过，绝不联网下载同名第三方包） |

直接调用（无 npm 别名）：

```bash
bash  scripts/verify-all.sh                # 发布闸门（见下）
bash  scripts/dev-postgres.sh start|stop|status|psql|destroy
node  scripts/db-bootstrap.mjs             # 从零建库
node  scripts/verify-api-contracts.mjs     # 前后端路由契约静态校验（无需 DB/服务）
node  scripts/db-snapshot.mjs --out f.json / --compare a.json --against b.json
```


## 验证（发布闸门）

```bash
AUTHZ_TEST_DB="postgresql://user:pw@127.0.0.1:55432/qls_test_0005" bash scripts/verify-all.sh
```

该入口一次性运行单元测试、双端类型检查、构建、前后端 API 契约静态校验，
以及 5 个**需要服务已启动**的 HTTP 套件（`MFA_BASE`，默认 `http://127.0.0.1:3200`）。
任一失败即整体失败。当前基线：**103 项单元测试 + 151 项 HTTP 断言全部通过**。

独立验证工具：

| 脚本 | 用途 |
|---|---|
| `scripts/verify-seed-failure.sh` | 证明「seed 全失败时拒绝启动」，而非带 0 个可用账号假启动 |
| `scripts/probe-file-validation.mjs` | 对**构建产物**做对抗性文件校验探针 |
| `scripts/backup-rehearse.mjs` | 逻辑导出/恢复往返演练（逐表 SHA-256 校验和比对） |
| `scripts/db-snapshot.mjs` | 迁移前后数据指纹 |

## 目录结构

```
server/            NestJS 后端
  modules/         auth · authz · resources · review · teachers · curriculum
                   dashboard · audit · files · health
  database/        schema.ts · migrations/0001..0007 · init.sql · seed-curriculum.sql
  common/          crypto/ · http/ · middleware/ · filters/
client/            React 前端（src/api · components · pages · i18n）
shared/            rbac.ts（权限单一事实源）· api.interface.ts
scripts/           构建、迁移、验证、备份工具
tests/             单元测试 + fixtures
evidence/          发布闸门原始日志
```

## 文档

| 文档 | 内容 |
|---|---|
| `PRODUCTION_RELEASE_REPORT.md` | **发布报告**：变更清单、迁移清单、测试结果、备份结果、阻塞项 |
| `PRODUCTION_READINESS.md` | 完整只读审计（§A–§R，带证据等级标记） |
| `RBAC.md` | 权限模型设计：角色、权限、范围、super_admin |
| `SECURITY.md` | 安全模型与**已知缺口** |
| `THREAT_MODEL.md` | 威胁模型（STRIDE） |
| `DEPLOYMENT_PRODUCTION.md` | 生产部署步骤与必需环境变量 |
| `DISASTER_RECOVERY.md` | 备份/恢复；**明确声明演练尚未执行** |
| `MIGRATION.md` / `MIGRATION_REPORT.md` | 迁移框架与逐条迁移说明 |
| `RUNBOOK.md` | 运维手册：启动、排障、密钥轮换、回滚 |
| `AGENTS.md` | 领域模型与视觉规范 |

## 领域模型

- **班型**：Pre-K、K
- **角色**：`super_admin` · `principal` · `curriculum_director` · `prek_head` ·
  `k_head` · `pe_specialist` · `prek_assistant` · `k_assistant` · `visitor`
- **资源状态**：`draft` · `pending_review` · `published` · `rejected`
- **六类资料夹**：课程大纲 · 周次教案 · 课件与示范 · 素材与工作单 · 观察与评价 · 教研归档
- **学期周次**：S1/S2，Week 1–20+

### 班型与科目结构（已逐项核对 `server/modules/curriculum/curriculum.data.ts`）

**Pre-K**（`program = 'prek'`）
- 美德 `virtue`
- 蒙特梭利 `montessori` → 日常生活 `practical_life` · 感官 `sensorial` · 数学 `math` ·
  英文语言 `english_language` · 中文语言 `chinese_language` · 文化 `culture`
- 体能 `physical_education`

**K**（`program = 'k'`）
- 美德 `virtue`
- 中文 `chinese` → 古诗 `ancient_poetry` · 绘本 `picture_books` · 戏剧 `drama` · 科学与工程 `stem`
- 英文 `english` → 阅读理解 `reading_comprehension` · 语言技能 `language_skills` · 数学 `math`
- 体能 `physical_education` → 体能专项 `pe_special` · 体育 `sports` · 攀岩 `rock_climbing`

> ✅ 以上与 `AGENTS.md` 的「班型与科目结构」**一致**。
> ⚠️ 但 `AGENTS.md` 的**技术栈**（企业微信 OAuth）、**角色表**（7 个，缺 `k_assistant`／`super_admin`）
> 与**页面结构**（`/logout`、`/virtue`、`/montessori`、`/prek/:subject` 等路由）**均已过时**，
> 以本 README 与代码为准。

## 已知限制

1. **无可用下载资源**：seed 的 347 条资源**全部没有文件引用**（0 条），且前端
   kebab-case 与数据库 snake_case 命名漂移，导致约 166 条资源在 UI 中不可达。
2. **限流为进程内实现**，多实例部署下失效。
3. **上传由浏览器直传平台 bucket**，服务端校验边界已实现，但真实存储字节流未验证。
4. 独立部署下每个请求都运行在**匿名数据库角色**上（`SET LOCAL ROLE` 由平台用户上下文
   驱动，独立运行时为空），因此**应用层鉴权才是真正的关卡**。
5. `scripts/predeploy-check.sh` **不存在**，因此 `npm run predeploy` 会失败
   （`package.json:32` 仍引用它）。
6. `postgres` 包被 `scripts/migrate.mjs`、`scripts/db-snapshot.mjs` 直接 `import`，
   但**未在 `package.json` 中声明**（仅靠传递依赖被提升到 `node_modules/postgres`）。
   上游一旦不再依赖它，`npm run migrate` 会直接 `ERR_MODULE_NOT_FOUND`。
7. `package.json` 的 `name`/`version` 仍是模板值（`fullstack-nestjs-template` / `2.3.0`）；
   业务版本是 **v1.3.0**（`RELEASE_NOTES.md`），健康检查返回的版本来自 `APP_VERSION` 环境变量。
8. `src/` 中未使用的 `LOG_DIR` / `LOG_REQUEST_BODY` / `LOG_RESPONSE_BODY` 仍留在
   `.env.example`，但**代码从不读取**；日志全部写 stdout/stderr。

## 与旧文档的差异（**已更正的说法**）

旧 `README.md` / `DEPLOYMENT.md` / `AGENTS.md` 中的以下说法**与代码不符**：

| 旧说法 | 事实 |
|---|---|
| 首次登录**强制改密** | ❌ 未实现。`must_change_password` 在代码中只被赋 `false`，前端也不读该字段 |
| 初始密码**系统随机生成并写入启动日志** | ❌ 20 个账号的口令哈希**硬编码在 `seed-teachers.ts`**，无任何日志输出初始口令 |
| 口令**不得与最近 5 次历史口令重复**、**180 天有效期** | ❌ 无相关表、字段或代码 |
| 管理员可在「教师管理」页**手动解除锁定** | ❌ 无该接口。可用 `POST /api/auth/reset-password`（**仅 `principal` 可用**，会顺带解锁）或直接改库（`RUNBOOK.md` §5.3.1） |
| 种子含 20 名教师 / 各角色权限 / 六类资料夹结构 | ❌ 课程种子**只插 resources**，且依赖仓库中无处创建的账号 `system_initializer`；按交付状态执行会**静默插入 0 行** |
| 下载链接是**临时签名 URL、有过期时间** | ⚠️ 旧实现是未签名、无过期的拼接 URL；**写作期间已替换**为 HMAC 签名令牌（默认 300s、绑定账号与资源），见 `SECURITY.md` §11.1.1 |
| `node scripts/reset-password.js` | ❌ **该文件不存在**（仓库中没有任何口令重置 CLI） |
| `npm run db:codegen` | ❌ 无此脚本名，真名是 `gen:db-schema` |
| 企业微信 OAuth 2.0 登录 | ❌ v1.3.0 已改为**账号密码**登录 |
| 角色共 7 个 | ❌ 实际 **9 个**（`shared/rbac.ts`） |

完整的差异清单见 `PRODUCTION_READINESS.md` §C 与 `SECURITY.md` §12。

