#!/usr/bin/env bash
# =============================================================================
# scripts/verify-seed-failure.sh — "no fake startup" regression test
# =============================================================================
#
# WHAT THIS PROVES
#   The project rule is: never catch an error and keep starting as if everything
#   succeeded. The seed path violated it — `AuthService.onModuleInit()` logged a
#   seeding failure and continued, so on a database where every insert failed the
#   process reported itself healthy with ZERO usable accounts.
#
#   This test FORCES that exact condition and asserts the application now REFUSES
#   TO START, rather than starting and lying about it.
#
# HOW THE FAILURE IS FORCED (and why this way)
#   A `CHECK (false) NOT VALID` constraint is added to `teachers`. `NOT VALID`
#   skips validation of EXISTING rows but still enforces the constraint on every
#   NEW insert. So the schema stays intact and the application boots normally
#   right up to the seeding step, where every single insert is rejected. That
#   isolates the seeding behaviour instead of tripping over an unrelated boot
#   error, which would make the test pass for the wrong reason.
#
# WHAT WOULD MAKE THIS TEST PASS WRONGLY
#   If the server failed to start for ANY other reason, the test would still see
#   a non-zero exit — so the assertion is not merely "it exited", it is
#   "the log contains the specific, deliberate refusal message". A generic crash
#   does not satisfy it.
#
# PREREQUISITES
#   A built server at dist/server/main.js  (run `npm run build` first)
#   A reachable PostgreSQL and an account that may CREATE DATABASE
#
# USAGE
#   ADMIN_DB="postgresql://user:pw@127.0.0.1:55432/postgres" \
#   bash scripts/verify-seed-failure.sh
# =============================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${ADMIN_DB:?set ADMIN_DB, e.g. postgresql://user:pw@127.0.0.1:55432/postgres}"

SCRATCH_DB="qls_seedfail_probe"
PORT="${SEED_PROBE_PORT:-3299}"
BASE_DB="${ADMIN_DB%/*}"
SCRATCH_URL="${BASE_DB}/${SCRATCH_DB}"
LOG="$(mktemp -t qls-seedfail.XXXXXX.log)"

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  URL="$ADMIN_DB" node -e "
    const Pg=require('postgres');
    (async()=>{const s=Pg(process.env.URL,{max:1,onnotice:()=>{}});
      try{await s.unsafe('DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE)')}catch(e){}
      await s.end();})()" >/dev/null 2>&1
}
trap cleanup EXIT

echo "=== 0. preconditions ==="
if [ ! -f dist/server/main.js ]; then
  bad "dist/server/main.js not found — run 'npm run build' first"
  exit 1
fi
ok "built server present"

echo "=== 1. scratch database with a failing seed ==="
URL="$ADMIN_DB" node -e "
  const Pg=require('postgres');
  (async()=>{const s=Pg(process.env.URL,{max:1,onnotice:()=>{}});
    await s.unsafe('DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE)');
    await s.unsafe('CREATE DATABASE \"${SCRATCH_DB}\"');await s.end();})()" \
  || { bad "could not create scratch database"; exit 1; }

node scripts/db-bootstrap.mjs --url "$SCRATCH_URL" >/dev/null 2>&1 \
  || { bad "db-bootstrap failed"; exit 1; }

# Make every future insert into teachers fail.
URL="$SCRATCH_URL" node -e "
  const Pg=require('postgres');
  (async()=>{const s=Pg(process.env.URL,{max:1,onnotice:()=>{}});
    await s.unsafe('ALTER TABLE teachers ADD CONSTRAINT seed_fail_probe CHECK (false) NOT VALID');
    const n=await s.unsafe('SELECT count(*)::int AS n FROM teachers');
    console.log('  teachers rows before start:', n[0].n);
    await s.end();})()" || { bad "could not install the failing constraint"; exit 1; }
ok "forced every teachers INSERT to fail (CHECK (false) NOT VALID)"

echo "=== 2. start the application and observe ==="
MFA_ENCRYPTION_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")" \
SUDA_DATABASE_URL="$SCRATCH_URL" \
FORCE_AUTHN_INNERAPI_DOMAIN="https://127.0.0.1:1" \
NODE_ENV=production SERVER_PORT="$PORT" SERVER_HOST=127.0.0.1 \
LOGIN_IP_RATE_LIMIT_MAX=100000 \
  node dist/server/main.js >"$LOG" 2>&1 &
SERVER_PID=$!

# Wait up to 60s for it to either die or start listening.
DEADLINE=$((SECONDS+60))
LISTENING=0
while [ $SECONDS -lt $DEADLINE ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then LISTENING=1; break; fi
  sleep 1
done

if kill -0 "$SERVER_PID" 2>/dev/null && [ "$LISTENING" -eq 1 ]; then
  bad "application started despite a TOTAL seed failure — it is still faking a healthy startup"
  echo "       (listening on $PORT; see $LOG)"
else
  ok "application did NOT stay up"
fi

echo "=== 3. the refusal must be the deliberate one ==="
if grep -q "Teacher seeding failed completely" "$LOG"; then
  ok "log contains the deliberate refusal message"
else
  bad "expected refusal message not found — a crash for another reason would also have exited"
  echo "       --- last 25 log lines ---"
  tail -25 "$LOG" | sed 's/^/       /'
fi

if grep -qE "created=0, skipped=0, failed=([1-9][0-9]*)" "$LOG"; then
  ok "seed reported the failure counts instead of hiding them"
else
  echo "  NOTE  seed summary line not matched; tail of log:"
  grep -i "seed" "$LOG" | tail -5 | sed 's/^/       /'
fi

echo
echo "=== RESULT ==="
echo "  pass=$pass fail=$fail"
if [ "$fail" -gt 0 ]; then
  echo "  FAILED — the application can still start with zero usable accounts."
  echo "  full log: $LOG"
  exit 1
fi
echo "  PASSED — a total seeding failure now aborts startup instead of faking health."
