#!/usr/bin/env bash
# ============================================================
# 开发环境启动（`npm run dev` 的目标）
# ============================================================
# FIX (production hardening): `package.json` declared `"dev": "./scripts/dev.sh"` but this
# file never existed in the repository, so `npm run dev` — the command documented in
# README.md §5 — failed immediately with "No such file or directory".
#
# This starts the NestJS server (watch mode) and the Vite dev server together using the
# `concurrently` dependency that is already in devDependencies.
#
# The Vite dev server proxies /api to the NestJS server via the lark-apaas Vite preset,
# and must be reached over the SAME ORIGIN as the backend so that the HttpOnly session
# cookie and the `suda-csrf-token` cookie are sent (see PRODUCTION_READINESS.md §D-0/D-1).
# Note: the platform CSRF cookie is issued with `secure: true`, so browsers reject it over
# plain HTTP. For local development open the app via the server port (which serves the
# built client) or run behind a local HTTPS proxy — see DEPLOYMENT_PRODUCTION.md.
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SERVER_HOST="${SERVER_HOST:-localhost}"
SERVER_PORT="${SERVER_PORT:-3000}"

if [ ! -f .env ]; then
  echo "[dev] 提示：未找到 .env，将使用内置默认值。"
  echo "[dev]       可执行  cp .env.example .env  并按 DEPLOYMENT_PRODUCTION.md 填写。"
fi

echo "[dev] 后端: http://${SERVER_HOST}:${SERVER_PORT}"
echo "[dev] 前端: Vite 默认 5173（由 Vite 预设决定）"
echo "[dev] 按 Ctrl+C 同时停止两个进程"
echo

exec npx concurrently \
  --names "server,client" \
  --prefix-colors "blue,green" \
  --kill-others-on-fail \
  "npm run dev:server" \
  "npm run dev:client"
