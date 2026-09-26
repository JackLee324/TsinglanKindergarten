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
# 阴性对照账号（第 6c 节）。它的存在本身就是断言的一部分，见那里的说明。
VISITOR_USER="E2EVisitor"
VISITOR_PASS="Vt5!qmz8Wr2nKd"

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
# E2E_SKIP_BUILD=1 复用现有镜像。用途只有一个：把"镜像构建"与"断言"的解耦用于迭代
# 调试（一次构建约 5-6 分钟）。**默认仍然是重新构建**，因为本脚本的价值就在于验收
# 当前源码构建出来的产物；依赖一个可能是旧的镜像会让它悄悄验收错东西。
if [ "${E2E_SKIP_BUILD:-0}" = "1" ]; then
  echo "  NOTE  E2E_SKIP_BUILD=1：跳过构建，复用现有镜像 $IMAGE（仅用于本地迭代调试）"
  "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 && ok "复用现有镜像 $IMAGE" || { bad "镜像 $IMAGE 不存在"; exit 2; }
elif "$DOCKER" build --platform linux/amd64 -t "$IMAGE" . > /tmp/qls-e2e-build.log 2>&1; then
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


echo "=== 6c. 登录之后的授权判定（真实登录 → 真实渲染）==="
# -----------------------------------------------------------------------------
# 为什么必须有这一段
# -----------------------------------------------------------------------------
# 线上故障是：**登录成功之后**页面显示「无权访问」，而「返回首页」点下去又回到
# 同一个页面 —— 看起来像"首页坏了"。真实原因是一条纯前端的授权判定缺陷：
#   client/src/app.tsx 的 TEACHER_ROLES 是一个**白名单字面量**，而
#   client/src/auth/ProtectedRoute.tsx 的判定是「user.roles ∩ requiredRoles ≠ ∅」。
#   super_admin 不在那份白名单里，于是**只持 super_admin 的账号**（本项目的
#   bootstrap 默认就是它，见 provision-super-admin.mjs --role 默认值）在每个受保护
#   路由上都被拒；/unauthorized 的「返回首页」指向 /，而 / 本身也在同一个守卫里，
#   所以又回到 /unauthorized —— 这正是"按钮没反应"的形态。
#
# 后端不这么认为：authorization.service.ts 对 super_admin 直接 `return true`。
# 也就是说前后端的授权模型不一致，前端比后端更严，症状就是"登录成功了但什么都
# 打不开"。
#
# 为什么前面 6 节和第 7 节都发现不了
#   它们全部只看 HTTP 状态码。后端对 super_admin 本来就放行（/api/teachers 200），
#   所以**所有状态码都是绿的**。唯一能发现它的办法，是让浏览器真的以一个账号登录，
#   再看它渲染出什么。
#
# 为什么必须同源
#   登录下发的是 HttpOnly Cookie。只有同源请求浏览器才会保存它并在后续请求上带上，
#   所以探针页必须由本容器自己提供。这里把一次性探针 HTML 拷进**本次测试的临时容器**
#   的静态目录 —— 它不进镜像、不进产物、不进仓库。
if [ -z "$DB_URL" ] || [ -z "$CHROME" ]; then
  echo "  NOTE  需要 E2E_DB_URL 与 Chrome。跳过 —— 注意这是唯一能发现「登录后无权访问」的断言"
