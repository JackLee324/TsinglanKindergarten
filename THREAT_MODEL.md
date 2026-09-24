# THREAT_MODEL.md — 威胁模型

> **文档基线**：git commit `671328a` + 写作时工作区改动。
> **方法**：STRIDE（Spoofing / Tampering / Repudiation / Information disclosure /
> Denial of service / Elevation of privilege），沿真实信任边界逐段建模。
>
> **这不是清单堆砌。** 每一条威胁都写成"针对**本系统**的具体攻击路径"，
> 并明确标注它**有没有控制**、控制在**哪个文件**、
> 还是**被接受/未缓解**（附理由）。
>
> **证据标记**：**[已证实]** 本次实测或源码逐行确证 · **[推断]** 由代码/配置互推 ·
> **[无法验证]** 需部署环境确认。
>
> 控制措施的完整说明见 [`SECURITY.md`](SECURITY.md)；
> 未被缓解的缺口清单见 [`SECURITY.md`](SECURITY.md) §12。

---

## 1. 系统与信任边界

```
        ┌──────────────────────────────────────────────────────────────┐
        │ 不可信区：公网 / 校园网 / 教师浏览器 / 被盗的设备             │
        └───────────────────────────┬──────────────────────────────────┘
                                    │ ① HTTPS（TLS 终止在外层）
        ┌───────────────────────────▼──────────────────────────────────┐
        │ TB-1  反向代理 / 平台入口（Nginx / 云 LB / 妙搭 ingress）      │
        │       可改写或追加 X-Forwarded-*、X-Real-IP、Host            │
        └───────────────────────────┬──────────────────────────────────┘
                                    │ ② 明文 HTTP（内网）
        ┌───────────────────────────▼──────────────────────────────────┐
        │ TB-2  NestJS 应用（本仓库，Node 22 单进程）                   │
        │       全局 AuthGuard → PermissionGuard → Controller → Service │
        └──────────┬────────────────────────────────┬──────────────────┘
                   │ ③ SQL                          │ ④ 存储 API / 代理
        ┌──────────▼───────────────┐   ┌────────────▼──────────────────┐
        │ TB-3  PostgreSQL         │   │ TB-4  妙搭 dataloom 对象存储   │
        │  RLS + GRANT + 触发器     │   │  （bucket，客户端可直连）      │
        └──────────────────────────┘   └───────────────────────────────┘
                   ▲
                   │ ⑤ 平台控制平面（SET LOCAL ROLE / SUDA_DATABASE_URL /
                   │    HBS 占位符替换 / vefaas 发布）
        ┌──────────┴───────────────────────────────────────────────────┐
        │ TB-5  妙搭 aPaaS 平台（第三方，非本仓库代码）                  │
        └──────────────────────────────────────────────────────────────┘
```

### 1.1 各边界上"谁能控制什么"

| 边界 | 攻击者可控制 | 不可控制 | 关键判断依据 |
|---|---|---|---|
| ①浏览器 → TB-1 | 全部请求内容：URL、header（含 `X-Forwarded-For`）、Cookie、body、CSRF header、UA | TLS 私钥、代理配置 | 经典威胁模型：客户端输入全不可信 |
| TB-1 → TB-2 | 仅当代理被攻陷 | — | **`trust proxy` 决定该边界是否可信**（§5） |
| TB-2 → TB-3 | 应用发出的 SQL（受应用层授权约束） | — | 但**所有请求共用同一个 DB 角色**（§4），DB 侧无法区分用户 |
| ④浏览器 → TB-4 | **当前实现下客户端可自行指定 `fileBucketId`/`filePath`** | bucket 凭据（当前未使用） | `UploadPage.tsx:157-160`、`resources.dto.ts:164,218` [已证实] |
| TB-5 → TB-2 | 平台注入的角色切换、CSRF cookie、连接串、HTML 占位符替换 | — | 平台是**信任根**，其行为**[无法验证]**（无平台访问） |

---

## 2. 资产清单（按价值排序）

| # | 资产 | 位置 | 影响面 | 备注 |
|---|---|---|---|---|
| **A1** | **教师账号凭据**（`teachers.password_hash`，scrypt） | TB-3 | 全校账号沦陷 | 20 个初始哈希**硬编码在源码**（`seed-teachers.ts:11-172`）[已证实] |
| **A2** | **会话令牌**（Cookie 明文令牌 + DB 中 `sha256`） | TB-1/2/3 | 冒充任意在线用户 | 令牌不可从 DB 反推（只存哈希）[已证实] |
| **A3** | **MFA 密钥与恢复码** | TB-3 | 绕过第二因素 → super_admin 完全沦陷 | 密文 AES-256-GCM；恢复码 SHA-256 [已证实] |
| **A4** | **`MFA_ENCRYPTION_KEY`** | 环境/密钥管理 | 拿到它 = 能解开全部 TOTP 密钥 → MFA 失效 | 与 DB 分开保管是硬要求 |
| **A5** | **课程资源与文件**（教案、工作单） | TB-3（元数据）+ TB-4（文件） | 知识产权、内部资料外泄 | 当前**实际文件数为 0**（347 行全无 file 引用）[已证实] |
| **A6** | **教师 PII**（姓名、邮箱、`sessions.ip_address`/`user_agent`） | TB-3 | 隐私合规 | `0005` 刻意不向匿名角色开放 `sessions` 的 PII 列 [已证实] |
| **A7** | **审计日志**（`audit_logs`） | TB-3 | 无法追溯入侵、合规缺失 | 对匿名角色 append-only（`0005:185-187`）[已证实] |
| **A8** | **授权配置**（`roles`、`permissions_version`、`account_permission_overrides`、`account_scopes`） | TB-3 | 提权 | 有 DB 触发器兜底（`0003`）[已证实] |
| **A9** | **数据库连接串** | 环境/平台注入 | 直接读写全库 | 单点、高价值 |
| **A10** | **平台凭据**（`FORCE_AUTHN_INNERAPI_DOMAIN` 等） | 平台 | 平台侧横向移动 | **[无法验证]** |
| **A11** | 应用产物 `dist/` | 部署机 | 可能**含 `.env`**（`build.sh:214-218`）[已证实] | 发布前必须检查 |

