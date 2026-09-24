#!/usr/bin/env bash
# =============================================================================
# scripts/verify-shutdown.sh — verifiable evidence for graceful shutdown
# =============================================================================
# Run with:   bash scripts/verify-shutdown.sh
#
# WHAT IT DOES
#   Starts the BUILT server (`dist/server/main.js`, started the way production
#   starts it: `cd dist && node server/main.js`) once per scenario, sends a real
#   signal, and reports what actually happened: the exit code, how long the process
#   took to go away, and the shutdown lines it logged. Cases:
#
#     A  SIGTERM, no traffic        -> exit 0, quickly, log says "cleanly"
#     B  SIGINT,  no traffic        -> exit 0 (same sequence, both signals handled)
#     C  SIGTERM with a request IN FLIGHT
#                                   -> the response is still delivered in full
#                                      (the drain WAITS), and the server then exits 0
#     D  SIGTERM with a request that never finishes (a hung client)
#                                   -> no new connection is accepted, the process
#                                      does NOT exit early, and it force-exits with
#                                      code 1 exactly at SHUTDOWN_TIMEOUT_MS
#     E  two signals in a row       -> the shutdown sequence runs exactly once and
#                                      still exits 0 (no double teardown, no deadlock)
#
# THE IN-FLIGHT REQUESTS ARE REAL, AND DETERMINISTIC
#   There is no artificial "slow route" and no sleep-based race. The helper opens a
#   raw socket and sends
#       POST /api/auth/login   with   Expect: 100-continue   and a Content-Length
#   The server answers `HTTP/1.1 100 Continue` and then waits for the body, so the
#   moment the helper sees that line, ONE REQUEST IS DEFINITELY IN FLIGHT — the
#   shell knows it without guessing. Case C then sends the body and expects the
#   response; case D never sends it, which is a request that can never complete.
#   (Verified against this application: `Expect: 100-continue` gets
#   `HTTP/1.1 100 Continue` and then silence, indefinitely.)
#
# EXIT CODES OF THE SCRIPT
#   0  every case behaved as documented
#   1  at least one case failed (the failing assertions are printed)
#   2  the environment cannot run the cases (no build, no database, another
#      verification run holds the shared environment)
#
# WHAT IT DELIBERATELY DOES NOT DO
#   * It never writes to the database, never seeds, never resets and never deletes
#     a resource. The booted server runs its own idempotent startup, exactly as it
#     does in production.
#   * It does not "retry until it passes". The only waiting is for a state that is
#     asserted (a TCP connection, the 100-continue line, process exit) with a bound
#     that FAILS the case instead of looping forever.
#   * It does not run the code path it is testing by re-implementing it: every
#     number below comes from the real process.
#
# WHY IT TAKES THE SHARED ENVIRONMENT LOCK
#   `npm run build` starts with `rm -rf dist/`, and this script serves the built
#   tree from `dist/`. Running inside a gate would therefore produce a failure that
#   says nothing about shutdown, so the script takes the same SHARED advisory lock
#   the live suites use and refuses (exit 2) instead of reporting a fake result.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
SERVER_JS="$DIST_DIR/server/main.js"

# The database and the two secrets the server needs to boot. Defaults are the
# documented local development values (the same ones the live suites use); every
# value can be overridden from the environment.
DB_URL="${SUDA_DATABASE_URL:-postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005}"
# An advisory lock is per-DATABASE, so the shared lock must be taken on the same
# database the gate takes it on (`AUTHZ_TEST_DB`, exported by verify-all.sh). They are
# the same instance in practice; when AUTHZ_TEST_DB is set it wins, so the exclusion
# against a concurrent gate actually holds.
LOCK_DB_URL="${AUTHZ_TEST_DB:-$DB_URL}"
SHUTDOWN_TIMEOUT_MS="${SHUTDOWN_TIMEOUT_MS:-5000}"
# Bound for "the process should have gone away by now" in the clean cases.
CLEAN_EXIT_BOUND_MS=6000
# Bound for helpers/servers to reach a state we are waiting for.
STATE_BOUND_MS=15000

