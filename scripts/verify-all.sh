#!/usr/bin/env bash
# ============================================================
# 统一验证入口
# ============================================================
# 一次性运行全部自动化测试与 HTTP 验证套件，任一失败即整体失败。
# 目的：让"回归门禁"只有一个入口，而不是靠人记住跑哪几个脚本。
#
# 前置条件：
#   1. PostgreSQL 可用：      bash scripts/dev-postgres.sh start
#   2. 已应用全部 migration： DATABASE_URL=... npm run migrate
#   3. 应用已以生产模式启动，并监听 $MFA_BASE（默认 127.0.0.1:3200）
#   4. 环境变量 AUTHZ_TEST_DB 指向测试库
#
# 两个**服务端**环境变量会改变门禁的检查数量，必须在启动服务时设置好；两者都
# 是"少跑了几项检查"，套件会明确打印 NOTE，不会静默通过：
#   * LOGIN_IP_RATE_LIMIT_MAX  —— 默认 30 次/60 秒/IP，且限流表在服务进程内存中
#     按 IP 共享。五个套件合计约 14 次登录（全部来自 127.0.0.1），默认值下并发
#     运行两个套件就可能被限流，表现为套件打印 LOGIN FAILED 后成片 401。
#     启动服务时设为 100000。
#   * DOWNLOAD_TOKEN_TTL_SECONDS —— 默认 300 秒。verify-files-http 的 F 节要真等
#     token 过期，只肯等 30 秒，因此默认值下这 2 项检查会**打印 NOTE 后跳过**
#     （files-http 由 73 项降为 71 项）。设为 10 才会现场跑满。
#     确定性覆盖在 tests/file-security.test.mjs，不受该变量影响。
#   推荐启动命令见 README / RUNBOOK；本仓库的实测门禁使用
#   DOWNLOAD_TOKEN_TTL_SECONDS=10 LOGIN_IP_RATE_LIMIT_MAX=100000。
#
# ── 门禁有**两种模式**，取决于服务进程有没有配对象存储 ───────────
# 这不是可有可无的细节：`files-http` / `naming-http` 有一组断言的前提**就是**
# "本进程没有对象存储后端"（没有后端时登记必须 fail closed），而生产**要求**
# 必须配后端。所以在配了 S3 的进程上跑整个门禁，那两组会红 —— 那是环境模式
# 不匹配，不是产品缺陷。最危险的处理方式是"为了把门禁弄绿去关掉对象存储"。
#
# 因此：**主门禁用"未配置存储"模式跑**（下方 A），配置模式下的等价行为由
# storage-upload / upload-web 两个套件覆盖（下方 B）。
#
#   A. 未配置存储（主门禁，全绿基线）
#      启动服务时**不要**设 S3_*；然后再跑门禁：
#        UPLOAD_WEB_EXPECT_STORAGE=off bash scripts/verify-all.sh
#      （upload-web 在未配置模式下断言的是"必须出现『文件没有上传』的警告、
#        且绝不出现绿色成功提示、绝不伪造 bucket/path"。）
#
#   B. 已配置存储（上传/下载链路）
#      启动服务时设齐 S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID /
#      S3_SECRET_ACCESS_KEY（+ S3_REGION），bucket 必须配 CORS（见
#      DEPLOYMENT_PRODUCTION.md §2.5），然后：
#        node scripts/verify-storage-upload-flow.mjs   # 接口链路（需 S3_ENDPOINT 可达）
#        EXPECT_STORAGE=on node scripts/verify-upload-web.mjs   # 真实浏览器闭环
#      files-http / naming-http 在该模式下会打印**醒目的前提不成立横幅**并失败；
#      横幅已说明该如何处理。
#
# ── 为什么这个门禁现在是可重复的 ─────────────────────────────
# 每个 HTTP 套件在运行时创建**属于自己的**账号与探针数据（见
# tests/helpers/reset-fixtures.mjs），运行结束再删除。因此套件之间不再共享
# 任何可变状态，顺序无关、反复执行结果一致。
#
# 曾经不是这样：套件共用 qlsadmin / prek-teacher01，而
# `teachers.permissions_version` 是**账号级全局**状态——数据库触发器在 roles /
# status 变化时自增它，AuthGuard 随即把该账号在**任何进程**中的会话判为 401。
# 于是两个套件一旦重叠，就会互相制造成片的假 401（实测 pass=50 fail=22），
# 以及探针资源被对方清理掉的假 404（实测 `0 expected 1`）。
# 用"401 后自动重登一次"掩盖症状已经移除：重试无法区分"环境变了"与"这个
# 端点真的不再接受我的会话"，恰好会掩盖该套件本该暴露的那类回归。
#
# 现在并发**套件**是安全的。但**门禁本身不能并行**，因为它会执行
# `npm run build`，而构建的第一步是 `rm -rf dist`，正在运行的服务正是从
# dist/ 读取封面等静态资源（scripts/verify-files-http.mjs 的 J 节）。
# 这一点由数据库咨询锁强制，而不是靠注释提醒：
#   * 门禁持有**排他**锁（本脚本，经 tests/helpers/gate-lock-holder.mjs）；
#   * 单独运行的套件持有**共享**锁，门禁运行期间会明确报错而不是给出假结果。
# ============================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${AUTHZ_TEST_DB:?请设置 AUTHZ_TEST_DB，例如 postgres://user:pass@127.0.0.1:55432/qls_test_0005}"