### 2.1 攻击者画像

| 画像 | 能力 | 最想做什么 |
|---|---|---|
| **P1 匿名外部攻击者** | 能访问登录页、能发任意 HTTP | 爆破口令、枚举账号、DoS |
| **P2 普通教师（已登录、权限低）** | 有合法会话 | 越权读别科/别班资源、提权、下载未发布内容 |
| **P3 离职/被停用教师** | 曾持有有效 cookie | 用旧会话继续访问（→ 停用即时失效是关键控制） |
| **P4 内部管理员（`principal`）** | 账号管理权限 | 提权为 `super_admin`、查看不该看的审计、删审计痕迹 |
| **P5 拿到数据库或备份的人** | 离线访问 DB 内容 | 复用会话哈希、解开 MFA 密钥、重置口令 |
| **P6 拿到应用进程的人** | 可执行应用代码 | 直连 DB、读环境变量、改审计 |
| **P7 供应链/构建链攻击者** | 影响依赖或构建 | 植入后门、窃取 `.env` |
| **P8 云/平台内其他租户** | 共享平台 | 猜测存储路径直读他人文件 |

---

## 3. 威胁建模（STRIDE）

> 每条给出：**攻击路径** → **现有控制（文件:行）** → **残余风险**。

### 3.1 Spoofing（身份伪造）

| ID | 攻击路径（针对本系统） | 现有控制 | 残余风险 |
|---|---|---|---|
| **S-1** | 攻击者用已知的用户名 + 常见弱口令登录（初始口令是**硬编码哈希**，若教师从未改密则口令空间有限） | scrypt N=16384/r=8/p=1（`auth.service.ts:22-26`）；连续 5 次失败锁 15 分钟（`:330-332`）；IP 限流 30/分钟（`:51`）；失败/锁定全写审计（`:283-347`） | ⚠️ **中**：限流是进程内的（§5.2）；`mustChangePassword` 从未置 true（无强制改密）；20 个哈希公开在仓库 |
| **S-2** | 攻击者伪造 `X-Forwarded-For` 以绕过按 IP 的限流、污染审计 | `getClientIp()` **只读 `req.ip`**（`client-ip.ts:34-45`）；`trust proxy` 在 `configureApp()` **之后**设置（`main.ts:34-61`）；默认 `false` | ✅ 已修复。实测：伪造 header 后记录真实 socket IP。**但部署侧若误设 `TRUST_PROXY=true` 且应用可直连 → 漏洞回归**（§5.3） |
| **S-3** | 攻击者用**被盗的会话 cookie** 冒充用户 | Cookie `HttpOnly`（JS 读不到）；令牌 256-bit 随机；DB 只存哈希（`session.service.ts:16-18,64-65`）；24h TTL | **中**：无设备绑定、无异地登录检测；`SameSite=None`（平台 CSRF cookie 强制）意味着**任何站点发起的请求都会带上 CSRF cookie**（但会话 cookie 是 `SameSite=Lax/None`，见 §9 T-6） |
| **S-4** | 用旧会话在被停用/降权后继续访问 | `AuthGuard` **每请求**重读 `teachers.status`；不一致即 `destroySession` + 401（`auth.guard.ts:113-119`）；`permissions_version` 不匹配即失效（`:121-134`） | ✅ 控制到位。代价：管理员改权限会**当场踢人**（属设计意图） |
| **S-5** | 攻击者用 CSRF 让已登录教师替他执行写操作 | 双提交令牌：Cookie `suda-csrf-token` ≡ Header `x-suda-csrf-token`，作用于 `api/*` 的 POST/PUT/PATCH/DELETE（`csrf-check.middleware.ts:4-28`、`app.module.ts:56-61`） | ✅ 本次实测四态（§[`SECURITY.md`](SECURITY.md) §6）。⚠️ 纯 HTTP 本地开发下浏览器拒收该 cookie → 403（开发体验问题，非生产问题） |
| **S-6** | 攻击者伪造合法的 `x-request-id` 污染日志/审计的关联性 | `sanitizeIncoming()`：长度 ≤128、字符集 `[A-Za-z0-9._:-]`，否则丢弃并重新生成（`request-id.middleware.ts:7-19`） | ✅ 低 |

### 3.2 Tampering（篡改）

