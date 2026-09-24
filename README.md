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

## npm 脚本

| 脚本 | 说明 |
|---|---|
| `npm run dev` | 前后端同时启动（`scripts/dev.sh`） |
| `npm run build` | 生产构建（`scripts/build.sh`，产物在 `dist/`） |
| `npm run start` | 以生产模式启动 `dist/server/main.js` |
| `npm test` | 单元测试（`node --test tests/*.test.mjs`） |
| `npm run type:check` | 服务端 + 前端类型检查 |
| `npm run lint` | eslint + stylelint + 类型检查 |
| `npm run migrate` | 数据库迁移（`status` / `up` / `down <ver>` / `verify` / `baseline <ver>`） |
| `npm run db:snapshot` | 迁移前后数据指纹快照与比对 |
| `npm run predeploy` | 部署前检查（`scripts/predeploy-check.sh`） |

## 验证（发布闸门）

```bash
AUTHZ_TEST_DB="postgresql://user:pw@127.0.0.1:55432/qls_test_0005" bash scripts/verify-all.sh
```

该入口一次性运行单元测试、双端类型检查、构建、前后端 API 契约静态校验，
以及 5 个**需要服务已启动**的 HTTP 套件（`MFA_BASE`，默认 `http://127.0.0.1:3200`）。
任一失败即整体失败。当前基线：**102 项单元测试 + 151 项 HTTP 断言全部通过**。

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

## 已知限制

1. **无可用下载资源**：seed 的 347 条资源**全部没有文件引用**（0 条），且前端
   kebab-case 与数据库 snake_case 命名漂移，导致约 166 条资源在 UI 中不可达。
2. **限流为进程内实现**，多实例部署下失效。
3. **上传由浏览器直传平台 bucket**，服务端校验边界已实现，但真实存储字节流未验证。
4. 独立部署下每个请求都运行在**匿名数据库角色**上（`SET LOCAL ROLE` 由平台用户上下文
   驱动，独立运行时为空），因此**应用层鉴权才是真正的关卡**。
