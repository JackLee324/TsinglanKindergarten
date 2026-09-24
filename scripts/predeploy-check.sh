#!/usr/bin/env bash
# =============================================================================
# scripts/predeploy-check.sh — production readiness gate
# =============================================================================
# Run with:   npm run predeploy
#
# WHY THIS FILE EXISTS
# --------------------
# `package.json` declared `"predeploy": "bash ./scripts/predeploy-check.sh"` while
# the file did not exist. A documented command whose file is absent is worse than
# no command at all: it fails in the most expensive place (the deploy), or worse,
# a wrapper swallows the "No such file or directory" and the deploy proceeds
# unverified. This script makes that command real and makes it mean something.
#
# CONTRACT
# --------
#   * Every check prints exactly one `PASS` / `FAIL` / `WARN` line, with evidence
#     on the lines beneath it.
#   * `WARN` is NEVER silently counted as a pass. A warning either declares a
#     POLICY WAIVER (a named, documented, non-blocking reason printed at the end)
#     or it makes the result NOT READY. There is no third option.
#   * The script ends with EXACTLY ONE of:
#         READY FOR PRODUCTION
#         NOT READY FOR PRODUCTION
#     and exits 0 only for the former. Anything it could not verify is reported
#     as UNVERIFIED and blocks READY unless waived by name.
#   * Secrets are NEVER printed. Only variable NAMES, whether they are set, and
#     whether a key decodes to the size the application demands.
#   * No check is allowed to pass because of `|| true`, a swallowed subshell, or
#     an empty `catch {}`. A failure is a real non-zero exit.
#
# WHAT IT DOES NOT DO (deliberately)
# ---------------------------------
#   * It never writes to the database, never seeds, never resets, never deletes a
#     resource, and never creates a fake file or storage entry. Everything below
#     is read-only except `npm run build` under `--build`.
#   * It does not create or repair the missing super_admin. That is an operator
#     action; this script reports the gap and stops.
#
# POLICY WAIVER TABLE (the ONLY WARNs that do not block READY)
# ------------------------------------------------------------
#   STORAGE   Object storage is reached through a per-request platform context
#             (dataloom, via @lark-apaas/file-service). A standalone/CI box has
#             no such context BY CONSTRUCTION, so this check can never observe it
#             here. The application refuses to invent a URL (503
#             STORAGE_NOT_CONFIGURED / STORAGE_UNAVAILABLE), so the failure mode
#             is a visible 503 rather than a fake link. Waived and named.
#             If storage is a HARD launch requirement for your deployment, set
#             PREDEPLOY_REQUIRE_STORAGE=1 to promote this WARN to a FAIL.
#   NPM AUDIT `npm audit` needs the registry. An air-gapped or slow box cannot run
#             it. Real findings at/above the threshold still FAIL; only "could not
#             run" is waived, and it is printed as such.
#
# USAGE
#   npm run predeploy
#   bash scripts/predeploy-check.sh [--build] [--skip-gate] [--verbose]
#
# ENVIRONMENT
#   MFA_BASE                     base URL of the running instance
#                                (default http://127.0.0.1:3200)
#   AUTHZ_TEST_DB                database the verification suites use (required
#                                by the gate; also used as a DB URL fallback)
#   SUDA_DATABASE_URL / DATABASE_URL / MIGRATION_DATABASE_URL
#                                database under test. Precedence matches
#                                scripts/migrate.mjs.
#   PREDEPLOY_EXPECT_NODE_ENV    default `production`
#   PREDEPLOY_REQUIRE_STORAGE=1  promote the storage WARN to a FAIL
#   PREDEPLOY_SUPER_ADMIN_MODE=report
#                                record "no usable super_admin" and "privileged
#                                accounts not enrolled" as NAMED WAIVERS instead of
#                                FAILs. Intended ONLY for contract verification
#                                against the fixture database, where the single
#                                super_admin is created password-less on purpose.
#                                Leave it unset for a real deploy.
#   PREDEPLOY_SKIP_ENV_CHECK=1   waive "required env var not set" (the deploy
#                                platform injects them). Named in the waiver list.
#   PREDEPLOY_SKIP_GATE=1        waive the security gate. Named in the waiver list.
#   PREDEPLOY_AUDIT_TIMEOUT_S    default 60
#   PREDEPLOY_AUDIT_REGISTRY     registry to audit against when the configured one
#                                does not implement the advisory endpoint (this
#                                repo's .npmrc points at a mirror that does not).
#                                e.g. https://registry.npmjs.org
# =============================================================================

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MFA_BASE="${MFA_BASE:-http://127.0.0.1:3200}"
MFA_BASE="${MFA_BASE%/}"
EXPECT_NODE_ENV="${PREDEPLOY_EXPECT_NODE_ENV:-production}"
AUDIT_TIMEOUT_S="${PREDEPLOY_AUDIT_TIMEOUT_S:-60}"
HELPER="scripts/predeploy-db-check.mjs"

DO_BUILD=0
SKIP_GATE=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --build)     DO_BUILD=1 ;;
    --skip-gate) SKIP_GATE=1 ;;
    --verbose)   VERBOSE=1 ;;
    -h|--help)   sed -n '2,70p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# -----------------------------------------------------------------------------
# bookkeeping
# -----------------------------------------------------------------------------
FAILURES=0
WARNINGS=0
UNVERIFIED=()      # things not verified -> block READY unless waived
WAIVED=()          # named, documented, non-blocking warnings
CHECK_INDEX=0
TMP_FILES=()
cleanup() {
  local f
  for f in ${TMP_FILES+"${TMP_FILES[@]}"}; do
    [ -n "$f" ] && rm -f "$f"
  done
}
trap cleanup EXIT

tmpfile() {
  local f
  f="$(mktemp -t qls-predeploy)" || return 1
  TMP_FILES+=("$f")
  printf '%s' "$f"
}

# Indent a block of text. Uses awk rather than `sed 's/^/     /'` on purpose:
# `sed` does not add a newline to a final line that lacks one, so a JSON response
# body printed after the header ran straight into the next status line.
indent() { awk '{ print "     " $0 }'; }
hr() { printf '%s\n' "------------------------------------------------------------------------"; }
section() { echo; hr; printf '== %s\n' "$1"; hr; }

