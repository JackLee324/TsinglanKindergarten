#!/usr/bin/env bash
# =============================================================================
# scripts/deploy-vps.sh — 单实例 VPS 部署编排（Docker Compose）
# =============================================================================
#
# ⚠️  这个脚本**在本机无法端到端验证**：编写它的机器没有 docker
#     （`command -v docker` 为空）。所有 compose 调用都是"读文档写出的正确形状"，
#     不是实测结果。第一次跑请当成调试。
#     可以在本机验证的部分：参数解析、.env 校验、密钥生成、失败退出码、
#     以及对数据库的那两个动作（迁移 / 角色成员关系）——它们走的是 node 脚本，
#     不依赖 docker。
#
# 用法：
#   bash scripts/deploy-vps.sh preflight      # 只体检，不做任何改动
#   bash scripts/deploy-vps.sh genkeys        # 打印两个新密钥（不写文件）
#   bash scripts/deploy-vps.sh migrate        # 跑迁移 + 角色成员关系（需库可达）
#   bash scripts/deploy-vps.sh up             # 起栈（含 migrate + 健康等待）
#   bash scripts/deploy-vps.sh verify         # 部署后验收（含 predeploy 门禁）
#   bash scripts/deploy-vps.sh logs           # 跟随日志
#   bash scripts/deploy-vps.sh down           # 停栈（**保留**数据卷）
#
# 环境文件默认 .env.deploy，可用 --env-file 指定。
#
# 为什么要有 preflight 这个子命令：部署失败最贵的形态是"起来一半"——
# 容器在跑、但密钥错、迁移没跑、健康检查其实过的不是这个实例。
# preflight 把所有能在动手前查出来的问题一次列清。
# =============================================================================

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env.deploy"
COMPOSE_FILES=(-f docker-compose.yml)
DO_BUILD=1

# -----------------------------------------------------------------------------
# args
# -----------------------------------------------------------------------------
COMMAND=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --external-db) COMPOSE_FILES+=(-f docker-compose.external-db.yml); shift ;;
    --no-build) DO_BUILD=0; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    preflight|genkeys|migrate|up|verify|logs|down) COMMAND="$1"; shift ;;
    *) echo "未知参数: $1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

if [ -z "$COMMAND" ]; then
  sed -n '2,40p' "$0"; exit 0
fi

# -----------------------------------------------------------------------------
# 输出helper：PASS / FAIL / WARN，绝不把 WARN 当 PASS
# -----------------------------------------------------------------------------
FAILURES=0
WARNINGS=0
step_ok()   { printf '  PASS  %s\n' "$1"; }
step_bad()  { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES+1)); }
step_warn() { printf '  WARN  %s\n' "$1"; WARNINGS=$((WARNINGS+1)); }
detail()    { printf '        %s\n' "$1"; }

# genkeys 不需要读 .env
if [ "$COMMAND" = "genkeys" ]; then
  echo "# 追加到 .env.deploy 即可（每次部署**必须**换新的，不要复用）"
  echo "MFA_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  echo "DOWNLOAD_TOKEN_SECRET=$(openssl rand -base64 32)"
  echo
  echo "# ⚠️ MFA_ENCRYPTION_KEY 丢失 = 所有已绑定 MFA 的账号永久无法登录。"
  echo "#    请与数据库备份**分开**保存。"
  exit 0
fi

# -----------------------------------------------------------------------------
# 读 .env.deploy
# -----------------------------------------------------------------------------
# 与 predeploy-check.sh 同一套做法：不 source，避免执行文件里的任意代码；
# 只做 NAME=VALUE 解析。值不会被打印。
ENV_NAMES="$(mktemp -t qls-envnames)"
ENV_VALS="$(mktemp -t qls-envvals)"
cleanup() { rm -f "$ENV_NAMES" "$ENV_VALS"; }
trap cleanup EXIT

