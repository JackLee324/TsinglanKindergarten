#!/usr/bin/env bash
# =============================================================================
# scripts/verify-live.sh — 上线后**真实验收**（对着公网入口跑）
# =============================================================================
#
# 与 scripts/predeploy-check.sh 的分工（两者不可互相替代）：
#
#   predeploy-check.sh   回答"这台机器上，我准备部署的这个环境是否就绪"
#                        查的是**本机进程环境** + 本机可达的实例。
#   本脚本（verify-live）回答"部署到线上后，用户真正会遇到的入口是否正常"
#                        查的是**公网 HTTPS 入口**：TLS、HSTS、Cookie 属性、
#                        反代是否真的覆写了 X-Forwarded-For。
#
# 为什么必须单独有它：predeploy 里有好几项在部署机上永远无法验证 ——
#   * 反代下的 trust proxy 行为（伪造 XFF 会不会影响 req.ip）
#   * TLS 下 Cookie 是否真的带 Secure
#   * HSTS 在 HTTPS 下是否出现、在纯 HTTP 下是否**不**出现
# DEPLOYMENT_PRODUCTION.md §12.2 把这几条明确列为"必须在部署环境复核"。
#
# 用法：
#   bash scripts/verify-live.sh --base https://qls.example.com
#   bash scripts/verify-live.sh --base https://qls.example.com --allow-http-fallback
#
# 退出码：0 全部通过；1 存在失败项（**不能**因为"查不了"就返回 0）
#
# ⚠️ 本机无法验证本脚本：这里没有公网域名、没有 TLS。脚本本身在本机用
#    --base http://127.0.0.1:3200 跑过（HTTP 分支），HTTPS 分支未实测。
# =============================================================================

set -uo pipefail

BASE=""
ALLOW_HTTP=0
for arg in "$@"; do
  case "$arg" in
    --base=*) BASE="${arg#--base=}" ;;
    --base) shift; BASE="${1:-}" ;;
    --allow-http-fallback) ALLOW_HTTP=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  esac
done

if [ -z "$BASE" ]; then
  echo "必须给 --base，例如 --base https://qls.example.com" >&2
  exit 2
fi
BASE="${BASE%/}"

FAILURES=0
WARNINGS=0
pass()  { printf '  PASS  %s\n' "$1"; }
bad()   { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES+1)); }
warn()  { printf '  WARN  %s\n' "$1"; WARNINGS=$((WARNINGS+1)); }
info()  { printf '        %s\n' "$1"; }

# 取 HTTP 状态码。curl 连不上时 %{http_code} **已经**输出 000，
# 所以这里绝不能写 `|| echo 000` —— 那会拼出 "000000"（实测踩过）。
# 只把空输出兜底成 000。
http_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null)"
  [ -z "$code" ] && code="000"
  printf '%s' "$code"
}

echo "== 线上验收 =="
echo "入口: $BASE"
echo "时间: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo

# -----------------------------------------------------------------------------
# 0. 必须走 HTTPS
# -----------------------------------------------------------------------------
echo "-- 传输层"
case "$BASE" in
  https://*)
    pass "入口使用 HTTPS"
    ;;
  http://*)
    if [ "$ALLOW_HTTP" -eq 1 ]; then
      warn "入口是 HTTP（显式允许）。生产下这是不可接受的："
      info "会话 Cookie 强制 Secure、平台 CSRF cookie 硬编码 Secure; SameSite=None，"
      info "纯 HTTP 下**根本无法登录**，且会话明文暴露。"
    else
      bad "入口是 HTTP。生产必须 HTTPS（见上：HTTP 下登录不了）"
    fi
    ;;
  *)
    bad "无法识别的入口协议: $BASE"
    ;;
esac

# TLS 证书与过期时间（仅 https）
if [ "${BASE#https://}" != "$BASE" ]; then
  HOSTPORT="${BASE#https://}"; HOSTPORT="${HOSTPORT%%/*}"
  HOST="${HOSTPORT%%:*}"
  if command -v openssl >/dev/null 2>&1; then
    CERT="$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null)"
    if [ -n "$CERT" ]; then
      pass "TLS 证书可获取"
      printf '%s\n' "$CERT" | sed 's/^/        /'
      NOTAFTER="$(printf '%s\n' "$CERT" | sed -n 's/^notAfter=//p')"
      if [ -n "$NOTAFTER" ]; then
        END="$(date -j -f '%b %d %H:%M:%S %Y %Z' "$NOTAFTER" +%s 2>/dev/null || date -d "$NOTAFTER" +%s 2>/dev/null || echo '')"
        NOW="$(date +%s)"
        if [ -n "$END" ]; then
          DAYS=$(( (END - NOW) / 86400 ))
          if [ "$DAYS" -lt 0 ]; then bad "TLS 证书**已过期**"
          elif [ "$DAYS" -lt 14 ]; then bad "TLS 证书 ${DAYS} 天后过期 —— 立刻续期"
          elif [ "$DAYS" -lt 30 ]; then warn "TLS 证书 ${DAYS} 天后过期"
          else pass "TLS 证书还有 ${DAYS} 天到期"; fi
        fi
      fi
    else
      warn "无法读取 TLS 证书（openssl s_client 失败）—— 未验证，不算通过"
    fi
  else
    warn "本机无 openssl，跳过证书检查（未验证）"
  fi