_report() {
  # $1=PASS|FAIL|WARN|INFO  $2=label
  local status="$1" label="$2"
  CHECK_INDEX=$((CHECK_INDEX + 1))
  printf '%-4s [%02d] %s\n' "$status" "$CHECK_INDEX" "$label"
}
pass() { _report PASS "$1"; }
fail() { _report FAIL "$1"; FAILURES=$((FAILURES + 1)); }
warn() { _report WARN "$1"; WARNINGS=$((WARNINGS + 1)); }
note() { printf '     %s\n' "$1"; }

# A waived warning: counted and printed, and named in the final waiver list.
warn_waived() {
  local label="$1" reason="$2"
  warn "$label"
  WAIVED+=("$label — $reason")
}

# Something that could not be checked. Blocks READY.
unverified() {
  local label="$1" reason="$2"
  warn "$label"
  note "UNVERIFIED: $reason"
  UNVERIFIED+=("$label — $reason")
}

# -----------------------------------------------------------------------------
# .env handling
# -----------------------------------------------------------------------------
# The application does NOT load .env itself (no dotenv call in server/main.ts);
# it reads process.env, and on 妙搭 the platform injects those variables. The
# deploy recipe in DEPLOYMENT_PRODUCTION.md §7 passes them inline. Reading .env
# here is therefore a CONVENIENCE for local pre-flight: it lets an operator keep
# the production-shaped values in the file the repository documents, without this
# script exporting anything or printing a value.
ENV_FILE_LOADED=0
ENV_FILE_NAMES=""
ENV_FILE_VALS=""
if [ -f "$ROOT_DIR/.env" ]; then
  ENV_FILE_LOADED=1
  ENV_FILE_NAMES="$(mktemp -t qls-predeploy-envnames)"
  ENV_FILE_VALS="$(mktemp -t qls-predeploy-envvars)"
  TMP_FILES+=("$ENV_FILE_NAMES" "$ENV_FILE_VALS")
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    # Tolerate `export FOO=bar` and `FOO = bar`.
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    case "$key" in
      export*) key="${key#export}" ;;
    esac
    case "$key" in
      ''|*[!A-Za-z0-9_]*) continue ;;
    esac
    # Strip surrounding quotes so a key can be length-checked.
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    printf '%s\n' "$key" >> "$ENV_FILE_NAMES"
    printf '%s\n' "$val" >> "$ENV_FILE_VALS"
  done < "$ROOT_DIR/.env"
fi

# NOTE ON BASH VERSION
# -------------------
# This script deliberately uses no bash-4-only feature (`declare -A`, `mapfile`,
# `${var^^}`). macOS ships bash 3.2 as /bin/bash, and a gate that only runs on a
# developer's newer bash is not a gate — the first version of this file used
# `declare -A` and died with "declare: -A: invalid option" on the target machine.
# The .env lookup is therefore two parallel temp files plus a line-number lookup,
# so a value containing '=' or ' ' is never mangled.
ENV_FILE_LINE=""
env_file_lookup() {
  ENV_FILE_LINE=""
  [ "$ENV_FILE_LOADED" -eq 1 ] || return 1
  ENV_FILE_LINE="$(grep -nxF -- "$1" "$ENV_FILE_NAMES" 2>/dev/null | head -1 | cut -d: -f1)"
  [ -n "$ENV_FILE_LINE" ] || return 1
  return 0
}

# env_value <NAME> -> prints the effective value on stdout (may be empty).
# Precedence: real environment first, then .env.
env_value() {
  local name="$1"
  if [ -n "${!name-}" ]; then
    printf '%s' "${!name}"
    return 0
  fi
  if env_file_lookup "$name"; then
    sed -n "${ENV_FILE_LINE}p" "$ENV_FILE_VALS"
    return 0
  fi
  printf ''
}

env_source_of() {
  local name="$1"
  if [ -n "${!name-}" ]; then
    printf 'environment'
  elif env_file_lookup "$name"; then
    printf '.env file'
  else
    printf 'unset'
  fi
}

# env_require <NAME> <why> [--value-of <printf-fmt>]
# Reports presence and the SOURCE, never the value.
ENV_MISSING=()
env_require() {
  local name="$1" why="$2"
  local src
  src="$(env_source_of "$name")"
  if [ "$src" = "unset" ] || [ -z "$(env_value "$name")" ]; then
    note "$name: NOT SET  ($why)"
    ENV_MISSING+=("$name")
    return 1
  fi
  note "$name: set (from $src)  ($why)"
  return 0
}

# -----------------------------------------------------------------------------
# the DB/admin helper (JSON out, secret-free)
# -----------------------------------------------------------------------------
# Runs the node helper and turns its JSON into PASS/FAIL/WARN plus indented lines.
# Sets HELPER_STATUS and HELPER_UNVERIFIED for the caller.
HELPER_STATUS=""
HELPER_UNVERIFIED=0
HELPER_LINES=""
helper_json() {
  local sub="$1" out err rc
  out="$(tmpfile)"; err="$(tmpfile)"
  node "$HELPER" "$sub" >"$out" 2>"$err"
  rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$out" ]; then
    note "helper '$sub' did not produce a result (exit $rc)"
    if [ -s "$err" ]; then
      sed 's/^/       /' < "$err"
    fi
    HELPER_STATUS="ERROR"
    HELPER_UNVERIFIED=1
    HELPER_LINES=""
    return 1
  fi
  if [ "$VERBOSE" -eq 1 ] && [ -s "$err" ]; then
    sed 's/^/       (stderr) /' < "$err"
  fi
  HELPER_STATUS="$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(j.status ?? "ERROR"));
    } catch { process.stdout.write("ERROR"); }
  ' "$out" 2>/dev/null)"
  HELPER_UNVERIFIED="$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(j.unverified ? "1" : "0");
    } catch { process.stdout.write("1"); }
  ' "$out" 2>/dev/null)"
  # The raw lines are kept as well: some checks (CORS) need to read an explicit
  # marker from them, so a PASS cannot claim more than the helper actually did.
  HELPER_LINES="$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(Array.isArray(j.lines) ? j.lines.join("\n") : "");
    } catch { process.stdout.write(""); }
  ' "$out" 2>/dev/null)"
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const line of j.lines ?? []) process.stdout.write("     " + line + "\n");
  ' "$out" 2>/dev/null
  return 0
}

