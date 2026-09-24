# SECURITY.md — 清澜山幼儿园教师课程资源平台 · 安全模型（实现现状）

> **文档基线**：git commit `671328a`（`phase7: fix all frontend/backend API contract drift`）+
> 写作时工作区中已存在但尚未提交的改动（见 §14.3）。生产加固仍在进行，代码可能继续变化；
> 任何一条结论以**当时的代码与实测输出**为准。
>
> **证据标记**（与 [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) §0 一致）：
> - **[已证实]** 本次或已记录的真实执行结果，或由源码逐行确证（附文件:行）
> - **[推断]** 由代码/配置互证推出，未实机执行
> - **[无法验证]** 需要目标部署环境（妙搭平台 / 真实域名 / 真实反向代理）才能确认
>
> **本文只描述代码里真实存在的控制。** 不存在的一律写入 §12「已知缺口」，
> 不写"计划中""已设计"当作"已实现"。设计意图见 [`RBAC.md`](RBAC.md)，
> 威胁与攻击路径见 [`THREAT_MODEL.md`](THREAT_MODEL.md)，
> 处置流程见 [`RUNBOOK.md`](RUNBOOK.md)。

---

## 1. 信任边界

```
浏览器 (教师/管理员)
   │  HTTPS
   ▼
反向代理 / 平台入口 (TLS 终止, X-Forwarded-*)
   │  HTTP (内网)
   ▼
NestJS 应用 (本仓库)
   │  SQL (postgres.js, 单一连接身份 + SET LOCAL ROLE)
   ▼
PostgreSQL (RLS + GRANT)
   │
   └──► 妙搭 dataloom 对象存储 (文件直传/代理下载)
```

| 边界 | 谁能控制边界两侧 | 应用侧的控制 |
|---|---|---|
| 浏览器 → 应用 | 完全不可信（含 `X-Forwarded-For`、`Cookie`、请求体、CSRF header） | 全局 `AuthGuard` + `PermissionGuard` + CSRF 中间件 |
| 代理 → 应用 | 只有 `TRUST_PROXY` 声明的跳数可信 | `req.ip` 全部来自 Express `trust proxy` 推导，不手解析 header（`server/common/http/client-ip.ts:34-45`） |
| 应用 → PostgreSQL | 应用自身的 SQL 与所采用的 DB 角色 | 列级 GRANT + RLS（§8）；**注意：RLS 当前不提供行级差异** |
| 应用 → 对象存储 | 客户端可直接上传到 bucket（§12 G-3） | 无服务端校验路径 —— 未缓解 |
| 妙搭平台 → 应用 | 平台注入的 `SET LOCAL ROLE`、`SUDA_DATABASE_URL`、CSRF cookie | 见 §8.2 / §12 |

---

## 2. 认证（Authentication）

### 2.1 口令存储 —— 参数以代码为准

| 项 | 实际值 | 证据 |
|---|---|---|
| 算法 | scrypt（`crypto.scryptSync`） | `server/modules/auth/auth.service.ts:96-103` [已证实] |
| N | **16384** | `auth.service.ts:22` [已证实] |
| r | **8** | `auth.service.ts:23` [已证实] |
| p | **1** | `auth.service.ts:24` [已证实] |
| keylen | **32 字节** | `auth.service.ts:25` [已证实] |
| salt | 每口令 **16 字节 `randomBytes`**，Base64 | `auth.service.ts:26,105-108` [已证实] |
| 存储格式 | `scrypt$N$r$p$<salt-b64>$<key-b64>` | `auth.service.ts:102` [已证实] |
| 校验 | `timingSafeEqual` 常数时间比较；参数不一致/异常一律返回 false | `auth.service.ts:110-124` [已证实] |

> 提示：任务书中给的参数（N=16384, r=8, p=1, keylen=32）**与代码一致**，已逐行核对。
>
> **两个如实记录的缺陷（未修复）**
> 1. 存储格式**不含 keylen**。`verifyPassword()` 用常量 `SCRYPT_KEYLEN=32` 重新派生，
>    因此将来若改 keylen，既有哈希将**全部校验失败**而不是自动升级。 [已证实，代码事实]
> 2. **没有渐进式 rehash**：`login()` 校验成功后不回写更强制参数的哈希
>    （`auth.service.ts:324-362`），`PRODUCTION_READINESS.md` §J-4 第 19 项仍未实现。 [已证实]

### 2.2 登录流程

`POST /api/auth/login`（`@Public()`，`server/modules/auth/auth.controller.ts:66-67`）：

1. IP 限流检查（§2.4）。超限 → `403 请求过于频繁，请稍后再试`。
2. 按 `lower(username)` 查库；不存在 → 写 `login_failed` 审计 + `401 用户名或密码错误`
   （不区分"用户不存在"与"密码错误"，避免用户名枚举）。 `auth.service.ts:247-277` [已证实]
3. `locked_until > now` → 写审计 + `403 账号已锁定`。 `auth.service.ts:282-294`
4. `status !== 'active'` → 写 `login_denied` 审计 + `403 账号已停用`。 `auth.service.ts:296-308`
5. 无 `password_hash` → 写审计 + `401`（不泄露内部状态）。 `auth.service.ts:310-322`
6. 口令校验失败 → `failed_login_attempts += 1`；达到 5 → 置 `locked_until = now + 15min`；写审计。 `auth.service.ts:324-353`
7. 成功 → 清零失败计数与锁定、写 `last_login_at`。
8. **若已启用 MFA：不创建会话**，只返回一次性 challenge token（§4.4）。 `auth.service.ts:366-400`
9. 否则创建会话（§3），会话上固定 `permissions_version`。 `auth.service.ts:404-409`

| 策略 | 值 | 证据 |
|---|---|---|
| 口令复杂度 | 长度 ≥ 10 且含大写、小写、数字 | `auth.service.ts:126-132` [已证实] |
| 失败锁定 | 连续 **5** 次 → 锁 **15 分钟** | `auth.service.ts:27-28,330-332` [已证实] |
| 改密后 | 撤销本人其他会话；`mustChangePassword` 置 false | `auth.service.ts:504,473` [已证实] |
| 管理员重置 | 生成 16 位随机临时口令，**仅在该响应返回一次**；撤销该账号全部会话 | `auth.service.ts:541-574` [已证实] |
| 会话内改密 | `POST /api/auth/change-password` | `auth.controller.ts:255` [已证实] |

> **`mustChangePassword` 不是强制改密功能。** 代码中它只被赋 `false`
> （`auth.service.ts:473,548`），没有任何路径赋 `true`，前端也不读取它。
> `DEPLOYMENT.md` 与旧 `README.md` 声称的"首次登录强制改密"**在代码中不存在**。
> 如实记录为缺口（§12 G-6），不写成已实现。 [已证实]

### 2.3 临时口令生成的两点观察

- 字母表 `ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789`（55 字符，去掉易混的 `I/O/l/i/o/0/1`），
  16 位，熵约 **92 bit**。 `auth.service.ts:146-154` [已证实]
- 取模方式为 `buf[i] % 55`，`256 % 55 = 36 ≠ 0`，存在**轻微模偏差**（不影响 92 bit 量级的实际强度，
  但属于密码学上不干净的写法）。恢复码同理：`256 % 31 = 8`，16 位约 **79.3 bit**。
  `auth.service.ts:151`、`server/common/crypto/mfa-crypto.ts:275` [已证实，代码事实]

### 2.4 登录限流 —— **进程内，多实例下不成立**

