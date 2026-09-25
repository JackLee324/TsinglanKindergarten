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
export SERVER_PORT="${PORT:-${SERVER_PORT:-3000}}"
export PORT="${SERVER_PORT}"
export NODE_ENV="${NODE_ENV:-production}"

# 1. 必需密钥 —— 缺失即拒绝启动，绝不随机生成
# ---------------------------------------------------------------------------
# 这里以前会在缺失时生成一次性随机密钥。那是个严重的生产缺陷：
#   * MFA_ENCRYPTION_KEY 每次启动都变 => 所有已绑定的 TOTP 密钥无法解密
#     => 那些账号 fail closed，永久无法登录（而且你再也登不进去重新绑定）。
#     PaaS 每次部署都重启，等于"今天绑好，明天锁死"。
#   * DOWNLOAD_TOKEN_SECRET 每次启动都变 => 所有已签发的下载链接立即失效。
# 正确做法：由部署环境生成一次并永久固定，缺失时明确失败。
require_env() {
  eval "_val=\${$1:-}"
  if [ -z "$_val" ]; then
    echo "[entrypoint] ✗ 缺少必需的环境变量: $1" >&2
    echo "[entrypoint]   $2" >&2
    echo "[entrypoint]   拒绝启动：与其带着错误的密钥跑起来，不如明确失败。" >&2
    exit 1
  fi
}
require_env MFA_ENCRYPTION_KEY "生成一次并永久固定：openssl rand -base64 32（换键 = 所有 MFA 账号永久锁死）"
require_env DOWNLOAD_TOKEN_SECRET "生成一次并永久固定：openssl rand -base64 32"

# 2. 自动检查数据库并执行初始化 / 迁移
if [ -n "${DATABASE_URL:-}" ] || [ -n "${SUDA_DATABASE_URL:-}" ]; then
  echo "[entrypoint] 正在检查数据库状态与迁移..."
  # 优先尝试从零初始化；若已有表，则执行增量迁移
  # 优先尝试从零初始化；若库已存在（bootstrap 会主动拒绝），则走增量迁移。
  # 两者都失败 => 明确拒绝启动，绝不带一个未迁移的库对外服务。
  if node /app/scripts/db-bootstrap.mjs >/dev/null 2>&1; then
    echo "[entrypoint] ✓ 数据库已从零初始化并完成迁移"
  elif node /app/scripts/migrate.mjs up; then
    echo "[entrypoint] ✓ 数据库增量迁移完成"
  else
    echo "[entrypoint] ✗ 数据库迁移失败，拒绝启动。" >&2
    echo "[entrypoint]   请检查 SUDA_DATABASE_URL/连接串与迁移状态（node scripts/migrate.mjs status）。" >&2
    exit 1
  fi
  # 若配置了初始管理员密码，自动创建超级管理员账号
  if [ -n "${INITIAL_ADMIN_PASSWORD:-}" ]; then
    ADMIN_USER="${INITIAL_ADMIN_USER:-TsinglanAdmin}"
    echo "[entrypoint] 正在初始化超级管理员账号: ${ADMIN_USER}..."
    node /app/scripts/provision-super-admin.mjs \
      # 密码经临时文件传入，不出现在进程列表（ps）或 shell 历史里。
      PW_FILE="$(mktemp)"
      chmod 600 "$PW_FILE"
      printf '%s' "$INITIAL_ADMIN_PASSWORD" > "$PW_FILE"
      node /app/scripts/provision-super-admin.mjs \
        --username "${ADMIN_USER}" \
        --password-file "$PW_FILE" \
        --name '系统超级管理员' \
        --yes-create-account
      PROVISION_RC=$?
      rm -f "$PW_FILE"
      if [ "$PROVISION_RC" -ne 0 ]; then
        echo "[entrypoint] ⚠️ 管理员创建/更新未成功（退出码 $PROVISION_RC），继续校验是否已存在可用管理员..."
      fi
    # 无论上面走了哪条分支，都必须能证明"存在一个真正可登录的 super_admin"。
    # 只报"账号存在"是不够的：本库里就有一个有角色但无法登录的账号。
    if node /app/scripts/bootstrap-super-admin.mjs --verify; then
      echo "[entrypoint] ✓ 已存在可登录的 super_admin"
    else
      echo "[entrypoint] ✗ 没有任何可登录的 super_admin，拒绝启动。" >&2
      echo "[entrypoint]   没有它，部署成功后也没有人能进入管理平台。" >&2
      echo "[entrypoint]   设置 INITIAL_ADMIN_USER/INITIAL_ADMIN_PASSWORD，或执行：" >&2
      echo "[entrypoint]     node scripts/bootstrap-super-admin.mjs   （只读，会给出精确步骤）" >&2
      exit 1
    fi
  fi
fi

# 3. 启动主服务
echo "[entrypoint] 正在启动 TsinglanKindergarten 服务 (端口 ${SERVER_PORT})..."
cd /app/dist
exec "$@"