| ID | 攻击路径 | 现有控制 | 残余风险 |
|---|---|---|---|
| **T-1** | 拿到 DB 写权限者**修改或删除审计日志**以掩盖入侵 | 对匿名角色：`REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs`（`0005:185-187`）→ 篡改 `42501`；实测 `has_table_privilege('anon_','audit_logs','DELETE') = false` ✅ | ⚠️ **仅对匿名角色**。`authenticated_` / `service_role_` 仍有全表权限（`0004:82`）→ 拥有这两个角色的连接可改审计。**已接受**（见 §6 R-2） |
| **T-2** | 越权提升自己为 `super_admin`（`principal` 提权） | 应用层 `canGrantRole()` / `canManageAccount()`（`shared/rbac.ts`）；DB 触发器 `rbac_guard_super_admin()` **要求事务内声明 super_admin 身份**，未声明视为不是（`0003:189-256`） | ✅ 兜底到位。**前提**：所有 super_admin 写入必须走显式事务（`set_config(...,true)` 是事务级的）—— 已在 `authorization.service.ts:59-66` 与测试中处理 |
| **T-3** | 删除/降级/停用**最后一名** super_admin → 系统永久失去最高管理能力 | 触发器 `rbac_protect_last_super_admin()`（`0003:261-306`） | ✅ |
| **T-4** | **篡改已应用的迁移文件**，使数据库结构与"记录中的 SQL"不一致 | `schema_migrations.checksum`（sha256）；漂移 → `up` **拒绝执行**（exit 2），`status` 报 `CHECKSUM DRIFT`（`migrate.mjs:187-197,226-233,256-263`） | ✅ 本次实测 `No checksum drift` + 6 个文件 sha256 逐项匹配 |
| **T-5** | 客户端伪造 `fileBucketId` / `filePath`，让"资源"指向**别人的文件**或任意存储路径 | ❌ **无控制**。`CreateResourceDto` 接受 `fileBucketId?`/`filePath?`（`resources.dto.ts:164,168`），service 直接落库（`resources.service.ts:993-994,1090-1091`） | ⚠️ **高（未缓解）**。`ValidationPipe` 存在但**无 `whitelist`/`forbidNonWhitelisted`**（§[`SECURITY.md`](SECURITY.md) §12 G-5）→ 未知字段不剥离。**应服务端生成 key，绝不信任客户端** |
| **T-6** | 客户端伪造资源的**状态**（如直接提交 `status='published'` 绕过审核） | DTO 对 `status` 有 `@IsIn(RESOURCE_STATUSES)`；`ValidationPipe` 全局存在（`PRODUCTION_READINESS.md` §Q-1 已实测 `400`）；审核走独立路由并写 `review_records` | ⚠️ **需复核**：`resource.publish_without_review` 是独立权限（[`RBAC.md`](RBAC.md) §4），但需确认 service 内那条"管理员直接发布"路径是否真的校验了该权限。**未在本轮逐行确认** [推断/待复核] |
| **T-7** | 篡改 `sessions.permissions_version` 让已撤销权限的旧会话复活 | 匿名角色对 `sessions` 的 `UPDATE` 仅限 `revoked, revoked_at, revoke_reason, last_accessed_at, permissions_version` 列（`0005:168`）—— **`permissions_version` 在可写列里！** | ⚠️ **中（有意取舍）**：会话校验需要写它（`0005` 注释说明它是"只导致拒绝、不导致提权"）。但理论上可被用来**延长**一个本该失效的会话（把 session 版本对齐到当前值）。由于需要 DB 写权限（即已越过应用层），**接受**该风险，见 §6 R-3 |
| **T-8** | 篡改 TOTP 密文以劫持/破坏 MFA | AES-**GCM**（AEAD）：密文被改 → `decipher.final()` 抛错（`mfa-crypto.ts:252-259`） | ✅ 检测得到（表现为解密失败 → 登录 fail closed） |
| **T-9** | 篡改 `resources.deleted_at` 让已删资源"复活"或反之 | `0007` 的 CHECK 约束 `resources_soft_delete_pairing` 保证"要么都空、要么都非空"（`0007:91-103`）；`deleted_by` 有外键 | ⚠️ 用户可见性最终由**应用层每条查询带 `deleted_at IS NULL`** 保证 —— 这是一处**高风险的单点约定**：漏写一条查询 = 回收站内容在 UI 泄露（[`MIGRATION_REPORT.md`](MIGRATION_REPORT.md) §4-0007） |

### 3.3 Repudiation（抵赖）

| ID | 攻击路径 | 现有控制 | 残余风险 |
|---|---|---|---|
| **R-1** | 管理员否认"我重置了某人密码 / 我改了权限" | 审计覆盖登录、失败、锁定、改密、管理员重置、登出、MFA 全阶段、下载拒绝、越权尝试（`auth.service.ts:266-714`、`PRODUCTION_READINESS.md` §A5）；`audit_logs` 对匿名角色 append-only | ⚠️ **中**：`audit_logs` **无外键**（`teacher_id`/`resource_id` 为裸 uuid，§E-12，**设计如此**）→ 账号删除后审计仍在，但**归因只能靠 `teacher_name` 快照**；且 `writeAuditLog()` 失败只打日志、不阻塞业务（`auth.service.ts:745-751`）→ **审计可能缺行而不被察觉** |
| **R-2** | 应用进程被攻陷者否认篡改过审计 | 见 T-1 | ⚠️ 若进程以 `authenticated_`/`service_role_` 运行，append-only 不成立 |
| **R-3** | 无法把某次 HTTP 请求与日志行对上 | `x-request-id` 中间件（`request-id.middleware.ts`）+ 5xx 响应体带 `requestId` | ⚠️ **requestId 的 header 与 body 一致性未解决**（[`SECURITY.md`](SECURITY.md) §12 G-9；`PRODUCTION_READINESS.md` §Q-5）→ 用户报的 id 可能与日志中的不同 |
| **R-4** | `_created_by` / `_updated_by` 恒为空 → 无法追溯谁改了什么 | ❌ 从未写入（GUC `app.user_id` 应用侧不设置，§E-9） | ⚠️ **低-中（未缓解）**；可靠性依赖 `audit_logs` |

### 3.4 Information Disclosure（信息泄露）