echo "清澜山幼儿园教师课程资源平台 — production readiness gate"
echo "host: $(hostname 2>/dev/null || echo unknown)   date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "repo: $ROOT_DIR"
echo "node: $(node --version 2>/dev/null || echo 'NOT FOUND')   npm: $(npm --version 2>/dev/null || echo 'NOT FOUND')"
echo "target instance (MFA_BASE): $MFA_BASE"
if [ "$ENV_FILE_LOADED" -eq 1 ]; then
  echo "secrets source: process environment first, then ./.env (values are never printed)"
else
  echo "secrets source: process environment only (no ./.env present)"
fi
echo "verdict is about the environment of THIS process ('npm run predeploy'). The running"
echo "instance's own environment is cross-checked separately below as corroboration only."

# -----------------------------------------------------------------------------
# Corroboration: the environment the RUNNING instance was actually started with
# -----------------------------------------------------------------------------
# `ps eww` exposes the environment block of another process you own. This NEVER
# changes the verdict — the verdict is about the environment you are about to
# deploy with — but when the two disagree, that disagreement is itself the
# finding: if the live process has NODE_ENV=production and both signing keys while
# your shell has none, then the deploy recipe you are about to use is NOT the one
# that produced the instance you just health-checked.
# Labelled INFERRED, and every secret is printed as "<set, value withheld>".
if [ -f "$HELPER" ]; then
  echo
  helper_json process-env
fi

# =============================================================================
# 1. production environment variables
# =============================================================================
section "1. Production environment"

if [ "$(env_value NODE_ENV)" = "$EXPECT_NODE_ENV" ]; then
  pass "NODE_ENV is $EXPECT_NODE_ENV"
  note "NODE_ENV governs Secure cookies, abortOnError and error sanitisation"
  note "(server/modules/auth/session.service.ts:47, server/common/filters/exception.filter.ts:134)"
else
  fail "NODE_ENV is '$(env_value NODE_ENV)' but must be '$EXPECT_NODE_ENV'"
  note "with NODE_ENV != production: cookies are not forced Secure, Nest boots with"
  note "abortOnError=false, and error bodies stop being sanitised for clients"
fi

note ""
note "Required variables (names and presence only — no value is ever printed):"

# The name the platform runtime actually reads is SUDA_DATABASE_URL
# (@lark-apaas/fullstack-nestjs-core/dist/index.js:36435
#  -> connectionString: process.env.SUDA_DATABASE_URL ?? "").
# DATABASE_URL / MIGRATION_DATABASE_URL are the migration + tooling names.
DB_URL_CHOSEN=""
for candidate in MIGRATION_DATABASE_URL DATABASE_URL SUDA_DATABASE_URL AUTHZ_TEST_DB; do
  if [ -n "$(env_value "$candidate")" ]; then
    DB_URL_CHOSEN="$candidate"
    note "$candidate: set (from $(env_source_of "$candidate"))"
    break
  fi
done

if [ -z "$(env_value SUDA_DATABASE_URL)" ]; then
  note "SUDA_DATABASE_URL: NOT SET"
fi

if [ -z "$DB_URL_CHOSEN" ]; then
  fail "no database connection variable is set"
  note "the runtime reads SUDA_DATABASE_URL; the migration tool accepts"
  note "MIGRATION_DATABASE_URL > DATABASE_URL > SUDA_DATABASE_URL (scripts/migrate.mjs:79-91)"
else
  pass "database connection string provided via $DB_URL_CHOSEN"
fi

env_require MFA_ENCRYPTION_KEY "AES-256-GCM key for TOTP secrets (openssl rand -base64 32)" || true
env_require DOWNLOAD_TOKEN_SECRET "HMAC-SHA256 key for signed download links (>=32 bytes)" || true

# Key shape, mirroring the application's own resolver
# (server/common/crypto/mfa-crypto.ts:198-217, download-token.ts:88-110).
# A key that is set but the wrong size is NOT "configured" — the app throws.
MFA_KEY="$(env_value MFA_ENCRYPTION_KEY)"
DOWNLOAD_KEY="$(env_value DOWNLOAD_TOKEN_SECRET)"
if [ -n "$MFA_KEY" ] || [ -n "$DOWNLOAD_KEY" ]; then
  KEYCHECK="$(node -e '
    const decode = (raw) => /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
    const mfa = process.argv[1];
    const dl = process.argv[2];
    const out = [];
    if (mfa) out.push(`MFA_ENCRYPTION_KEY decodes to ${decode(mfa).length} byte(s) (must be exactly 32)`);
    if (dl) out.push(`DOWNLOAD_TOKEN_SECRET decodes to ${decode(dl).length} byte(s) (must be >= 32)`);
    process.stdout.write(out.join("\n"));
  ' "$MFA_KEY" "$DOWNLOAD_KEY" 2>/dev/null)"
  if [ -n "$KEYCHECK" ]; then
    while IFS= read -r line; do note "$line"; done <<< "$KEYCHECK"
  fi
fi

if [ -n "$MFA_KEY" ]; then
  MFA_BYTES="$(node -e '
    const raw = process.argv[1];
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    process.stdout.write(String(key.length));
  ' "$MFA_KEY" 2>/dev/null)"
  if [ "$MFA_BYTES" = "32" ]; then
    pass "MFA_ENCRYPTION_KEY is a valid AES-256 key (32 bytes)"
  else
    fail "MFA_ENCRYPTION_KEY decodes to ${MFA_BYTES:-?} bytes, not 32 — the application will throw"
  fi
fi

if [ -n "$DOWNLOAD_KEY" ]; then
  DL_BYTES="$(node -e '
    const raw = process.argv[1];
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    process.stdout.write(String(key.length));
  ' "$DOWNLOAD_KEY" 2>/dev/null)"
  if [ "${DL_BYTES:-0}" -ge 32 ] 2>/dev/null; then
    pass "DOWNLOAD_TOKEN_SECRET is long enough (${DL_BYTES} bytes >= 32)"
  else
    fail "DOWNLOAD_TOKEN_SECRET decodes to ${DL_BYTES:-?} bytes, below the 32-byte minimum"
  fi
fi