| 项 | 实际实现 | 证据 |
|---|---|---|
| 存储 | `private readonly ipRateMap = new Map<string, IpRateRecord>()`（**进程内**） | `auth.service.ts:77` [已证实] |
| 默认阈值 | 每 IP 每 **60 秒 30 次** | `auth.service.ts:50-51` [已证实] |
| 可配置 | `LOGIN_IP_RATE_LIMIT_MAX` / `LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS`；**模块加载时读取一次，改值需重启** | `auth.service.ts:41-51` [已证实] |
| 计数键 | `getClientIp(req)` → Express `req.ip`（§9） | `auth.controller.ts` 调用链 + `client-ip.ts` |
| Map 清理 | **无**。键按 IP 无限增长，`cleanup()` 不清理该 Map | `auth.service.ts:134-144`、`session.service.ts:228-240` [已证实] |

> ⚠️ **这是本系统当前最重要的可用性/安全性折衷，必须写进部署决策：**
> 限流计数**不跨进程、不跨实例**。N 个副本时实际允许的尝试次数约为 `30 × N` / 分钟/IP。
> 代码注释已自认此点（`auth.service.ts:35-39`），`PRODUCTION_READINESS.md` §D-12 与 §R-4 也列为未完成。
> 在补齐共享存储（`RateLimitStore` 抽象 + Redis/DB）之前，**它是一道刹车，不是硬上限**；
> 若以多副本发布，必须在反向代理/网关层另加一层按 IP 的登录限流。
> N=1 时该限流有效。 [已证实，代码与注释]

### 2.5 会话清理定时器的生命周期

`onModuleInit()` 用 `setInterval(..., 60*60*1000)` 每小时清理过期会话，
**没有 `onModuleDestroy` / `clearInterval`**，进程优雅退出时该定时器悬挂。
`auth.service.ts:91-93` [已证实]。`cleanup()` 只删 `expires_at < now`，
**不删已撤销记录**（`session.service.ts:228-240`），因此 `sessions` 表会持续增长到过期为止。 [已证实]

---

## 3. 会话管理（Session）

| 项 | 实际实现 | 证据 |
|---|---|---|
| 会话令牌 | `randomBytes(32).toString('hex')`（256 bit） | `session.service.ts:64` [已证实] |
| 服务端存储 | **只存 `sha256(sessionId)`**，DB 泄露不等于会话可被使用 | `session.service.ts:16-18,65` [已证实] |
| Cookie 名 | `SESSION_COOKIE_NAME`，默认 `qls_session` | `session.service.ts:8,44-45` [已证实] |
| TTL | `SESSION_TTL_SECONDS`，默认 86400（24h） | `session.service.ts:31-34` [已证实] |
| Cookie 属性 | `httpOnly: true`、`secure: isHttps`、`sameSite: isHttps ? 'none' : 'lax'`、`path: '/'`、`maxAge: ttl` | `session.service.ts:196-211` [已证实] |
| **生产不可降级** | `NODE_ENV === 'production'` 时**强制 `isHttps = true`**，`HTTPS_ENABLED=false` 无法关闭 `Secure` | `session.service.ts:47-51` [已证实] |
| 有效判定 | 必须 `revoked = false` 且 `expires_at >= now` | `session.service.ts:109-118` [已证实] |
| 撤销 | `revoked = true` + `revoked_at` + `revoke_reason`（`logout` / `permissions_changed` / …） | `session.service.ts:137-150` [已证实] |
| 本人其他会话 | 改密 / 管理员重置时批量撤销 | `session.service.ts:152-174` [已证实] |
| 续期 | `last_accessed_at` 每次请求更新；**不滑动过期**（`expires_at` 不变） | `session.service.ts:121-128` [已证实] |

### 3.1 即时失效：两道独立机制

1. **停用即失效**：`AuthGuard` 每个请求重新读取 `teachers.status`（不信任 Cookie），
   非 `active` → `destroySession()` + `401 账号已停用`。 `auth.guard.ts:113-119` [已证实]
2. **权限变更即失效**：`AuthGuard` 比较 `sessions.permissions_version` 与
   `teachers.permissions_version`；不一致 → `destroySession(sessionId, 'permissions_changed')`
   + `401 权限已变更，请重新登录`。 `auth.guard.ts:121-134` [已证实]

`permissions_version` 由**数据库触发器**自增，而不是靠调用方记得写：
`teachers` 的 `roles`/`status` 变化、以及 `account_permission_overrides` /
`account_scopes` 的任何增删改，都会 bump（migration `0003` 第 122-168 行）。 [已证实]

> 这也解释了运行中的一个常见现象：修改某人角色后，该用户**当次请求就掉线**，
> 需要重新登录 —— 这是设计意图，不是故障。见 `RUNBOOK.md` §5。

---

## 4. MFA / TOTP（RFC 6238）

### 4.1 算法实现

| 项 | 实现 | 证据 |
|---|---|---|
| 实现位置 | 自己用 `node:crypto` 实现（HMAC + 动态截断），不引第三方依赖 | `server/common/crypto/mfa-crypto.ts:90-156` [已证实] |
| 算法 | SHA1 / SHA256 / SHA512 可选，默认 **SHA1** | `mfa-crypto.ts:99,118`、`0006_mfa.sql:40` [已证实] |
| 位数 / 周期 | 默认 **6 位 / 30 秒**（DB 有 CHECK 约束限制） | `mfa-crypto.ts:116-117`、`0006_mfa.sql:50-52` |
| 密钥 | `randomBytes(20)` → Base32（160 bit），RFC 4226 推荐长度 | `mfa-crypto.ts:72-74` [已证实] |
| 时钟漂移 | `window = ±1` 步（±30s）；服务端常量 `TOTP_WINDOW = 1` | `mfa-crypto.ts:138`、`mfa.service.ts:41` [已证实] |
| 比较 | `timingSafeEqual` 常数时间；非纯数字或长度不符直接 false | `mfa-crypto.ts:141-155` [已证实] |
| otpauth URI | `otpauth://totp/<issuer>:<account>?...`，issuer 为「清澜山幼儿园课程资源平台」 | `mfa-crypto.ts:164-181`、`mfa.service.ts:43` [已证实] |

### 4.2 密钥静态加密（AES-256-GCM）

| 项 | 实现 | 证据 |
|---|---|---|
| 算法 | `aes-256-gcm`，96-bit 随机 IV，带认证标签 | `mfa-crypto.ts:230-242` [已证实] |
| 存储格式 | `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`（**版本前缀便于将来轮换算法**） | `mfa-crypto.ts:187,236-241` [已证实] |
| 密钥来源 | 环境变量 `MFA_ENCRYPTION_KEY`；接受 Base64 或 64 位 hex，**必须恰好 32 字节** | `mfa-crypto.ts:198-217` [已证实] |
| 缺密钥行为 | **fail closed**：`encryptSecret`/`decryptSecret` 抛错，不会降级为明文，也不会每次重启生成新密钥 | `mfa-crypto.ts:190-217` [已证实] |
| 篡改检测 | GCM 认证失败即抛错（AEAD，非 CBC） | `mfa-crypto.ts:252-259` [已证实] |
| DB 列 | `teacher_mfa.secret_encrypted text NOT NULL`，含 COMMENT 说明不得存明文 | `0006_mfa.sql:36-59` [已证实] |

### 4.3 恢复码

