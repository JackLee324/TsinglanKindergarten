#!/usr/bin/env bash
# =============================================================================
# scripts/verify-e2e-deploy.sh — 部署产物端到端验收
# =============================================================================
# 这是本仓库唯一一个**真正把产品跑起来**的验收：构建镜像 → 起容器 → 用 HTTP 与
# 无头浏览器验证真实行为。它补的是其它套件的共同盲区 —— 那些套件全部只看 HTTP
# 状态码，因此在独立部署上出现过的两个致命缺陷它们一个都测不出来：
#
#   1. SPA 资源不可达 → 每个资源请求都被 SPA 回退接走、返回 200 text/html，
#      浏览器把 HTML 当脚本解析 → **白屏**，而所有状态码都是绿的。
#   2. 根路径被平台写死的 basename `/app/` 挡住 → `/` 匹配不到路由 →
#      **白屏**，而 `/` 与 `/app/` 返回的是同一份 200 HTML。
#
# 所以本脚本的断言不是"状态码对不对"，而是"**页面到底渲染出了什么**"。
#
# 前置：Docker 可用（本机 Docker Desktop 的 CLI 常不在 PATH，见 DOCKER_BIN）。
# 用法：
#   bash scripts/verify-e2e-deploy.sh
# 退出码 0 = 全部通过；非 0 = 有断言失败。
# =============================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${E2E_PORT:-3411}"
IMAGE="${E2E_IMAGE:-qls-e2e:test}"
NAME="${E2E_NAME:-qls-e2e}"
DB_URL="${E2E_DB_URL:-}"
ADMIN_USER="E2EAdmin"
ADMIN_PASS="Zq7!kmv2Rt9pLx"
PRINCIPAL_USER="E2EPrincipal"
PRINCIPAL_PASS="Wy4!nbh8Sd3fCv"

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
chk() { [ "$2" = "$3" ] && ok "$1 -> $2" || bad "$1 -> $2 (期望 $3)"; }

# ---- 定位 docker -------------------------------------------------------------
DOCKER="${DOCKER_BIN:-}"
if [ -z "$DOCKER" ]; then
  for c in docker "/Applications/Docker.app/Contents/Resources/bin/docker" /usr/local/bin/docker; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then DOCKER="$c"; break; fi
  done
fi
if [ -z "$DOCKER" ]; then
  echo "  ❌ 找不到 docker —— 本验收必须有 Docker。"
  echo "     本机 Docker Desktop 的 CLI 常在 /Applications/Docker.app/Contents/Resources/bin/docker"
  exit 2
fi
export PATH="$(dirname "$DOCKER"):$PATH"

