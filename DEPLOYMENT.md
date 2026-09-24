# DEPLOYMENT.md（已归档）

> **本文档已归档，请勿据此部署。**
>
> 生产部署的权威文档是 **`DEPLOYMENT_PRODUCTION.md`**。本文档保留的仅有妙搭平台
> 相关的历史说明，且早于本次生产加固，其中的环境变量、`dist/` 启动路径、
> 数据库构建流程与上传/下载鉴权模型**均已过时**。

## 请改用

| 需求 | 文档 |
|---|---|
| 生产部署完整步骤、必需环境变量 | `DEPLOYMENT_PRODUCTION.md` |
| 数据库迁移与回滚 | `MIGRATION.md` |
| 备份与恢复（含尚未执行的演练） | `DISASTER_RECOVERY.md` |
| 日常运维、排障、密钥轮换 | `RUNBOOK.md` |
| 安全模型与已知缺口 | `SECURITY.md` |
| 发布闸门与阻塞项 | `PRODUCTION_RELEASE_REPORT.md` |

## 三个最容易踩的坑

1. **从零建库**：`init.sql` 与迁移 `0001` **互为前提**，单独执行任一都会失败。
   必须用 `bash scripts/db-bootstrap.mjs --url "$DATABASE_URL"`。
2. **`trust proxy`**：平台 `configureApp()` 会硬编码 `app.set('trust proxy', true)`，
   因此应用必须在**其后**再设置一次，否则 `X-Forwarded-For` 可被伪造，
   客户端 IP 与 `audit_logs.ip_address` 全部失真，按 IP 的登录限流也可被绕过。
3. **必需密钥**：`MFA_ENCRYPTION_KEY` 与 `DOWNLOAD_TOKEN_SECRET` 缺失时对应功能
   **明确失败**（不会退化成无签名链接或明文存储）。各用 `openssl rand -base64 32`
   生成，两者不可复用。

原文不再保留：其中包含与新文档冲突的可执行指令，保留会造成误用。