if [ ! -f "$ENV_FILE" ]; then
  echo "找不到环境文件: $ENV_FILE" >&2
  echo "  从模板复制：cp .env.deploy.example .env.deploy" >&2
  echo "  生成密钥：  bash scripts/deploy-vps.sh genkeys >> .env.deploy" >&2
  exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  case "$key" in export*) key="${key#export}" ;; esac
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; \'*\') val="${val#\'}"; val="${val%\'}" ;; esac
  printf '%s\n' "$key" >> "$ENV_NAMES"
  printf '%s\n' "$val" >> "$ENV_VALS"
done < "$ENV_FILE"

env_get() {
  local n="$1" ln
  ln="$(grep -nxF -- "$n" "$ENV_NAMES" 2>/dev/null | head -1 | cut -d: -f1)"
  [ -n "$ln" ] && sed -n "${ln}p" "$ENV_VALS" || printf ''
}
env_has() { [ -n "$(env_get "$1")" ]; }

# 占位符检测：模板里带来的 <...> 值必须被替换掉
is_placeholder() {
  case "$1" in *'<'*'>'*) return 0 ;; *) return 1 ;; esac
}

# compose 环境（把 .env.deploy 的值导给 docker compose 用）
compose() {
  docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE" "$@"
}

# -----------------------------------------------------------------------------
# preflight
# -----------------------------------------------------------------------------
preflight() {
  echo "== 部署前体检 =="
  echo "环境文件: $ENV_FILE"
  echo "compose 文件: ${COMPOSE_FILES[*]}"
  echo

  # ---- 1. 工具链 ----
  echo "-- 工具链"
  if command -v docker >/dev/null 2>&1; then
    step_ok "docker: $(docker --version 2>/dev/null | head -1)"
    if docker compose version >/dev/null 2>&1; then
      step_ok "docker compose: $(docker compose version 2>/dev/null | head -1)"
    else
      step_bad "docker compose 插件不可用（需要 Docker Compose v2）"
    fi
    if docker info >/dev/null 2>&1; then
      step_ok "docker daemon 可达"
      ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo unknown)"
      detail "宿主机架构: $ARCH"
      if [ "$ARCH" != "x86_64" ]; then
        step_warn "宿主机不是 x86_64（$ARCH）"
        detail "package-lock.json 只有 linux/x64 条目，compose 里已钉 platforms: linux/amd64。"
        detail "构建会走 qemu 模拟，明显更慢；能跑通，但别指望构建速度。"
      fi
    else
      step_bad "docker daemon 不可达（当前用户没权限？还是服务没起？）"
    fi
  else
    step_bad "找不到 docker —— 这一步在本机必然失败，请在目标 VPS 上跑"
  fi
  if command -v openssl >/dev/null 2>&1; then
    step_ok "openssl 可用（生成密钥用）"
  else
    step_bad "找不到 openssl（genkeys 和密钥校验都需要它）"
  fi
  echo

  # ---- 2. 必填环境变量 ----
  echo "-- 环境变量"
  for pair in \
    "NODE_ENV:必须是 production" \
    "SUDA_DATABASE_URL:应用与迁移的运行库连接串" \
    "FORCE_AUTHN_INNERAPI_DOMAIN:平台硬性要求，缺失则进程直接退出" \
    "MFA_ENCRYPTION_KEY:AES-256-GCM 加密 TOTP 密钥" \
    "DOWNLOAD_TOKEN_SECRET:下载直链 HMAC 签名键" \
    "HTTPS_ENABLED:生产必须 true，否则 Cookie 不 Secure、HTTP 下登录不了" \
    "TRUST_PROXY:反代拓扑（loopback / 跳数 / CIDR）"
  do
    name="${pair%%:*}"; why="${pair#*:}"
    if env_has "$name"; then
      val="$(env_get "$name")"
      if is_placeholder "$val"; then
        step_bad "$name 仍是模板占位符 <...>，未替换（$why）"
      else
        case "$name" in
          MFA_ENCRYPTION_KEY|DOWNLOAD_TOKEN_SECRET|SUDA_DATABASE_URL)
            step_ok "$name 已设置（值不打印）" ;;
          *) step_ok "$name=$(printf '%s' "$val")" ;;
        esac
      fi
    else
      step_bad "$name 未设置（$why）"
    fi
  done
  echo

  # ---- 3. 值本身的正确性（不是"设了"就算过）----
  echo "-- 值校验"
  NODE_ENV_V="$(env_get NODE_ENV)"
  [ "$NODE_ENV_V" = "production" ] && step_ok "NODE_ENV=production" \
    || step_bad "NODE_ENV='$NODE_ENV_V'，必须恰好是 production"

  HTTPS_V="$(env_get HTTPS_ENABLED)"
  [ "$HTTPS_V" = "true" ] && step_ok "HTTPS_ENABLED=true（Cookie Secure + 反代下 HSTS）" \
    || step_bad "HTTPS_ENABLED='$HTTPS_V'，生产必须是 true"

  TP="$(env_get TRUST_PROXY)"
  case "$TP" in
    ''|false) step_bad "TRUST_PROXY 未设或为 false：反代后 req.ip 会变成反代自己的 IP，按 IP 的登录限流与审计归因都会失真" ;;
    true)     step_warn "TRUST_PROXY=true：信任**任意** X-Forwarded-For。仅当反代一定覆写该头时才可接受；否则登录限流可被绕过" ;;
    *)        step_ok "TRUST_PROXY=$TP（具体跳数/CIDR，而非全信任）" ;;
  esac

  # MFA 密钥必须是恰好 32 字节
  MFA_K="$(env_get MFA_ENCRYPTION_KEY)"
  if [ -n "$MFA_K" ] && ! is_placeholder "$MFA_K"; then
    BYTES="$(printf '%s' "$MFA_K" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')"
    [ "$BYTES" = "32" ] && step_ok "MFA_ENCRYPTION_KEY 解码为 32 字节（AES-256 合规）" \
      || step_bad "MFA_ENCRYPTION_KEY 解码为 ${BYTES} 字节，必须恰好 32（mfa-crypto.ts 会抛错）"
  fi

  DL_K="$(env_get DOWNLOAD_TOKEN_SECRET)"
  if [ -n "$DL_K" ] && ! is_placeholder "$DL_K"; then
    BYTES="$(printf '%s' "$DL_K" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')"
    [ "${BYTES:-0}" -ge 32 ] 2>/dev/null && step_ok "DOWNLOAD_TOKEN_SECRET 解码为 ${BYTES} 字节（>=32）" \
      || step_bad "DOWNLOAD_TOKEN_SECRET 解码为 ${BYTES} 字节，至少需要 32"
  fi

  DB_U="$(env_get SUDA_DATABASE_URL)"
  case "$DB_U" in
    *schema=*)
      step_warn "SUDA_DATABASE_URL 带 ?schema= 参数"
      detail "平台会推导 anon_<schema>/authenticated_<schema>/service_role_<schema>，"
      detail "而迁移 0004 建的是空后缀角色。不一致会导致登录 42501。" ;;
  esac
  if [ -n "$DB_U" ] && ! is_placeholder "$DB_U"; then
    if command -v node >/dev/null 2>&1; then
      node -e '
        try { const u = new URL(process.argv[1]);
          const db = u.pathname.replace(/^\//,"");
          console.log(`        scheme=${u.protocol.replace(":","")} host=${u.hostname} port=${u.port||"default"} db=${db} creds=${u.username?"present":"ABSENT"}`);
          if (!u.username) { console.log("        ^ 连接串没有用户名，应用连不上"); process.exit(3); }
        } catch { console.log("        连接串不是可解析的 URL"); process.exit(2); }' "$DB_U"
      RC=$?
      [ "$RC" = "0" ] && step_ok "SUDA_DATABASE_URL 形状正常" || step_bad "SUDA_DATABASE_URL 形状有问题（见上）"
    fi
  fi
  echo

  # ---- 4. 仓库卫生 ----
  echo "-- 仓库卫生"
  if [ -f .env ]; then
    step_warn "仓库根存在 .env：scripts/build.sh:214-217 会把它复制进 dist/"
    detail "Docker 构建不受影响（.dockerignore 排除 .env*），但在宿主机直接构建会泄进产物。"
    detail "自检：find dist -maxdepth 1 -name '.env*'   应当无输出"
  else
    step_ok "仓库根没有 .env（不会被打进产物）"
  fi
  if [ -f dist/server/main.js ]; then
    step_ok "dist/server/main.js 存在"
    if find server shared client -type f \( -name '*.ts' -o -name '*.tsx' \) -newer dist/server/main.js -print -quit 2>/dev/null | grep -q .; then
      step_bad "dist/ 已过期（有源文件比产物新）——compose 会在容器内重新构建，但宿主机产物是旧的"
    else
      step_ok "dist/ 是最新的"
    fi
  else
    step_warn "dist/ 不存在（compose 会在镜像内构建，所以不阻塞）"
  fi
  if command -v git >/dev/null 2>&1; then
    DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    [ "$DIRTY" = "0" ] && step_ok "工作区干净（没有未提交改动进入发布）" \
      || step_warn "工作区有 $DIRTY 个未提交改动；发布应来自干净检出"
  fi
  echo

  # ---- 5. 结论 ----
  echo "== 体检结论 =="
  printf '  failures: %d   warnings: %d\n' "$FAILURES" "$WARNINGS"
  if [ "$FAILURES" -gt 0 ]; then
    echo "  ❌ 有阻塞项，先修好再部署（WARN 不是 PASS，请逐条判断）"
    return 1
  fi
  echo "  ✅ 无阻塞项（有 WARN 时请确认你接受它）"
  return 0
}

