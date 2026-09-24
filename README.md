> ## ⚠️ 本文档尚未更新，请勿据此部署
>
> 本文档描述的是 **v1.3.0 内部测试版**，早于本次生产加固，**部分内容已不准确**，
> 例如环境变量、迁移流程、限流与存储行为。**请勿据此执行部署。**
>
> 权威文档：
> - 生产部署：`DEPLOYMENT_PRODUCTION.md`
> - 备份与恢复：`DISASTER_RECOVERY.md`
> - 数据库迁移：`MIGRATION.md` / `MIGRATION_REPORT.md`
> - 安全模型：`SECURITY.md` / `THREAT_MODEL.md`
> - 运维手册：`RUNBOOK.md`
> - 发布闸门与阻塞项：`PRODUCTION_RELEASE_REPORT.md`
> - 完整审计：`PRODUCTION_READINESS.md`
>
> 已知与本文档冲突的要点：`npm run start` 的产物路径、必需环境变量（新增
> `DOWNLOAD_TOKEN_SECRET`、`CSP_MODE`、`TRUST_PROXY` 等）、数据库构建方式
> （`init.sql` 与迁移互为前提，须用 `scripts/db-bootstrap.mjs`）、以及上传/下载
> 的鉴权模型。原文保留仅为对照，**待重写**。

# 清澜山幼儿园教师课程资源平台

清澜山幼儿园内部使用的教师课程资源管理平台，支持 Pre-K / K 双轨课程体系、RBAC 权限控制、资源上传审核流程、中英文双语。

## 技术栈

- **前端**：React 19 + TypeScript + Tailwind CSS + shadcn/ui
- **后端**：NestJS 10 + Drizzle ORM + PostgreSQL
- **认证**：账号密码 + scrypt hash + HttpOnly Cookie Session
- **文件存储**：云存储 + 服务端权限校验代理下载
- **双语**：中文（zh-CN）/ 英文（en-US）

## 环境要求

- Node.js >= 22.0.0
- npm >= 10.x（随 Node 安装）
- PostgreSQL 14+

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入数据库连接等配置。主要环境变量见 [.env.example](.env.example)。

### 3. 初始化数据库

```bash
# 执行建表 DDL
psql <your_database_url> -f server/database/init.sql

# 执行 RLS 策略修复（如需要）
psql <your_database_url> -f server/database/fix-rls-policies.sql

# 导入课程资源数据
psql <your_database_url> -f server/database/seed-curriculum.sql
```

### 4. 初始化教师账号

系统首次启动时会自动创建 20 个初始教师账号（幂等）。密码使用 scrypt hash 存储，初始密码通过**线下安全渠道**分发。

账号角色分布：
| 角色 | 数量 | 用户名前缀 |
|------|------|-----------|
| principal (园长) | 1 | qlsadmin |
| curriculum_director (教学主任) | 1 | qlsdirector |
| prek_head (Pre-K 主教) | 3 | prek-head01~03 |
| k_head (K 主教) | 3 | k-head01~03 |
| pe_specialist (体能专科) | 4 | pe-teacher01~04 |
| prek_assistant (Pre-K 配班) | 4 | prek-teacher01~04 |
| k_assistant (K 配班) | 4 | k-teacher01~04 |

### 5. 启动开发环境

```bash
# 前端 + 后端同时启动（开发模式）
npm run dev
```

前端默认端口：5173
后端默认端口：3000

### 6. 生产构建

```bash
# 构建前端
npm run build:client

# 构建后端
npm run build:server

# 同时构建
npm run build
```

### 7. 启动生产服务

```bash
npm run start:prod
```

## 课程资源目录

### Pre-K（共 303 条已发布资源）
- 美德 Virtue
- 蒙特梭利 Montessori
  - 日常生活 Practical Life
  - 感官 Sensorial
  - 数学 Math
  - 英文语言 English Language
  - 中文语言 Chinese Language
  - 文化 Culture
- 体能 Physical Education

### K（共 44 条已发布资源）
- 美德 Virtue
- 中文 Chinese
  - 古诗 Ancient Poetry
  - 绘本 Picture Books
  - 戏剧 Drama
  - 科学与工程 STEM
- 英文 English（按 Big Unit Theme 组织）
  - Reading Comprehension
  - Language Skills
  - Math
- 体能 Physical Education
  - 体能专项 PE Special
  - 体育 Sports
  - 攀岩 Rock Climbing

### 六类资料夹（每个末级科目下）
1. 课程大纲 Curriculum Outline
2. 周次教案 Weekly Lesson Plans
3. 课件与示范 Courseware & Demonstration
4. 素材与工作单 Materials & Worksheets
5. 观察与评价 Observation & Assessment
6. 教研归档 Teaching Research Archive

### 绘本封面
Pre-K 英文绘本封面共 34 张，位于 `server/assets/prek-english-covers/`。

## Cookie / HTTPS 注意事项

- Session 使用 HttpOnly Cookie 存储
- 生产环境必须启用 HTTPS（`HTTPS_ENABLED=true`），Cookie 将设置 `Secure; SameSite=None`
- 本地开发可使用 HTTP（`HTTPS_ENABLED=false`），Cookie 为 `SameSite=Lax`
- 跨域部署时需确保前端和后端在同一顶级域名下，否则 Cookie 可能无法正确携带

## 账号与角色模型

| 角色标识 | 中文名 | 权限说明 |
|---------|--------|---------|
| principal | 园长/平台管理员 | 全部权限，教师管理、权限分配、审计 |
| curriculum_director | 教学主任 | 全部课程查看、审核发布、教师权限分配 |
| prek_head | Pre-K 主教 | Pre-K 全部科目上传、提交审核 |
| k_head | K 主教 | K 全部科目上传、提交审核 |
| pe_specialist | 体能专科教师 | 体能类科目上传、提交审核 |
| prek_assistant | Pre-K 配班 | Pre-K 只读（可配置部分上传权限） |
| k_assistant | K 配班 | K 只读（可配置部分上传权限） |

## 备份与恢复

### 数据库备份
```bash
pg_dump <your_database_url> > backup_$(date +%Y%m%d).sql
```

### 数据库恢复
```bash
psql <your_database_url> < backup_20240101.sql
```

### 文件备份
绘本封面等静态资源位于 `server/assets/`，需单独备份。

## 常见问题

### Q: 未登录时打开登录页，控制台看到 `GET /api/auth/me` 返回 401，这是错误吗？

**A: 不是错误。** 未登录状态下，前端会调用 `/api/auth/me` 检查当前登录状态，返回 401 表示"当前未登录"，这是正常的初始状态。前端会静默处理这个 401，不会弹出错误提示、不会白屏、不会闪退。只有非 401 的网络/服务器错误才会显示错误提示。

### Q: 登录后一直加载中？

检查：
1. 后端服务是否正常启动
2. 数据库连接是否正常
3. Cookie 是否被正确设置（浏览器 DevTools → Application → Cookies）
4. 如果部署在 HTTPS 下，确认 `HTTPS_ENABLED=true`

### Q: 忘记管理员密码怎么办？

可以使用密码重置工具（需在服务端执行）：
```bash
# 需要先配置好环境
node scripts/reset-password.js <username> <new_password>
```

或直接在数据库中更新 `password_hash` 字段（使用 scrypt 算法）。

### Q: 如何新增教师账号？

使用园长账号登录后，进入"管理 → 教师管理"页面添加。

## 版本

详见 [RELEASE_NOTES.md](RELEASE_NOTES.md)