# tests/ 里有 5 条用例只在 DATABASE_URL 存在时才注册（数据库相关）。
# 之前门禁只设了 AUTHZ_TEST_DB，于是它跑的是 **270** 而不是 275 —— 少了 5 条，
# 而输出里的 `# pass 270 # fail 0` 看上去完全正常。这种"静默少跑"正是
# 这个门禁最需要避免的东西，所以这里显式补上。
export DATABASE_URL="${DATABASE_URL:-$AUTHZ_TEST_DB}"

# ---------------------------------------------------------------------------
# 环境独占。没有它，两个门禁（或一个门禁 + 一个单独套件）会在 dist/ 上互相
# 破坏，并产出无法归因的假失败。
# ---------------------------------------------------------------------------
LOCK_READY="$(mktemp -t qls-gate-lock)"
LOCK_PID=""
cleanup_lock() {
  rm -f "$LOCK_READY"
  if [ -n "$LOCK_PID" ]; then kill "$LOCK_PID" 2>/dev/null || true; fi
}
trap cleanup_lock EXIT

node tests/helpers/gate-lock-holder.mjs "$LOCK_READY" &
LOCK_PID=$!

# 就绪握手：等待锁持有者写下 LOCKED / BUSY。
for _ in $(seq 1 100); do
  [ -s "$LOCK_READY" ] && break
  sleep 0.1
done
LOCK_STATUS="$(head -1 "$LOCK_READY" 2>/dev/null)"
if [ "$LOCK_STATUS" != "LOCKED" ]; then
  echo "❌ 无法独占验证环境：${LOCK_STATUS:-门禁锁持有者未就绪}" >&2
  echo "   同一时间只允许一个门禁运行；请等它结束后重试。" >&2
  exit 1
fi
# 套件不再重复取共享锁——门禁已代表它们持有排他锁。
export QLS_GATE_LOCK_HELD=1