# -----------------------------------------------------------------------------
# migrate：跑迁移 + 角色成员关系
# -----------------------------------------------------------------------------
migrate_db() {
  echo "== 数据库迁移 =="
  DB_U="$(env_get SUDA_DATABASE_URL)"
  if [ -z "$DB_U" ] || is_placeholder "$DB_U"; then
    step_bad "SUDA_DATABASE_URL 不可用，无法迁移"
    return 1
  fi

  # 容器内的库要用 compose 网络里的服务名；从宿主机连不上 postgres:5432。
  # 所以迁移一律**在容器里**跑（镜像内已带 scripts/migrate.mjs 与迁移 SQL）。
  if ! command -v docker >/dev/null 2>&1; then
    step_bad "没有 docker，无法在容器内跑迁移（本机必然失败，请在 VPS 上跑）"
    return 1
  fi

  echo "-- 迁移前状态（只读）"
  if compose run --rm --no-deps --entrypoint node app scripts/migrate.mjs status; then
    step_ok "migrate.mjs status 退出 0"
  else
    step_bad "migrate.mjs status 失败（连不上库？库不存在？）"
    return 1
  fi

  echo "-- 校验和（只读）"
  if compose run --rm --no-deps --entrypoint node app scripts/migrate.mjs verify; then
    step_ok "migrate.mjs verify 退出 0（无 checksum drift）"
  else
    step_bad "migrate.mjs verify 失败：存在 checksum drift 或读取失败"
    return 1
  fi

  echo "-- 应用迁移"
  if compose run --rm --no-deps --entrypoint node app scripts/migrate.mjs up; then
    step_ok "migrate.mjs up 退出 0"
  else
    step_bad "migrate.mjs up 失败（失败会回滚该迁移的事务，库保持原状）"
    return 1
  fi

  echo "-- 迁移后状态"
  if compose run --rm --no-deps --entrypoint node app scripts/migrate.mjs status; then
    step_ok "迁移后 status 退出 0（确认无 pending）"
  else
    step_bad "迁移后 status 失败"
    return 1
  fi

  echo "-- 应用角色成员关系（独立部署的必做步骤）"
  detail "迁移 0004 建了 anon_/authenticated_/service_role_ 三个 NOLOGIN 角色，"
  detail "但**故意不**决定谁可以切换成它们。没有成员关系，平台每请求的"
  detail "SET LOCAL ROLE 会以 42501 失败 → 登录报\"用户名或密码错误\"且不写审计。"
  if compose run --rm --no-deps --entrypoint node app scripts/db-setup-app-role.mjs --db-url "$DB_U"; then
    step_ok "db-setup-app-role 通过（含实连切换验收）"
  else
    step_bad "db-setup-app-role 未通过"
    detail "若报'缺特权连接串'：该脚本需要能 GRANT 的身份。"
    detail "可在宿主机直接跑（库端口可达时）："
    detail "  PGHOST=… PGPORT=… PGUSER=… PGPASSWORD=… \\"
    detail "    node scripts/db-setup-app-role.mjs --db-url \"\$SUDA_DATABASE_URL\""
    return 1
  fi
  return 0
}