| 项 | 实现 | 证据 |
|---|---|---|
| 数量 / 格式 | **10 个**，`XXXX-XXXX-XXXX-XXXX`（31 字符表，去易混字符） | `mfa.service.ts:42`、`mfa-crypto.ts:266-278` [已证实] |
| 存储 | **只存 `sha256(code)`**（`code_hash varchar(64)`），明文只在生成那一次响应里出现 | `mfa-crypto.ts:281-283`、`0006_mfa.sql:64-80` [已证实] |
| 一次性 | `UPDATE ... WHERE used_at IS NULL`，重放匹配 0 行 → 拒绝 | `mfa.service.ts:325-343` [已证实] |
| 重置 | 重新生成会删除旧码，旧码立即失效 | `mfa.service.ts:253-264` [已证实] |
| 唯一索引 | `idx_mfa_recovery_hash` UNIQUE | `0006_mfa.sql:79-80` [已证实] |

### 4.4 登录 challenge —— 明确为多实例安全

- 位置：**数据库表 `mfa_challenges`**，不在进程内存。
  原因（代码注释原文）：密码在实例 A 校验、TOTP 提交到实例 B 时不应失败。 `mfa.service.ts:70-76` [已证实]
- 只存 `sha256(challengeToken)`；令牌本身 32 字节随机。 `mfa-crypto.ts:286-292`、`0006_mfa.sql:87-89` [已证实]
- TTL **5 分钟**；`consumed_at` 保证单次使用；`attempts` 上限 **5**，耗尽即消费掉该 challenge，
  强制重新走密码登录。 `mfa.service.ts:37-39,380-433` [已证实]
- 过期行借签发时机顺带清理（无独立定时任务）。 `mfa.service.ts:369-374` [已证实]

### 4.5 强制 MFA 的"两半"都已落地

| 半边 | 实现 | 证据 |
|---|---|---|
| 不允许关闭 | `assertMayDisable()`：持有 `super_admin` 者禁用 MFA 一律 `403` | `mfa.service.ts:276-284` [已证实] |
| **未绑定即拒绝一切** | `AuthGuard` 对"角色要求 MFA 但尚未绑定"的账号**默认拒绝所有路由**，仅放行 `@MfaExempt()` 标记的路由（自身身份、MFA 流程、登出、健康检查） | `auth.guard.ts:155-182`、`permission.decorator.ts:59-77` [已证实] |
| 要求 MFA 的角色 | 目前仅 `super_admin` | `mfa.service.ts:96-99` [已证实] |
| 登录不绕过 | 已启用 MFA 时密码步骤完成**不创建会话** | `auth.service.ts:366-400` [已证实] |
| 密钥缺失时 | **fail closed**：拒绝登录，而不是静默降级为单因素 | `auth.service.ts:372-377` [已证实] |

> 设计选择说明：采用「默认拒绝 + `@MfaExempt` 白名单」而非「路径白名单」，
> 是为了**将来新增的端点自动受限**。见 `permission.decorator.ts:69-74`。

---

## 5. 授权（Authorization）

### 5.1 全局守卫链

`AuthModule` 以 `APP_GUARD` 注册**两个**全局守卫，**顺序即注册顺序**：

```
APP_GUARD → AuthGuard        (认证：建立 request.teacher / request.authz)
APP_GUARD → PermissionGuard  (授权：执行 @RequirePermission / @RequireSuperAdmin)
```

证据：`server/modules/auth/auth.module.ts:12-35`；顺序原因见该文件 19-24 行注释与
`permission.guard.ts:32-39`。 [已证实]

| 守卫 | 行为 |
|---|---|
| `AuthGuard` | `@Public()` 直接放行；否则读 Cookie → 查会话 → 重读账号状态 → 校验 `permissions_version` → 解析**有效权限**挂到 `request.authz` → 强制 MFA 检查。缺会话 `401 未登录`，无效会话 `401 会话已过期，请重新登录`。 `auth.guard.ts:68-187` |
| `PermissionGuard` | 读取路由元数据；**没有声明任何权限的路由只要求登录态**；声明了则逐条 `authz.require()`。`request.teacher` 缺失时**fail closed** 抛 `401` 并打 error 日志（视为接线错误，绝不当成"无需校验"）。 `permission.guard.ts:57-107` |

实测（本机运行中的实例，只读 GET，未改动任何状态）：
```
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/curriculum/structure
401
$ curl -s -H 'Cookie: qls_session=deadbeef' .../api/curriculum/structure
401 {"error":{"code":"UNAUTHORIZED","message":"会话已过期，请重新登录",...}}
```
[已证实，2026-09-24]

### 5.2 装饰器

| 装饰器 | 作用 | 位置 |
|---|---|---|
| `@Public()` | 跳过认证（登录、健康检查） | `auth.guard.ts:26-29` |
| `@RequirePermission('a','b')` | 声明的权限**全部**需要（AND）；由 `PermissionGuard` 执行 | `permission.decorator.ts:24-25` |
| `@RequireSuperAdmin()` | 比单个权限更严：断言账号**持有 `super_admin` 角色**（用于"管理超级管理员"这类操作） | `permission.decorator.ts:34` |
| `@MfaExempt()` | 允许"要求 MFA 但未绑定"的账号访问（仅 MFA/身份/登出/健康检查） | `permission.decorator.ts:76-77` |
| `@CurrentTeacher()` / `@CurrentAuthz()` | 注入当前用户 / 有效权限；`@CurrentAuthz` 明确标注**不是安全边界**，只是便利 | `auth.guard.ts:31-43`、`permission.decorator.ts:52-57` |

### 5.3 权限目录与有效权限

- **单一契约源** `shared/rbac.ts`：9 个角色（含 `super_admin`）、44 条权限、
  `ROLE_PERMISSIONS` 默认值、`ROLE_RANK`、`scopeSatisfies()`。见 [`RBAC.md`](RBAC.md)。
- 有效权限 = `(角色默认权限并集 ∪ 追加授权) − 显式禁止`，**deny 永远优先**；
  过期覆盖项被忽略。 `server/modules/authz/authorization.service.ts:88-170` [已证实]
- `assertRbacCatalogIntegrity()` 在启动/测试时断言目录完整性，违反即抛错。 [已证实]
- 角色等级 `ROLE_RANK` **只**用于"不得授予不低于自己等级的角色"这一条规则，
  不用来决定权限是否允许。 `shared/rbac.ts` 文件头注释 [已证实]

### 5.4 数据库层兜底（即使应用层有 bug 也守得住）

migration `0003` 装了三个触发器： [已证实，`0003_rbac_database_layer.sql`]

| 触发器 | 作用 |
|---|---|
| `trg_teachers_bump_permissions_version` 等 | 任何授权面变更 → `permissions_version += 1` |
| `trg_teachers_guard_super_admin` | 修改/删除 `super_admin` 行需要事务内声明
`set_config('app.rbac_actor_super_admin','on',true)`；**未声明视为不是**（fail closed）。
例外：本人改自己密码（不改 roles/status/username/email/name）允许 |
| `trg_teachers_protect_last_super_admin` | 拒绝删除/降级/停用**最后一名 active super_admin** |

> ⚠️ `set_config(..., true)` 是**事务级**的。跨 autocommit 语句会立即丢失，
> 因此应用侧所有超级管理员写入必须包在 `withSuperAdminAuthority()` 的显式事务里
> （`authorization.service.ts:59-66`），否则合法操作也会以 `42501` 失败。
> 这一点在 `tests/rbac-database.test.mjs` 中被实证并回归。 [已证实]

### 5.5 路由覆盖现状（含**仅认证**的路由 —— 它们**不是**未受保护）