cleanup() {
  "$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== 0. 前置 ==="
"$DOCKER" info >/dev/null 2>&1 && ok "docker 守护进程可用" || { bad "docker 守护进程不可用"; exit 2; }
[ -n "$DB_URL" ] || echo "  NOTE  未设 E2E_DB_URL，跳过依赖数据库的断言（仅验证静态资源与跳转）"

echo "=== 1. 构建镜像（这会真正跑一遍 Dockerfile）==="
if "$DOCKER" build --platform linux/amd64 -t "$IMAGE" . > /tmp/qls-e2e-build.log 2>&1; then
  ok "镜像构建成功"
else
  bad "镜像构建失败 —— 见 /tmp/qls-e2e-build.log"
  tail -20 /tmp/qls-e2e-build.log | sed 's/^/       /'
  exit 1
fi

echo "=== 2. 启动容器 ==="
"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
RUN_ARGS=(-d --name "$NAME" -p "${PORT}:3000"
  -e NODE_ENV=production -e HTTPS_ENABLED=true -e TRUST_PROXY=loopback
  -e MFA_ENCRYPTION_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
  -e DOWNLOAD_TOKEN_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")")
if [ -n "$DB_URL" ]; then
  RUN_ARGS+=(-e SUDA_DATABASE_URL="$DB_URL"
             -e INITIAL_ADMIN_USER="$ADMIN_USER" -e INITIAL_ADMIN_PASSWORD="$ADMIN_PASS"
             -e INITIAL_PRINCIPAL_USER="$PRINCIPAL_USER" -e INITIAL_PRINCIPAL_PASSWORD="$PRINCIPAL_PASS")
fi
if ! "$DOCKER" run "${RUN_ARGS[@]}" "$IMAGE" >/dev/null 2>&1; then
  bad "容器启动失败"
  exit 1
fi
ok "容器已启动"

# 等健康
B="http://127.0.0.1:${PORT}"
UP=0
for _ in $(seq 1 45); do
  if [ "$(curl -sS -o /dev/null -w '%{http_code}' -m 3 "$B/api/health" 2>/dev/null)" = "200" ]; then UP=1; break; fi
  sleep 2
done
[ "$UP" = "1" ] && ok "健康检查 200" || { bad "健康检查未就绪"; "$DOCKER" logs --tail 30 "$NAME" 2>&1 | sed 's/^/       /'; exit 1; }

echo "=== 3. 根路径直接渲染（白屏缺陷 #2 的反面）==="
# 以前这里断言的是 302 -> /app/。那个跳转是妙搭平台把 React Router 的 basename
# 写死成 /app/ 造成的白屏绕行；basename 现在是 /，跳转已删除，因此正确的断言变成
# 「/ 直接 200 且没有任何重定向」。断言从 302 改成 200 不是放宽 —— 它是同一个缺陷
# 修复后的正确形态，而且新增了「不重定向」与「老书签 /app/* 仍可达」两条。
chk "GET /         状态码" "$(curl -sS -o /dev/null -w '%{http_code}' "$B/")" "200"
chk "GET /         没有重定向（basename 已是 /）" "$(curl -sS -o /dev/null -w '%{redirect_url}' "$B/")" ""
chk "GET /login    状态码" "$(curl -sS -o /dev/null -w '%{http_code}' "$B/login")" "200"
chk "GET /app/login（平台期老书签）跳转目标" "$(curl -sS -o /dev/null -w '%{redirect_url}' "$B/app/login")" "$B/login"
chk "GET /api/health 不被跳转" "$(curl -sS -o /dev/null -w '%{http_code}' "$B/api/health")" "200"

echo "=== 4. 静态资源（白屏缺陷 #1）==="
HTML="$(curl -sS "$B/")"
chk "首页是 HTML" "$(printf '%s' "$HTML" | grep -c '<div id="root">')" "1"
for ref in $(printf '%s' "$HTML" | grep -oE '(src|href)="/[^"]+\.(js|css)"' | sed -E 's/.*="\/([^"]+)"/\1/' | sort -u); do
  CT="$(curl -sS -o /dev/null -w '%{content_type}' "$B/$ref")"
  case "$ref" in
    *.js)  case "$CT" in *javascript*) ok "/$ref -> $CT" ;; *) bad "/$ref -> $CT (期望 javascript，说明被 SPA 回退接走，会白屏)" ;; esac ;;
    *.css) case "$CT" in *css*) ok "/$ref -> $CT" ;; *) bad "/$ref -> $CT (期望 css)" ;; esac ;;
  esac
done
# 平台遗留：妙搭的 Vite 预设会往 HTML 注入一段 document.write('/polyfills.js')，
# 而 polyfills.js 又落在平台中间件跳过列表里的 assets/ 下 —— 独立部署时它 404，
# 浏览器把 SPA 首页当脚本执行。那是白屏缺陷 #1 的另一个面。
#
# 现在这条断言反过来写：**产物里不应再有这个注入**。plain Vite 不产 polyfills.js，
# 也不产这段 document.write，所以「文件不存在」+「HTML 不引用它」才是正确状态，
# 而且比原来那条「文件类型对」更严格 —— 它同时盯住了注入本身。
chk "入口 HTML 不再注入 polyfills.js" "$(printf '%s' "$HTML" | grep -c 'polyfills.js')" "0"