if [ "${#ENV_MISSING[@]}" -gt 0 ]; then
  note ""
  note "missing: ${ENV_MISSING[*]}"
  if [ "${PREDEPLOY_SKIP_ENV_CHECK:-0}" = "1" ]; then
    warn_waived "required environment variables are not visible to this shell" \
      "PREDEPLOY_SKIP_ENV_CHECK=1: the deploy platform injects them at container start; presence cannot be confirmed here"
  else
    fail "required environment variable(s) not set: ${ENV_MISSING[*]}"
    note "set them and re-run, or set PREDEPLOY_SKIP_ENV_CHECK=1 to waive this BY NAME"
    note "(waiving is recorded in the final waiver list; it is never silent)"
  fi
fi

# =============================================================================
# 2. database connectivity
# =============================================================================
section "2. Database connectivity (a real connection, not a variable check)"

if helper_json connectivity; then
  case "$HELPER_STATUS" in
    PASS) pass "database reachable and the required tables exist" ;;
    FAIL) fail "database connectivity or schema check failed" ;;
    *)    unverified "database connectivity" "helper returned status $HELPER_STATUS" ;;
  esac
else
  fail "database connectivity could not be determined"
fi

# =============================================================================
# 3. migration state — the real tool
# =============================================================================
section "3. Migration state (scripts/migrate.mjs — the real runner)"

if [ ! -f "scripts/migrate.mjs" ]; then
  fail "scripts/migrate.mjs is missing — migration state cannot be verified"
else
  MIG_OUT="$(tmpfile)"
  npm run migrate:status >"$MIG_OUT" 2>&1
  MIG_RC=$?
  if [ "$MIG_RC" -eq 0 ]; then
    pass "migrate.mjs status: exit 0"
    indent < "$MIG_OUT"
  else
    fail "migrate.mjs status: exit $MIG_RC (pending migrations, checksum drift, or no connection)"
    indent < "$MIG_OUT"
  fi

  PENDING_COUNT="$(grep -cE 'pending' "$MIG_OUT" 2>/dev/null || true)"
  [ -z "$PENDING_COUNT" ] && PENDING_COUNT=0
  if [ "$PENDING_COUNT" -gt 0 ]; then
    fail "$PENDING_COUNT migration(s) are pending — apply them before deploying"
  fi
  if grep -q 'CHECKSUM DRIFT' "$MIG_OUT" 2>/dev/null; then
    fail "checksum drift: an already-applied migration file has been modified"
    note "add a NEW migration instead of editing an applied one"
  fi
  if grep -q 'No checksum drift' "$MIG_OUT" 2>/dev/null; then
    note "no checksum drift"
  fi

  VERIFY_OUT="$(tmpfile)"
  node scripts/migrate.mjs verify >"$VERIFY_OUT" 2>&1
  VERIFY_RC=$?
  if [ "$VERIFY_RC" -eq 0 ]; then
    pass "migrate.mjs verify: exit 0"
    indent < "$VERIFY_OUT"
    if grep -qE '^[^0-9]*0 pending' "$VERIFY_OUT" 2>/dev/null; then
      note "0 pending migrations"
    fi
  else
    fail "migrate.mjs verify: exit $VERIFY_RC"
    indent < "$VERIFY_OUT"
  fi
fi

# =============================================================================
# 4. super_admin existence and state
# =============================================================================
section "4. super_admin account that can actually log in"

if helper_json super-admin; then
  case "$HELPER_STATUS" in
    PASS) pass "an ACTIVE super_admin can authenticate" ;;
    FAIL)
      # This check encodes a PRODUCTION property: a real account with a password
      # hash that can log in. It cannot be true of the verification database,
      # where the only super_admin is `__rbac_keeper`, created password-less by
      # design (tests/helpers/reset-fixtures.mjs:116-131) to keep the
      # last-super_admin trigger satisfiable during runs.
      # A CI job that verifies the CONTRACT therefore needs a way to say "record
      # this, do not fail on this one"; a production operator needs it to be a
      # hard failure. The switch is explicit, narrow, and printed as a waiver.
      if [ "${PREDEPLOY_SUPER_ADMIN_MODE:-require}" = "report" ]; then
        warn_waived "no ACTIVE super_admin can authenticate" \
          "PREDEPLOY_SUPER_ADMIN_MODE=report: this check is a PRODUCTION property, and it is verified against a verification database whose only super_admin is the password-less fixture. Recorded, not ignored — leave this unset for a real deploy"
      else
        fail "no ACTIVE super_admin can authenticate"
        note "this is a PRODUCTION property, verified against the database this shell"
        note "points at. If you are running contract verification against a fixture"
        note "database, set PREDEPLOY_SUPER_ADMIN_MODE=report — the result is then a"
        note "named waiver rather than a pass."
      fi
      ;;
    WARN) unverified "super_admin state" "helper reported WARN" ;;
    *)    unverified "super_admin state" "helper returned status $HELPER_STATUS" ;;
  esac
else
  fail "super_admin state could not be determined"
fi

# =============================================================================
# 5. MFA requirement
# =============================================================================
section "5. Privileged-account MFA enforcement"

if helper_json mfa; then
  case "$HELPER_STATUS" in
    PASS) pass "MFA enforcement in place and privileged accounts enrolled" ;;
    FAIL)
      # Same reasoning as check 4: the code-level half (requiresMfa wired into
      # login AND into AuthGuard) is a property of the release and must always be
      # verified; the enrolment half is a property of the DATABASE. When the only
      # super_admin is the password-less fixture, "privileged accounts are not
      # enrolled" is a true statement about a database nobody logs into.
      if [ "${PREDEPLOY_SUPER_ADMIN_MODE:-require}" = "report" ]; then
        warn_waived "privileged-account MFA enrolment is not satisfied" \
          "PREDEPLOY_SUPER_ADMIN_MODE=report: the enforcement code paths are verified, but the database has no privileged account that can log in, so enrolment cannot be demonstrated. Recorded, not ignored"
      else
        fail "MFA enforcement or privileged-account enrolment is not satisfied"
        note "the enforcement code paths are checked separately from enrolment; read the"
        note "lines above to see which half failed. If the failure is enrolment in a"
        note "fixture database, set PREDEPLOY_SUPER_ADMIN_MODE=report (named waiver)."
      fi
      ;;
    WARN)
      # The helper emits WARN when the enforcement CODE is present but there is no
      # privileged account with a password to demonstrate enrolment on. That is the
      # same fixture-database situation as check 4, so the same switch resolves it —
      # otherwise `PREDEPLOY_SUPER_ADMIN_MODE=report` would waive one half of the
      # finding and still block on the other.
      if [ "${PREDEPLOY_SUPER_ADMIN_MODE:-require}" = "report" ]; then
        warn_waived "privileged-account MFA enrolment could not be demonstrated" \
          "PREDEPLOY_SUPER_ADMIN_MODE=report: MFA enforcement code paths verified, but no privileged account with a password exists in this database to enrol. Recorded, not ignored"
      else
        unverified "privileged-account MFA enrolment" "no privileged account with a password exists, so enrolment cannot be demonstrated"
      fi
      ;;
    *)    unverified "MFA" "helper returned status $HELPER_STATUS" ;;
  esac
