#!/usr/bin/env bash
# =============================================================================
# TsinglanKindergarten — Container Entrypoint
# =============================================================================
set -e

# 1. 规范化环境变量 / Normalize Environment Variables
# 兼容 Zeabur (POSTGRES_CONNECTION_STRING / POSTGRES_URI) 与通用 DATABASE_URL
DB_CONN="${DATABASE_URL:-${POSTGRES_CONNECTION_STRING:-${POSTGRES_URI:-${SUDA_DATABASE_URL:-}}}}"
export DATABASE_URL="$DB_CONN"
export SUDA_DATABASE_URL="$DB_CONN"
export FORCE_AUTHN_INNERAPI_DOMAIN="${FORCE_AUTHN_INNERAPI_DOMAIN:-https://127.0.0.1:1}"
export SERVER_HOST="${SERVER_HOST:-0.0.0.0}"
export SERVER_PORT="${SERVER_PORT:-3000}"
export NODE_ENV="${NODE_ENV:-production}"

# 如果部署在 PaaS 未配置特定密钥，自动生成默认临时密钥保障启动可用
if [ -z "${MFA_ENCRYPTION_KEY:-}" ]; then
  echo "[entrypoint] ⚠️ MFA_ENCRYPTION_KEY 未配置，生成随机 32 字节密钥供本次运行使用..."
  export MFA_ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
fi

if [ -z "${DOWNLOAD_TOKEN_SECRET:-}" ]; then
  echo "[entrypoint] ⚠️ DOWNLOAD_TOKEN_SECRET 未配置，生成随机 32 字节密钥供本次运行使用..."
  export DOWNLOAD_TOKEN_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
fi

# 2. 自动检查数据库并执行初始化 / 迁移
if [ -n "${DATABASE_URL:-}" ] || [ -n "${SUDA_DATABASE_URL:-}" ]; then
  echo "[entrypoint] 正在检查数据库状态与迁移..."
  # 优先尝试从零初始化；若已有表，则执行增量迁移
  node /app/scripts/db-bootstrap.mjs >/dev/null 2>&1 || node /app/scripts/migrate.mjs up || true
  
  # 若配置了初始管理员密码，自动创建超级管理员账号
  if [ -n "${INITIAL_ADMIN_PASSWORD:-}" ]; then
    ADMIN_USER="${INITIAL_ADMIN_USER:-TsinglanAdmin}"
    echo "[entrypoint] 正在初始化超级管理员账号: ${ADMIN_USER}..."
    node /app/scripts/provision-super-admin.mjs \
      --username "${ADMIN_USER}" \
      --password "${INITIAL_ADMIN_PASSWORD}" \
      --name '系统超级管理员' \
      --yes-create-account || true
  fi
fi

# 3. 启动主服务
echo "[entrypoint] 正在启动 TsinglanKindergarten 服务 (端口 ${SERVER_PORT})..."
cd /app/dist
exec "$@"
