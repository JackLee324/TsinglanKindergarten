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
# 三个 HTTP 套件各自在启动时重置 fixture（tests/helpers/reset-fixtures.mjs），
# 因此**运行顺序无关**，可反复执行。
# ============================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${AUTHZ_TEST_DB:?请设置 AUTHZ_TEST_DB，例如 postgres://user:pass@127.0.0.1:55432/qls_test_0005}"

FAILED=0
run() {
  local label="$1"; shift
  printf '  %-24s ' "$label"
  if out=$("$@" 2>&1); then
    echo "$(echo "$out" | grep -oE 'pass=[0-9]+ fail=[0-9]+' | tail -1 || echo 'PASS')"
  else
    echo "FAIL"
    echo "$out" | grep -E 'FAIL|TEST ERROR|not ok|Error:' | head -5 | sed 's/^/      /'
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

echo
if [ "$FAILED" -eq 0 ]; then
  echo "  ✅ 全部通过"
else
  echo "  ❌ 存在失败项"
fi
exit "$FAILED"