FAILED=0
run() {
  local label="$1"; shift
  printf '  %-24s ' "$label"
  if out=$("$@" 2>&1); then
    counts=$(echo "$out" | grep -oE 'pass=[0-9]+ fail=[0-9]+' | tail -1)
    if [ -z "$counts" ]; then
      echo "PASS"
    else
      echo "$counts"
      # **pass=0 不算通过。** exit code 0 只说明"没报错"，不说明"检查了什么"。
      # 一个因为环境缺失而把所有断言都跳过的套件，同样会以 0 退出并打印
      # `pass=0 fail=0` —— 那与"跑过且没发现问题"在外观上完全一致。
      # 这正是本仓库反复在防的假绿，所以在这里显式拦掉。
      if echo "$counts" | grep -q '^pass=0 '; then
        echo "      ⚠️  该套件**一条断言都没跑**（pass=0）—— 不算通过。请检查它是否因环境缺失而整体跳过。"
        FAILED=1
      fi
    fi
  else
    echo "FAIL"
    # 打印**全部**失败项，而不是前 5 行：截断的诊断会让人去猜。
    echo "$out" | grep -E 'FAIL|TEST ERROR|not ok|ABORTED|FATAL|CLEANUP FAILED|Error:' | sed 's/^/      /'
    # 再打印套件**自报的前提横幅**。
    #
    # 为什么需要这一段：`files-http` / `naming-http` 在"已配置对象存储"的进程上
    # 必然变红，而它们会打印一段说明"这是环境模式不匹配、不是产品缺陷、
    # 切勿为了变绿而关掉对象存储"的横幅。上面的 grep 只挑 FAIL 行，
    # 于是那段横幅**恰好被过滤掉了** —— 看到的就是一条没有解释的红，
    # 而最容易想到的"修法"正是关掉对象存储，也就是最危险的处理方式。
    # 实测：在配置存储模式下跑门禁时，本段之前看不到任何前提说明。
    premise=$(echo "$out" | grep -E '⚠️|前提不成立|环境模式不匹配' || true)
    if [ -n "$premise" ]; then
      echo "      ── 该套件自报的前提（请先读这一段再判断这是不是产品缺陷）──"
      echo "$premise" | sed 's/^/      /'
    fi
    FAILED=1
  fi
}

echo "=== 自动化测试 ==="
printf '  %-24s ' "npm test"
if out=$(npm test 2>&1); then
  echo "$(echo "$out" | grep -E '^# (tests|pass|fail)' | tr '\n' ' ')"
else
  echo "FAIL"; echo "$out" | tail -5 | sed 's/^/      /'; FAILED=1
fi

echo "=== 静态检查（lint）==="
# lint 此前**从未在这个门禁里跑过**，而且两个命令本身都是坏的：
#   * `npm run eslint` 依赖已随去平台化删除的 @lark-apaas/fullstack-presets → 找不到模块；
#   * `npm run stylelint` 仓库里根本没有配置文件，且 glob 未加引号，
#     shell 把 `**` 当单个 `*`，只匹配到被忽略的 vendor 目录 → 一个文件都没检查却退出 0。
# 两项都已修好；现在把它们放进门禁，否则"修好了"只存在于注释里。
printf '  %-24s ' "eslint"
npm run eslint >/dev/null 2>&1 && echo PASS || { echo FAIL; npm run eslint 2>&1 | tail -12 | sed 's/^/      /'; FAILED=1; }
printf '  %-24s ' "stylelint"
npm run stylelint >/dev/null 2>&1 && echo PASS || { echo FAIL; npm run stylelint 2>&1 | tail -12 | sed 's/^/      /'; FAILED=1; }

echo "=== 类型检查 ==="
printf '  %-24s ' "typecheck server"
npm run type:check:server >/dev/null 2>&1 && echo PASS || { echo FAIL; FAILED=1; }
printf '  %-24s ' "typecheck client"
npm run type:check:client >/dev/null 2>&1 && echo PASS || { echo FAIL; FAILED=1; }

echo "=== 构建 ==="
printf '  %-24s ' "npm run build"
npm run build >/dev/null 2>&1 && echo PASS || { echo FAIL; FAILED=1; }

echo "=== 前后端 API 契约（静态检查，无需运行服务） ==="
printf '  %-24s ' "api-contracts"
if out=$(node scripts/verify-api-contracts.mjs 2>&1); then
  echo "$(echo "$out" | grep -oE '[0-9]+ server routes discovered' | head -1) matched"
else
  echo "FAIL"; echo "$out" | grep -E 'NO matching' -A2 | head -8 | sed 's/^/      /'; FAILED=1
fi