# -----------------------------------------------------------------------------
# up
# -----------------------------------------------------------------------------
up_stack() {
  preflight || { echo; echo "体检未通过，不启动。"; return 1; }

  if ! migrate_db; then
    echo
    echo "迁移未通过，不启动应用（避免「起来了但库是空的」这种半成品状态）。"
    return 1
  fi
  if [ "$FAILURES" -gt 0 ]; then
    echo
    echo "迁移阶段有 FAIL，不启动。"
    return 1
  fi

  echo
  echo "== 启动栈 =="
  if [ "$DO_BUILD" -eq 1 ]; then
    compose up -d --build || { step_bad "compose up --build 失败"; return 1; }
  else
    compose up -d || { step_bad "compose up 失败"; return 1; }
  fi
  step_ok "compose up 已返回"

  echo "-- 等待健康"
  BASE="http://127.0.0.1:$(env_get APP_PORT)"; BASE="${BASE%/}"
  [ "$BASE" = "http://127.0.0.1" ] && BASE="http://127.0.0.1:3200"

  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/api/health" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then step_ok "liveness 200（${i}s）"; break; fi
    if [ "$i" -eq 60 ]; then
      step_bad "60s 内 /api/health 没有返回 200"
      detail "看日志定位：bash scripts/deploy-vps.sh logs"
      compose logs --tail=60 app || true
      return 1
    fi
    sleep 1
  done

  ready="$(curl -s -o /tmp/qls-ready.json -w '%{http_code}' --max-time 10 "$BASE/api/health/ready" 2>/dev/null || true)"
  if [ "$ready" = "200" ]; then
    step_ok "readiness 200（实例真的能服务流量）"
    sed 's/^/        /' < /tmp/qls-ready.json
  else
    step_bad "readiness 返回 $ready（503 = 库/表/迁移有问题，不是「没起来」）"
    sed 's/^/        /' < /tmp/qls-ready.json 2>/dev/null || true
    return 1
  fi
  return 0
}

