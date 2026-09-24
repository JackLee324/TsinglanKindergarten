#!/usr/bin/env bash
# ============================================================
# scripts/verify-gate-reproducible.sh
# ============================================================
# 回归守卫：证明"验证门禁是状态无关的"，并防止今天修好的这一类问题悄悄回来。
#
# 背景（实测，不是推测）：同一份代码连续运行门禁曾产出四种不同结果——成片的假
# 401（pass=50 fail=22）、探针资源消失（`0 expected 1` / `404 expected 201`）、
# 封面 404。根因是套件之间共享可变状态：
#   * `teachers.permissions_version` 是账号级全局状态，任何进程的 roles/status
#     变更都会让该账号在**所有**进程里的会话变成 401；
#   * reset-fixtures 曾经吊销**全库**会话；
#   * 探针资源标题前缀是共享字面量，两个 run 会互相删除对方的行。
#
# 本脚本检查四件事，每一件都对应上面一种真实出现过的失败：
#
#   GUARD 1  脏状态下连跑两次门禁，套件结果必须逐字节相同
#            （第一次运行会推进 permissions_version、增删行；第二次必须一致）
#   GUARD 2  套件崩溃时必须非零退出，绝不能报 pass=N fail=0
#            （`finally` 里的 process.exit() 曾把异常连同退出码一起吞掉）
#   GUARD 3  两个 files-http 同时运行都必须 73/0
#            （这正是当初产生 pass=50 fail=22 的场景）
#   GUARD 4  门禁持锁期间，单独启动的套件必须明确报错，而不是给出假结果
#
# 用法：
#   AUTHZ_TEST_DB=... bash scripts/verify-gate-reproducible.sh            # 全部
#   AUTHZ_TEST_DB=... bash scripts/verify-gate-reproducible.sh --quick    # 跳过 GUARD 1
# ============================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${AUTHZ_TEST_DB:?请设置 AUTHZ_TEST_DB}"

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

FAILED=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAILED=1; }

