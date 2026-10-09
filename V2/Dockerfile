# V2 生产镜像（多阶段）
# ============================================================================
# 三条硬要求（业主 Stage 12 §2）：
#   · non-root：运行阶段用非 root 用户（uid 10001），没有 shell 的多余权限
#   · healthcheck：镜像自带 HEALTHCHECK，指向 /api/health/ready（会真的查数据库）
#   · production dependencies：运行阶段只装 `--omit=dev`，devDeps 一个都不进镜像
#
# 另外两条同样重要：
#   · **没有 dev secret**：镜像里不写任何密钥；`V2_ALLOW_DEV_SECRETS` 绝不出现在这里，
#     缺密钥时进程会**启动失败**（见 server/config.ts）——那是刻意的。
#   · **没有本地测试数据**：.dockerignore 把 tests/、.migration/（含生产快照）、
#     credentials/、.devtools/、.devdata/ 全部挡在构建上下文之外。
#
# 分层（让改代码不用重装依赖）：
#   1) deps      → 只按 package*.json 装依赖（这一层被缓存）
#   2) build     → 拷贝源码 + 构建（nest build + vite build + check-dist）
#   3) prod-deps → 只装生产依赖
#   4) runtime   → 只拷 dist + 生产依赖，非 root 跑

# ── 1. 依赖 ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── 2. 构建 ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# ⚠️ `postcss.config.mjs` 必须在这里 —— Tailwind v4 是**通过它**接进 Vite 的
#    （`vite.config.mts` 里只有 `react()` 插件，没有 `@tailwindcss/vite`）。
#    漏掉它的后果不是构建失败，而是**构建"成功"、页面却是裸 HTML**：
#    Vite 只会把 `@import 'tailwindcss'` 原样内联（theme/preflight 两份源文件），
#    `@theme` 与所有工具类都不会被展开 —— 首页/登录页挤在左上角。
#    2026-10-08 的演练镜像就是这么出来的（`index-fJHUGZie.css` 里 `.flex` 一个都没有）。
#    现在还有 `scripts/check-client-assets.mjs` 兜底：真漏了会直接让构建失败。
COPY package.json package-lock.json nest-cli.json tsconfig*.json vite.config.mts postcss.config.mjs ./
COPY scripts ./scripts
COPY shared ./shared
COPY server ./server
COPY client ./client
# 构建链自带两道自检：check-dist（产物必须比源文件新）与 prepare-build（先清 dist）
RUN npm run build

# ── 3. 生产依赖 ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ── 4. 运行 ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SERVER_PORT=3300 \
    NODE_OPTIONS=--enable-source-maps

# 只装运行一个 Node 服务需要的东西；不装 curl/wget（healthcheck 用 node 自己）
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 迁移与运维脚本进镜像：生产迁移（V1→V2 导入）与 `migrate up` 都要能在容器里跑，
# 否则部署就得依赖"某台机器上恰好有一份完整的仓库"。它们只是代码，不含任何数据。
COPY database ./database
COPY scripts ./scripts

# 非 root：固定 uid/gid，便于挂卷时对权限（10001:10001）
RUN groupadd --gid 10001 v2 \
 && useradd --uid 10001 --gid 10001 --shell /usr/sbin/nologin --create-home v2 \
 && chown -R v2:v2 /app
USER v2

EXPOSE 3300

# readiness 会真的查数据库：数据库不可达时它返回非 200（业主 §15）。
# 用 node 内置 fetch，不依赖 curl（slim 镜像里没有）。
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||3300)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 当 PID 1：正确转发信号、回收僵尸进程（Node 不该同时干这两件事）
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