| ID | 攻击路径 | 现有控制 | 残余风险 |
|---|---|---|---|
| **I-1** | 触发 500 让应用回吐 stack / SQL / 连接串 | 5xx 分支只返回 `INTERNAL_ERROR` + 通用文案 + requestId；`stack`/`cause` **仅 `NODE_ENV !== 'production'`**（`exception.filter.ts:94-128`）。实测（§Q-3）：`LEAKS: NONE` | ⚠️ **低-中**：`details` 会把 Nest 异常对象 JSON 化后返回（含被请求路径，本次 curl 实测）[已证实] |
| **I-2** | 通过健康检查读取配置（DSN/主机/库名） | `HealthService` **刻意只报状态不报配置**（`health.module.ts:28-33`）；就绪检查失败时只返回 `database_unreachable` 而不回显驱动错误（`:114-117`） | ✅ 实测返回体不含任何配置 |
| **I-3** | 越权读取他人/他科资源 | `PermissionGuard` + `@RequirePermission('resource.view')`（`resources.controller.ts:53-54`）；service 内另有发布状态与科目权限判定（`PRODUCTION_READINESS.md` §A5） | ✅ 主体到位。⚠️ `curriculum` / `dashboard` 两条 controller **无权限声明**（登录即可读），且 `getPublicDownloadUrl`/`getPublicStorybookCoverStream` 是**不校验科目权限的死代码**（`resources.service.ts:758,786`）→ 一旦被接上公开路由即权限失效（§F/D-7） |
| **I-4** | **拿到数据库 dump 后直接生成 TOTP 验证码** | TOTP 密钥以 AES-256-GCM 加密存储（`mfa-crypto.ts:230-260`），密钥在环境变量（不在 DB 内） | ✅ 设计正确。**但**：若 A4（密钥）与 dump 一起泄露 → 完全失效。**因此密钥与备份必须分开保管** |
| **I-5** | 拿到数据库 dump 后用会话哈希登录 | DB 只存 `sha256(sessionId)`，攻击者需要逆向 256-bit 随机值 | ✅ 计算上不可行 |
| **I-6** | 匿名角色读取 `sessions` 的 IP / UA（PII） | `0005` 的列级 `SELECT` **刻意排除** `ip_address` / `user_agent` / `device`（`0005:152-166`） | ✅ 实测（策略与授权一致） |
| **I-7** | 发布产物中带 `.env`（含数据库口令、MFA 密钥） | ❌ **无控制**：`build.sh:214-218` 在存在 `.env` 时**复制进 dist** | ⚠️ **高（未缓解）**。已列入发布前检查（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §6.4） |
| **I-8** | 通过日志读到口令/Cookie/MFA 密钥 | ❌ **无脱敏白名单** | ⚠️ **中（未缓解）**（[`SECURITY.md`](SECURITY.md) §12 G-10） |
| **I-9** | 签名下载链接经 `Referer` 泄露给第三方 | 新中间件设 `Referrer-Policy: strict-origin-when-cross-origin`（`security-headers.middleware.ts:140`） | ⚠️ **当前无效**：运行中的实例**尚未输出该头**（§9 / [`SECURITY.md`](SECURITY.md) §10.2）。且下载链接目前的真正问题是**根本没签名** |
| **I-10** | 20 个初始账号口钥哈希公开在仓库 → 离线爆破 | ❌ 无控制 | ⚠️ **高**：`seed-teachers.ts:11-172`（§D-2）。**必须在部署前确认这些口令已轮换** |
| **I-11** | 平台内其他租户猜测 bucket/路径直读文件 | **[无法验证]**（依赖平台 bucket 策略）。且当前客户端可自选 `filePath`（T-5）→ 若 bucket 是共享/可猜测命名，风险上升 | ⚠️ **无法验证** |
| **I-12** | CSP 缺失导致注入脚本后外传数据 | 新中间件带 CSP，但**默认 report-only**，且**尚未生效** | ⚠️ **中**（§9 G-12） |

### 3.5 Denial of Service（拒绝服务）

| ID | 攻击路径 | 现有控制 | 残余风险 |
|---|---|---|---|
| **D-1** | 暴力登录耗尽 CPU | ⚠️ **scrypt 是同步调用**（`scryptSync`，`auth.service.ts:97`）→ 每次登录在**事件循环上**阻塞（N=16384 约几十毫秒量级 [推断，未实测]）。攻击者可用并发登录把 Node 单线程打满 | ⚠️ **中-高**：IP 限流是进程内的且按 IP 计数（可分布式轮换 IP 绕过）；**没有全局并发上限、没有队列**。**建议在代理层加限流**（[`SECURITY.md`](SECURITY.md) §2.4） |
| **D-2** | 大量 `Map` 键导致内存增长 | ❌ `ipRateMap` **无清理**（`auth.service.ts:77,134-144`）→ 每个不同 IP 留一条记录，永不回收 | ⚠️ **中**：IPv6 地址空间极大，长期运行会持续增长。**未缓解** |
| **D-3** | `sessions` 表膨胀 | `cleanup()` 每小时删 `expires_at < now`（`auth.service.ts:91-93`）；⚠️ **不删已撤销记录**（`session.service.ts:228-240`）；⚠️ 定时器**无 `onModuleDestroy`**（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §7.3） | ⚠️ **低-中** |
| **D-4** | 打满数据库连接 | `postgres.js` 默认连接池；无显式上限配置 | ⚠️ 低（单进程默认池较小） `[推断]` |
| **D-5** | 上传巨型文件 / ZIP 炸弹 / 路径穿越 | ❌ **完全没有服务端上传路径**（0 个可下载资源；上传是 TODO）→ **当前不可利用**，但一旦实现直传就必须补 | ⚠️ **当前无风险，未来必须设计**（[`SECURITY.md`](SECURITY.md) §12 G-3） |
| **D-6** | 依赖服务不可用导致进程崩溃 | 实测：停掉 PostgreSQL 后进程**未崩溃**，返回 500 且不泄露（§Q-3）；`/api/health`（存活）**不碰依赖**，避免编排器误杀健康进程（`health.module.ts:12-26`） | ✅ **设计正确** |
| **D-7** | 优雅退出缺失导致滚动更新中断请求 | ❌ 无 `enableShutdownHooks()` / SIGTERM 处理 | ⚠️ **中**：先在 LB 摘流量再停 |

### 3.6 Elevation of Privilege（提权）