**独立复核的计数**（我的方法：`grep -cE "^\s*@(Get|Post|Patch|Put|Delete)\(" server/modules/*/*.controller.ts`，
排除 `hello.controller.ts` —— 该文件**整体被注释掉**，是模板残留）：

| 指标 | 数量 |
|---|---|
| 活跃 controller | **9** |
| 路由处理器（decorator 计） | **42** |
| 声明了显式权限（`@RequirePermission` / `@RequireSuperAdmin`） | **23** |
| **仅要求认证**（无权限声明） | **19** |

[已证实，本次 grep 逐文件计数；末行的 `view.controller.ts` 是 SPA 兜底
`@Get(['/', '*'])`，一个 decorator 覆盖两个路径]

> ⚠️ **与 `evidence/authorization-coverage.txt` 的计数差异（如实记录）**：
> 那份审计报告写的是"40 路由 / 21 条显式权限 / 19 条仅认证"。
> 它的 **19** 与我的 **19** 一致，但 40/21 与我的 42/23 不同 ——
> 我复核该扫描的原始输出后发现它把 `resources.controller.ts` 的 `GET /:id`
> 重复计了 3 次（第 67/69/90 行，look-ahead 窗口造成），同时漏了几条。
> **结论方向一致（19 条仅认证），数字以本表为准。**

**这 19 条为什么是"仅认证"而不是"未加保护"**：
`AuthGuard` 与 `PermissionGuard` **都是** 全局 `APP_GUARD`
（`server/modules/auth/auth.module.ts`，按该顺序注册），
**除显式 `@Public()` 外每一条路由都要求有效会话**。
[已证实：`auth.module.ts` 源码 + 实测——未带会话访问 `/api/curriculum/structure` 返回 401]

| 分组 | 路由 | 为什么"仅认证"是对的 |
|---|---|---|
| 认证自助（13 条） | `POST login`、`mfa/verify`、`mfa/enroll`、`mfa/confirm`、`mfa/disable`、`mfa/recovery-codes`、`change-password`、`reset-password`、`logout`、`GET config`、`me`、`me/permissions`、`mfa/status` | 给它们加权限是**错的**：任何账号（哪怕一条权限都没有）都必须能改自己的口令、绑自己的 MFA、登出。`login` / `mfa/verify` 必须是 `@Public()`（调用方此刻没有会话） |
| 目录只读（3 条） | `curriculum/structure`、`folders`、`roles` | 静态目录数据，不含用户数据 |
| 仪表盘（2 条） | `dashboard/stats`、`recent` | 服务方法接收的是**调用者自己的** `teacher.id`，**无法**返回他人数据 |
| SPA 兜底（1 条） | `view.controller.ts` | 渲染前端外壳，本身不含数据 |

**仍然需要指出的一条真实不一致（§12 G-8）**：

**`POST /api/resources/:id/review`（审核通过/退回）声明的是 `review.view`**，
而不是 `review.approve` / `review.reject`
（`server/modules/review/review.controller.ts:40-41`，本次再次确认装饰器未变）。
该文件注释自称"approve 与 reject 现在是分开的权限"，但路由实际只要求 `review.view`。
**这只影响"谁能审核"，是一个权限粒度问题，不是未受保护**（仍要求认证 + `review.view`），
但**代码与自身注释不一致**，应按 `shared/rbac.ts` 的默认值复核后修正。

> **审计报告的对应结论（供对照）**：`evidence/authorization-coverage.txt` 的
> `A-1 [LOW, defence in depth]` —— dashboard / curriculum 依赖"仅认证"，
> **不存在可利用漏洞**（服务按调用者作用域），但**建议**显式声明权限以便审计与防未来重构走偏。
> 另一条 `A-2 [INFO]`：`server/modules/hello/` 是死代码，静态扫描会报出幻影路由，建议删除。

---

## 6. CSRF

| 项 | 实现 | 证据 |
|---|---|---|
| 中间件 | `CsrfCheckMiddleware`，仅作用于 `api/*` 的 **POST/PUT/PATCH/DELETE** | `server/app.module.ts:56-61` [已证实] |
| 机制 | **双提交（double-submit）**：Cookie `suda-csrf-token` 与请求头 `x-suda-csrf-token` 必须**字符串相等** | `server/modules/auth/csrf-check.middleware.ts:4-28` [已证实] |
| 安全方法 | `GET/HEAD/OPTIONS` 直接放行 | 同上 `:4,11-14` |
| 失败响应 | `403` + 纯文本（三态可区分：cookie 缺失 / header 缺失 / 不匹配） | 同上 `:16-28` [已证实] |
| 平台侧 | `PlatformModule.forRoot({ enableCsrf: false })` 关闭平台自带校验，改用上面的自建中间件；cookie 仍由平台中间件下发 | `server/app.module.ts:21`、`PRODUCTION_READINESS.md` §D-0/D-16 [已证实] |
| 前端注入 | axios 请求拦截器写 `X-Suda-Csrf-Token: window.csrfToken`；该值由 HBS 用平台下发的 token 渲染进产物 HTML | `PRODUCTION_READINESS.md` §D-0 第 3-4 步 [已证实] |

**本次实测（只读、无状态变更；打到不存在的路由，因此不产生任何业务写入）：**

```
POST /api/__nonexistent__                       → 403 Forbidden，csrf token not found in cookie.
POST /api/__nonexistent__ + Cookie only          → 403 Forbidden，csrf token not found in header.
POST /api/__nonexistent__ + Cookie≠Header        → 403 Forbidden，csrf token not match.
POST /api/__nonexistent__ + Cookie=Header        → 404（说明 CSRF 已放行，进入路由层）
```
[已证实，2026-09-24，对运行中实例 `127.0.0.1:3200`]

同时实测 `GET /` 的响应确实下发该 cookie，且属性与 `PRODUCTION_READINESS.md` §D-1 记录一致：
```
Set-Cookie: suda-csrf-token=<48hex>-<ts>; Max-Age=2592000; Path=/; Expires=...;
            Secure; Partitioned; SameSite=None
```
[已证实] ⚠️ 平台把该 cookie 硬编码为 `Secure; SameSite=None; Partitioned`，
**纯 HTTP 的本地开发环境浏览器会拒收**，导致本地写操作 403。
这不影响生产 HTTPS，但会让本地开发者误判为 bug（`PRODUCTION_READINESS.md` §D-1）。
`scripts/dev.sh:14-17` 已就此写了提示。

---

## 7. 审计日志

| 项 | 实现 | 证据 |
|---|---|---|
| 表 | `audit_logs`：`action`、`teacher_id`、`teacher_name`、`ip_address`、`user_agent`、`detail`、`success`、`error_message`、`resource_id`、`program`、`subject` | `server/database/schema.ts` |
| 登录路径覆盖 | 成功、失败、账号锁定、账号停用、无口令哈希、MFA 各阶段、改密、管理员重置、登出 | `auth.service.ts:266-714` [已证实] |
| 授权路径覆盖 | 下载被拒、越权尝试 | `PRODUCTION_READINESS.md` §A5 [已证实] |
| MFA 动作 | `mfa_challenge_issued` / `mfa_success` / `mfa_failed` / `mfa_enrolled` / `mfa_enabled` / `mfa_disabled` / `mfa_reset` / `mfa_recovery_used` / `mfa_recovery_regenerated` | `auth.service.ts:638-652` |
| 写失败处理 | `writeAuditLog()` catch 住并**打 error 日志**（不静默吞掉） | `auth.service.ts:745-751` [已证实] |

### 7.1 "append-only" 的**真实边界**（不要过度宣称）