else
  fail "MFA state could not be determined"
fi

# =============================================================================
# 6. storage configuration
# =============================================================================
section "6. Object storage (@lark-apaas/file-service / dataloom)"

if helper_json storage; then
  case "$HELPER_STATUS" in
    PASS)
      pass "platform storage context present"
      unverified "object storage reachability" "context variables exist, but signing happens per request against the live platform"
      ;;
    FAIL)
      fail "the storage service no longer fails closed on missing configuration"
      ;;
    WARN)
      if [ "${PREDEPLOY_REQUIRE_STORAGE:-0}" = "1" ]; then
        fail "object storage is NOT configured (PREDEPLOY_REQUIRE_STORAGE=1 makes this blocking)"
      else
        warn_waived "object storage is NOT configured for this process" \
          "dataloom needs a per-request platform context that a standalone box cannot have; the app returns 503 STORAGE_NOT_CONFIGURED instead of a fake URL (set PREDEPLOY_REQUIRE_STORAGE=1 to make this blocking)"
      fi
      ;;
    *) unverified "object storage" "helper returned status $HELPER_STATUS" ;;
  esac
else
  fail "object storage configuration could not be determined"
fi

# =============================================================================
# 7. HTTPS / secure cookies
# =============================================================================
section "7. HTTPS / secure cookie configuration"

HTTPS_ENABLED_V="$(env_value HTTPS_ENABLED)"
TRUST_PROXY_V="$(env_value TRUST_PROXY)"
CSP_MODE_V="$(env_value CSP_MODE)"

note "HTTPS_ENABLED=$( [ -n "$HTTPS_ENABLED_V" ] && printf '%s' "$HTTPS_ENABLED_V" || printf 'unset' )   TRUST_PROXY=$( [ -n "$TRUST_PROXY_V" ] && printf '%s' "$TRUST_PROXY_V" || printf 'unset' )   CSP_MODE=$( [ -n "$CSP_MODE_V" ] && printf '%s' "$CSP_MODE_V" || printf 'unset' )"

# HSTS is only emitted when the process believes TLS is in front of it
# (security-headers.middleware.ts:99-104). Cookies are only Secure when
# HTTPS_ENABLED=true (session.service.ts:47-55).
if [ "$HTTPS_ENABLED_V" = "true" ]; then
  pass "HTTPS_ENABLED=true: session cookies are Secure and HSTS will be sent"
  note "implied: the TLS-terminating proxy MUST forward X-Forwarded-Proto=https, or"
  note "the Secure cookie will not be stored and login will appear to silently fail"
else
  fail "HTTPS_ENABLED is '${HTTPS_ENABLED_V:-unset}', not 'true'"
  note "in production this means: cookies are not Secure, and HSTS is only sent if"
  note "TRUST_PROXY is set (security-headers.middleware.ts:99-104). Session cookies"
  note "would travel over plaintext."
fi

if [ -z "$TRUST_PROXY_V" ] || [ "$TRUST_PROXY_V" = "false" ]; then
  note "TRUST_PROXY is '${TRUST_PROXY_V:-unset}' => Express ignores X-Forwarded-For and req.ip"
  note "is the unforgeable socket address (the SAFE default, audit finding D-10)."
  if [ "$HTTPS_ENABLED_V" = "true" ]; then
    pass "TRUST_PROXY left restrictive while TLS is declared by HTTPS_ENABLED"
    note "behind a real proxy, set TRUST_PROXY=loopback (nginx on 127.0.0.1) or the"
    note "proxy CIDR, otherwise every client is rate-limited as the proxy's own IP and"
    note "every audit_logs.ip_address row records the proxy"
  else
    fail "neither HTTPS_ENABLED nor TRUST_PROXY indicates TLS termination"
    note "HSTS will be OFF and cookies will not be Secure (security-headers.middleware.ts)"
  fi
elif [ "$TRUST_PROXY_V" = "true" ]; then
  warn "TRUST_PROXY=true (trusts EVERY X-Forwarded-For hop)"
  note "only correct when a proxy you control always overwrites the header; otherwise"
  note "the per-IP login rate limit is bypassable by rotating the header and every"
  note "audit row becomes unattributable (server/main.ts:103-109 warns the same way)"
  unverified "trust-proxy correctness" "TRUST_PROXY=true cannot be validated from here: it depends on the ingress stripping X-Forwarded-For"
else
  pass "TRUST_PROXY=$TRUST_PROXY_V (a specific trusted hop/CIDR, not blanket trust)"
  note "implies TLS is in front of this process, so HSTS is sent (max-age=15552000)"
fi

if [ "$HTTPS_ENABLED_V" = "true" ]; then
  note "CSP mode: $( [ -n "$CSP_MODE_V" ] && printf '%s' "$CSP_MODE_V" || printf 'report-only (default)' )"
fi

# =============================================================================
# 8. CORS
# =============================================================================
section "8. CORS configuration"

if helper_json cors; then
  case "$HELPER_STATUS" in
    PASS)
      # A PASS must not claim more than the helper actually did. The helper emits
      # an explicit CORS_LIVE= marker: CONFIRMED only when a live response was
      # actually inspected.
      if printf '%s\n' "$HELPER_LINES" | grep -q '^CORS_LIVE=CONFIRMED'; then
        pass "CORS is at the restrictive default (confirmed in the source AND against the live instance)"
      else
        pass "CORS is at the restrictive default (source-confirmed, not live-confirmed)"
        note "the live half of this check did not run: no instance was reachable."
        note "With no CORS layer anywhere in server/ or shared/ there is nothing for a"
        note "live probe to contradict, which is why this is still a PASS — but it is"
        note "labelled source-confirmed so the weaker evidence is visible."
      fi
      ;;
    FAIL) fail "a CORS layer is configured — that is a policy change, not a neutral one" ;;
    *)    unverified "CORS" "helper returned status $HELPER_STATUS" ;;
  esac