| ID | 攻击路径 | 现有控制 | 残余风险 |
|---|---|---|---|
| **E-1** | 普通账号直接调用管理员 API（IDOR / 越权） | 全局 `AuthGuard`（认证）+ `PermissionGuard`（授权）；`teachers`/`resources`/`review`/`audit` 全部路由都有 `@RequirePermission`（[`SECURITY.md`](SECURITY.md) §5.5） | ✅ 主体到位。⚠️ `curriculum`/`dashboard` 未声明；⚠️ 审核路由声明的是 `review.view` 而非 `review.approve`/`reject`（与同文件注释不一致） |
| **E-2** | 忘记给新端点加校验 → 静默开放 | `PermissionGuard` **默认 fail closed**：`request.teacher` 缺失时抛 401 并打 error（`permission.guard.ts:76-93`）；MFA 强制采用**默认拒绝 + `@MfaExempt` 白名单**（`auth.guard.ts:155-182`） | ✅ 设计正确。但**"没有 `@RequirePermission` 就只要求登录"**这一默认是开放的（`permission.guard.ts:74`）—— 评审必须逐路由确认 |
| **E-3** | 通过 mass assignment 写入不该写的字段（如自己 `roles`） | ⚠️ `ValidationPipe` **未配置 `whitelist`/`forbidNonWhitelisted`** → 未知字段不剥离（`PRODUCTION_READINESS.md` §Q-1，已实测 DTO 的 `@IsIn` 生效但未知字段不拦） | ⚠️ **中-高（未缓解）**。DTO 显式列出的字段仍受类型/枚举校验 |
| **E-4** | **`anon` 角色直接改 `teachers.password_hash` / `roles`**（若匿名连接可达 DB） | `0005` 列级 GRANT：`UPDATE` 仅 `last_login_at, failed_login_attempts, locked_until`；末尾用 `has_column_privilege` 断言 | ✅ **已修复并实测**：`anon_.teachers.password_hash UPDATE = false`、`roles = false`，`last_login_at = true` |
| **E-5** | 假设有 RLS 就以为有行级隔离 → 设计出实际上无人保护的路径 | — | ⚠️ **认知风险（必须记录）**：**RLS 不提供行级保护**（全 `USING(true)`，无 `FORCE RLS`，实测 `FORCE RLS` 表数 = **0**）；**且独立部署下每个请求都跑在匿名角色上**（§4）→ **数据库角色无法区分应用用户**。**应用层授权是唯一闸门**（`0005:179-184`）[已证实] |
| **E-6** | 通过 MFA 未绑定状态使用 super_admin | "不允许关闭 MFA" + **"未绑定即拒绝一切（除 `@MfaExempt`）"** 两半都已实现（`auth.guard.ts:155-182`、`mfa.service.ts:276-284`） | ✅ 控制到位 |
| **E-7** | 用恢复码无限次登录 | 恢复码单次使用：`UPDATE … WHERE used_at IS NULL`，重放影响 0 行（`mfa.service.ts:325-343`） | ✅ |
| **E-8** | 拿到密码后无限次猜 TOTP | challenge 次数上限 5，耗尽即消费（`mfa.service.ts:408-433`） | ✅ |
| **E-9** | 平台侧（或其他租户）通过 `SET LOCAL ROLE` 拿到 `service_role_` 的**全表权限** | ❌ 无控制（平台行为） | ⚠️ **无法验证**：`service_role_` 有 `SELECT/INSERT/UPDATE/DELETE ON ALL TABLES`（`0004:82`）。平台如何决定切换角色**在平台侧代码里**，本仓库不可控 |
| **E-10** | 通过平台 HBS 占位符替换机制注入（`{{csrfToken}}` / `{{userId}}`） | 依赖平台实现；本应用 `server/main.ts:69` 用 `hbsExpressEngine` 渲染 | ⚠️ **[无法验证]**（无平台环境）。⚠️ 副产品风险：若把 client 产物丢到纯静态 CDN 而不经本应用渲染，CSRF 与用户上下文会**全部失效**（§G-14） |

---

## 4. 关键发现：独立部署下"每个请求都是匿名数据库角色"

这是本系统**最容易被误判**的一点，逐条记录：

```
平台包 SqlExecutionContextMiddleware（每请求执行）：
    SET LOCAL app.user_id = '<userId>';
    SET LOCAL ROLE 'anon_<roleSchema>' | 'authenticated_<roleSchema>' | 'service_role_<roleSchema>';
其中 <roleSchema> 来自连接串的 schema 查询参数 —— 独立部署时为空 ⇒ 角色 = anon_
```
出处：`0004_rls_role_alignment.sql:5-34`；`0005_tighten_rls_writes.sql:179-184`。 [已证实]

| 推论 | 说明 |
|---|---|
| **DB 角色无法区分应用用户** | 因为 `SET ROLE` 由平台的 `userContext.userId` 驱动，而该值在独立部署时为空。**登录用户在数据库层面与匿名访客同权** |
| **应用层授权是唯一闸门** | `AuthGuard` + `PermissionGuard` + `AuthorizationService`。**它们失效 = 无任何兜底** |
| **RLS 不是纵深防御** | 全 `USING(true)`、`FORCE RLS` 表数 = 0（实测）→ 不提供行级隔离 |
| **列级 GRANT 却是真控制** | `0005` 的列级授权是**按角色**生效的，与"谁来调用"无关 → 它对匿名角色（即所有请求）**真实生效**。这是当前 DB 侧最有价值的一道防线 |
| **加固方向** | 短期：继续用列级 GRANT + 触发器（应用无关的硬约束）。长期：让应用在认证后显式 `SET LOCAL app.user_id` 并按用户/角色切换 DB 角色 —— **属代码改造，尚未实现** |

> ⚠️ **对文档/评审的直接要求**：任何"我们有 RLS，所以数据是行级隔离的"的说法都是**错的**。
> 正确表述见 [`SECURITY.md`](SECURITY.md) §8。

---

## 5. 三个专门的威胁专项

### 5.1 客户端直传对象存储（绕过服务端校验）

**现状（已证实）**

- 前端**没有任何真实上传**：`UploadPage.tsx:157-160`
  ```ts
  // TODO: Integrate dataloom storage SDK for real file upload
  // Flow: get pre-signed URL -> upload to storage -> get file_path/bucket -> submit
  const fileBucketId = selectedFile ? 'placeholder-bucket' : undefined;
  const filePath = selectedFile ? `uploads/${Date.now()}/${selectedFile.name}` : undefined;
  ```
  → **存储坐标由前端捏造**，字节从未上传到任何地方。