echo "=== HTTP 验证套件（需要运行中的服务） ==="
run "authz-http"       node scripts/verify-authz-http.mjs
run "hardening"        node scripts/verify-hardening.mjs
run "mfa"              node scripts/verify-mfa.mjs
run "security-headers"    node scripts/verify-security-headers.mjs
run "files-http"          node scripts/verify-files-http.mjs
run "naming-http"         node scripts/verify-naming-http.mjs
# 目录树接口（§1/§2/§20）：断言 PDF 权威目录的精确节点数、各角色的可见分支，
# 以及「无权限的科目返回 404 而不是空树」。需要 migration 0009 已应用。
run "directories"         node scripts/verify-directories.mjs
# 目录**写路径**（§24/§25/§26）：自建文件夹的增/改/删，以及"拦得住"的否定用例
# —— 系统节点不可改删、PDF 未标自建的地方不可新建、非空不可删、无 manage 权限 403。
run "directories-write"   node scripts/verify-directories-write.mjs
# 资源版本生命周期（§15）：新建/编辑是否真的产生版本、无实质变化是否**不**产生版本、
# 以及迁移回填是否覆盖了每一个既有资源。
run "resource-versions"   node scripts/verify-resource-versions.mjs
# 按需永久删除（`resource.purge`）的三道闸：只接受已在回收站中的行、
# reason 必填、审计留下"谁/何时/为什么/原 purge_after"。
# 它同时还是一条**回归防线**：本套件第一版就抓到 `DELETE` 在 `anon_` 角色下
# 静默影响 0 行、而审计照样写"已永久删除"—— 一条**假审计**。
run "resource-purge"    node scripts/verify-resource-purge.mjs
# §2/§3 的**行为**验证（不是结构断言）：让 prek_head / k_head 真的去动
# 「Pre-K English」「K Chinese Arts」，并验证越界被拒、?directory= 不是越权入口。
# 此前 §2 只有"树里有这个节点 + 角色 scope 覆盖整个班型"这两条证据，
# 后者是**推理**：一旦某个 head 的范围被写成逐科目白名单，新科目会落到无人可见，
# 而结构断言照样全绿。所以这里改成测量。
run "curriculum-scope"  node scripts/verify-curriculum-scope.mjs
# §11 按账号授权（追加/禁止/清除覆盖）+ `role.assign` 的**行为**验证 ——
# 构造"有 account.update、无 role.assign"的账号，真的去改角色，看它是否被挡住。
run "account-permissions" node scripts/verify-account-permissions.mjs
# S3 兼容对象存储：签名结构 + （S3RVER_MODULE 存在时）**真实字节往返**。
# 其中两条在缺少"严格校验 V4 的端点"时**大声跳过**，不算通过 —— 见脚本头注释。
run "storage-s3"          node scripts/verify-storage-s3.mjs
# **真实上传链路**：建资源 → 申请直传地址 → PUT 真字节 → 登记 → 两跳签名下载 → 逐字节比对。
# 服务端未配置 S3 时会（正确地）503，本套件据此**大声跳过**而不是假通过；
# 配好 S3 后再跑同一个门禁即可执行完整链路（见脚本头注释）。
run "storage-upload"      node scripts/verify-storage-upload-flow.mjs

# **真实 SigV4 签名校验**（§4）。s3rver **不校验 V4 签名**（其源码自述），
# 所以"PUT 返回 200"完全不能证明签名是对的。这一项要求一个**真正重算签名**的后端：
#     node scripts/test-s3-sigv4-server.mjs        # 起后端
#     并把应用指向它：S3_ENDPOINT=http://127.0.0.1:9300 S3_BUCKET=…（等）
# 未设置 S3_SIGV4_ENDPOINT 时**明确说没跑**，而不是打印 PASS。
if [ -n "${S3_SIGV4_ENDPOINT:-}" ]; then
  run "storage-sigv4"     node scripts/verify-storage-sigv4.mjs
else
  printf '  %-24s ' "storage-sigv4"
  echo "未运行（未设置 S3_SIGV4_ENDPOINT）—— 这一项**不算通过**"
fi

