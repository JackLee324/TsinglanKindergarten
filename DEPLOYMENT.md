# 清澜山幼儿园教师内部课程资源平台 - 部署指南

## 目录
1. [系统概述](#系统概述)
2. [技术架构](#技术架构)
3. [初始账号与密码管理](#初始账号与密码管理)
4. [环境变量配置](#环境变量配置)
5. [部署步骤](#部署步骤)
6. [数据库初始化](#数据库初始化)
7. [文件存储配置](#文件存储配置)
8. [HTTPS 要求](#https-要求)
9. [上线检查清单](#上线检查清单)
10. [会话与多实例部署](#会话与多实例部署)
11. [日常运维](#日常运维)
12. [安全说明](#安全说明)
13. [故障排查](#故障排查)

---

## 系统概述

清澜山幼儿园教师内部课程资源平台是一个仅供校内教师使用的课程资源管理系统。

### 核心功能
- 账号密码登录 + 首次登录强制改密（唯一登录方式）
- 基于角色的访问控制（RBAC）
- Pre-K / K 双轨课程资源管理
- 六类资料夹：课程大纲、周次教案、课件与示范、素材与工作单、观察与评价、教研归档
- 资源上传、审核、发布、归档全流程
- 受控文件下载（服务端权限校验）
- 审计日志（登录、访问、下载、审核、权限变更）
- 中英双语切换

### 角色定义
| 角色 | 说明 |
|------|------|
| 园长/平台管理员 (principal) | 全部权限，管理教师和权限 |
| 教学主任/教研主管 (curriculum_director) | 审核发布、全部课程查看、教师权限分配 |
| Pre-K 主教 (prek_head) | Pre-K 全部科目上传与提交审核 |
| K 主教 (k_head) | K 全部科目上传与提交审核 |
| 体能专科教师 (pe_specialist) | 体能类科目上传与提交审核 |
| Pre-K 配班/代课 (prek_assistant) | Pre-K 课程只读 |
| K 配班 (k_assistant) | K 课程只读 |
| 普通访客/家长 (visitor) | 不能进入课程内容 |

---

## 技术架构

- **前端**：React 19 + TypeScript + Tailwind CSS + shadcn/ui
- **后端**：NestJS 10 + TypeScript + Drizzle ORM
- **数据库**：PostgreSQL
- **认证**：账号密码 + scrypt 哈希 + HttpOnly Cookie 会话
- **文件存储**：dataloom 对象存储
- **部署形态**：妙搭全栈应用平台

---

## 初始账号与密码管理

### 1. 初始账号 Seed 机制
系统首次启动时，会自动创建 20 个初始教师账号（**幂等**，仅插入不存在的账号，不会覆盖已修改的密码或已调整的角色）。

- 所有账号初始密码由系统随机生成，首次登录后**强制修改**
- 初始密码通过安全渠道分发给各教师（建议由管理员统一打印或使用企业私聊一对一发送）
- 管理员可在「教师管理」页面为任意教师重置密码
- 已修改过密码的账号不会被 seed 覆盖

### 2. 密码规则
- 长度 **≥ 10 位**
- 必须包含：**大写字母 + 小写字母 + 数字**
- 不含特殊符号强制要求（兼容记忆习惯）
- 不得与最近 5 次历史密码重复
- 密码有效期：180 天，到期前 7 天提示修改

### 3. 账号锁定策略
- 连续失败 **5 次** 自动锁定
- 锁定时长：**15 分钟**
- 锁定期间即使输入正确密码也无法登录
- 管理员可在「教师管理」页面手动解除锁定
- 所有失败尝试和锁定事件均写入审计日志

### 4. 管理员密码重置
- 拥有 `principal` 或 `curriculum_director` 角色的管理员可在「教师管理」页重置任意教师密码
- 重置后该账号下次登录时**强制修改**新密码
- 重置操作记录审计日志（操作人、被重置人、时间）

### 5. 初始账号列表
| 用户名 | 角色 | 中文名 |
|--------|------|--------|
| qlsadmin | principal | 园长/平台管理员 |
| qlsdirector | curriculum_director | 教学主任/教研主管 |
| prek-head01 | prek_head | Pre-K主教01 |
| prek-head02 | prek_head | Pre-K主教02 |
| prek-head03 | prek_head | Pre-K主教03 |
| prek-teacher01 | prek_assistant | Pre-K教师01 |
| prek-teacher02 | prek_assistant | Pre-K教师02 |
| prek-teacher03 | prek_assistant | Pre-K教师03 |
| prek-teacher04 | prek_assistant | Pre-K教师04 |
| k-head01 | k_head | K主教01 |
| k-head02 | k_head | K主教02 |
| k-head03 | k_head | K主教03 |
| k-teacher01 | k_assistant | K教师01 |
| k-teacher02 | k_assistant | K教师02 |
| k-teacher03 | k_assistant | K教师03 |
| k-teacher04 | k_assistant | K教师04 |
| pe-teacher01 | pe_specialist | 体能教师01 |
| pe-teacher02 | pe_specialist | 体能教师02 |
| pe-teacher03 | pe_specialist | 体能教师03 |
| pe-teacher04 | pe_specialist | 体能教师04 |

> 初始密码以 scrypt 哈希形式预置在服务端代码中，数据库不存储明文。
> 20 个初始账号的明文密码由管理员通过安全渠道（打印分发 / 企业私聊一对一）交付给各教师，**不得写入代码仓库或配置文件**。
> 教师首次登录后强制修改密码。

---

## 环境变量配置

复制 `.env.example` 为 `.env` 并填入以下必填项：

```bash
# 会话 Cookie 名称（可选，默认 qls_session）
SESSION_COOKIE_NAME=qls_session

# 会话有效期，单位秒（可选，默认 86400 = 24 小时）
SESSION_TTL_SECONDS=86400

# 生产环境必须为 true
HTTPS_ENABLED=true
```

> ⚠️ **安全提示**：生产环境下 `HTTPS_ENABLED=true` 时，Cookie 强制开启 `Secure` 属性，
> 仅允许通过 HTTPS 传输，防止中间人攻击窃取会话。

---

## 部署步骤

### 第一步：准备工作
1. 已配置 HTTPS 证书
2. 确认数据库实例已创建（妙搭平台默认提供）
3. 确认文件存储 bucket 已创建

### 第二步：配置环境变量
1. 复制 `.env.example` 为 `.env`
2. 根据需要调整 `SESSION_COOKIE_NAME` 和 `SESSION_TTL_SECONDS`
3. 设置 `HTTPS_ENABLED=true`（生产环境）

### 第三步：数据库初始化
1. 确保数据库实例已创建（妙搭平台默认提供）
2. 执行初始化 SQL 创建业务表：
   ```bash
   miaoda db sql "$(cat server/database/init.sql)"
   ```
3. 启动应用后，20 个初始账号会自动 seed 创建（幂等，不覆盖已修改密码）
4. 初始管理员账号 `qlsadmin` 角色为 `principal`（园长/平台管理员）
5. 管理员登录后，可在管理后台添加更多教师并分配权限

### 第四步：首次登录
1. 访问应用主页
2. 使用初始账号密码登录
3. 首次登录会强制跳转至修改密码页面
4. 设置新密码后进入系统
5. 种子管理员登录后进入「管理后台」添加教师

### 第五步：添加教师
1. 管理员登录后，进入「管理后台」→「教师管理」
2. 点击「添加教师」
3. 填写教师的用户名、姓名、角色，设置初始密码
4. 在「权限管理」中配置科目级权限
5. 将初始密码分发给教师，教师首次登录后强制改密

---

## 数据库初始化

### 数据表清单
| 表名 | 说明 |
|------|------|
| teachers | 教师账号表（用户名、姓名、角色、状态、scrypt 密码哈希） |
| subject_permissions | 教师-班型-科目权限表 |
| resources | 资源元数据表（标题、班型、科目、资料夹、状态、文件信息） |
| review_records | 审核记录表（审核人、动作、意见） |
| audit_logs | 审计日志表（登录、访问、下载、权限变更等） |
| sessions | 会话表（持久化登录态，HttpOnly Cookie 仅存 session id） |

所有表均启用 PostgreSQL Row Level Security (RLS)，默认 policy 由平台管理。

### 首次建表
本项目使用妙搭平台数据库管理，建表命令：

```bash
# 执行初始化 SQL（6 张业务表 + 索引 + RLS policy）
miaoda db sql "$(cat server/database/init.sql)"

# 或直接运行初始化脚本
miaoda db sql -f server/database/init.sql
```

> 也可以在妙搭开发控制台的数据库管理界面中手动执行 `server/database/init.sql` 的内容。

### 课程初始化数据（Seed）
系统内置课程大纲等结构化初始数据，确保平台上线后课程内容立即可见，无需教师从零上传。

```bash
# 执行课程 seed（教师、科目权限、课程大纲资源，全部幂等可重复执行）
miaoda db sql -f server/database/seed-curriculum.sql
```

Seed 内容包括：
- 20 名初始教师（覆盖全部 8 种角色）
- 各角色默认科目权限
- Pre-K 美德课程（9 个真实主题 + 1 个预留主题）
- Pre-K 蒙特梭利基础框架（日常 / 感官 / 数学 / 中文语言 / 文化 目录结构，详细工作条目待补充）
- Pre-K 蒙特梭利英文语言区（39 个教学周 + 3 个假期/校历列，共 42 列）
- K 英文（6 个 Big Unit Theme + 38 个周/总结条目）
- K 中文、Pre-K / K 体能课程目录结构
- 六类资料夹标准结构

> 所有源表缺失内容在界面上显示为「待补充 / Not filled in source」，不会编造内容。
> 第 20 本 Pre-Decodable Booklet 因源 PDF 裁切，标题保持待补。

### RLS Policy 角色名修复（可选）
部分平台环境的数据库角色名带 workspace 后缀（如 `authenticated_workspace_xxx`），
而 init.sql 使用标准角色名 `authenticated` / `service_role` / `anon`。

**症状**：后端 API 返回 `42501 permission denied`，数据库日志显示 RLS policy 不匹配。

**修复方式**：

```bash
# 先确认当前环境的角色名
miaoda db sql "SELECT rolname FROM pg_roles WHERE rolname LIKE 'authenticated%' OR rolname LIKE 'service_role%' OR rolname LIKE 'anon%' ORDER BY rolname;"

# 如果角色名带 workspace 后缀，执行修复脚本
# 注意：先编辑 fix-rls-policies.sql 顶部的 auth_role / srv_role / anon_role 变量
miaoda db sql -f server/database/fix-rls-policies.sql
```

### 表结构变更
后续结构变更使用 `miaoda db sql` 执行相应的 ALTER TABLE / CREATE INDEX 语句，然后运行 `npm run db:codegen` 更新 `server/database/schema.ts`。

```bash
# 执行 DDL 变更
miaoda db sql "ALTER TABLE resources ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;"

# 更新 schema.ts
npm run db:codegen
```

### 初始账号 Seed
首次启动时，系统会自动创建 20 个初始教师账号（幂等），角色覆盖 principal、curriculum_director、prek_head、prek_assistant、k_head、k_assistant、pe_specialist。

- 初始密码由系统随机生成，写入服务端启动日志
- 首次登录强制修改密码
- 已修改过密码的账号不会被重新覆盖

---

## 文件存储配置

### 存储方案
使用 dataloom 对象存储服务。文件不是公开访问的，下载必须经过服务端权限校验。

### 安全特性
- 文件不放在可匿名访问的公共静态目录
- 下载前服务端校验会话和科目权限
- 下载链接为临时签名 URL，有过期时间
- 所有下载操作记录审计日志

### 封面图资源迁移
Pre-K 蒙特梭利英文语言区包含 34 张 Weekly Storybook 封面图，**已随应用版本内置**，无需校方手工提供。

- **存储方式**：版本化静态资源，位于 `server/assets/prek-english-covers/`
- **访问方式**：通过服务端受控接口 `GET /api/resources/:id/storybook-cover/:index` 读取
- **权限控制**：复用资源权限体系（登录态 + 科目权限 + 发布状态校验），未登录返回 401，无科目权限返回 403
- **构建配置**：`nest-cli.json` 已配置 assets 规则，构建时自动打包进 dist

封面书名待核对标注：部分封面图在源 HTML 中可看到但书名缺失，seed 数据中已保留 `note: "Cover is visible in the source table; title needs verification."` 标注，**禁止根据封面图像猜测书名**，需校方核对后补充。

---

## HTTPS 要求

### 必须使用 HTTPS
账号密码登录和会话 Cookie 的 `Secure` 属性仅在 HTTPS 下生效。生产环境必须启用 HTTPS。

### Cookie 安全属性
- `HttpOnly`：禁止 JavaScript 读取，防止 XSS 窃取 ✅
- `Secure`：生产环境（NODE_ENV=production）默认开启；
  仅当 `HTTPS_ENABLED=false` 且非生产环境时关闭 Secure。
  生产环境下即使误设 `HTTPS_ENABLED=false`，Secure 仍然强制开启。
- `SameSite=None`：生产环境 `HTTPS_ENABLED=true` 时，Cookie 设置为 `SameSite=None`，
  适配 iframe 嵌入和跨站访问场景；非 HTTPS 环境回退为 `SameSite=Lax`。
- Cookie 名称由 `SESSION_COOKIE_NAME` 环境变量配置，默认 `qls_session`
- 有效期由 `SESSION_TTL_SECONDS` 配置，默认 86400 秒（24 小时）

> ⚠️ **iframe / 跨站嵌入说明**：若平台需要嵌入到企业微信、飞书、学校门户等第三方 iframe 中，
> 必须确保 `HTTPS_ENABLED=true`，此时 Cookie 同时携带 `Secure` 和 `SameSite=None`，
> 第三方站点的 iframe 内才能正常携带会话 Cookie。

---

## 上线检查清单

### 账号密码检查
- [ ] 20 个初始账号已成功 seed 创建
- [ ] 初始密码已通过安全渠道分发给对应教师
- [ ] 管理员账号 `qlsadmin` 已修改初始密码
- [ ] 密码规则验证：≥10位、含大写、含小写、含数字
- [ ] 锁定策略验证：连续输错 5 次后账号锁定 15 分钟
- [ ] 管理员可手动解除锁定
- [ ] 管理员可重置教师密码，重置后下次登录强制改密
- [ ] 首次登录强制跳转改密页面

### 环境变量检查
- [ ] `HTTPS_ENABLED=true`（生产环境 Secure 强制开启）
- [ ] `SESSION_COOKIE_NAME=qls_session`（确认与环境一致）
- [ ] `SESSION_TTL_SECONDS` 已按需求配置（默认 86400）

### 安全检查
- [ ] Cookie 为 HttpOnly + Secure + SameSite=None（HTTPS 环境）
- [ ] 密码使用 scrypt 哈希存储，数据库中无明文密码
- [ ] 未授权用户访问受保护 API 返回 401
- [ ] 无权限用户访问课程 API 返回 403
- [ ] 文件下载必须经过权限校验
- [ ] 审计日志正常记录登录成功、登录失败、锁定、改密、重置密码等操作
- [ ] 连续失败 5 次后账号确实被锁定

### 功能检查
- [ ] 账号密码登录流程正常
- [ ] 初始管理员可登录并已改密
- [ ] 首次登录强制改密功能正常
- [ ] 教师添加和权限分配功能正常
- [ ] 管理员重置密码功能正常
- [ ] 资源上传、提交审核、审核发布流程正常
- [ ] 不同角色看到的菜单和数据正确
- [ ] 中英文切换正常
- [ ] 文件下载功能正常
- [ ] 审计日志可查看

### 备份与运维
- [ ] 数据库定期备份策略已配置
- [ ] 文件存储备份方案已确认
- [ ] 审计日志保留周期已设定
- [ ] 监控告警已配置
- [ ] 会话表定期清理已配置

---

## 会话与多实例部署

### 持久化会话存储
- 会话存储在数据库 `sessions` 表中，不使用内存 Map
- 支持多实例部署，服务重启后登录态不丢失
- Cookie 仅保存不透明 session id（服务端以 SHA-256 哈希存储）
- 服务端支持：查询、续期、注销、过期清理
- 退出登录会将服务端会话标记为已撤销（revoked=true），立即失效

### 会话表字段
| 字段 | 说明 |
|------|------|
| session_hash | session id 的 SHA-256 哈希（唯一索引） |
| teacher_id | 关联教师 ID |
| created_at | 创建时间 |
| last_accessed_at | 最后访问时间（每次有效请求更新） |
| expires_at | 过期时间 |
| revoked | 是否已撤销 |
| ip_address | 登录 IP（如可用） |
| user_agent | 浏览器 User-Agent（如可用） |

### 审计与清理
- 登录、退出、会话过期、无效会话均写入 `audit_logs` 表
- 后端定期清理已过期和已撤销的会话记录
- Cookie 保留 HttpOnly、Secure、SameSite=None（HTTPS）安全属性

---

## 日常运维

### 教师管理
- 新教师入职：管理员在后台添加教师并分配角色和权限，设置初始密码
- 教师离职：将教师状态设为「停用」（软删除，保留历史数据）
- 角色调整：在教师管理页编辑角色
- 权限调整：在权限管理页调整科目级权限
- 忘记密码：管理员在教师管理页重置密码，教师首次登录强制改密
- 账号锁定：管理员可手动解除锁定，或等待 15 分钟自动解锁

### 资源管理
- 教师上传资源 → 保存草稿 → 提交审核
- 教学主任审核 → 通过（发布）或 退回（附原因）
- 已发布资源全校授权教师可见
- 资源版本管理（可更新新版本）

### 审计日志
- 管理员可在「审计日志」页面查看全部操作记录
- 可按动作类型、教师、班型、日期范围筛选
- 记录包括：登录成功、登录失败、登出、账号锁定、密码修改、密码重置、资源上传/下载/编辑/审核、权限变更、教师创建/更新、权限拒绝

---

## 安全说明

### 认证安全
- 唯一登录方式：账号密码
- 不开放自助注册，只有管理员创建的教师账号才能登录
- 密码使用 **scrypt** 算法哈希存储，参数：`N=16384, r=8, p=1`，输出 32 字节密钥
- 数据库中仅存储 scrypt 哈希值 + salt，绝不明文存储密码
- 连续失败 5 次锁定 15 分钟，防止暴力破解
- 首次登录强制修改密码，避免初始密码泄露风险
- 会话使用 HttpOnly Cookie，防止 XSS 窃取

### 权限安全
- 所有受保护 API 在服务端校验登录状态
- 课程 API 和文件下载在服务端校验科目权限
- 前端仅做 UI 隐藏，不替代服务端鉴权
- 未登录返回 401，无权限返回 403

### 数据安全
- 密码哈希仅存在于服务端数据库，salt 与哈希值一同存储
- 文件不公开访问，下载必须经过权限校验
- 所有敏感操作记录审计日志
- 操作人、IP、时间、结果全量记录

---

## 故障排查

### 登录失败 - 用户名或密码错误
1. 确认用户名拼写正确（区分大小写）
2. 确认密码输入正确，注意大小写和中英文输入法
3. 检查教师账号状态是否为「启用」
4. 查看服务端日志获取失败原因（密码错误 / 用户不存在 / 账号已停用）
5. 若为首次登录，确认使用的是初始密码而非分发后的新密码

### 账号被锁定
1. 确认是否连续输错 5 次导致锁定
2. 等待 15 分钟后自动解锁，或联系管理员手动解除锁定
3. 管理员可在「教师管理」页面查看锁定状态并手动解锁
4. 查看审计日志中的失败登录记录，排查是否存在暴力破解尝试

### 首次登录不跳改密页面
1. 确认账号的 `must_change_password` 标志是否为 true
2. 检查前端路由是否正常跳转至 `/change-password`
3. 清除浏览器缓存和 Cookie 后重新尝试
4. 查看服务端登录接口返回的 `mustChangePassword` 字段

### 忘记密码 / 重置密码不生效
1. 管理员在「教师管理」页面确认重置操作成功
2. 确认被重置账号使用的是管理员提供的**新临时密码**，而非旧密码
3. 重置后首次登录仍会强制改密，确认是否在改密页面输入的新密码符合规则
4. 查看审计日志中的 `password_reset` 记录

### 密码不符合规则被拒绝
1. 确认密码长度 ≥ 10 位
2. 确认包含大写字母（A-Z）
3. 确认包含小写字母（a-z）
4. 确认包含数字（0-9）
5. 确认未使用最近 5 次历史密码

### 权限不对
1. 检查教师角色是否正确
2. 检查科目权限配置
3. 部分角色（prek_head、k_head 等）有自动授予的权限
4. 查看审计日志中的权限拒绝记录

### 文件下载失败
1. 检查是否有该科目的查看权限
2. 检查文件是否已发布（草稿/待审核状态其他人不可见）
3. 查看服务端日志和审计日志

### 页面白屏
1. 打开浏览器控制台查看错误
2. 检查网络请求是否有 401/403/500
3. 确认后端服务是否正常运行