else
  has() { grep -q -- "$1" "$2" && echo 1 || echo 0; }
  has_re() { grep -qE -- "$1" "$2" && echo 1 || echo 0; }

  # 阴性对照：visitor 必须**仍然**被拒。
  # 没有它，本节就只是在证明"我把门开大了" —— 那种"修复"能让 super_admin 进去，
  # 也能让任何人进去，而所有断言依然全绿。
  echo "  --- 准备阴性对照账号 visitor ---"
  if printf '%s' "$VISITOR_PASS" | "$DOCKER" exec -i -e DATABASE_URL="$DB_URL" "$NAME" \
       sh -c 'cat > /tmp/.qpw; node /app/scripts/provision-super-admin.mjs \
                --username "$1" --password-file /tmp/.qpw --name "$2" --role "$3" \
                --yes-create-account; rc=$?; rm -f /tmp/.qpw; exit $rc' \
       sh "$VISITOR_USER" 'E2E 访客' visitor >/dev/null 2>&1; then
    ok "visitor 对照账号已创建（--role visitor）"
  else
    bad "visitor 对照账号创建失败 —— 本节的阴性对照缺失"
  fi

  # 探针：登录 → 跳转到 / → 由 SPA 自己决定渲染什么。
  #
  # CSRF 是必需的，**这一条是我第一版探针写错后才加上的**：登录接口虽然在
  # request-paths.ts 的 CSRF 豁免前缀里（免于被校验）—— 不，更准确地说，豁免的是
  # "签发"这一步的路径判断，而 CsrfCheckMiddleware 对每个 /api 下的 POST 都要求
  # `suda-csrf-token` 的 **cookie 与 header 相等**。cookie 由页面路由签发，
  # 所以探针必须先读 document.cookie，再把它原样放进 header。
  # 漏了这一步的症状是 login 返回 403，SPA 于是停在登录页 —— 而那一版的断言
  # "看不到无权访问" 仍然会因为登录页里没有那四个字而**假绿**。
  # 这正是下面必须有 principal 阳性对照的原因。
  probe_render() { # <username> <password> <outfile>
    cat > /tmp/qls-authz-probe.html <<PROBE
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>authz-probe</title></head><body>
<pre id="out">PROBE-PENDING</pre>
<script>
(function () {
  var out = document.getElementById('out');
  function cookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  var tok = cookie('suda-csrf-token');
  fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-suda-csrf-token': tok },
    credentials: 'same-origin',
    body: JSON.stringify({ username: '$1', password: '$2' })
  }).then(function (r) {
    return r.text().then(function (t) {
      if (r.status === 201) { location.replace('/'); return; }
      // 登录没成功就不要跳转 —— 停在探针页，把真实原因留在 DOM 里，
      // 而不是让 SPA 渲染出登录页、让断言以"看不到无权访问"的方式假绿。
      out.textContent = 'PROBE-LOGIN-STATUS-' + r.status + ' ' + t.slice(0, 200) +
        ' CSRF=' + (tok ? 'present' : 'MISSING');
    });
  }, function (e) {
    out.textContent = 'PROBE-LOGIN-FETCHFAIL ' + e + ' CSRF=' + (tok ? 'present' : 'MISSING');
  });
})();
</script>
</body></html>
PROBE
    "$DOCKER" cp /tmp/qls-authz-probe.html "$NAME:/app/dist/dist/client/__authz_probe.html" >/dev/null 2>&1
    "$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=25000 \
      --dump-dom "$B/__authz_probe.html" > "$3" 2>/dev/null
  }

  # 探针自身的失败必须被看见：只要 DOM 里还有 PROBE- 前缀，就说明这次渲染根本没
  # 走到 SPA，那么关于它的所有结论都无效 —— 报 FAIL，绝不算通过。
  probe_ok() { [ "$(has 'PROBE-' "$1")" = "0" ]; }

  # --- 阳性对照：principal ---
  # 它同时是**机制自检**：principal 本来就在 TEACHER_ROLES 里，因此它必须渲染出
  # 首页。如果这一条不过，说明探针本身没跑通（CSRF、Cookie、跳转任一环节），
  # 后面 super_admin 的失败就不能算作缺陷证据。
  probe_render "$PRINCIPAL_USER" "$PRINCIPAL_PASS" /tmp/probe-principal.html
  chk "principal：探针跑通（DOM 里不留 PROBE- 标记）" "$(has 'PROBE-' /tmp/probe-principal.html)" "0"
  chk "principal：渲染出首页（探针机制自检）" "$(has_re '早上好|下午好' /tmp/probe-principal.html)" "1"
  chk "principal：看不到「无权访问」" "$(has '无权访问' /tmp/probe-principal.html)" "0"
  # 平台级统计那一排卡片的三张（HomePage.tsx:174-194）：
  #   dashboard.stat.prekResources (Pre-K 资源) / dashboard.stat.kResources (K 资源)
  #   / storybook.weeklyStorybooks (本周绘本封面)
  #
  # 为什么不用 `dashboard.stat.totalResources`（资源总数）：那个 key 在
  # translations.ts 里有，但**全代码库没有任何地方渲染它**（死 key）——
  # 我第一版就是用它断言的，结果是**假绿**：`资源总数` 是教师那一排里
  # `我的资源总数`（dashboard.stat.myResources）的**子串**，grep 一定能命中。
  # 一条永远为真的断言比没有断言更糟，因为它看起来像有覆盖。
  # 下面两个标签都不是任何教师卡片标签的子串。
  chk "principal：首页出现平台级统计（Pre-K 资源）" \
    "$(has 'Pre-K 资源' /tmp/probe-principal.html)" "1"

  # --- 故障复现：super_admin ---
  probe_render "$ADMIN_USER" "$ADMIN_PASS" /tmp/probe-superadmin.html
  chk "super_admin：探针跑通（DOM 里不留 PROBE- 标记）" "$(has 'PROBE-' /tmp/probe-superadmin.html)" "0"
  chk "super_admin：看不到「无权访问」" "$(has '无权访问' /tmp/probe-superadmin.html)" "0"
  chk "super_admin：渲染出首页而非登录页或错误页" \
    "$(has_re '早上好|下午好' /tmp/probe-superadmin.html)" "1"
  # 同一缺陷形态的**第二个实例**：HomePage.tsx:128 手写的
  # `user?.roles?.includes('principal') || …includes('curriculum_director')`
  # 把 super_admin 漏掉了，于是首页少三张平台统计卡片。
  # 上面那条"渲染出首页"抓不到它（页面确实渲染了，只是少了一块），必须单独断言。
  chk "super_admin：首页出现平台级统计（HomePage 的角色判定不得漏掉它）" \
    "$(has 'Pre-K 资源' /tmp/probe-superadmin.html)" "1"
  chk "super_admin：平台统计第三张卡也在（本周绘本封面）" \
    "$(has '本周绘本封面' /tmp/probe-superadmin.html)" "1"

  # --- 阴性对照：visitor ---
  probe_render "$VISITOR_USER" "$VISITOR_PASS" /tmp/probe-visitor.html
  chk "visitor：探针跑通（DOM 里不留 PROBE- 标记）" "$(has 'PROBE-' /tmp/probe-visitor.html)" "0"
  chk "visitor：仍被拒（阴性对照，防止把门开大）" "$(has '无权访问' /tmp/probe-visitor.html)" "1"
  chk "visitor：没有渲染出首页" "$(has_re '早上好|下午好' /tmp/probe-visitor.html)" "0"

  # 失败时把三个探针的实际渲染文本打出来 —— 否则"渲染出首页 -> 0"这种输出
  # 无法区分"权限被拒"与"探针根本没跑"。
  if [ "$FAIL" -gt 0 ]; then
    for side in principal superadmin visitor; do
      [ -f "/tmp/probe-$side.html" ] || continue
      echo "  --- probe[$side] 渲染文本（前 300 字符）---"
      python3 -c "
import re
s=open('/tmp/probe-$side.html',encoding='utf-8',errors='replace').read()
t=re.sub(r'<script[\s\S]*?</script>','',s); t=re.sub(r'<style[\s\S]*?</style>','',t)
t=re.sub(r'<[^>]+>',' ',t)
print('      '+re.sub(r'\s+',' ',t).strip()[:300])
" 2>/dev/null || true
    done
  fi
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
