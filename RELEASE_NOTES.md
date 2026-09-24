# RELEASE NOTES

## v1.3.0 — 账号密码登录 + auth/me 静默 401 修复

### 发布日期
2026-09-22

### 登录方式
- **账号密码登录**（独立账号体系，非企业微信）
- 会话基于 HttpOnly + Secure + SameSite Cookie
- **不强制改密**（`must_change_password = false`）

### 账号与角色分布（共 20 个账号）

| 角色 | 数量 | 说明 |
|------|------|------|
| principal (园长/管理员) | 1 | qlsadmin — 全部权限、教师管理、审计 |
| curriculum_director (教学主任) | 1 | 全部课程查看、审核发布、权限分配 |
| prek_head (Pre-K 主教) | 2 | Pre-K 全部科目上传、提交审核 |
| k_head (K 主教) | 2 | K 全部科目上传、提交审核 |
| pe_specialist (体能专科) | 2 | 体能类科目上传、提交审核 |
| prek_assistant (Pre-K 配班) | 6 | Pre-K 只读 |
| k_assistant (K 配班) | 6 | K 只读 |

> 初始密码通过线下安全渠道分发，源码包中仅含 scrypt hash。

### 课程资源统计

| 指标 | 数值 |
|------|------|
| Pre-K 已发布资源总数 | 303 |
| K 已发布资源总数 | 44 |
| Pre-K 英文绘本封面素材 | 34 张 |

### 本次修复

**问题**：未登录状态下打开登录页，`GET /api/auth/me` 返回 401 时，前端将其作为 error 级别日志打印，用户看到"请求失败"提示。

**修复**：
1. `getMe()` 接口调用对 401 响应静默处理，返回 `null` 而非抛出错误
2. `handleApiError` 中 401 分支日志级别从 `warn` 降为 `debug`，避免在日志面板高亮为错误
3. 非 401 的网络/服务器错误仍正常显示错误提示并保留登录态（不清空）
4. `AuthProvider` 适配 `getMe()` 返回 `null` 的情况，未登录即为正常初始状态

**验证结果**：
- 未登录打开根路径：登录页正常渲染，无错误提示、无白屏、无闪退 ✅
- 手机视口未登录：同样正常 ✅

### 技术栈
- 前端：React 19 + TypeScript + Tailwind CSS + shadcn/ui
- 后端：NestJS 10 + Drizzle ORM + PostgreSQL
- 认证：账号密码 + scrypt hash + HttpOnly Cookie Session
- 双语：中文（zh-CN）/ 英文（en-US）
- 文件存储：dataloom storage + 服务端权限校验代理下载