fi
echo

# -----------------------------------------------------------------------------
# 1. 健康与就绪
# -----------------------------------------------------------------------------
echo "-- 健康检查"
for path in /api/health /api/health/ready; do
  OUT="$(mktemp -t qls-live)"
  CODE="$(curl -s -o "$OUT" -w '%{http_code}' --max-time 15 "$BASE$path" 2>/dev/null)"
  [ -z "$CODE" ] && CODE="000"
  if [ "$CODE" = "200" ]; then
    pass "GET $path -> 200"
    # awk 而非 sed：sed 不会给缺少结尾换行的末行补换行，
    # JSON 响应体后面会直接粘上下一条状态行（这个坑在 predeploy 里踩过一次）。
    awk '{ print "        " $0 }' < "$OUT"
  else
    bad "GET $path -> $CODE"
    awk '{ print "        " $0 }' < "$OUT" 2>/dev/null || true
  fi
  rm -f "$OUT"
done

OUT="$(mktemp -t qls-live)"
CODE="$(curl -s -o "$OUT" -w '%{http_code}' --max-time 15 "$BASE/" 2>/dev/null)"
[ -z "$CODE" ] && CODE="000"
if [ "$CODE" = "200" ] && grep -q '<!DOCTYPE html' "$OUT" 2>/dev/null; then
  pass "GET / -> 200 且是 HTML 文档（SPA 外壳经服务端渲染，CSRF/用户上下文占位符才会被替换）"
else
  bad "GET / -> $CODE 或响应体不是 HTML"
fi
rm -f "$OUT"
echo

# -----------------------------------------------------------------------------
# 2. 安全响应头 + HSTS 的正确行为
# -----------------------------------------------------------------------------
echo "-- 安全响应头"
H="$(curl -s -D - -o /dev/null --max-time 15 "$BASE/api/health" 2>/dev/null | tr 'A-Z' 'a-z')"
for h in x-content-type-options x-frame-options referrer-policy cross-origin-opener-policy \
         cross-origin-resource-policy permissions-policy; do
  printf '%s' "$H" | grep -q "^$h:" && pass "存在: $h" || bad "缺失: $h"
done
printf '%s' "$H" | grep -q '^x-powered-by:' && bad "暴露 X-Powered-By（应被安全中间件移除）" \
  || pass "未暴露 X-Powered-By"

case "$BASE" in
  https://*)
    printf '%s' "$H" | grep -q '^strict-transport-security:' \
      && pass "HSTS 已下发（HTTPS 下必须出现）" \
      || bad "HTTPS 入口没有 HSTS —— 检查 HTTPS_ENABLED/TRUST_PROXY 是否真的传给了进程"
    ;;
  http://*)
    printf '%s' "$H" | grep -q '^strict-transport-security:' \
      && warn "纯 HTTP 下也下发了 HSTS（浏览器会忽略；若进程以为自己在 TLS 后面，说明 TRUST_PROXY/HTTPS_ENABLED 配置与实际拓扑不符）" \
      || pass "纯 HTTP 下未下发 HSTS（符合安全中间件的 gating 逻辑）"
    ;;
esac

if printf '%s' "$H" | grep -q '^content-security-policy'; then
  MODE="$(printf '%s' "$H" | grep -m1 '^content-security-policy' | cut -d: -f1)"
  case "$MODE" in
    *report-only*) warn "CSP 处于 report-only（只上报不拦截）—— 属刻意取舍，启用前需先看 violation 上报" ;;
    *) pass "CSP 处于强制模式" ;;
  esac
else
  warn "没有 Content-Security-Policy（CSP_MODE=off？）"
fi
echo

# -----------------------------------------------------------------------------
# 3. Cookie 属性 —— 只有真入口才看得到
# -----------------------------------------------------------------------------
echo "-- Cookie 属性"
COOKIES="$(curl -s -D - -o /dev/null --max-time 15 "$BASE/api/health" 2>/dev/null | grep -i '^set-cookie:' || true)"
if [ -z "$COOKIES" ]; then
  info "该请求未下发任何 Set-Cookie（/api/health 是公开探针，属正常）。"
  info "改用登录页取样："
  COOKIES="$(curl -s -D - -o /dev/null --max-time 15 "$BASE/" 2>/dev/null | grep -i '^set-cookie:' || true)"