# 真实浏览器 E2E（§32）。它不是"再跑一次接口" —— 它验证的是**浏览器里真的点得动、
# 页面真的渲染出了数据库里的东西**（§16 那条卡了三轮的 SKIP 已用可判定断言替代）。
#
# 需要账号：没有就**明确说没跑**，而不是打印 PASS ——
# 门禁里最危险的不是失败，是一条看起来通过的检查其实什么都没检查。
if [ -n "${BROWSER_E2E_USER:-}" ] && [ -n "${BROWSER_E2E_PASS:-}" ]; then
  run "browser-e2e"       node scripts/verify-browser-e2e.mjs
  # 两步验证与首次登录强制改密的浏览器闭环（§12/§13）。它会建一个临时账号、
  # 走完"临时密码→强制改密→启用 MFA→退出重登→第二步"，用完即删。
  run "mfa-web"           node scripts/verify-mfa-web.mjs
  # **浏览器里的真实上传闭环**（§4/§23 客户端侧）。接口套件只能证明服务端三步可用，
  # 证明不了"老师点「保存草稿」之后客户端真的把字节送上去了、失败时真的说清楚了"。
  # 它按 EXPECT_STORAGE 决定期望哪条分支：
  #   on（配了 S3）→ 成功提示 + hasFile=true + 从签名直链取回的字节与上传的字节一致；
  #                 并额外验证"服务端拒绝的文件"必须报上传失败而不是成功。
  #   off（没配 S3）→ 必须出现"文件没有上传"的**警告**，且不得出现绿色成功提示、
  #                   不得伪造 bucket/path。服务端没配 S3 时用 off 跑一遍：
  run "upload-web"        env EXPECT_STORAGE="${UPLOAD_WEB_EXPECT_STORAGE:-on}" node scripts/verify-upload-web.mjs
  # §1 目录模型的**浏览器级**三项硬要求（此前完全没被覆盖）：
  #   ① 目录改动 **F5 硬刷新**后仍然存在（不是活在前端内存里的假象）；
  #   ② 新增目录**无需改代码**即出现在上传页的候选里（数据驱动，不是硬编码数组）；
  #   ③ 目录页面能按目录查到归属其中的资源。
  # verify-browser-e2e 的 §24 建完文件夹就删、**从不刷新**，所以①此前是裸奔的。
  run "directory-web"     node scripts/verify-directory-web.mjs
  # §6 超级管理员安全引导：bootstrap→首次登录→改强密码→MFA 登记→确认→恢复码→
  # 重登第二因素；外加"再次引导不得写回 INITIAL_ADMIN_PASSWORD"与
  # "秘密不进审计详情/前端产物"。用独立探针账号，跑完删除。
  run "admin-bootstrap"   node scripts/verify-admin-bootstrap.mjs
  # **业务全链路**（§9）：新建→选班型/科目/目录→上传真实文件→保存草稿→我的资源→
  # 详情→提交审核→审核→发布→目录出现→下载逐字节一致；外加大编辑刷新、删除回收站恢复、
  # 授权重登生效、撤销后旧 Session 失效。单点都对、串起来断掉，是这类系统最常见
  # 也最难发现的缺陷，所以必须有这一条。
  # 配置了对象存储时才有意义（未配置时上传与下载必然失败）：
  #
  # ⚠️ 它**必须有对象存储**才能跑（链里有"上传真实文件"和"下载字节一致"）。
  # 未配置时**明确打印"未运行、不算通过"**，而不是让它跑出一行 `pass=0 fail=0`
  # —— 那和"跑过且没有断言"在外观上无法区分，正是本仓库一直在防的假绿。
  if [ "${UPLOAD_WEB_EXPECT_STORAGE:-on}" = "on" ]; then
    run "business-e2e"    node scripts/verify-business-e2e.mjs
  else
    printf '  %-24s ' "business-e2e"
    echo "未运行（UPLOAD_WEB_EXPECT_STORAGE=off，本进程未配置对象存储）—— 这一项**不算通过**"
  fi
else
  printf '  %-24s ' "browser-e2e"
  echo "未运行（未设置 BROWSER_E2E_USER / BROWSER_E2E_PASS）—— 这一项**不算通过**"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "  ✅ 全部通过"
else
  echo "  ❌ 存在失败项"
fi
exit "$FAILED"