# -----------------------------------------------------------------------------
# verify：部署后验收
# -----------------------------------------------------------------------------
verify_deploy() {
  echo "== 部署后验收 =="
  BASE="http://127.0.0.1:$(env_get APP_PORT)"
  [ "$BASE" = "http://127.0.0.1" ] && BASE="http://127.0.0.1:3200"

  for path in /api/health /api/health/ready; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$path" 2>/dev/null || true)"
    [ "$code" = "200" ] && step_ok "GET $path -> 200" || step_bad "GET $path -> $code"
  done

  code="$(curl -s -o /tmp/qls-root.html -w '%{http_code}' --max-time 10 "$BASE/" 2>/dev/null || true)"
  if [ "$code" = "200" ] && grep -q '<!DOCTYPE html' /tmp/qls-root.html 2>/dev/null; then
    step_ok "GET / -> 200 且是 HTML 文档（SPA 外壳在服务端渲染）"
  else
    step_bad "GET / -> $code 或响应体不是 HTML"
  fi

  # CORS 必须仍是限制性默认
  n="$(curl -s -D - -o /dev/null --max-time 10 -H 'Origin: https://cors-probe.invalid' "$BASE/api/health" 2>/dev/null | grep -ci '^access-control-allow' || true)"
  [ "${n:-0}" -gt 0 ] && step_bad "对外来 Origin 返回了 $n 个 Access-Control-Allow-* 头" \
    || step_ok "对外来 Origin 无 CORS 授权（限制性默认）"

  # 安全响应头
  H="$(curl -s -D - -o /dev/null --max-time 10 "$BASE/api/health" 2>/dev/null | tr 'A-Z' 'a-z')"
  for h in x-content-type-options x-frame-options referrer-policy permissions-policy; do
    printf '%s' "$H" | grep -q "^$h:" && step_ok "安全头存在: $h" || step_bad "安全头缺失: $h"
  done
  if [ "$(env_get HTTPS_ENABLED)" = "true" ]; then
    # 注意：这一步直连的是 HTTP，进程若认为自己在 TLS 后面就会发 HSTS。
    printf '%s' "$H" | grep -q '^strict-transport-security:' \
      && step_ok "HSTS 已下发" \
      || step_warn "HTTPS_ENABLED=true 但直连响应里没有 HSTS —— 需在**经反代的 HTTPS 入口**复验"
  fi
  printf '%s' "$H" | grep -q '^x-powered-by:' && step_bad "对外暴露 X-Powered-By" || step_ok "未暴露 X-Powered-By"

  # 数据层面：能不能真的登录（有没有可用的 super_admin）
  echo "-- 数据层"
  # 数据层面：库里到底有没有能登录的 super_admin。
  # 容器内跑（镜像里带了 predeploy-db-check.mjs 与迁移 SQL）。
  if compose run --rm --no-deps --entrypoint node app \
       scripts/predeploy-db-check.mjs super-admin > /tmp/qls-superadmin.json 2>/dev/null; then
    SA_STATUS="$(node -e '
      try { process.stdout.write(String(JSON.parse(require("fs")
        .readFileSync("/tmp/qls-superadmin.json","utf8")).status ?? "ERROR")); }
      catch { process.stdout.write("ERROR"); }' 2>/dev/null)"
    case "$SA_STATUS" in
      PASS) step_ok "存在可登录的 super_admin" ;;
      FAIL) step_bad "没有可登录的 super_admin（生产上线后会无人能管理平台）" ;;
      *)    step_warn "super-admin 检查返回 $SA_STATUS（未通过也未失败，需人工看）" ;;
    esac
  else
    step_warn "无法在容器内跑 super-admin 检查（跳过，不算通过）"
  fi

  echo
  echo "-- predeploy 门禁"
  # 注意：这里**不吞退出码**。predeploy 的结论就是这个子命令的结论的一部分；
  # 早先写成 `... || true` 会让 verify 在门禁失败时仍然退出 0 —— 那正是本仓库
  # 最不能接受的一类缺陷（失败被静默吞掉）。
  if [ -n "$(env_get AUTHZ_TEST_DB)" ]; then
    MFA_BASE="$BASE" bash scripts/predeploy-check.sh
    PRE_RC=$?
  else
    step_warn "AUTHZ_TEST_DB 未设置，无法跑完整门禁"
    detail "生产库不能用作 AUTHZ_TEST_DB（套件会建/删夹具账号与探针数据）。"
    detail "用 PREDEPLOY_SKIP_GATE=1 时它会在豁免清单里具名打印 —— 那是跳过，不是通过。"
    MFA_BASE="$BASE" PREDEPLOY_SKIP_GATE=1 bash scripts/predeploy-check.sh
    PRE_RC=$?
  fi
  if [ "$PRE_RC" -eq 0 ]; then
    step_ok "predeploy 门禁判定 READY"
  else
    step_bad "predeploy 门禁判定 NOT READY（退出码 $PRE_RC）—— 上面的 FAIL/UNVERIFIED 逐条看"
  fi
  return 0
}

# -----------------------------------------------------------------------------
case "$COMMAND" in
  preflight)
    preflight
    ;;
  migrate)
    migrate_db
    ;;
  up)
    up_stack
    ;;
  verify)
    verify_deploy
    ;;
  logs)
    compose logs -f --tail=100 app
    ;;
  down)
    echo "== 停栈 =="
    echo "数据卷 pgdata 会被**保留**（只有 docker compose down -v 才删）。"
    compose down
    ;;
esac

RC=$?
echo
if [ "$RC" -eq 0 ] && [ "$FAILURES" -eq 0 ]; then
  echo "结果: 完成（warnings: $WARNINGS）"
  exit 0
fi
echo "结果: 未完成（failures: $FAILURES, warnings: $WARNINGS）"
exit 1