else
  fail "CORS configuration could not be determined"
fi

# =============================================================================
# 9. health / readiness of the running instance
# =============================================================================
section "9. Health and readiness of the running instance ($MFA_BASE)"

HTTP_TMP="$(tmpfile)"
LIVE_CODE="$(curl -s -o "$HTTP_TMP" -w '%{http_code}' --max-time 10 "$MFA_BASE/api/health" 2>/dev/null)"
CURL_RC=$?

if [ "$CURL_RC" -ne 0 ] || [ "$LIVE_CODE" = "000" ] || [ -z "$LIVE_CODE" ]; then
  fail "no server is responding at $MFA_BASE/api/health (curl exit $CURL_RC)"
  note "the gate needs a RUNNING instance; scripts/verify-all.sh does not start one."
  note "documented start recipe (DEPLOYMENT_PRODUCTION.md §7):"
  note "  NODE_ENV=production SERVER_HOST=127.0.0.1 SERVER_PORT=3200 \\"
  note "  SUDA_DATABASE_URL=... MFA_ENCRYPTION_KEY=... DOWNLOAD_TOKEN_SECRET=... \\"
  note "  DOWNLOAD_TOKEN_TTL_SECONDS=10 LOGIN_IP_RATE_LIMIT_MAX=100000 npm run start"
  unverified "liveness and readiness" "no instance reachable at $MFA_BASE"
else
  if [ "$LIVE_CODE" = "200" ]; then
    pass "GET /api/health -> 200"
    indent < "$HTTP_TMP"
  else
    fail "GET /api/health -> $LIVE_CODE (expected 200)"
    indent < "$HTTP_TMP"
  fi

  READY_CODE="$(curl -s -o "$HTTP_TMP" -w '%{http_code}' --max-time 10 "$MFA_BASE/api/health/ready" 2>/dev/null)"
  if [ "$READY_CODE" = "200" ]; then
    READY_STATUS="$(node -e '
      const fs = require("fs");
      try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).status ?? "")); }
      catch { process.stdout.write("unparseable"); }
    ' "$HTTP_TMP" 2>/dev/null)"
    if [ "$READY_STATUS" = "ready" ]; then
      pass "GET /api/health/ready -> 200 (status=ready)"
      indent < "$HTTP_TMP"
    else
      fail "GET /api/health/ready -> 200 but status='$READY_STATUS' (expected 'ready')"
      indent < "$HTTP_TMP"
    fi
  else
    fail "GET /api/health/ready -> $READY_CODE (expected 200; 503 means the instance cannot serve traffic)"
    indent < "$HTTP_TMP"
  fi

  # The instance must not be leaking CORS grants to arbitrary origins.
  CORS_LIVE="$(curl -s -D - -o /dev/null --max-time 10 -H 'Origin: https://cors-probe.invalid' "$MFA_BASE/api/health" 2>/dev/null | grep -ci '^access-control-allow' || true)"
  if [ "${CORS_LIVE:-0}" -gt 0 ]; then
    fail "live instance returned $CORS_LIVE Access-Control-Allow-* header(s) to a foreign Origin"
  else
    note "live instance returned no Access-Control-Allow-* header to a foreign Origin"
  fi

  # Security headers actually being served (not merely implemented).
  # NOTE: the app ships CSP in REPORT-ONLY mode by default, so the header on the
  # wire is `Content-Security-Policy-Report-Only`, not `Content-Security-Policy`
  # (security-headers.middleware.ts:158-163). Matching only the enforcing name
  # produced a false FAIL on the first run of this script.
  HEADERS="$(curl -s -D - -o /dev/null --max-time 10 "$MFA_BASE/api/health" 2>/dev/null)"
  HEADERS_LC="$(printf '%s' "$HEADERS" | tr 'A-Z' 'a-z')"
  for h in "x-content-type-options" "x-frame-options" "referrer-policy" "cross-origin-opener-policy" "cross-origin-resource-policy" "permissions-policy"; do
    if printf '%s' "$HEADERS_LC" | grep -q "^${h}:"; then
      note "header present: $h"
    else
      fail "expected security header MISSING from the live response: $h"
    fi
  done
  if printf '%s' "$HEADERS_LC" | grep -q '^content-security-policy'; then
    CSP_MODE_LIVE="$(printf '%s' "$HEADERS_LC" | grep -m1 '^content-security-policy' | cut -d: -f1 | sed 's/content-security-policy//; s/^-//')"
    if [ -n "$CSP_MODE_LIVE" ]; then
      note "header present: content-security-policy ($CSP_MODE_LIVE mode)"
      note "report-only does not block; switch to enforcing with CSP_MODE=enforce once"
      note "violation reports from the real build have been reviewed"
    else
      pass "Content-Security-Policy present in ENFORCING mode"
    fi
  else
    note "no Content-Security-Policy header (CSP_MODE=off). Deliberate, but it means"
    note "the browser is given no script-src restriction."
  fi
  if printf '%s' "$HEADERS" | tr 'A-Z' 'a-z' | grep -q '^strict-transport-security:'; then
    if [ "$HTTPS_ENABLED_V" = "true" ]; then
      pass "Strict-Transport-Security present, matching HTTPS_ENABLED=true"
    else
      note "Strict-Transport-Security present even though HTTPS_ENABLED is not 'true'"
      note "(TRUST_PROXY is set, so the process believes a TLS proxy is in front — see check 7)"
    fi
  else
    if [ "$HTTPS_ENABLED_V" = "true" ]; then
      fail "HTTPS_ENABLED=true but the live response carries no Strict-Transport-Security header"
      note "the RUNNING process was not started with HTTPS_ENABLED=true, even if this"
      note "shell has it — the check tests the process's actual behaviour"
    else
      note "Strict-Transport-Security absent, consistent with HTTPS_ENABLED not being 'true'"
    fi
  fi
  if printf '%s' "$HEADERS" | tr 'A-Z' 'a-z' | grep -q '^x-powered-by:'; then
    fail "live response advertises X-Powered-By (should be removed by the security middleware)"
  else
    note "live response does not advertise X-Powered-By"
  fi

  # The SPA shell is rendered by the platform view engine, so the only honest way
  # to verify "teachers can load the app" is to ask the running instance for it.
  SHELL_TMP="$(tmpfile)"
  SHELL_CODE="$(curl -s -o "$SHELL_TMP" -w '%{http_code}' --max-time 10 "$MFA_BASE/" 2>/dev/null)"
  if [ "$SHELL_CODE" != "200" ]; then
    fail "GET / -> $SHELL_CODE (the SPA shell is not being served)"
  elif grep -q '<!DOCTYPE html' "$SHELL_TMP" 2>/dev/null; then
    pass "GET / -> 200 and returns an HTML document ($(wc -c < "$SHELL_TMP" | tr -d ' ') bytes)"
  else
    fail "GET / -> 200 but the body is not an HTML document"
    head -c 200 "$SHELL_TMP" | sed 's/^/     /'
  fi