echo "=== 5. 安全响应头 ==="
HDR="$(curl -sS -D - -o /dev/null "$B/api/health" | tr -d '\r')"
printf '%s' "$HDR" | grep -qi 'x-content-type-options: nosniff' && ok "nosniff" || bad "nosniff 缺失"
printf '%s' "$HDR" | grep -qi 'x-frame-options: DENY'      && ok "X-Frame-Options" || bad "X-Frame-Options 缺失"
printf '%s' "$HDR" | grep -qi 'strict-transport-security'  && ok "HSTS（HTTPS_ENABLED=true 时应存在）" || bad "HSTS 缺失"
printf '%s' "$HDR" | grep -qi 'x-powered-by'               && bad "X-Powered-By 未移除" || ok "X-Powered-By 已移除"

echo "=== 6. 浏览器渲染（唯一能发现白屏的断言）==="
CHROME=""
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium" \
         "$(command -v google-chrome 2>/dev/null)" \
         "$(command -v chromium 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
done
if [ -z "$CHROME" ]; then
  echo "  NOTE  未找到 Chrome/Chromium，跳过渲染断言（这是本脚本最有价值的一条，请在有浏览器的环境跑）"
else
  "$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=15000 \
    --dump-dom "$B/" > /tmp/qls-e2e-dom.html 2>/dev/null
  ROOT_LEN=$(python3 -c "
import re,sys
s=open('/tmp/qls-e2e-dom.html',encoding='utf-8',errors='replace').read()
i=s.find('<div id=\"root\">')
seg=s[i:i+9000] if i!=-1 else ''
t=re.sub(r'<script[\s\S]*?</script>','',seg); t=re.sub(r'<[^>]+>',' ',t)
print(len(re.sub(r'\s+',' ',t).strip()))
" 2>/dev/null || echo 0)
  if [ "$ROOT_LEN" -gt 20 ]; then
    ok "根路径直接渲染出内容（#root 文本 ${ROOT_LEN} 字符）"
  else
    bad "根路径渲染为空 —— 白屏。所有状态码可能仍全绿，这就是本断言的用途"
  fi
  # 浏览器实际的 document.title。线上曾经是「妙搭应用」：平台把正确的 <title>
  # 换成 HBS 占位符，再用一个默认值兜底。断言它现在是产品名 —— 而且是**渲染之后**
  # 的值，所以任何在运行时改写标题的代码都会在这里露出来。
  chk "浏览器 document.title" "$(grep -o '<title>[^<]*</title>' /tmp/qls-e2e-dom.html | head -1)" \
    "<title>TsinglanKindergarten - 清澜山幼儿园课程资源平台</title>"
fi

echo "=== 6b. 脱平台：HTML 里不得残留平台注入 ==="
# 「彻底移除妙搭依赖」在**用户可见层面**的验收。标题那一条之所以放在上一节，是因为
# 它必须由浏览器渲染后取值（见那里的注释）。
TITLE="$(printf '%s' "$HTML" | grep -o '<title>[^<]*</title>' | head -1)"
chk "服务端返回的 <title>" "$TITLE" "<title>TsinglanKindergarten - 清澜山幼儿园课程资源平台</title>"
chk "HTML 里没有 {{appName}} 占位符" "$(printf '%s' "$HTML" | grep -c '{{appName}}')" "0"
chk "HTML 里没有 __platform__ 注入" "$(printf '%s' "$HTML" | grep -c '__platform__')" "0"
chk "HTML 里没有 __BASENAME__ 注入（basename 不再是 /app/）" "$(printf '%s' "$HTML" | grep -c '__BASENAME__')" "0"
chk "HTML 里没有「妙搭」字样" "$(printf '%s' "$HTML" | grep -c '妙搭')" "0"
if printf '%s' "$HTML" | grep -qE 'slardar|ibytedapm|feishucdn|bytescm|bytednsdoc'; then
  bad "页面仍在加载字节/妙搭平台的外链脚本（Slardar / Tea / performance SDK）"
else
  ok "页面不再加载任何字节/妙搭平台的外链脚本"
fi


if [ -n "$DB_URL" ]; then
  echo "=== 7. 账号与权限（真实登录）==="
  csrf_of() { grep -i 'suda-csrf-token' "$1" | awk '{print $7}' | tail -1; }
  login() {
    rm -f "$3"
    curl -sSL -c "$3" -o /dev/null "$B/" 2>/dev/null
    curl -sS -b "$3" -c "$3" -X POST "$B/api/auth/login" \
      -H 'Content-Type: application/json' -H "Origin: $B" \
      -H "x-suda-csrf-token: $(csrf_of "$3")" \
      -d "{\"username\":\"$1\",\"password\":\"$2\"}" \
      -o /tmp/qls-e2e-login.json -w '%{http_code}'
  }
  code_of() { curl -sS -b "$1" -o /dev/null -w '%{http_code}' "$2"; }

  chk "super_admin 登录" "$(login "$ADMIN_USER" "$ADMIN_PASS" /tmp/e2e-a.txt)" "201"
  grep -q 'mfaRequired":false' /tmp/qls-e2e-login.json && ok "super_admin 未被强制 MFA" || bad "super_admin 仍被要求 MFA"
  grep -q 'super_admin' /tmp/qls-e2e-login.json && ok "登录响应含 super_admin 角色" || bad "登录响应角色异常"
  chk "super_admin -> /api/teachers" "$(code_of /tmp/e2e-a.txt "$B/api/teachers")" "200"
  chk "super_admin -> /api/resources" "$(code_of /tmp/e2e-a.txt "$B/api/resources")" "200"

  chk "principal 登录" "$(login "$PRINCIPAL_USER" "$PRINCIPAL_PASS" /tmp/e2e-p.txt)" "201"
  grep -q 'principal' /tmp/qls-e2e-login.json && ok "登录响应含 principal 角色" || bad "登录响应角色异常"
  chk "principal -> /api/resources" "$(code_of /tmp/e2e-p.txt "$B/api/resources")" "200"
  chk "principal -> /api/dashboard/stats" "$(code_of /tmp/e2e-p.txt "$B/api/dashboard/stats")" "200"

  echo "  --- 提权边界：principal 不得动 super_admin ---"
  curl -sS -b /tmp/e2e-a.txt "$B/api/teachers" -o /tmp/e2e-teachers.json 2>/dev/null
  ADMIN_ID="$(python3 -c "
import json
try:
    d=json.load(open('/tmp/e2e-teachers.json'))
    items=d if isinstance(d,list) else (d.get('items') or d.get('data') or [])
    for t in items:
        if 'super_admin' in (t.get('roles') or []):
            print(t.get('id')); break
except Exception: pass
" 2>/dev/null)"
  if [ -n "$ADMIN_ID" ]; then
    RC="$(curl -sS -b /tmp/e2e-p.txt -X POST "$B/api/auth/reset-password" \
      -H 'Content-Type: application/json' -H "Origin: $B" \
      -H "x-suda-csrf-token: $(csrf_of /tmp/e2e-p.txt)" \
      -d "{\"teacherId\":\"$ADMIN_ID\"}" -o /dev/null -w '%{http_code}')"
    if [ "$RC" = "403" ] || [ "$RC" = "404" ]; then ok "principal 重置 super_admin 密码被拒（$RC）"; else bad "principal 竟可重置 super_admin 密码（$RC）"; fi
  else
    echo "  NOTE  未取到 super_admin 的 id，跳过越权断言"
  fi
fi

echo "=== 8. 优雅关闭 ==="
"$DOCKER" stop -t 15 "$NAME" >/dev/null 2>&1
chk "SIGTERM 后退出码" "$("$DOCKER" inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null || echo '?')" "0"

echo
echo "=== RESULT ==="
echo "  pass=$PASS fail=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ E2E 验收失败"
  exit 1
fi
echo "  ✅ E2E 验收通过"
