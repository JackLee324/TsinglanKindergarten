#!/usr/bin/env bash
# =============================================================================
# TsinglanKindergarten — Container Entrypoint
# =============================================================================
set -e

# 1. 规范化环境变量 / Normalize Environment Variables
# 过滤未展开的模板占位符 (如 ${POSTGRES_CONNECTION_STRING}, ${WEB_PORT})
sanitize_var() {
  local val="$1"
  if [[ "$val" =~ ^\$\{.*\}$ ]]; then
    echo ""
  else
    echo "$val"
  fi
}

DATABASE_URL="$(sanitize_var "${DATABASE_URL:-}")"
POSTGRES_CONNECTION_STRING="$(sanitize_var "${POSTGRES_CONNECTION_STRING:-}")"
POSTGRESQL_CONNECTION_STRING="$(sanitize_var "${POSTGRESQL_CONNECTION_STRING:-}")"
POSTGRES_URI="$(sanitize_var "${POSTGRES_URI:-}")"
SUDA_DATABASE_URL="$(sanitize_var "${SUDA_DATABASE_URL:-}")"

# 若 DATABASE_URL 为空，尝试各可能来源或由组件环境变量拼接
DB_CONN="${DATABASE_URL:-${POSTGRES_CONNECTION_STRING:-${POSTGRESQL_CONNECTION_STRING:-${POSTGRES_URI:-${SUDA_DATABASE_URL:-}}}}}"
if [ -z "$DB_CONN" ] && [ -n "${POSTGRES_HOST:-}" ]; then
  PG_USER="${POSTGRES_USERNAME:-${POSTGRES_USER:-postgres}}"
  PG_PASS="${POSTGRES_PASSWORD:-}"
  PG_HOST="${POSTGRES_HOST:-localhost}"
  PG_PORT="${POSTGRES_PORT:-5432}"
  PG_DB="${POSTGRES_DATABASE:-${POSTGRES_DB:-postgres}}"
  DB_CONN="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}"
fi

export DATABASE_URL="$DB_CONN"
export SUDA_DATABASE_URL="$DB_CONN"
export FORCE_AUTHN_INNERAPI_DOMAIN="${FORCE_AUTHN_INNERAPI_DOMAIN:-https://127.0.0.1:1}"
export SERVER_HOST="${SERVER_HOST:-0.0.0.0}"

# 端口规范化：必须为合法数字，否则回退到 3000
RAW_PORT="$(sanitize_var "${PORT:-}")"
if [ -z "$RAW_PORT" ] || ! [[ "$RAW_PORT" =~ ^[0-9]+$ ]]; then
  RAW_PORT="$(sanitize_var "${SERVER_PORT:-}")"
fi
if [ -z "$RAW_PORT" ] || ! [[ "$RAW_PORT" =~ ^[0-9]+$ ]]; then
  RAW_PORT=3000
fi
export SERVER_PORT="$RAW_PORT"
export PORT="$RAW_PORT"
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
  if node /app/scripts/db-bootstrap.mjs; then
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
    # 密码经临时文件传入，不出现在进程列表（ps）或 shell 历史里。
    PW_FILE="$(mktemp)"
    chmod 600 "$PW_FILE"
    printf '%s' "$INITIAL_ADMIN_PASSWORD" > "$PW_FILE"
    if ! node /app/scripts/provision-super-admin.mjs \
      --username "${ADMIN_USER}" \
      --password-file "$PW_FILE" \
      --name '系统超级管理员' \
      --yes-create-account; then
      echo "[entrypoint] ⚠️ 管理员创建/更新未成功，继续校验是否已存在可用管理员..."
    fi
    rm -f "$PW_FILE"
    # 校验：至少存在一个"能凭密码认证"的 super_admin，否则明确警告。
    #
    # 这里刻意【不】使用 bootstrap-super-admin.mjs --verify 的结论来阻断启动，
    # 原因有两条，都是我第一版写错后才发现的：
    #   1. --verify 的 superAdminUsable 只有在 MFA 也绑定后才 > 0，而它的
    #      退出码在不可用时仍然是 0（实测：superAdminUsable=0，exit=0）。
    #      用它当 if 条件会得到一个永远通过的空断言 —— 又一例假绿。
    #   2. 更重要的是会造成死锁：绑定 MFA 只能通过 /api/auth/mfa/enroll，
    #      而该接口需要服务先跑起来。若要求"已绑定 MFA"才允许启动，
    #      全新部署将永远无法启动。
    # 因此这里只做检查并大声告警，把"必须已绑定 MFA 才能算可用"这一严格
    # 判定留给上线门禁 npm run predeploy（它不在启动路径上，不会死锁）。
    echo "[entrypoint] 校验超级管理员状态（只读）："
    node /app/scripts/bootstrap-super-admin.mjs 2>/dev/null | grep -E "能否真正登录|未设置|未绑定|共 .* 个账号" | sed 's/^/[entrypoint]   /' || true
    echo "[entrypoint] ⚠️ 若上面显示没有可登录的 super_admin，请在浏览器完成 MFA 绑定；"
    echo "[entrypoint]    或设置 INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD 后重新部署。"
    echo "[entrypoint]    严格验收请运行：npm run predeploy（期望不再出现 FAIL [07]/[08]）。"
  fi
fi

# 3. 启动主服务
echo "[entrypoint] 正在启动 TsinglanKindergarten 服务 (端口 ${SERVER_PORT})..."
cd /app/dist
exec "$@"