- 服务端**接受并落库**客户端给的值：`resources.dto.ts:164,168`（创建）、`:218,222`（更新）；
  `resources.service.ts:993-994,1090-1091`。
- `FileService` 已注入构造函数（`resources.service.ts:55`）但**全仓库零引用**。

**攻击路径（当前与未来）**

| 阶段 | 路径 | 影响 |
|---|---|---|
| **现在** | 攻击者 `POST /api/resources` 带 `fileBucketId`/`filePath` 指向**他人的文件路径** | 让一条"自己的资源"指向别人的文件；一旦下载实现上线，即成为**越权取文件的跳板** |
| **按 TODO 实现后** | 若沿用"客户端拿预签名 URL 直传 bucket，再把路径回传后端"的设计：攻击者**跳过服务端校验**上传任意类型/大小/内容（含可执行文件、超长文件名、`../` 路径穿越），后端只收到一个可信度为零的路径字符串 | 恶意文件托管在**校方域名下的 bucket**、XSS/钓鱼载体、存储成本滥用 |
| **下载侧** | 当前下载返回**未签名、无过期**的手拼 URL（`resources.service.ts:1465-1467`）：`/api/__platform__/storage/download?bucket=…&path=…`。该端点**由平台提供、本仓库未定义**（§G-15） | 链接一旦外泄即长期有效；`bucket`/`path` 若可猜则直接取文件 |

**必须的控制（尚未实现，属 [`SECURITY.md`](SECURITY.md) §12 G-3）**

1. **服务端生成存储 key**（`uploads/<resourceId>/<random>.<ext>`），**忽略**客户端传入的 bucket/path；
2. 服务端校验：扩展名白名单 + **Magic Bytes**、大小上限、请求体上限；
3. 防**路径穿越**（拒绝 `..`、绝对路径、控制字符）与 **ZIP 炸弹**；
4. 下载改为**短时效、与调用者绑定**的签名 URL（`FileService.createSignedUrl` 或 S3 兼容签名）；
5. 软删除 + 回收站 + 永久删除需更高权限与二次认证（`0007` 已提供持久化，应用层待接）。
6. 删除全部"渲染给用户的 TODO 文案"与 `placeholder-bucket` 伪造值。

### 5.2 进程内限流（多实例失效）

| 项 | 事实 |
|---|---|
| 实现 | `private readonly ipRateMap = new Map<...>()`（`auth.service.ts:77`），`checkIpRateLimit()`（`:134-144`） |
| 阈值 | 每 IP 每 60 秒 30 次，可由环境变量调整；**模块加载时读取一次**（`:41-51`） |
| 跨进程 | ❌ 不共享 |
| 清理 | ❌ 无 |

**攻击路径**：以 N 个副本部署时，攻击者获得约 `30 × N` 次/分钟/IP 的配额；
再配合分布式 IP（或伪造 `X-Forwarded-For`，若 `trust proxy` 配错）→ **限流形同虚设**。
后果不是"仅仅慢一点"：账号锁定是按**账号**计数的（5 次/15 分钟），
所以绕过 IP 限流后攻击者仍受账号锁定约束，但**跨大量账号的口令喷洒（password spraying）**
不受影响 —— 每账号只试 4 次即可无限探测账号集合。

**未成熟但明确的处置**：
1. **在反向代理/网关层增加按 IP 的登录限流**（最有效，且与副本数无关）；
2. 单副本部署时本限流有效；
3. 长期：抽象 `RateLimitStore` 并接 Redis/DB（[`SECURITY.md`](SECURITY.md) §12 G-1）。

**已接受的风险理由**：补齐分布式限流需要引入新的基础设施依赖（Redis），
在当前阶段（内部平台、单一校方、访问面有限）成本高于收益；
**但必须写进部署文档**，且一旦多副本发布就必须先做代理层限流。

### 5.3 `trust proxy` 伪造（**已修复**，但配置错误会让它回归）

**曾经的漏洞（实测过）**

```
请求：X-Forwarded-For: 203.0.113.99, 10.0.0.1
结果：audit_logs.ip_address = 203.0.113.99   ← 攻击者自选值
```
根因：3 处代码 `req.headers['x-forwarded-for'].split(',')[0]`；且
`configureApp()`（平台包）末尾执行 `app.set('trust proxy', true)`，
**在它之前设置的 `trust proxy` 会被静默丢弃**。
后果：IP 限流可用轮换 header 绕过；**审计无法归因**（审计是事后追责的唯一凭据）。
证据：`PRODUCTION_READINESS.md` §Q-2。 [已证实]

**当前控制**
- `getClientIp()` **只返回 `req.ip`**，绝不自己解析 header（`client-ip.ts:34-45`）；
- `resolveTrustProxySetting()` **默认 `false`**（安全默认），支持 `loopback` / 跳数 / CIDR（`client-ip.ts:68-80`）；
- 在 `configureApp()` **之后**设置（`main.ts:41-61`）；
- `TRUST_PROXY=true` 且在 production 时启动打印明确警告（`main.ts:81-87`）。

**残余风险与攻击路径**

| 配置错误 | 攻击路径 | 后果 |
|---|---|---|
| 应用**可直连**但设了 `TRUST_PROXY=true` | 攻击者直接对应用发 `X-Forwarded-For: <任意>` | **漏洞完全回归**：限流绕过 + 审计污染 |
| 代理**追加**而非覆写 XFF（例如 Nginx 用 `$proxy_add_x_forwarded_for`） | 攻击者先发一个伪造值，代理把真实 IP 追加在其后；最右一跳之外仍有攻击者值 | 取决于跳数配置，可能仍被利用 |
| `TRUST_PROXY` 与实际跳数不符 | 同上网关 | 同上 |

