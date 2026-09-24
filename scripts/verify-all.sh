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
    echo "$(echo "$out" | grep -oE 'pass=[0-9]+ fail=[0-9]+' | tail -1 || echo 'PASS')"
  else
    echo "FAIL"
    # 打印**全部**失败项，而不是前 5 行：截断的诊断会让人去猜。
    echo "$out" | grep -E 'FAIL|TEST ERROR|not ok|ABORTED|FATAL|CLEANUP FAILED|Error:' | sed 's/^/      /'
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

echo
if [ "$FAILED" -eq 0 ]; then
  echo "  ✅ 全部通过"
else
  echo "  ❌ 存在失败项"
fi
exit "$FAILED"