fi

# =============================================================================
# 10. production build
# =============================================================================
section "10. Production build (dist/)"

if [ "$DO_BUILD" -eq 1 ]; then
  note "--build requested: running npm run build (this rebuilds dist/ from scratch)"
  BUILD_LOG="$(tmpfile)"
  if npm run build >"$BUILD_LOG" 2>&1; then
    pass "npm run build succeeded"
    tail -5 "$BUILD_LOG" | sed 's/^/     /'
  else
    fail "npm run build failed"
    tail -30 "$BUILD_LOG" | sed 's/^/     /'
  fi
fi

if [ ! -f "dist/server/main.js" ]; then
  fail "dist/server/main.js does not exist — no production build to deploy"
  note "run: npm run build   (or: bash scripts/predeploy-check.sh --build)"
else
  pass "dist/server/main.js exists ($(wc -c < dist/server/main.js | tr -d ' ') bytes)"

  if [ ! -d "dist/client" ]; then
    fail "dist/client is missing — the server would have no SPA to serve"
  else
    BUILD_ENTRY_COUNT="$(find dist/client -maxdepth 2 -type f \( -name 'index.html' -o -name '*.js' -o -name '*.css' \) 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${BUILD_ENTRY_COUNT:-0}" -eq 0 ]; then
      fail "dist/client contains no html/js/css at all — the SPA bundle was not emitted"
    else
      pass "dist/client has $BUILD_ENTRY_COUNT client artifact(s)"
    fi
    # NOTE: the SPA shell is rendered by the view engine through the platform
    # package, not read from a fixed path on disk, and the platform's public-asset
    # middleware deliberately skips the `assets/` prefix because hashed bundles are
    # served from the platform CDN
    # (@lark-apaas/fullstack-nestjs-core/dist/index.js, PLATFORM_PREFIXES).
    # A request for /assets/* therefore returns the HTML shell by design, both in
    # production and in local verification, so the shell is checked over HTTP below
    # rather than by looking for dist/client/index.html.
    note "SPA shell is verified over HTTP in check 9 (the platform renders it; it is"
    note "not a fixed file on disk, and /assets/* is served from the platform CDN)"
  fi

  # Freshness: any source file newer than the build output means dist/ is stale.
  # .tsbuildinfo files are excluded: they are caches, not sources.
  STALE_LIST="$(tmpfile)"
  find server shared client -type f \
      \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.json' \) \
      -newer dist/server/main.js -print 2>/dev/null > "$STALE_LIST"
  STALE_COUNT="$(wc -l < "$STALE_LIST" | tr -d ' ')"
  if [ "${STALE_COUNT:-0}" -eq 0 ]; then
    pass "the build is current: no source file is newer than dist/server/main.js"
  else
    fail "$STALE_COUNT source file(s) are NEWER than dist/server/main.js — the build is stale"
    head -10 "$STALE_LIST" | sed 's/^/     /'
    [ "$STALE_COUNT" -gt 10 ] && note "... and $((STALE_COUNT - 10)) more"
    note "rebuild with: bash scripts/predeploy-check.sh --build"
  fi
fi

# =============================================================================
# 11. critical security tests — the real gate, one at a time
# =============================================================================
section "11. Critical security tests (scripts/verify-all.sh)"

GATE_WAIVED=0
if [ "$SKIP_GATE" -eq 1 ] || [ "${PREDEPLOY_SKIP_GATE:-0}" = "1" ]; then
  GATE_WAIVED=1
  warn_waived "security test gate skipped by explicit request" \
    "PREDEPLOY_SKIP_GATE=1/--skip-gate: an explicit, named waiver; the security suites were NOT run"
elif [ ! -f "scripts/verify-all.sh" ]; then
  fail "scripts/verify-all.sh is missing — the security gate cannot run"
elif [ -z "$(env_value AUTHZ_TEST_DB)" ]; then
  unverified "security test gate" "AUTHZ_TEST_DB is not set, and verify-all.sh refuses to run without it"
  note "set AUTHZ_TEST_DB to the test database, e.g."
  note "  AUTHZ_TEST_DB=postgresql://user:pass@127.0.0.1:55432/qls_test_0005"
else
  # ---- one gate at a time: check the advisory lock BEFORE trying to take it ----
  if helper_json gate-lock; then
    if printf '%s' "$HELPER_STATUS" | grep -q 'PASS'; then
      GATE_LOCK_FREE=1
    else
      GATE_LOCK_FREE=0
    fi
  else
    GATE_LOCK_FREE=0
  fi

  if [ "$GATE_LOCK_FREE" -ne 1 ]; then
    unverified "security test gate" "another verification run holds the exclusive advisory lock on the shared environment"
    note "verify-all.sh takes an EXCLUSIVE lock (namespace 20812, resource 1) because it"
    note "runs npm run build, whose first step is rm -rf dist — while the running server"
    note "serves static assets out of dist/. Two concurrent gates were proven to poison"
    note "each other. This check SKIPS rather than corrupting the other run."
    note "re-run this predeploy check once the other gate has finished."
  else
    note "exclusive gate lock is free; starting scripts/verify-all.sh"
    note "NOTE: verify-all.sh runs npm run build itself (rm -rf dist first). The"
    note "      running instance serves static assets from dist/, so brief 404s for"
    note "      those assets during the run are expected; API checks are unaffected."
    GATE_LOG="$(tmpfile)"
    AUTHZ_TEST_DB="$(env_value AUTHZ_TEST_DB)" bash scripts/verify-all.sh >"$GATE_LOG" 2>&1
    GATE_RC=$?
    indent < "$GATE_LOG"
    if [ "$GATE_RC" -eq 0 ]; then
      pass "scripts/verify-all.sh passed (exit 0)"
    else
      fail "scripts/verify-all.sh failed (exit $GATE_RC)"
      note "every FAIL line above is a real regression; this is the security gate"
    fi
  fi