fi
if [ -n "$COOKIES" ]; then
  printf '%s\n' "$COOKIES" | sed 's/^/        /'
  if [ "${BASE#https://}" != "$BASE" ]; then
    if printf '%s' "$COOKIES" | grep -qi 'secure'; then
      pass "至少一个 cookie 带 Secure"
    else
      bad "HTTPS 入口下发的 cookie 没有 Secure 属性"
    fi
    if printf '%s' "$COOKIES" | grep -qi 'httponly'; then
      pass "至少一个 cookie 带 HttpOnly"
    else
      warn "下发 cookie 未见 HttpOnly（会话 cookie 应当有；平台 CSRF cookie 可能刻意开放给 JS，需人工判断）"
    fi
    if printf '%s' "$COOKIES" | grep -qi 'samesite=none' && ! printf '%s' "$COOKIES" | grep -qi 'secure'; then
      bad "存在 SameSite=None 但没有 Secure 的 cookie —— 浏览器会直接丢弃"
    fi
  fi
else
  warn "拿不到任何 Set-Cookie，Cookie 属性**未验证**（不算通过）"
fi
echo

# -----------------------------------------------------------------------------
# 4. trust proxy：伪造 XFF 是否影响审计归因
# -----------------------------------------------------------------------------
echo "-- trust proxy / 客户端 IP 归因"
info "原理：应用把 req.ip 写入 audit_logs.ip_address，并用于按 IP 的登录限流。"
info "若 Express 轻信 X-Forwarded-For，攻击者轮换该头即可绕过限流且审计不可归因。"
info "这条**必须人工对照**：脚本只能证明'我不带 XFF 与带 XFF 的响应没有差异'，"
info "不能替你确认审计表里那行到底是什么。"
NOXFF="$(http_code "$BASE/api/health")"
WITHXFF="$(http_code -H 'X-Forwarded-For: 203.0.113.99' "$BASE/api/health")"
if [ "$NOXFF" = "200" ] && [ "$WITHXFF" = "200" ]; then
  pass "带/不带伪造 XFF 的请求都能正常服务（不代表 IP 归因正确，需人工查 audit_logs）"
  info "人工复核：登录一次后执行"
  info "  SELECT ip_address, action, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5;"
  info "  伪造头为 203.0.113.99；若表里出现该值，说明 TRUST_PROXY 设置过于宽松。"
else
  warn "带 XFF 的请求返回 $WITHXFF（不带时 $NOXFF）—— 无法据此判断，需人工复核"
fi
echo

# -----------------------------------------------------------------------------
# 5. CORS 仍是限制性默认
# -----------------------------------------------------------------------------
echo "-- CORS"
n="$(curl -s -D - -o /dev/null --max-time 15 -H 'Origin: https://cors-probe.invalid' "$BASE/api/health" 2>/dev/null | grep -ci '^access-control-allow' || true)"
[ "${n:-0}" -gt 0 ] && bad "对外来 Origin 返回了 $n 个 Access-Control-Allow-* 头" \
  || pass "对外来 Origin 无 CORS 授权（限制性默认）"
echo

# -----------------------------------------------------------------------------
# 6. 未认证访问必须 401
# -----------------------------------------------------------------------------
echo "-- 鉴权边界"
CODE="$(http_code "$BASE/api/teachers")"
case "$CODE" in
  401) pass "未认证访问 /api/teachers -> 401" ;;
  403) warn "未认证访问 /api/teachers -> 403（可以接受，但 401 更准确）" ;;
  200) bad "未认证访问 /api/teachers -> 200 —— 鉴权边界有问题" ;;
  404) warn "/api/teachers -> 404，路径可能不对，鉴权边界**未验证**" ;;
  *)   warn "/api/teachers -> $CODE，无法判断（未验证）" ;;
esac

# -----------------------------------------------------------------------------
# 结论
# -----------------------------------------------------------------------------
echo
echo "== 结论 =="
printf '  failures: %d   warnings: %d\n' "$FAILURES" "$WARNINGS"
if [ "$FAILURES" -eq 0 ]; then
  echo "  ✅ 线上验收未发现失败项"
  [ "$WARNINGS" -gt 0 ] && echo "  ⚠️  但上面有 $WARNINGS 条 WARN —— 逐条判断，WARN 不是 PASS"
  echo "  仍需人工完成的几条（脚本查不了）："
  echo "    - audit_logs 里的 IP 归因是否可信（见第 4 节的人工复核命令）"
  echo "    - 用真实超级管理员账号登录一次，并验证一个恢复码"
  echo "    - 文件上传/下载走一遍（dataloom 是否真的可用）"
  echo "    - 备份/恢复演练（DISASTER_RECOVERY.md §8）"
  exit 0
fi
echo "  ❌ 存在 $FAILURES 条失败项 —— 不要宣布上线成功"
exit 1
