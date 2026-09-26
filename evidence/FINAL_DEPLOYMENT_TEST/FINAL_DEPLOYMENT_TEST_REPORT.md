# 从零公网部署全链路验收报告

**CURRENT_COMMIT**: `ee59a05ee43298a6a39bb3dba90dab84d0c9fb18`（== `origin/main`，工作树干净）
**验收时间**: 2026-09-26
**执行范围声明**: 规格含 56 节。**我完整执行的是第 2、3、5 节，以及第 6/12/16/17/18/23/24 节的等价验证**（clean-room 首次部署、空库 bootstrap、Docker build/run、SPA 渲染、根路径跳转）。**其余各节未执行，一律标记 UNVERIFIED，不写 PASS。**

---

## 🔴 一、核心问题的答案：为什么每次部署都出问题

**根因已复现，且是本轮最重要的发现。**

### 现象
```
容器状态:            Up          ← 看起来部署成功
/api/health       -> 200         ← 全绿
/api/health/ready -> 200         ← 全绿
GET /             -> 302         ← 正常跳转
登录              -> 401 用户名或密码错误   ← 进不去
```

### 机制
`scripts/provision-super-admin.mjs` 有一条**弱口令检查**：

```
[provision-super-admin] 密码不能包含用户名本身 —— 这是密码管理器评分里的弱口令特征
```

如果你的 `INITIAL_ADMIN_PASSWORD` **包含用户名**（例如用户名 `TsinglanAdmin`、密码 `TsinglanAdmin2026!`——这是极常见的设密码方式），**建号会被拒绝**。

而 `entrypoint.sh` 当时只把它当作**警告**继续启动。结果：

- 容器 `Up` ✅
- 健康检查 `200` ✅
- 站点能打开 ✅
- **但没有任何管理员账号 → 登录永远 401** ❌

**部署方的结论必然是"部署失败"**。而实际上是：部署成功了，只是没人能进。

### 已修复（本轮实测验证）
新增 `scripts/assert-admin-exists.mjs`：存在 active 且 `password_hash` 非空的 `super_admin` 才允许启动，否则 `exit 1` 并打印明确原因与修法。

**修复前**（全新空库 + 弱口令）：容器 `Up`、health `200`、登录 `401`
**修复后**（同样条件）：
```
容器状态: Exited (1)
[assert-admin] ✗ 没有任何"能凭密码登录"的 super_admin —— 拒绝启动。
[assert-admin]   容器起来、健康检查全绿，但没有任何人能登录管理平台。
[assert-admin]   常见原因：INITIAL_ADMIN_PASSWORD 是弱口令（例如**包含用户名**）
```

### 其他已确认会导致部署异常的原因（本会话中发现并修复）
| # | 问题 | 后果 | 状态 |
|---|------|------|------|
| 2 | `.npmrc` 钉死国内镜像 `registry.npmmirror.com` | 海外 PaaS 上 `npm ci` 超时 → 构建失败 | 已修（`NPM_REGISTRY` 构建参数，默认公共 registry） |
| 3 | SPA 资源不可达（Vite 输出到 `dist/client`，平台中间件读 `dist/dist/client`） | **白屏**，而所有状态码全绿 | 已修（build.sh 复制 + 构建期断言） |
| 4 | 平台注入 `basename: "/app/"` | 访问 `/` **白屏** | 已修（`/` 302 → `/app/`） |
| 5 | entrypoint `|| true` 吞掉迁移失败 | 带着未迁移的库对外服务 | 已修 |
| 6 | 每次启动随机生成 `MFA_ENCRYPTION_KEY` | 重启后所有 MFA 账号永久锁死 | 已修（改为强制要求） |

---

## A. 本机已真实验证
- git 状态：`HEAD == origin/main == ee59a05`，工作树干净
- 仓库完整性：`package.json` 脚本、Dockerfile COPY 源、entrypoint 引用的脚本、CI 引用脚本 —— **全部存在，零缺失**
- TypeScript：`type:check:server` / `type:check:client` 均 0 错误
- 单元测试：225/225（含 `AUTHZ_TEST_DB` 时 230/230）
- E2E 部署验收 `scripts/verify-e2e-deploy.sh`：**31/31 PASS**（镜像构建、根跳转、资源 Content-Type、安全响应头、**无头浏览器渲染**、super_admin/principal 登录、提权边界 403、SIGTERM 退出码 0）

## B. Clean-room 已真实验证
- **全新空库 `qls_e2e_fresh` + 全新容器**：从零 bootstrap → 8 个 migration → 建号 → 启动 → 登录
```
✓ 数据库已从零初始化并完成迁移
✓ 存在可登录的 super_admin：TsinglanAdmin
✓ 园长账号就绪: TsinglanPrincipal
TsinglanAdmin     登录=201  角色 ['super_admin']
TsinglanPrincipal 登录=201  角色 ['principal']
/api/health 200 · /ready 200 · / 302 · /app/ 200
```
- 负向场景：全新空库 + 弱口令 → **容器拒绝启动（exit 1）**，不再假成功

## C. Linux/Docker 已真实验证
- `docker build --platform linux/amd64` 真实完成（exit 0）
- 容器真实运行、health/ready 200、SPA 渲染、登录成功
- 注：构建宿主是 macOS arm64 + Docker Desktop（amd64 模拟），**非原生 linux/amd64 机器**