migration `0005` 对**匿名角色**（`anon` 与 `anon_`）执行：
```sql
REVOKE ALL ON audit_logs FROM <role>;
GRANT SELECT, INSERT ON audit_logs TO <role>;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM <role>;
```
证据：`server/database/migrations/0005_tighten_rls_writes.sql:185-187` [已证实]

因此准确的表述是：

- **[已证实] 对匿名角色而言，审计日志在数据库层是 append-only** ——
  篡改会以 `42501` 失败，即使应用进程被攻陷也一样。
- **[已证实] 这不是全库性质**：migration `0004` 给 `authenticated_` 与 `service_role_`
  授予了 `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`（`0004_rls_role_alignment.sql:82`），
  这两个角色**仍可 UPDATE/DELETE 审计行**。它们只在会话校验通过后使用，
  但"审计不可篡改"不能声称对这些角色成立。
- **[已证实] 匿名角色是独立部署下每个请求实际采用的角色**（§8.2），
  所以这条控制在当前部署形态下是**生效的那一条**。

---

## 8. 数据库层：RLS 与角色

### 8.1 RLS 当前**不提供**行级保护

所有 policy 谓词都是 `USING (true)` / `WITH CHECK (true)`，且没有 `FORCE ROW LEVEL SECURITY`。
`PRODUCTION_READINESS.md` §D-4 [已证实]。
`0004` 与 `0005` 新加的 policy 同样采用 `USING (true)` —— **它们解决的是"角色名不匹配导致 0 行"，
不是"行级隔离"**。

> 结论：**行级隔离没有实现，也无法靠现有 policy 实现**。
> 真正的授权闸门是应用层的 `AuthGuard` + `PermissionGuard` + `AuthorizationService`（§5）。
> 这一点必须写进任何安全评审结论，不能声称"有 RLS 所以有行级安全"。

### 8.2 匿名角色的真实地位（关键发现，必须保留）

平台包 `@lark-apaas/nestjs-datapaas` 的 `SqlExecutionContextMiddleware` 对**每个请求**执行前置语句：

```sql
SET LOCAL app.user_id = '<userId>';
SET LOCAL ROLE 'anon_<roleSchema>' | 'authenticated_<roleSchema>' | 'service_role_<roleSchema>';
```

`<roleSchema>` 来自连接串的 `schema` 查询参数，**独立部署时为空**，
于是角色名变成 `anon_` / `authenticated_` / `service_role_`。 [已证实，`0004_rls_role_alignment.sql:5-34` 注释 + 该 migration 的实际内容]

后果（逐条，均有代码/实测依据）：

1. **`SET ROLE` 由平台的 `userContext.userId` 驱动，而该值在独立部署时为空**
   → **每个请求都跑在匿名角色下**，即使调用者已经登录并持有会话。
   `0005` 的文件注释把这个结论写得很直白：
   "in a standalone deployment every request runs under the anonymous database role,
   because the platform's `userContext.userId` (which drives SET ROLE) is only populated by
   the platform's own authentication. Database roles therefore cannot distinguish our
   authenticated users, and read access is gated by the application's authorization layer instead."
   （`0005_tighten_rls_writes.sql:179-184`）[已证实]
2. **因此数据库角色无法区分应用用户**，不能作为授权依据；
   应用层授权（§5）是**唯一**的实际闸门。
3. 这也解释了为什么 `0005` 把 `anon` 的读权限保留在表级而不是列级：
   收紧读会把正常页面打成 500，而安全收益接近零
   （因为登录查询本来就需要读 `password_hash`）。见 `0005:135-149` 的完整理由。 [已证实]

### 8.3 `0005` 实际收紧到什么程度（对匿名角色）

| 表 | 授权 | 证据 |
|---|---|---|
| `teachers` | `UPDATE` 仅限 `last_login_at, failed_login_attempts, locked_until`（列级）；`SELECT` 表级 | `0005:130-149` |
| `sessions` | `SELECT` 仅限 `id, session_hash, teacher_id, created_at, last_accessed_at, expires_at, revoked, permissions_version, revoked_at, revoke_reason, _created_at, _updated_at`；`INSERT` 表级；`UPDATE` 仅限 `revoked, revoked_at, revoke_reason, last_accessed_at, permissions_version` | `0005:152-168` |
| `audit_logs` | `SELECT, INSERT`；`UPDATE/DELETE/TRUNCATE` 显式 REVOKE | `0005:185-187` |

并带断言：若匿名角色仍能 `UPDATE teachers.password_hash` 或 `teachers.roles`，
migration 直接 `RAISE EXCEPTION`（`0005:197-237`）。 [已证实]

> 注意 `0005` 的两条"战伤记录"，写 migration 时容易再犯：
> ① 只重建未加后缀的 policy 会**静默删掉** `anon_` 的会话 UPDATE policy，
>    导致会话撤销 `42501`（`0005:74-79`）；
> ② 会话列级 SELECT 漏了 `id`，而 `destroySession()` 用了 `RETURNING id`，
>    表现为"任何权限变更后的第一个请求 500"（`0005:157-159`）。

### 8.4 平台角色的创建工作由 migration 承担

`init.sql` 中使用 `TO anon` / `TO authenticated` / `TO service_role`，
但仓库里**没有任何 `CREATE ROLE`**；`0001` 与 `0004` 分别补齐了
无后缀与带空后缀的两套角色（`0001:67-78`、`0004:60-71`）。 [已证实]