fi

# =============================================================================
# 12. dependency audit
# =============================================================================
section "12. Dependency audit (npm audit)"

if ! command -v npm >/dev/null 2>&1; then
  unverified "npm audit" "npm is not on PATH"
else
  AUDIT_JSON="$(tmpfile)"
  AUDIT_LOG="$(tmpfile)"
  AUDIT_ARGS=(audit --json)
  # The configured registry may not implement the advisory endpoint. This repo's
  # .npmrc points at registry.npmmirror.com, which answers 404 [NOT_IMPLEMENTED]
  # for /-/npm/v1/security/audits/quick — the audit then CANNOT run, and saying so
  # is the only honest outcome. Point it at a registry that does by setting
  # PREDEPLOY_AUDIT_REGISTRY=https://registry.npmjs.org
  AUDIT_REGISTRY_OVERRIDE="${PREDEPLOY_AUDIT_REGISTRY:-}"
  if [ -n "$AUDIT_REGISTRY_OVERRIDE" ]; then
    AUDIT_ARGS+=(--registry="$AUDIT_REGISTRY_OVERRIDE")
    note "auditing against explicit registry override (PREDEPLOY_AUDIT_REGISTRY)"
  else
    note "auditing against the configured registry from .npmrc"
  fi
  npm "${AUDIT_ARGS[@]}" >"$AUDIT_JSON" 2>"$AUDIT_LOG" &
  AUDIT_PID=$!
  AUDIT_WAITED=0
  for _ in $(seq 1 "$AUDIT_TIMEOUT_S"); do
    if ! kill -0 "$AUDIT_PID" 2>/dev/null; then AUDIT_WAITED=1; break; fi
    sleep 1
  done
  if [ "$AUDIT_WAITED" -ne 1 ]; then
    kill "$AUDIT_PID" 2>/dev/null || true
    wait "$AUDIT_PID" 2>/dev/null || true
    unverified "npm audit" "did not finish within ${AUDIT_TIMEOUT_S}s (registry unreachable or slow); it was killed, not assumed to pass"
  else
    wait "$AUDIT_PID" 2>/dev/null
    AUDIT_RC=$?
    AUDIT_SUMMARY="$(node -e '
      const fs = require("fs");
      let raw = "";
      try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch { /* handled below */ }
      let j = null;
      try { j = JSON.parse(raw); } catch { /* not JSON */ }
      if (!j || !j.metadata || !j.metadata.vulnerabilities) {
        process.stdout.write("UNPARSEABLE");
        process.exit(0);
      }
      const v = j.metadata.vulnerabilities;
      process.stdout.write(JSON.stringify({
        info: v.info ?? 0, low: v.low ?? 0, moderate: v.moderate ?? 0,
        high: v.high ?? 0, critical: v.critical ?? 0, total: v.total ?? 0,
      }));
    ' "$AUDIT_JSON" 2>/dev/null)"

    if [ "$AUDIT_SUMMARY" = "UNPARSEABLE" ] || [ -z "$AUDIT_SUMMARY" ]; then
      # Report WHY, in one bounded line, and say when it was cut: an ellipsis is
      # the difference between "that is all npm said" and "there is more".
      ERR_FULL="$(tr '\n' ' ' < "$AUDIT_LOG" 2>/dev/null | tr -s ' ')"
      ERR_LINE="$(printf '%s' "$ERR_FULL" | cut -c1-220)"
      if [ "${#ERR_FULL}" -gt 220 ]; then
        ERR_LINE="${ERR_LINE} …[truncated]"
      fi
      unverified "npm audit" "could not be run (exit $AUDIT_RC): ${ERR_LINE:-no output from npm}"
      note "npm audit needs a registry that implements the advisory endpoint. If your"
      note "registry does not (or the box is air-gapped), this is NOT VERIFIED — never"
      note "reported as a pass. Run it against the public registry, e.g."
      note "  npm audit --registry=https://registry.npmjs.org --json"
    else
      note "severity counts: $AUDIT_SUMMARY"
      HIGH="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).high))' "$AUDIT_SUMMARY" 2>/dev/null)"
      CRIT="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).critical))' "$AUDIT_SUMMARY" 2>/dev/null)"
      TOTAL="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).total))' "$AUDIT_SUMMARY" 2>/dev/null)"
      if [ "${CRIT:-0}" -gt 0 ]; then
        fail "npm audit reports ${CRIT} CRITICAL vulnerability(ies)"
      elif [ "${HIGH:-0}" -gt 0 ]; then
        fail "npm audit reports ${HIGH} HIGH vulnerability(ies)"
      else
        pass "npm audit ran and reports no HIGH or CRITICAL vulnerabilities (total: ${TOTAL:-0})"
        if [ "${TOTAL:-0}" -gt 0 ]; then
          note "${TOTAL} lower-severity advisory(ies) remain — recorded, not ignored"
        fi
      fi
    fi
  fi
fi

# =============================================================================
# summary
# =============================================================================
section "Summary"

printf 'checks run      : %d\n' "$CHECK_INDEX"
printf 'failures        : %d\n' "$FAILURES"
printf 'warnings        : %d\n' "$WARNINGS"

if [ "${#WAIVED[@]}" -gt 0 ]; then
  echo
  echo "documented, non-blocking waivers (${#WAIVED[@]}):"
  for w in "${WAIVED[@]}"; do
    printf '  - %s\n' "$w"
  done
fi

if [ "${#UNVERIFIED[@]}" -gt 0 ]; then
  echo
  echo "UNVERIFIED — NOT counted as passing (${#UNVERIFIED[@]}):"
  for u in "${UNVERIFIED[@]}"; do
    printf '  - %s\n' "$u"
  done
fi

echo
if [ "$FAILURES" -eq 0 ] && [ "${#UNVERIFIED[@]}" -eq 0 ]; then
  echo "READY FOR PRODUCTION"
  exit 0
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "reason: $FAILURES failing check(s)"
else
  echo "reason: no check failed, but ${#UNVERIFIED[@]} item(s) could not be verified"
  echo "        (an item that could not be checked is NOT a pass)"
fi
echo "NOT READY FOR PRODUCTION"
exit 1