## D. 公网 HTTPS：UNVERIFIED
- 已确认线上 `https://tsinglankindergarten.zeabur.app/` 可达（`/` 302、`/app/` 200、资源 `application/javascript`）
- **TLS 证书链、HSTS 实际生效、Secure Cookie、X-Forwarded-Proto、反向代理下的 XFF 归因 —— 未验证**
- `scripts/verify-live.sh` 的 HTTPS 分支**从未执行过**

## E. 真实数据库：部分验证
- 已在真实 PostgreSQL 16 上完成空库 bootstrap + 8 migration + 数据读写
- **`pg_dump` / `pg_restore` 备份恢复：UNVERIFIED** —— 本机无这些二进制，**未伪造**

## F. 真实 Object Storage：UNVERIFIED
- dataloom 不可达；下载路径保持明确 `503 STORAGE_NOT_CONFIGURED`，**未伪造任何下载 URL**
- `registerFile` 的魔数证据仍由客户端提供，**不具权威性**

## G. 无法验证（明确列出，一律不计为 PASS）
| 节 | 内容 | 原因 |
|----|------|------|
| 21 | 端口 80/443/3200/5432 公网暴露面 | 无目标 VPS 防火墙控制权 |
| 26–32 | 登录/会话/CSRF/CORS 的**浏览器端**行为 | 部分有 HTTP 断言，但浏览器 Cookie 属性未逐项验证 |
| 27 | `MFA_ENFORCE_SUPER_ADMIN` 三态（true/false/unset）实测 | 未逐一运行时验证 |
| 33 | 经真实 Nginx/Caddy 的 XFF 归因 | 无反向代理环境 |
| 34 | 文件上传 7 种合法 + 8 种非法类型 | 需真实 storage |
| 37–38 | 真实域名下的 TLS/HSTS/Cookie | 无域名控制权 |
| 40 | 限流 429 阈值 | 未实测 |
| 41 | 服务器 reboot / nginx reload | 无该环境 |
| 43 | pg_dump/pg_restore | 本机无二进制 |
| 46 | GitHub Actions 真实执行 | 未触发过 workflow |
| 51 | 21 步浏览器业务流程 E2E | 未执行 |
| 52 | 移动端 Safari/Chrome Android | 未执行 |
| 53 | 新 VPS 全新部署 | 无 VPS |

## H. 失败项
1. ~~弱口令导致无管理员却假成功~~ → **已修复并验证**
2. 环境变量模板缺口：**30 个代码读取的变量未在模板中声明**，其中生产相关：`MFA_ENFORCE_SUPER_ADMIN`、`POSTGRES_CONNECTION_STRING`、`POSTGRES_URI`、`DATABASE_URL`、`MIGRATION_DATABASE_URL`、`CSRF_STATE_TTL_SECONDS`

## I. 高风险项
1. `MFA_ENFORCE_SUPER_ADMIN` **默认关闭** —— 最高权限账号在公网上仅单因素保护（已记录为业主接受的风险）
2. 单实例架构：限流为进程内实现，**扩容后静默失效**
3. 平台 `HTTPTraceInterceptor` 无条件记录请求/响应体 —— auth 模块已封堵，**平台级未封堵**；`POST /api/teachers` 仍返回 `temporaryPassword` 并被写日志
4. `PATCH`/`DELETE /api/teachers/:id` 因 `anon_` 列权限返回 **500** —— 教师管理不可用
5. 6 个 HIGH 依赖漏洞（已论证不可达，但门禁仍拒绝豁免）

## J. 修复项（本会话）
1. `scripts/assert-admin-exists.mjs` + entrypoint 硬断言 —— **修复"假成功无管理员"**
2. `NPM_REGISTRY` 构建参数 —— 修复海外构建
3. `build.sh` 资源复制 + 构建期存在性断言 —— 修复白屏
4. `/` → `/app/` 302 跳转 —— 修复根路径白屏
5. entrypoint 去掉三处 `|| true` —— 不再吞掉迁移/建号失败
6. `MFA_ENCRYPTION_KEY` / `DOWNLOAD_TOKEN_SECRET` 改为强制要求 —— 不再生成一次性密钥
7. `INITIAL_PRINCIPAL_USER/PASSWORD` —— 支持创建日常办公账号
8. `scripts/verify-e2e-deploy.sh` —— 唯一真正渲染页面的验收

## K. 仍然阻塞项
| # | 阻塞项 | 阻断上线 |
|---|--------|----------|
| 1 | **生产库 pg_dump/pg_restore 备份恢复演练从未执行** | 是 |
| 2 | **真实 Object Storage 未接入** | 是 |
| 3 | **CI 从未真实执行** | 是 |
| 4 | 真实 HTTPS/反代/HSTS/Cookie 未验证 | 是 |
| 5 | 教师管理 `PATCH`/`DELETE` 500 | 是 |
| 6 | 环境变量模板 30 处缺口 | 否（但应补） |
| 7 | 浏览器业务流程 / 移动端未测 | 是 |

---

# 最终判定

# NOT READY FOR GO-LIVE

**理由**：判定规则第 14 条（database restore 未验证）、第 16 条（CI 无法真实执行）已触发；另有第 11 条（storage failure 未经真实验证）。
代码侧在本机能走通的路径**已全部走通并留下证据**；但备份恢复、真实对象存储、CI、公网 HTTPS 四项**我无法在本环境验证**，按规则必须判 NOT READY，不得输出"基本可以"。