`0004` 之后，应用连接角色必须是这三个角色的**成员**，否则 `SET LOCAL ROLE` 失败：
```sql
GRANT anon_           TO <app_db_role>;
GRANT authenticated_  TO <app_db_role>;
GRANT service_role_   TO <app_db_role>;
```
（见 `0004_rls_role_alignment.sql:48-54`）。**部署时必须执行**，见
[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §6。

---

## 9. 客户端 IP 与 `trust proxy`

| 项 | 实现 | 证据 |
|---|---|---|
| 取值 | **只用 `req.ip`**（Express 推导），从不自己解析 `X-Forwarded-For` | `server/common/http/client-ip.ts:34-45` [已证实] |
| IPv4-mapped 归一 | `::ffff:203.0.113.7` → `203.0.113.7`，避免同一客户占两个限流桶 | 同上 `:39-42` |
| 配置解析 | `TRUST_PROXY`：未设置/`false` → `false`；`true` → `true`；纯整数 → 跳数；其余字符串按 Express 的地址/CIDR/关键字列表传递 | `client-ip.ts:68-80` [已证实] |
| **默认值** | **`false`（安全默认）**：忽略 `X-Forwarded-For`，`req.ip` 是不可伪造的 socket 地址 | `client-ip.ts:69-71` [已证实] |
| 设置时机 | **必须在 `configureApp()` 之后**调用 `app.set('trust proxy', …)` | `server/main.ts:34-61` [已证实] |
| 生产警告 | `TRUST_PROXY=true` 且 `NODE_ENV=production` 时启动日志打印明确警告 | `main.ts:81-87` [已证实] |

### 9.1 曾经的漏洞与根因（已修复，但原因值得记住）

修复前，3 处代码手工取 `x-forwarded-for.split(',')[0]` —— 即**客户端自己写的第一个值**。
实测：请求带 `X-Forwarded-For: 203.0.113.99, 10.0.0.1`，
`audit_logs.ip_address` 被记成 `203.0.113.99`（攻击者指定值）→ IP 限流可通过轮换 header 绕过、
审计无法归因。 [已证实，`PRODUCTION_READINESS.md` §Q-2]

**根因不在应用**：`configureApp()`（`@lark-apaas/fullstack-nestjs-core`）末尾执行
`app.set("trust proxy", true)`，**在此之前的设置会被静默丢弃**。
因此修复方式是把设置移到 `configureApp()` **之后**。修复后同样的伪造 header
被记录为 `127.0.0.1`（真实 socket 地址）。 [已证实，`PRODUCTION_READINESS.md` §Q-2]

> ⚠️ **部署侧必须遵守的规则（违反即回到漏洞状态）**：
> 1. 若应用**直接暴露**（前面没有代理）→ `TRUST_PROXY` 必须保持 `false`/不设。
> 2. 若前面有你自己控制的代理 → 设 `TRUST_PROXY=loopback`（代理在本机）或明确的 CIDR 列表，
>    **不要图省事设 `true`**。
> 3. 无论哪种情况，反向代理都必须**覆写**（而不是追加）入站的 `X-Forwarded-For`/`X-Real-IP`。
> 详见 [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §9。

---

## 10. 错误响应脱敏与安全响应头

### 10.1 错误响应

统一形状（`GlobalExceptionFilter`）：
```json
{"error":{"code":"…","message":"…","details":"…","requestId":"…","timestamp":…}}
```
证据：`server/common/filters/exception.filter.ts:48-131`；实测见 §6/§5.1 的 curl 输出。

| 分支 | 返回内容 | 证据 |
|---|---|---|
| 业务异常 / `HttpException` | `code` + `message`；`details` 为异常对象 JSON 字符串化 | `exception.filter.ts:51-77` |
| Postgres `22P02`（非法 UUID 等） | 归一为 `404 资源不存在`，避免 500 噪声 | `exception.filter.ts:78-93` |
| **未预期异常（5xx）** | **`INTERNAL_ERROR` + 「服务器内部错误」+ requestId**；`stack`/`cause` **仅当 `NODE_ENV !== 'production'`** 才附带 | `exception.filter.ts:94-128` [已证实] |

实测证据：`PRODUCTION_READINESS.md` §Q-3 记录了通过停掉 PostgreSQL 制造真实 500，
响应为通用信息、`LEAKS: NONE`。 [已证实，见该文档]
本次我只读复核了代码路径；**未再次制造 500**。

> 如实记录两点残留：
> 1. `details` 会把 Nest 异常对象 JSON 字符串化后返回（例如 `"Cannot POST /api/…"`），
>    其中包含被请求的路径。**不含 stack / SQL / 连接串**，但属于轻微信息暴露。
>    [已证实，本次 curl 实测输出]
> 2. `requestId` 的 header/body 一致性仍未解决，且 `exception.filter.ts:109` 在 5xx 分支内
>    **重新声明**了同名 `const requestId`，遮蔽了第 33 行取自 `res.locals` 的值，
>    因此 5xx 的 **body** 用的是 `req.requestId` 而 header（`exception.filter.ts:44-46`）用的是 `res.locals` 值。
>    [已证实：代码事实] [推断：两者在平台中间件改写 `req.requestId` 后可能不一致 ——
>    `PRODUCTION_READINESS.md` §Q-5 已实测观察到不一致] 见 §12 G-9。

### 10.2 安全响应头 —— **已实现并在线实测通过**

实现位置：`server/common/http/security-headers.middleware.ts`，
在 `server/main.ts` 中于 `configureApp()` **之后** `app.use(securityHeaders)`
（必须在之后：`configureApp()` 自己会 `app.set('trust proxy', true)`，
且 `app.use` 必须在 `app.listen()` 之前，否则 Nest 的路由已挂载完毕）。

**本次会话在线实测（重新构建并重启之后的实例）**：

```console
$ curl -sI http://127.0.0.1:3200/api/health
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
  frame-ancestors 'none'
x-request-id: 20f56862-…
x-log-trace-id: f65dc551-…
                        ← 不再有 X-Powered-By
```
[已证实，2026-09-24 本次会话实测]

| 项 | 行为 |
|---|---|
| **CSP** | **默认 report-only**（`CSP_MODE` 未设或为 `report-only`）；`enforce` 才真正拦截；`off`/`false`/`0` 不发该头。默认不 enforce 是**刻意的**：未经真实构建产物验证的强制 CSP 会导致整站白屏 |
| **HSTS** | 仅当 `HTTPS_ENABLED` 或 `TRUST_PROXY` 表明前面有 TLS 时发出（`max-age=15552000; includeSubDomains`，**不含 `preload`**）；纯 HTTP 下刻意不发 |
| `X-Frame-Options: DENY` + `frame-ancestors 'none'` | ⚠️ 与"平台 CSRF cookie 带 `Partitioned`（iframe 场景）"存在**设计冲突**，上线前须确认是否需被 iframe 嵌入（[`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) §9.2） |
| 验证套件 | `node scripts/verify-security-headers.mjs`；**整改前**对旧构建的评分是 **`pass=5 fail=15`**（`evidence/security-headers.txt`）—— 这个失败基线证明该套件不是空转；整改后同一构建 **20/20**（`evidence/gate-run-final.txt`） |

**整改前的真实状态（保留作为对照，说明这不是"本来就有"）**：应用**一个安全头都没有**，
并且用 `X-Powered-By: Express` 主动暴露框架（`evidence/security-headers.txt` BEFORE 节）。

**教训**：`dist/` 陈旧会造成"改了代码但线上没有"——
`dist/server/main.js` 的 mtime 早于 `server/main.ts`、且 `dist/server/common/http/` 里只有 `client-ip.js`。
**每次改动中间件都必须重新 `npm run build` + 重启 + `curl -sI` 复验。**

平台另外注入了 `X-Robots-Tag: noindex, nofollow` 与 `x-log-trace-id`
（后者与平台的 request-id 中间件并存，是 §12 G-9 那条 header/body 不一致的可能成因）。

---

## 11. 密钥与配置管理

### 11.1 必须由部署环境生成并保管的密钥

| 名称 | 用途 | 生成方式 | 缺省时的行为 |
|---|---|---|---|
| `MFA_ENCRYPTION_KEY` | AES-256-GCM 加密 TOTP 密钥 | `openssl rand -base64 32`（必须解出 32 字节） | **fail closed**：无法开始绑定、已启用 MFA 的账号登录失败 |
| `DOWNLOAD_TOKEN_SECRET`（写作期间新增） | HMAC-SHA256 签发下载令牌 | `openssl rand -base64 32`（**≥32 字节**） | **fail closed**：下载接口返回 503，**不会**发出无法签名的链接（`download-token.ts:92-116`） |
| 数据库连接串 | 应用与迁移 | 平台注入 `SUDA_DATABASE_URL` 或部署侧提供 `DATABASE_URL` | 应用无法查询任何数据；`/api/health/ready` 返回 503 |
| 会话/Cookie 相关 | `SESSION_COOKIE_NAME`、`SESSION_TTL_SECONDS` | 配置值，非密钥 | 有安全默认值（`qls_session` / 86400s） |
| 平台凭据（`FORCE_AUTHN_INNERAPI_DOMAIN` 等） | 妙搭平台集成 | 平台控制台 | **进程直接退出**（`PRODUCTION_READINESS.md` §O-1） |

> **会话本身不存在"签名密钥"**：会话是不透明随机令牌 + 服务端 SHA-256 存储，
> 没有 JWT、没有 HMAC 签名密钥。任何文档若提到"轮换会话签名密钥"都是误解 ——
> 应改为"轮换/失效全部会话"（见 `RUNBOOK.md` §6）。 [已证实：`session.service.ts` 全文]
>
> 但**下载令牌确实有签名密钥**（`DOWNLOAD_TOKEN_SECRET`），它的轮换是安全的
> （只影响默认 300 秒的短时链接），与 MFA 密钥的不可逆性完全不同。
> 两者的备份/轮换策略**必须分开**，见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) §3.3。

### 11.1.1 下载授权的新实现（写作期间落地，已读文件头/导出）

| 项 | 实现 | 证据 |
|---|---|---|
| 令牌形态 | `base64url(payload).base64url(hmac-sha256)`，payload 含 `resourceId` + `teacherId` + `exp` + `nonce` | `server/common/crypto/download-token.ts:16-30` [已证实] |
| 绑定 | 一个令牌只对一个资源 + 一个账号有效；`/api/files/download` 还要求会话的 teacherId 与令牌一致 | 同上 |
| 时效 | 默认 **300s**，硬上限 **3600s**；非正数配置直接报错 | `download-token.ts:57,63,138-149` |
| 服务端校验 | 常数时间比较（`timingSafeEqual`） | `download-token.ts:6,220+` |
| 实际直链 | 由平台 `FileService` 签名；平台存储不可用时返回 **503** 并说明原因，**不返回占位/伪造 URL** | `server/modules/files/files.service.ts:11-33` [已证实] |
| 路由与权限 | `GET /api/files/download`，`@RequirePermission('resource.download','storage.download')` | `server/modules/files/files.controller.ts:71,85,90` |
| 明确**不是**什么 | **不是加密**：payload 可被持有者读取（base64url），安全性来自 HMAC 不可伪造 + 会话绑定 + 短时效。不要把机密放进 payload | `download-token.ts:33-40` [已证实] |

> ⚠️ 我**只读了文件头与关键导出**，未做完整审阅，也**未运行**新增的
> `scripts/probe-file-validation.mjs` / `verify-security-headers.mjs`。
> 因此在验收前，这一项应标为"已实现、待独立复审"。 [已证实：文件内容]

### 11.2 密钥管理期望（部署方必须满足）

1. **不进仓库**。`.gitignore` 已包含 `.env` / `.env.*`（`PRODUCTION_READINESS.md` §D-3/O-6 记录了它此前缺失）。
   仍然必须人工确认：`git check-ignore -v .env`。
2. **由密钥管理系统注入**（妙搭平台密钥、KMS、Docker/K8s Secret），不要写进镜像或构建产物。
   ⚠️ `scripts/build.sh:214-218` 会把仓库根的 `.env` **复制进 dist 产物目录**，
   因此**构建机上的 `.env` 会被打包**。发布前必须确认产物里没有
   （`tar -tf dist.tgz | grep -x './.env'` 或等价检查），或干脆不在构建机上放 `.env`。
3. **`MFA_ENCRYPTION_KEY` 必须有备份且与数据库备份分开保存**。
   丢失它 = 所有已绑定 MFA 的账号（含 super_admin）无法登录，且恢复码无法使用；
   `mfa-crypto.ts:190-217` 明确拒绝"自动生成新密钥"这种会让所有人静默失效的做法。
4. **轮换需要计划**：当前 `teacher_mfa.secret_encrypted` 只带 `v1:` 版本前缀，
   没有"用旧密钥解密、新密钥加密"的双密钥读取路径，因此轮换必须离线进行。
   步骤见 `RUNBOOK.md` §7。
5. **凭证类字符串禁止进日志**。日志脱敏白名单化（`PRODUCTION_READINESS.md` §J-10 第 42 项）
   **尚未实现**，属于 §12 的缺口。

### 11.3 已知的硬编码秘密（必须处理）

- **`server/modules/auth/seed-teachers.ts:11-172` 中硬编码了 20 个生产账号的 scrypt 口令哈希**
  （`PRODUCTION_READINESS.md` §D-2，等级：高）。哈希不是明文，但哈希进仓库意味着：
  初始口令一旦在口令空间内被字典/暴力命中即失守；且这批哈希无法在不改代码的情况下轮换。
  **部署前必须做的**：确保这 20 个账号的口令已在首次登录后被修改，或直接停用/删除不需要的账号。
  该问题**未修复**。

---

## 12. 已知缺口 / 尚未实现（**不得在验收中说成已完成**）

| # | 缺口 | 现状与证据 | 风险 |
|---|---|---|---|
| G-1 | **限流为进程内 Map**，多实例下失效；Map 无清理会持续增长 | §2.4；`PRODUCTION_READINESS.md` §D-12、§R-4④ | 多副本时暴破防护被稀释 N 倍 |
| G-2 | **RLS 不提供行级保护**（全 `USING(true)`，无 `FORCE RLS`）。**且独立部署下每个请求都跑在匿名 DB 角色**，DB 角色无法区分应用用户 | §8.1、§8.2 | 应用层一旦出现越权漏洞，数据库层不会兜底 |
| G-3 | **文件链路：写入期间已部分落地，但未完整审阅**。旧的"未签名、无过期手拼 URL"实现已被替换为 `DOWNLOAD_TOKEN_SECRET` 签名的、**绑定 resourceId + teacherId + exp + nonce** 的令牌（默认 TTL 300s，硬上限 3600s，缺密钥 fail closed），实际直链由平台 `FileService` 签名；平台存储不可用时返回明确 503。**但**：`resources.dto.ts:164,168,218,222` 仍接受客户端传入的 `fileBucketId`/`filePath`（服务端生成 key 尚未确认），上传端仍是前端伪造坐标（`UploadPage.tsx:157-160` 的 `placeholder-bucket`），且我**未逐行审阅**新增的 `server/modules/files/*`、`server/common/files/file-validation.ts` | `server/common/crypto/download-token.ts`、`server/modules/files/files.{service,controller}.ts`（写作期间新增）；旧实现见 `PRODUCTION_READINESS.md` §B1-B3/§D-8 | 中（已显著降低；剩余为"服务端是否仍信任客户端存储坐标"与"新代码未经完整审阅"） |
| G-4 | **`getPublicDownloadUrl` / `getPublicStorybookCoverStream` 是不校验科目权限的死代码**，一旦被接上公开路由即权限失效 | `resources.service.ts:758,786`、`PRODUCTION_READINESS.md` §D-7 | 高（潜在） |
| G-5 | **没有 `whitelist` / `forbidNonWhitelisted`**。全局 `ValidationPipe` 确实存在（`PRODUCTION_READINESS.md` §Q-1 更正了此前判断），但未知字段**既不剥离也不拒绝** | `PRODUCTION_READINESS.md` §Q-1、§R-4① | mass-assignment 面 |
| G-6 | **无强制改密**：`mustChangePassword` 只被赋 `false`，前端不读该字段 | §2.2；`PRODUCTION_READINESS.md` §B4/C1 | 初始口令长期有效 |
| G-7 | **密码策略不完整**：无弱口令字典、无相似度校验、无历史口令、无有效期；**无渐进式 rehash**；哈希格式不含 keylen | §2.1、§2.2；`PRODUCTION_READINESS.md` §B5 | 中 |
| G-8 | 审核路由声明 `review.view` 而非 `review.approve`/`review.reject`，与同文件注释不一致 | §5.5-1；`review.controller.ts:40-41` | 需按 `shared/rbac.ts` 复核；可能放宽或收紧 |
| G-9 | `requestId` 的 header/body 一致性未解决；5xx 分支内变量遮蔽 | §10.1-2；`PRODUCTION_READINESS.md` §Q-5 | 低（可追溯性） |
| G-10 | **日志脱敏白名单未实现**（password / cookie / sessionId / MFA secret / recovery code / DSN / 存储密钥） | `PRODUCTION_READINESS.md` §J-10 第 42 项 | 中 |
| G-11 | **CORS 未收敛**：未配置到 `PUBLIC_APP_URL`，也未禁止 `*` + credentials | 同上 §J-10 第 43 项 | 中（取决于平台默认） |
| ~~G-12~~ | ~~安全响应头在运行实例中尚未生效~~ → **已闭环**：重新构建后实测全部响应头在线生效（含 CSP report-only、HSTS 条件发送、`X-Powered-By` 已移除），套件 20/20 通过。**CSP 仍为默认 report-only**（这是刻意选择，不是缺口） | §10.2；`evidence/security-headers.txt`、`evidence/gate-run-final.txt` | 已解决（CSP enforce 属待启用项，见 §10.2） |
| G-13 | **无多设备会话管理界面**：无管理员查询会话、无强制下线接口（`session.view`/`session.revoke` 权限已定义但无路由） | `PRODUCTION_READINESS.md` §B6、RBAC.md §4 | 中 |
| G-14 | **超级管理员账号的 MFA 恢复码丢失后无自助路径**，只能由另一名 super_admin 重置（而系统最多 2 名） | `RBAC.md` §3.1、`mfa.service.ts:267-274` | 高（可用性） |
| G-15 | **20 个生产账号哈希硬编码在源码** | §11.3 | 高 |
| G-16 | **构建产物会带上仓库根的 `.env`** | §11.2-2；`scripts/build.sh:214-218` | 高（若构建机有 `.env`） |
| G-17 | **`0005` 的列级收紧没有覆盖后来新建的 MFA 表**：匿名角色对 `teacher_mfa` / `mfa_recovery_codes` / `mfa_challenges`（以及 `account_permission_overrides` / `account_scopes`）**仍有 SELECT/INSERT/UPDATE/DELETE** | 本次实测 `has_table_privilege('anon_', '<表>', …)` 五张表四项全为 `true`。原因是 `0004` 的 `ALTER DEFAULT PRIVILEGES` 会作用于其后创建的表，而 `0005` 只处理了 `teachers`/`sessions`/`audit_logs` | 中：拿到应用连接级写权限者可**删除 `teacher_mfa` 行**，把非 super_admin 的账号降级为单因素（super_admin 则会因"要求 MFA 但未绑定"被 `AuthGuard` 全面拒绝 → 表现为 DoS 而非绕过）。**未修复**，建议按 `0005` 的方式对这 5 张表补列级授权 |
| G-18 | **`POST /api/auth/reset-password` 用的是硬编码角色判断而非权限声明**：`if (!operator.roles.includes('principal')) throw new NotFoundException()` | `auth.controller.ts:279-281` [已证实]。后果：① 与新的 `@RequirePermission('account.reset_password')` 体系不一致，`super_admin` 若**不同时持有 `principal`** 会被拒绝；② 返回 404 而非 403，语义上是"隐瞒存在性"，但会让运维排查困惑 | 中（一致性 + 运维可用性） |

### 明确"不是缺口"的项（避免无谓改造）

- CSRF 链路**实际可用**（§6，本次实测）。不需要重写，只需保证非平台部署时
  HBS 占位符仍被替换。
- 口令哈希处理（scrypt + `timingSafeEqual` + 随机 salt）、会话哈希存储、
  生产 `Secure` 强制、登录锁定、MFA 全套（含 challenge 落库）、
  `trust proxy` 修复、5xx 脱敏 —— **实现正确，保留**。

---

## 13. 负责任披露

**安全联系人与披露渠道：`[无法验证]` —— 仓库中不存在。**

我检查了仓库根的 `*.md` 与 `package.json`，**没有任何 SECURITY 联系人、
邮箱、bug bounty 或披露流程**。请在发布前填写下列占位并提交：

```
安全联系人 / Security contact : <待填写：姓名 + 邮箱（建议 security@<组织域名>）>
备用渠道 / Backup channel     : <待填写：电话或 IM>
响应时限 / Response SLA       : <待填写：例如 3 个工作日内确认>
```

处理期望（建议，需校方确认后生效）：

1. 收到报告后在 SLA 内确认收到，并给出临时缓解措施。
2. 不要求报告者签署 NDA 即可受理。
3. 修复后在 `RELEASE_NOTES.md` 中致谢（除非报告者要求匿名）。
4. **不要**在公开 issue 中讨论未修复漏洞。

> 本条是**未完成项**：在填写真实联系人之前，本系统不具备可用的外部披露渠道。

---

## 14. 本文档的验证方式

### 14.1 本次写作期间真实执行过的命令

| 命令 | 结果 |
|---|---|
| `SUDA_DATABASE_URL=… node scripts/migrate.mjs status` | 6 个 migration 全部 `applied`，`✓ No checksum drift.`，exit 0 |
| `node scripts/verify-api-contracts.mjs` | 38 条服务端路由 / 27 条客户端调用，全部匹配，exit 0 |
| `curl` 只读探测运行中实例（`/api/health`、`/api/health/ready`、`/`、`/api/curriculum/structure`） | 见 §5.1、§6、§10.2 |
| `curl` 对**不存在的路由**发 POST 验证 CSRF 四态 | 见 §6（不产生任何业务写入） |
| 直接查询本地 PostgreSQL（表结构、行数） | 见 [`MIGRATION_REPORT.md`](MIGRATION_REPORT.md) |

### 14.2 **未**执行的事（不得据本文档推断为已验证）

- 未运行 `npm test` / `scripts/verify-all.sh`（三个 HTTP 套件需要独占的 fixture 与运行中服务，
  同一工作区有另一个 agent 在改代码与跑测试，避免相互污染）。
- 未制造 500 复验脱敏（依赖 `PRODUCTION_READINESS.md` §Q-3 的既有实测）。
- **未在真实反向代理 / 真实 HTTPS 域名下验证 `trust proxy`、Cookie `Secure`、HSTS**
  （[无法验证]，本机无该环境）。
- **未验证妙搭平台的 dataloom 存储、vefaas 发布、`{{...}}` 占位符替换**
  （[无法验证]，无平台凭据）。
- **未对真实/生产数据库做备份或恢复演练**（见 [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)）。
  已做的是一次**本机逻辑往返演练**（12 表 / 902 行 / 行数与校验和一致），
  它**不涉及** `pg_dump`/`pg_restore`，也**不覆盖**生产库。 [已证实：`evidence/backup-restore-rehearsal.txt`]
- **未复跑**由另一个 agent 执行的套件与演练（`verify-all.sh`、`verify-seed-failure.sh`、
  `backup-rehearse.mjs`、回滚演练、安全响应头套件）——
  我**阅读了它们的原始日志**（`evidence/`）并据此引用，标注为"已证实：阅读日志"。

### 14.3 需要复验的动态项

- 安全响应头**已在本会话实测通过**（§10.2），G-12 已闭环；
  但每次改动中间件仍需**重新构建 + 重启 + `curl -sI` 复验**。
- 若在此之后代码继续变化，请以新代码为准并更新本文档；
  发布口径以 [`PRODUCTION_RELEASE_REPORT.md`](PRODUCTION_RELEASE_REPORT.md) 与 `evidence/` 为准。

---

*本文档只写代码里真实存在的控制。任何"已实现"的结论都必须附文件:行或实测输出。*