echo "=== GUARD 2: 崩溃的套件必须非零退出（不得报 pass=N fail=0） ==="
# 一个不可达的 base URL 让套件在第一次请求就抛异常。修复前 finally 里的
# process.exit() 会把它变成 exit 0 —— 于是一个根本没跑完的套件看起来是绿的。
for probe in \
  "verify-authz-http.mjs|AUTHZ_BASE=http://127.0.0.1:1" \
  "verify-hardening.mjs|MFA_BASE=http://127.0.0.1:1" \
  "verify-mfa.mjs|MFA_BASE=http://127.0.0.1:1" \
  "verify-files-http.mjs|FILES_BASE=http://127.0.0.1:1" ; do
  script="${probe%%|*}"; envkv="${probe##*|}"
  out=$(env "$envkv" node "scripts/$script" 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    ok "$script exits $rc on an unreachable server"
  else
    bad "$script exited 0 after aborting: $(echo "$out" | grep -m1 'pass=')"
    echo "$out" | tail -3 | sed 's/^/       /'
  fi
done

echo
echo "=== GUARD 3: 两个 files-http 并发都必须 73/0 ==="
# 这是当初失败的原始场景：两个 run 共用账号与前缀，互相把对方打成 401 级联。
node scripts/verify-files-http.mjs > /tmp/gate-guard-conc-a.log 2>&1 & A=$!
node scripts/verify-files-http.mjs > /tmp/gate-guard-conc-b.log 2>&1 & B=$!
wait "$A"; RA=$?
wait "$B"; RB=$?
RA_LINE=$(grep -m1 'pass=' /tmp/gate-guard-conc-a.log)
RB_LINE=$(grep -m1 'pass=' /tmp/gate-guard-conc-b.log)
if [ "$RA" -eq 0 ] && [ "$RB" -eq 0 ] && [ "$RA_LINE" = "  pass=73 fail=0" ] && [ "$RB_LINE" = "  pass=73 fail=0" ]; then
  ok "concurrent runs: A exit 0 ($RA_LINE) · B exit 0 ($RB_LINE)"
else
  bad "concurrent runs disagreed: A exit=$RA [${RA_LINE:-none}] B exit=$RB [${RB_LINE:-none}]"
  grep -E 'FAIL|ABORTED|FATAL' /tmp/gate-guard-conc-a.log /tmp/gate-guard-conc-b.log | head -10 | sed 's/^/       /'
fi

echo
echo "=== GUARD 4: 门禁持锁期间单独套件必须明确报错 ==="
READY=$(mktemp -t qls-guard-lock)
node tests/helpers/gate-lock-holder.mjs "$READY" > /tmp/gate-guard-holder.log 2>&1 &
HOLDER=$!
for _ in $(seq 1 100); do [ -s "$READY" ] && break; sleep 0.1; done
if [ "$(head -1 "$READY" 2>/dev/null)" != "LOCKED" ]; then
  bad "could not take the gate lock for the guard: $(head -1 "$READY" 2>/dev/null)"
else
  out=$(node scripts/verify-authz-http.mjs 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q 'verification GATE is running'; then
    ok "standalone suite refused while the gate lock is held"
  else
    bad "standalone suite did NOT refuse while the gate held the lock (exit=$rc)"
    echo "$out" | tail -3 | sed 's/^/       /'
  fi
fi
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
rm -f "$READY"

echo
echo '=== GUARD 5: 已被移除的「401 后自动重登」不得重新出现 ==='
# 静态守卫：曾经用「401 后自动重登并重放请求」掩盖症状。重试无法区分
# 「环境变了」与「这个端点真的不再接受我的会话」，会掩盖该套件本该暴露的回归。
if grep -qE "MAX_SESSION_RECOVERIES|Re-authenticating" scripts/verify-*.mjs; then
  bad "a suite re-introduced session re-authentication retry"
  grep -nE "MAX_SESSION_RECOVERIES|Re-authenticating" scripts/verify-*.mjs | sed 's/^/       /'
else
  ok "no suite retries a 401 by re-authenticating"
fi
# 封面断言必须保持严格：它守的是"真实平台路径不被判为非法"，200 是原断言。
if grep -qF "check('a leading-slash platform cover path is ACCEPTED (not 400)', cover.status, 200)" scripts/verify-files-http.mjs; then
  ok "cover check still asserts status 200 strictly"
else
  bad "the cover-path check was weakened (expected a strict === 200 assertion)"
fi

if [ "$QUICK" -eq 1 ]; then
  echo
  echo "=== GUARD 1 已跳过（--quick） ==="
else
  echo
  echo "=== GUARD 1: 脏状态下连跑两次门禁，结果必须逐字节相同 ==="
  # 第一次运行本身就把库弄"脏"：permissions_version 前进、账号与探针行增删。
  # 第二次必须与第一次完全一致，否则门禁仍然依赖状态。
  bash scripts/verify-all.sh > /tmp/gate-guard-run1.log 2>&1; R1=$?
  bash scripts/verify-all.sh > /tmp/gate-guard-run2.log 2>&1; R2=$?
  # 只比较会漂移的部分之外的全部输出；两次的锁提示是常量，无需剔除。
  if diff -u /tmp/gate-guard-run1.log /tmp/gate-guard-run2.log > /tmp/gate-guard-diff.log; then
    if [ "$R1" -eq 0 ] && [ "$R2" -eq 0 ]; then
      ok "two consecutive gates are byte-identical (exit 0 both times)"
      sed -n '/HTTP 验证套件/,$p' /tmp/gate-guard-run1.log | sed 's/^/       /'
    else
      bad "gates agreed but did NOT pass (exit $R1 / $R2)"
      sed -n '/HTTP 验证套件/,$p' /tmp/gate-guard-run1.log | sed 's/^/       /'
    fi
  else
    bad "two consecutive gates produced DIFFERENT output"
    head -40 /tmp/gate-guard-diff.log | sed 's/^/       /'
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "  ✅ 回归守卫全部通过"
else
  echo "  ❌ 回归守卫存在失败项"
fi
exit "$FAILED"
