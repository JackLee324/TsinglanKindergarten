#!/usr/bin/env bash
# =============================================================================
# scripts/repair-local-native-bindings.sh — 修复 macOS/arm64 上被 npm 剪掉的本地绑定
# =============================================================================
#
# 为什么需要这个脚本
# ------------------
# `package-lock.json` 是 **linux/x64 专用**的：它记录的平台门控可选依赖全部是
# `os: ["linux"], cpu: ["x64"]`，**darwin/arm64 条目为 0 条**（已实测确认）。
#
# 后果：在这台 macOS/arm64 机器上，**任何** `npm install` 都会按 lockfile 重新解析
# 可选依赖，并把 lockfile 里没有的本机原生绑定**删掉**：
#
#     @swc/core-darwin-arm64          ← nest build 必需，缺了报
#                                        "Failed to load @swc/cli and/or @swc/core"
#     @rolldown/binding-darwin-arm64  ← vite build 必需
#     lightningcss-darwin-arm64       ← vite/postcss 必需
#     @tailwindcss/oxide-darwin-arm64 ← tailwind 必需
#
# 这不是本项目的 bug，是"lockfile 为发布目标平台生成 + 开发机是另一个平台"的必然结果。
# DEPLOYMENT_PRODUCTION.md §6 与 §7.2 都记录过同一现象（npm ci 在 macOS 上会破坏本地
# 依赖树，但不要为了本地而重建 lockfile —— 那会丢掉 linux 条目）。
#
# 本脚本**不修改** package.json 与 package-lock.json：它只把缺失的绑定从 npm registry
# 取回 node_modules。发布用的 lockfile 保持 linux/x64 不变，这是刻意的。
#
# 用法：
#   bash scripts/repair-local-native-bindings.sh          # 只补缺失的
#   bash scripts/repair-local-native-bindings.sh --check  # 只检查，不下载（CI 用）
#
# 退出码：0 全部就位；1 仍有缺失
# =============================================================================

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# 平台判定：只有 darwin/arm64 需要这套修复
PLATFORM="$(uname -s)-$(uname -m)"
if [ "$PLATFORM" != "Darwin-arm64" ]; then
  echo "平台是 $PLATFORM，不需要本机绑定修复（lockfile 的 linux/x64 与此匹配）。"
  exit 0
fi

FAIL=0

# name|version  —— 版本取自各父包在本机 node_modules 里的 optionalDependencies，
# 保证补回来的是**正好匹配**的那一版，而不是随手一个新版。
resolve_version() {
  local parent_pkg="$1" binding="$2"
  node -e '
    const fs=require("fs");
    try {
      const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      process.stdout.write(String((j.optionalDependencies||{})[process.argv[2]] || ""));
    } catch { process.stdout.write(""); }
  ' "$parent_pkg" "$binding" 2>/dev/null
}

check_and_fix() {
  local binding="$1" parent_pkg="$2"
  if [ -d "node_modules/$binding" ]; then
    printf '  ✓ %-42s 已就位\n' "$binding"
    return 0
  fi
  local ver; ver="$(resolve_version "$parent_pkg" "$binding")"
  if [ -z "$ver" ]; then
    printf '  ✗ %-42s 缺失，且无法从 %s 解析所需版本\n' "$binding" "$parent_pkg"
    FAIL=1
    return 1
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    printf '  ✗ %-42s 缺失（需要 @%s）\n' "$binding" "$ver"
    FAIL=1
    return 1
  fi
  local tmp; tmp="$(mktemp -d)"
  local url="https://registry.npmjs.org/$binding/-/$(basename "$binding")-$ver.tgz"
  if curl -sSL --max-time 120 "$url" -o "$tmp/p.tgz" && tar -xzf "$tmp/p.tgz" -C "$tmp" 2>/dev/null; then
    mkdir -p "node_modules/$binding"
    cp -R "$tmp/package/." "node_modules/$binding/"
    printf '  ✓ %-42s 已补齐 @%s\n' "$binding" "$ver"
  else
    printf '  ✗ %-42s 下载失败: %s\n' "$binding" "$url"
    FAIL=1
  fi
  rm -rf "$tmp"
}

echo "本机原生绑定检查（平台 $PLATFORM）"
echo "说明：npm install 会按 linux/x64 的 lockfile 剪掉这些包，属于已知且已记录的行为。"
echo
check_and_fix "@swc/core-darwin-arm64"           "node_modules/@swc/core/package.json"
check_and_fix "@rolldown/binding-darwin-arm64"   "node_modules/rolldown/package.json"
check_and_fix "lightningcss-darwin-arm64"        "node_modules/lightningcss/package.json"
check_and_fix "@tailwindcss/oxide-darwin-arm64"  "node_modules/@tailwindcss/oxide/package.json"
echo

if [ "$FAIL" -eq 0 ]; then
  echo "✅ 全部就位。构建可用。"
  exit 0
fi
echo "❌ 仍有缺失 —— 构建（nest build / vite build）会失败。"
exit 1