TMP_DIR="$(mktemp -d -t qls-shutdown)"
CHILDREN=""

cleanup() {
  for pid in $CHILDREN; do
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

pass=0
fail=0

report() {
  # report <PASS|FAIL> <label> <observed>
  if [ "$1" = "PASS" ]; then
    printf '  PASS  %-56s %s\n' "$2" "$3"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-56s %s\n' "$2" "$3"
    fail=$((fail + 1))
  fi
}

check_eq() {
  # check_eq <label> <actual> <expected>
  if [ "$2" = "$3" ]; then report PASS "$1" "-> $2"; else report FAIL "$1" "-> $2 (expected $3)"; fi
}

check_range() {
  # check_range <label> <actual> <min> <max>
  if [ "$2" -ge "$3" ] 2>/dev/null && [ "$2" -le "$4" ] 2>/dev/null; then
    report PASS "$1" "-> $2 ms (expected $3..$4)"
  else
    report FAIL "$1" "-> $2 ms (expected $3..$4)"
  fi
}

now_ms() {
  # `date +%s%N` is not portable (BSD date prints a literal N), and bash 3.2 has no
  # EPOCHREALTIME, so the timestamp comes from node. The ~30ms spawn cost is a
  # constant offset on both ends of every measurement below.
  node -e 'process.stdout.write(String(Date.now()))'
}

free_port() {
  node -e '
    const net = require("net");
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });
  '
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
if [ ! -f "$SERVER_JS" ]; then
  echo "❌ $SERVER_JS is missing." >&2
  echo "   This script starts the BUILT server on purpose (that is what production runs)." >&2
  echo "   Run 'npm run build' first." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Child helpers (written to a temp dir so the socket logic is readable and the
# shell keeps only the assertions).
# ---------------------------------------------------------------------------
cat > "$TMP_DIR/request.js" <<'NODE_HELPER'
/**
 * One HTTP request over a raw socket, with the caller controlling when the body is
 * sent — which is what makes "in flight" a fact rather than a guess.
 *
 *   node request.js <mode> <port> <ready-file> <go-file> <result-file>
 *   mode=hold : wait for <go-file>, then send the body and report the response
 *   mode=hang : never send the body (a request that can never complete)
 *
 * <ready-file> is written only once the server has answered `100 Continue`, i.e.
 * only once the request has definitely arrived and is being held open by the server.
 */
const fs = require('fs');
const net = require('net');

const [mode, portArg, readyFile, goFile, resultFile] = process.argv.slice(2);
const port = Number(portArg);
const body = JSON.stringify({ username: 'shutdown-probe', password: 'not-a-real-password' });
const started = Date.now();

function result(text) {
  fs.writeFileSync(resultFile, text + '\n');
}

const socket = net.connect(port, '127.0.0.1', () => {
  socket.write(
    'POST /api/auth/login HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Expect: 100-continue\r\n' +
      'Connection: close\r\n\r\n',
  );
});

let buffered = '';
let sawContinue = false;

socket.setTimeout(120000, () => {
  result(`TIMEOUT after ${Date.now() - started}ms, buffered=${JSON.stringify(buffered.slice(0, 120))}`);
  socket.destroy();
  process.exit(0);
});

socket.on('data', (chunk) => {
  buffered += chunk.toString('latin1');
  if (!sawContinue && buffered.includes('100 Continue')) {
    sawContinue = true;
    fs.writeFileSync(readyFile, String(Date.now()) + '\n');
    if (mode === 'hold') {
      const timer = setInterval(() => {
        if (fs.existsSync(goFile)) {
          clearInterval(timer);
          socket.write(body);
        }
      }, 20);
    }
  }
  // A FINAL status only. `HTTP/1.1 100 Continue` is an interim response, not the
  // answer to the request: matching it would make the helper hang up while the
  // request is still in flight, i.e. the exact opposite of what this script needs.
  const match = buffered.match(/^HTTP\/1\.1 (?!1\d\d)(\d{3})/m);
  if (match) {
    result(`STATUS ${match[1]} ${Date.now()}`);
    socket.destroy();
    process.exit(0);
  }
});

socket.on('close', () => {
  if (!fs.existsSync(resultFile)) {
    result(`CLOSED_WITHOUT_RESPONSE ${Date.now()} buffered=${JSON.stringify(buffered.slice(0, 120))}`);
  }
  process.exit(0);
});

socket.on('error', (error) => {
  result(`SOCKET_ERROR ${error.code || error.message} ${Date.now()}`);
  process.exit(0);
});
NODE_HELPER

cat > "$TMP_DIR/suite-lock.js" <<'NODE_HELPER'
/**
 * Holds the SHARED advisory lock on the shared verification environment for as long
 * as this process lives, so a gate (which rebuilds dist/) cannot overlap this script.
 * Writes LOCKED / BUSY:<reason> to the ready file, exactly like the gate's own holder.
 */
const readyFile = process.argv[2];
const helperUrl = process.argv[3];
const dbUrl = process.argv[4];
const { writeFileSync } = require('fs');

(async () => {
  let lock;
  try {
    const { acquireSuiteLock } = await import(helperUrl);
    lock = await acquireSuiteLock(dbUrl);
  } catch (error) {
    writeFileSync(readyFile, `BUSY: ${error.message}\n`);
    process.exit(3);
  }
  writeFileSync(readyFile, 'LOCKED\n');
  const release = async () => {
    try {
      await lock.release();
    } catch (error) {
      console.error(`could not release the shared environment lock: ${error.message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', release);
  process.on('SIGINT', release);
})();
NODE_HELPER

LOCK_READY="$TMP_DIR/lock-ready"
node "$TMP_DIR/suite-lock.js" "$LOCK_READY" \
  "file://$ROOT_DIR/tests/helpers/reset-fixtures.mjs" "$LOCK_DB_URL" &
LOCK_PID=$!
CHILDREN="$CHILDREN $LOCK_PID"

for _ in $(seq 1 100); do
  [ -s "$LOCK_READY" ] && break
  sleep 0.1
done
LOCK_STATUS="$(head -1 "$LOCK_READY" 2>/dev/null)"
case "$LOCK_STATUS" in
  LOCKED) : ;;
  BUSY:*)
    echo "❌ cannot run: ${LOCK_STATUS#BUSY: }" >&2
    echo "   Only one verification run owns the environment at a time (it may be rebuilding dist/)." >&2
    exit 2
    ;;
  *)
    echo "❌ the shared-environment lock holder did not become ready (status: ${LOCK_STATUS:-none})" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Server harness
# ---------------------------------------------------------------------------
SERVER_LOG=""
SERVER_PID=""

start_server() {
  # start_server <extra-env-assignments...>
  local port
  port="$(free_port)"
  SERVER_LOG="$TMP_DIR/server-$port.log"
  (
    cd "$DIST_DIR" || exit 1
    exec env \
      SUDA_DATABASE_URL="$DB_URL" \
      FORCE_AUTHN_INNERAPI_DOMAIN="https://127.0.0.1:1" \
      NODE_ENV=production \
      SERVER_PORT="$port" \
      SERVER_HOST=127.0.0.1 \
      MFA_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
      DOWNLOAD_TOKEN_SECRET="$(openssl rand -base64 32)" \
      DOWNLOAD_TOKEN_TTL_SECONDS=10 \
      LOGIN_IP_RATE_LIMIT_MAX=100000 \
      SHUTDOWN_TIMEOUT_MS="$SHUTDOWN_TIMEOUT_MS" \
      "$@" \
      node server/main.js
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  CHILDREN="$CHILDREN $SERVER_PID"
  LAST_PORT="$port"
}

wait_ready() {
  # wait_ready <port> — liveness only: it touches no dependency, so 200 means the
  # process is fully initialized and listening.
  local port="$1"
  local waited=0
  while [ "$waited" -lt "$STATE_BOUND_MS" ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "  (server exited during startup; log follows)"
      sed 's/^/      /' "$SERVER_LOG"
      return 1
    fi
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/api/health")" = "200" ]; then
      return 0
    fi
    sleep 0.1
    waited=$((waited + 100))
  done
  return 1
}

wait_exit() {
  # wait_exit <pid> <max_ms> — 0 when the process is gone within the bound.
  local pid="$1" max_ms="$2" waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$max_ms" ]; then return 1; fi
    sleep 0.05
    waited=$((waited + 50))
  done
  return 0
}

wait_file() {
  # wait_file <path> <max_ms>
  local path="$1" max_ms="$2" waited=0
  while [ ! -f "$path" ]; do
    if [ "$waited" -ge "$max_ms" ]; then return 1; fi
    sleep 0.05
    waited=$((waited + 50))
  done
  return 0
}

stop_leftovers() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

echo "=== graceful shutdown: observed behaviour ==="
echo "  build:              $SERVER_JS"
echo "  database:           $(printf '%s' "$DB_URL" | sed 's#://[^:]*:[^@]*@#://***:***@#')"
echo "  SHUTDOWN_TIMEOUT_MS=$SHUTDOWN_TIMEOUT_MS"
echo ""

# ===========================================================================
echo "--- A. SIGTERM, no traffic ------------------------------------------------"
# ===========================================================================
start_server
SERVER_A="$SERVER_PID"
if wait_ready "$LAST_PORT"; then
  check_eq "SHUTDOWN_TIMEOUT_MS is reported at boot" \
    "$(grep -c "shutdown timeout: ${SHUTDOWN_TIMEOUT_MS}ms (from SHUTDOWN_TIMEOUT_MS)" "$SERVER_LOG")" "1"
  killed_at=$(now_ms)
  kill -TERM "$SERVER_A"
  if wait_exit "$SERVER_A" "$CLEAN_EXIT_BOUND_MS"; then
    wait "$SERVER_A"
    code=$?
    elapsed=$(( $(now_ms) - killed_at ))
    check_eq "SIGTERM: exit code" "$code" "0"
    check_range "SIGTERM: time from signal to exit" "$elapsed" 0 "$CLEAN_EXIT_BOUND_MS"
    check_eq "SIGTERM: logged a clean shutdown" "$(grep -c 'graceful shutdown finished cleanly' "$SERVER_LOG")" "1"
    check_eq "SIGTERM: drained before the deadline" "$(grep -c 'stopped accepting new connections' "$SERVER_LOG")" "1"
    check_eq "SIGTERM: no force exit was needed" "$(grep -c 'FORCE EXIT' "$SERVER_LOG")" "0"
    echo "        log: $(grep '\[shutdown\]' "$SERVER_LOG" | sed 's/^/          /' | head -6)"
  else
    report FAIL "SIGTERM: process exited within ${CLEAN_EXIT_BOUND_MS}ms" "-> still running"
    stop_leftovers
  fi
else
  report FAIL "server started and answered /api/health" "-> never became ready"
fi
SERVER_PID=""
echo ""

# ===========================================================================
echo "--- B. SIGINT, no traffic -------------------------------------------------"
# ===========================================================================
start_server
SERVER_B="$SERVER_PID"
if wait_ready "$LAST_PORT"; then
  killed_at=$(now_ms)
  kill -INT "$SERVER_B"
  if wait_exit "$SERVER_B" "$CLEAN_EXIT_BOUND_MS"; then
    wait "$SERVER_B"
    code=$?
    elapsed=$(( $(now_ms) - killed_at ))
    check_eq "SIGINT: exit code" "$code" "0"
    check_range "SIGINT: time from signal to exit" "$elapsed" 0 "$CLEAN_EXIT_BOUND_MS"
    check_eq "SIGINT: logged a clean shutdown" "$(grep -c 'graceful shutdown finished cleanly' "$SERVER_LOG")" "1"
    echo "        log: $(grep '\[shutdown\]' "$SERVER_LOG" | sed 's/^/          /' | head -6)"
  else
    report FAIL "SIGINT: process exited within ${CLEAN_EXIT_BOUND_MS}ms" "-> still running"
    stop_leftovers
  fi
else
  report FAIL "server started and answered /api/health" "-> never became ready"
fi
SERVER_PID=""
echo ""

# ===========================================================================
echo "--- C. SIGTERM with a request IN FLIGHT: the drain must WAIT --------------"
# ===========================================================================
start_server
SERVER_C="$SERVER_PID"
READY_C="$TMP_DIR/c-ready"
GO_C="$TMP_DIR/c-go"
RESULT_C="$TMP_DIR/c-result"
if wait_ready "$LAST_PORT"; then
  PORT_C="$LAST_PORT"
  node "$TMP_DIR/request.js" hold "$PORT_C" "$READY_C" "$GO_C" "$RESULT_C" &
  REQ_C=$!
  CHILDREN="$CHILDREN $REQ_C"
  if wait_file "$READY_C" "$STATE_BOUND_MS"; then
    request_arrived=$(head -1 "$READY_C")
    killed_at=$(now_ms)
    kill -TERM "$SERVER_C"
    sleep 0.5
    if kill -0 "$SERVER_C" 2>/dev/null; then
      report PASS "SIGTERM: still running while a request is in flight" "-> alive 500ms after the signal (the drain waits)"
    else
      report FAIL "SIGTERM: still running while a request is in flight" "-> exited immediately: the drain did NOT wait"
    fi
    : > "$GO_C" # let the in-flight request finish
    if wait_file "$RESULT_C" "$STATE_BOUND_MS"; then
      result_line="$(head -1 "$RESULT_C")"
      response_status="$(printf '%s' "$result_line" | awk '{print $2}')"
      response_at="$(printf '%s' "$result_line" | awk '{print $3}')"
      case "$result_line" in
        STATUS\ *) report PASS "the in-flight request was answered, not destroyed" "-> $result_line" ;;
        *) report FAIL "the in-flight request was answered, not destroyed" "-> $result_line" ;;
      esac
      if [ -n "$response_at" ] && [ "$response_at" -gt "$killed_at" ] 2>/dev/null; then
        report PASS "the response arrived AFTER the signal" "-> response ${response_at}, signal ${killed_at}"
      else
        report FAIL "the response arrived AFTER the signal" "-> response ${response_at:-none}, signal ${killed_at}"
      fi
    else
      report FAIL "the in-flight request was answered" "-> no result written within ${STATE_BOUND_MS}ms"
    fi
    if wait_exit "$SERVER_C" "$CLEAN_EXIT_BOUND_MS"; then
      wait "$SERVER_C"
      code=$?
      elapsed=$(( $(now_ms) - killed_at ))
      check_eq "in-flight case: exit code after the request finished" "$code" "0"
      check_range "in-flight case: time from signal to exit" "$elapsed" 400 "$CLEAN_EXIT_BOUND_MS"
      check_eq "in-flight case: nothing was forced" "$(grep -c 'FORCE EXIT' "$SERVER_LOG")" "0"
      echo "        log: $(grep '\[shutdown\]' "$SERVER_LOG" | sed 's/^/          /' | head -6)"
    else
      report FAIL "in-flight case: process exited within ${CLEAN_EXIT_BOUND_MS}ms" "-> still running"
      stop_leftovers
    fi
  else
    report FAIL "the helper got 100 Continue (a request is genuinely in flight)" "-> never observed"
    stop_leftovers
  fi
  kill -9 "$REQ_C" 2>/dev/null || true
else
  report FAIL "server started and answered /api/health" "-> never became ready"
fi
SERVER_PID=""
echo ""

# ===========================================================================
echo "--- D. SIGTERM with a request that NEVER finishes: force-exit code 1 ------"
# ===========================================================================
start_server
SERVER_D="$SERVER_PID"
READY_D="$TMP_DIR/d-ready"
GO_D="$TMP_DIR/d-go"
RESULT_D="$TMP_DIR/d-result"
if wait_ready "$LAST_PORT"; then
  PORT_D="$LAST_PORT"
  node "$TMP_DIR/request.js" hang "$PORT_D" "$READY_D" "$GO_D" "$RESULT_D" &
  REQ_D=$!
  CHILDREN="$CHILDREN $REQ_D"
  if wait_file "$READY_D" "$STATE_BOUND_MS"; then
    killed_at=$(now_ms)
    kill -TERM "$SERVER_D"
    sleep 0.6
    # While the drain is blocked, the listening socket must already be closed.
    curl -s -o /dev/null -w '' --max-time 2 "http://127.0.0.1:$PORT_D/api/health" 2>/dev/null
    curl_rc=$?
    check_eq "new connections are refused once shutdown starts" "$curl_rc" "7"
    # The deadline is the configured one; allow 4s of scheduling slack on top.
    deadline_bound=$(( SHUTDOWN_TIMEOUT_MS + 4000 ))
    if wait_exit "$SERVER_D" "$(( SHUTDOWN_TIMEOUT_MS + 5000 ))"; then
      wait "$SERVER_D"
      code=$?
      elapsed=$(( $(now_ms) - killed_at ))
      check_eq "hung request: exit code (UNCLEAN)" "$code" "1"
      check_range "hung request: forced at the configured deadline" "$elapsed" \
        "$(( SHUTDOWN_TIMEOUT_MS - 700 ))" "$deadline_bound"
      check_eq "hung request: the force exit is logged" "$(grep -c 'FORCE EXIT' "$SERVER_LOG")" "1"
      echo "        log: $(grep '\[shutdown\]' "$SERVER_LOG" | sed 's/^/          /' | head -8)"
    else
      report FAIL "hung request: process exited within $(( SHUTDOWN_TIMEOUT_MS + 5000 ))ms" "-> still running"
      stop_leftovers
    fi
  else
    report FAIL "the helper got 100 Continue (a request is genuinely in flight)" "-> never observed"
    stop_leftovers
  fi
  kill -9 "$REQ_D" 2>/dev/null || true
else
  report FAIL "server started and answered /api/health" "-> never became ready"
fi
SERVER_PID=""
echo ""

# ===========================================================================
echo "--- E. SIGTERM then SIGINT: the sequence must run exactly once ------------"
# ===========================================================================
start_server
SERVER_E="$SERVER_PID"
if wait_ready "$LAST_PORT"; then
  killed_at=$(now_ms)
  kill -TERM "$SERVER_E"
  kill -INT "$SERVER_E"
  if wait_exit "$SERVER_E" "$CLEAN_EXIT_BOUND_MS"; then
    wait "$SERVER_E"
    code=$?
    elapsed=$(( $(now_ms) - killed_at ))
    check_eq "two signals: exit code" "$code" "0"
    check_range "two signals: time from signal to exit" "$elapsed" 0 "$CLEAN_EXIT_BOUND_MS"
    check_eq "two signals: the sequence started exactly once" "$(grep -c 'received: draining' "$SERVER_LOG")" "1"
    check_eq "two signals: the second one was ignored, not run again" \
      "$(grep -c 'ignoring (the sequence runs exactly once; the drain in progress is not abandoned)' "$SERVER_LOG")" "1"
    check_eq "two signals: exited once (one clean-shutdown line)" \
      "$(grep -c 'graceful shutdown finished cleanly' "$SERVER_LOG")" "1"
    echo "        log: $(grep '\[shutdown\]' "$SERVER_LOG" | sed 's/^/          /' | head -8)"
  else
    report FAIL "two signals: process exited within ${CLEAN_EXIT_BOUND_MS}ms" "-> still running (deadlock?)"
    stop_leftovers
  fi
else
  report FAIL "server started and answered /api/health" "-> never became ready"
fi
SERVER_PID=""
echo ""

echo "=== RESULT ==="
echo "  pass=$pass fail=$fail"
if [ "$fail" -eq 0 ]; then
  echo "  ✅ the shutdown sequence behaves as documented (exit codes 0 clean / 1 unclean)"
  exit 0
fi
echo "  ❌ at least one assertion above failed"
exit 1