**部署强制项**：见 [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §9.1
（配置值 + 代理必须覆写 + **伪造 XFF 后核对 `audit_logs.ip_address` 的验证方法**）。

---

## 6. 被接受的风险 / 未缓解风险（含理由）

> "被接受"= 有意识地不去修，理由成立，但**必须写进验收记录**。
> "未缓解"= 应该修但还没修，属发布阻塞项。

| ID | 风险 | 类别 | 理由 / 处置 |
|---|---|---|---|
| **R-1** | `authenticated_` / `service_role_` 仍可改删审计日志 | 被接受 | 这两个角色只在会话校验通过后使用，且**当前独立部署下并不采用它们**（§4）。真正的执行角色是 `anon_`，而它对审计是 append-only。**接受**；若将来启用 `authenticated_`，必须同步收窄 `SELECT, INSERT` 之外的权限（对称于 `0005`） |
| **R-2** | 匿名角色可写 `sessions.permissions_version` | 被接受 | 会话校验路径需要写它（`0005:168`）；它**只能导致拒绝**，正常路径下不构成提权。利用它需要已具备 DB 写权限（即已越过应用层）。**接受**，但列入季度复审 |
| **R-3** | RLS 全 `USING(true)`、无 `FORCE RLS` | 未缓解（架构级） | 见 §4：即使收紧 policy 也无意义，因为**所有请求同一角色**。正确方向是先让应用显式携带用户身份（`SET LOCAL app.user_id` + 角色切换），再收紧 RLS。**这是改造项，不是配置项** |
| **R-4** | 进程内限流 | 未缓解（有代理层缓解） | §5.2 |
| **R-5** | 客户端可指定存储坐标 | 未缓解 | §5.1；未上传实现前不可利用，**一旦实现立即成为高危** |
| **R-6** | 安全响应头尚未生效 | 未缓解（短期） | 代码已在工作区，`dist/` 陈旧导致运行实例无该头（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §9.4）。**属于"重新构建即可解决"，但必须复验** |
| **R-7** | `X-Frame-Options: DENY` 与平台 `Partitioned` CSRF cookie（iframe 场景）可能互斥 | 待决 | 见 [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §9.2。**上线前必须确认是否 iframe 嵌入** |
| **R-8** | 20 个生产口令哈希在源码中 | 未缓解（需运维动作） | 无法在文档层修复；**部署前必须确认这些账号的口令已轮换或账号已停用** |
| **R-9** | `mustChangePassword` 无实现 | 未缓解 | 初始口令可能长期有效。**与 R-8 叠加后风险上升** |
| **R-10** | 无登录/访问日志脱敏 | 未缓解 | 中；需要一份明确的脱敏白名单 |
| **R-11** | 无上限的 `ipRateMap` 增长 | 被接受（低） | 内存增长缓慢；重启即清。列入长期改进 |
| **R-12** | `I-11` 平台存储隔离 | **[无法验证]** | 需向平台确认 bucket 是否私有、路径是否可枚举 |
| **R-13** | 无备份/恢复演练 | 未缓解（最高优先级之一） | 见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) —— **这是当前最大的一处"未知"** |
| **R-14** | 平台是信任根，其行为不可审计 | **[无法验证]** | 无平台代码访问权。缓解：平台凭据最小化 + 定期复核平台侧账号 |

---

## 7. 攻击树（两个最可能的真实入侵剧本）

### 剧本 A：从公网到 `super_admin`

```
① 在 GitHub/交付包里读到 seed-teachers.ts 的 20 个 scrypt 哈希
   → 离线爆破（教师常用弱口令；无弱口令字典、无强制改密）
   → 得到某个 principal/curriculum_director 的明文口令
        ↓
② 用该口令登录（IP 限流进程内，可缓慢试；或直接不触发）
        ↓
③ 尝试提权为 super_admin
   ├─ 应用层：canGrantRole() 拒绝 → 审计记录
   └─ DB 层：rbac_guard_super_admin() 要求声明 super_admin 身份 → 拒绝
        → 【被挡住】
        ↓
③' 改为横向：把某教师口令重置 → 登录其账号 → 读其科目资源
   → 若目标已启用 MFA 则不可行（未启用则可行）
        ↓
④ 若目标是 super_admin 且未绑定 MFA → AuthGuard 直接 403（默认拒绝）
   → 无法用它做任何事，攻击者被卡住
```
**结论**：提权链在 ③ 被两处独立控制挡住；真正的损失集中在 ①/③'（账号接管）。
**最该做的**：轮换初始口令 + 实现强制改密 + 弱口令字典。

### 剧本 B：从数据库/备份泄露到全面接管

```
① 获得一份数据库 dump（备份文件泄露、DB 直连凭据泄露、SQL 注入等）
        ↓
② 复用会话？ → 不行，DB 只有 sha256(sessionId)   【被挡住】
        ↓
③ 读 TOTP 密钥 → 不行，AES-256-GCM 密文，密钥在环境变量里   【被挡住】
        ↓
④ 读明文口令 → 不行，只有 scrypt 哈希   【被挡住】
        ↓
⑤ 但可以：
   ├─ 读 teacher_mfa.confirmed + 删除该行 → 让某账号"MFA 未绑定"
   │    → 若该账号是 super_admin：AuthGuard 会 403 拦下（默认拒绝）→ 【被挡住】
   │    → 若该账号是普通角色（不要求 MFA）：直接少一层保护 → 可接受损失
   ├─ 改 resources.file_path 指向他人文件 → 越权取文件（下载实现上线后）【未缓解】
   ├─ 改 account_permission_overrides 给自己加权限
   │    → 应用层会读到"更宽"的有效权限 → 【可被利用！】
   └─ 把 sessions.revoked 改回 false → 复活一个自己持有的旧会话
        （需要旧 cookie，且 permissions_version 要对得上）
```
**结论**：**数据库泄露本身不等于系统沦陷**（口令/会话/TOTP 三层都不直接从 dump 受益），
但**权限覆盖表与资源路径可被直接改写**，因此"能写 DB"≈"能提权"。
**这再次说明**：DB 侧的角色/列级约束（`0005`）和触发器（`0003`）是**必要的第二道防线**，
但它们保护的是"**通过应用连接**的写入"，不能保护"**拿到连接串直连**的写入"。
→ **连接串的最低权限化 + 网络隔离 + 备份加密** 是补这一环的关键。

---

## 8. 控制矩阵（按信任边界汇总）

| 边界 | 控制 | 状态 | 证据 |
|---|---|---|---|
| ①浏览器→TB-1 | TLS + `Secure` Cookie 强制 | ✅ / **[无法验证]** 实际代理 | `session.service.ts:47-51` |
| ① | 安全响应头（nosniff / frame / referrer / CSP / HSTS） | ⚠️ 代码已写，**运行实例未生效** | `security-headers.middleware.ts`；实测无这些头 |
| ① | CSRF 双提交 | ✅ 实测四态 | `csrf-check.middleware.ts:4-28` |
| TB-1→TB-2 | `trust proxy` 显式配置 + 默认安全 + 代理须覆写 XFF | ✅ 代码 / ⚠️ 配置责任在部署方 | `main.ts:34-61`、`client-ip.ts:68-80` |
| TB-2 | 全局认证（`AuthGuard`）+ 授权（`PermissionGuard`） | ✅ | `auth.module.ts:25-33` |
| TB-2 | 强制 MFA（两半）+ 数据库 challenge | ✅ | `auth.guard.ts:155-182`、`mfa.service.ts` |
| TB-2 | 输入校验 | ⚠️ `ValidationPipe` 存在但**无 whitelist/forbidNonWhitelisted** | §Q-1 |
| TB-2 | 错误脱敏 | ✅ 5xx 不返回 stack/cause（production） | `exception.filter.ts:94-128`；§Q-3 |
| TB-2 | 日志脱敏 | ❌ 未实现 | §12 G-10 |
| TB-2 | 优雅退出 | ❌ 未实现 | §7.3 |
| TB-2→TB-3 | 列级 GRANT（凭据不可改、审计 append-only） | ✅ 实测 | `0005`；`has_column_privilege` 实测 |
| TB-2→TB-3 | 提权/最后管理员保护触发器 | ✅ | `0003:189-306` |
| TB-3 | RLS 行级隔离 | ❌ **不成立**（全 `USING(true)`、无 `FORCE RLS`；单一角色） | §4；实测 FORCE RLS = 0 |
| TB-3 | 迁移校验和 / 幂等 / 事务 | ✅ | `migrate.mjs`；实测无漂移 |
| TB-3 | 备份与恢复 | ❌ **从未演练** | [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) |
| TB-4 | 服务端生成存储 key | ❌ 未实现 | §5.1 |
| TB-4 | 签名下载 | ❌ 未实现（未签名无过期 URL） | `resources.service.ts:1465-1467` |
| TB-5 | 平台注入行为（角色切换 / HBS / 发布） | **[无法验证]** | 无平台访问 |

---

## 9. 未验证项（必须由部署环境确认）

| # | 项 | 为什么无法验证 |
|---|---|---|
| U-1 | 真实反向代理下 `trust proxy` / `X-Forwarded-For` 行为 | 本机无 Nginx/云入口 |
| U-2 | 真实 HTTPS 下 `Secure` / `SameSite` / `Partitioned` cookie 行为 | 无真实域名与证书 |
| U-3 | HSTS / CSP 在真实浏览器中的实际效果 | 同上；且运行实例尚未输出这些头 |
| U-4 | 平台 dataloom 的 bucket 是否私有、路径是否可枚举、是否有签名机制 | 无平台凭据 |
| U-5 | 平台 `SET LOCAL ROLE` 在生产（非空 `schema` 参数）下的实际角色 | 无平台环境 |
| U-6 | HBS 占位符替换链路在生产构建中的真实行为 | 无平台环境 |
| U-7 | 平台侧账号/密钥的隔离与审计能力 | 属平台责任范围 |
| U-8 | 生产库的真实数据规模、权限配置、RLS 现状 | 无连接串 |

---

## 10. 一页总结

**这个系统在"应用层"做得比典型项目扎实**（全局守卫 + 声明式权限 + 数据库触发器兜底 +
MFA 全套 + 会话哈希存储 + fail-closed 的错误处理 + 列级 GRANT）。

**它的风险集中在三处**：

1. **纵深防御的第二层是空的**：RLS 不提供行级隔离，且所有请求共用匿名 DB 角色
   → **应用层一旦有洞，没有兜底**。这是架构级结论（§4 / R-3）。
2. **文件链路完全未生产化**：客户端可指定存储坐标、下载链接未签名无过期
   → 现在不可利用（0 个文件），**一旦开始真实使用就立刻高危**（§5.1 / R-5）。
3. **可用性/运维侧的空白比例子更危险**：进程内限流、无优雅退出、无备份演练
   → 前两个有缓解手段，**第三个完全没有**（§6 R-13）。

**优先级排序（按"被利用的可能性 × 影响"）**：

| 优先级 | 动作 |
|---|---|
| P0 | 完成**备份/恢复演练**（[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §8） |
| P0 | 轮换/停用 20 个源码内硬编码口令对应的账号 |
| P0 | 部署 `trust proxy` 正确配置 + 代理层限流 + 验证伪造 XFF 无效 |
| P1 | 实装安全响应头（重新构建）并复验；确认 iframe 策略 |
| P1 | 文件链路上线前，先做服务端 key 生成 + 类型校验 + 签名下载 |
| P1 | `ValidationPipe` 加 `whitelist` + `forbidNonWhitelisted` |
| P2 | 补齐 `curriculum`/`dashboard` 权限声明；复核审核路由权限码 |
| P2 | 日志脱敏白名单；`requestId` header/body 一致性；优雅退出 |
| P2 | 分布式限流（多副本前必须） |
