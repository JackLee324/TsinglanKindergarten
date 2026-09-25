# syntax=docker/dockerfile:1.7
# =============================================================================
# 清澜山幼儿园教师课程资源平台 — production container image
# =============================================================================
#
# ⚠️  THIS IMAGE HAS NEVER BEEN BUILT OR RUN. THERE IS NO DOCKER ON THE MACHINE
#     WHERE IT WAS WRITTEN.
#
#     Everything below is therefore correct-by-reading, not observed. It was
#     checked against the repository's real build script (`scripts/build.sh`), the
#     real start command (`package.json:20`), the real lockfile platform entries
#     and the real readiness endpoint — but no `docker build` and no
#     `docker run` has been executed against it. Treat the first build as a
#     debugging session, not a formality.
#
#     The specific things most likely to need adjustment on the first real build
#     are called out inline with `# FIRST-BUILD RISK:`.
#
# WHY THIS TARGET PLATFORM
# ------------------------
# `package-lock.json` is linux/x64 ONLY (lockfileVersion 3; 12 platform entries,
# every one of them `os: ["linux"]`, `cpu: ["x64"]`; zero darwin/arm64 entries —
# see DEPLOYMENT_PRODUCTION.md §6). `npm ci` installs exactly what the lockfile
# records for the current platform, so a linux/amd64 image is the one shape this
# lockfile actually supports. Build it with:
#
#     docker build --platform linux/amd64 -t qls-platform:1.3.0 .
#
# Building on an arm64 host without that flag produces an image whose native
# bindings (@swc/core, @rolldown/binding, lightningcss, @napi-rs/nice,
# @tailwindcss/oxide) do not match the recorded platform.
#
# SECRETS
# -------
# No credential is baked into any layer. Every secret (SUDA_DATABASE_URL,
# MFA_ENCRYPTION_KEY, DOWNLOAD_TOKEN_SECRET, …) is read from the environment at
# run time. Do not "fix" a missing variable with ENV — that writes it into the
# image, where every user with pull access can read it with `docker history`.
#
# SIGNALS
# -------
# `dumb-init` is PID 1 and execs the Node process directly, so SIGTERM/SIGINT are
# delivered to Node itself. A shell wrapper (`sh -c "node …"`) is deliberately NOT
# used: without `exec`, the shell stays PID 1, keeps the signal, and Node is killed
# by SIGKILL after the grace period instead of running its shutdown path. Server
# code adding graceful shutdown must therefore work through `dumb-init` — which it
# does, because the entrypoint `exec`s.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — build
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim

FROM --platform=linux/amd64 ${NODE_IMAGE} AS build

# Build-time only. Never inherited by the runtime stage, so nothing here leaks.
WORKDIR /build

# Dependency layer first: it is by far the slowest step and only invalidates when
# the manifests change.
COPY package.json package-lock.json .npmrc ./

RUN npm ci --no-audit --no-fund

# Sources. Ordered so the most frequently edited trees come last.
COPY tsconfig.json tsconfig.node.json tsconfig.app.json nest-cli.json ./
COPY vite.config.ts postcss.config.js tailwind.config.ts components.json eslint.config.js ./
COPY server ./server
COPY shared ./shared
COPY client ./client
COPY scripts ./scripts

RUN npm run build

# Drop build-only dependencies from the tree that will be copied into the image.
RUN npm ci --omit=dev --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM --platform=linux/amd64 ${NODE_IMAGE} AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=3000

WORKDIR /app

# ---------------------------------------------------------------------------
# Non-root from here on: `qls` (uid/gid 10001) owns everything the process
# touches. The numeric ids are pinned so a bind-mounted volume keeps predictable
# ownership. Nothing in this image needs root at run time.
# ---------------------------------------------------------------------------
RUN groupadd --gid 10001 qls \
 && useradd --uid 10001 --gid 10001 --shell /usr/sbin/nologin --no-create-home qls

# ---------------------------------------------------------------------------
# Runtime payload — exactly what the server reads, nothing else.
#
# The layout is dictated by the application, not by taste:
#   * `npm run start` is `cd dist && NODE_ENV=production node server/main.js`, so
#     the working directory is /app/dist and `server/main.js` sits directly
#     beneath it.
#   * `server/main.ts` sets the views directory to `join(process.cwd(),
#     'dist/client')` — i.e. /app/dist/dist/client from that cwd — which is where
#     scripts/build.sh moves the built index.html. Both paths are required; the
#     HTML is deliberately NOT under /app/dist/client (it must not be published to
#     the public CDN, which is why the build moves rather than copies it).
#   * `dist/client/assets/*` stays out of the same-origin static middleware on
#     purpose (the platform serves hashed bundles from its CDN), so it is served
#     for CDN parity, not by the Node process.
# ---------------------------------------------------------------------------
COPY --chown=qls:qls package.json ./package.json
COPY --chown=qls:qls --from=build /build/dist ./dist
COPY --chown=qls:qls --from=build /build/node_modules ./node_modules

# Migration tooling and the SQL it applies, for
#     docker run --rm -e SUDA_DATABASE_URL=… <image> node scripts/migrate.mjs status
# `scripts/migrate.mjs` resolves `server/database/migrations` relative to its own
# location, so the repository-relative layout must be preserved: scripts/ and
# server/ side by side at /app. The .sql files are NOT emitted into dist/ by the
# build, so without these two copies the image could not report or apply
# migration state — and "cannot verify migration state" is exactly the class of
# gap this project is trying to close.
COPY --chown=qls:qls --from=build /build/server/database ./server/database
COPY --chown=qls:qls --from=build /build/scripts ./scripts
RUN chmod +x ./scripts/*.sh ./scripts/*.mjs

USER qls

# The documented application port. Not a security control — it documents intent
# and lets `-P` publish it; the actual binding comes from SERVER_PORT, which the
# application reads (server/main.ts:85).
EXPOSE 3000

# Liveness, matching what the application actually provides:
#   GET /api/health        liveness  — no dependencies touched, so a slow database
#                                      never causes an orchestrator to kill a
#                                      healthy process.
#   GET /api/health/ready  readiness — touches the database, 503 when not ready.
# Wiring the HEALTHCHECK to /ready would restart the container on a transient
# database blip; the orchestrator's readiness probe is the right consumer for
# that endpoint. See server/modules/health/health.module.ts.
# `node -e` is used rather than `curl`/`wget` because the slim runtime image
# deliberately does not install an HTTP client.
#
# Two details that decide whether this probe works at all:
#   * the host is `localhost`, matching the application's own default bind
#     (server/main.ts: `const host = process.env.SERVER_HOST || 'localhost'`). A
#     literal 127.0.0.1 in the probe is a DIFFERENT address family choice than
#     `localhost` on dual-stack images and can be refused even though the server is
#     up.
#   * the port comes from SERVER_PORT, because EXPOSE is documentation only and
#     the real binding is whatever SERVER_PORT says.
# FIRST-BUILD RISK: Docker health checks run the command directly (no shell here,
# since the exec form is used), so `process.exit(1)` is the only way to report
# failure — there is no `exit 1` available.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "const p=Number(process.env.SERVER_PORT||3000);const r=require('http').get({host:'localhost',port:p,path:'/api/health',timeout:4000},res=>{res.resume();process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)})"]

# dumb-init is PID 1; it execs the CMD below, so the Node process IS the process
# that receives SIGTERM/SIGINT. No shell wrapper, and no `npm` in between.
#
# WHY NOT `npm run start`, even though DEPLOYMENT_PRODUCTION.md §7 documents it:
# `npm run start` resolves to `cd dist && NODE_ENV=production node server/main.js`
# — npm spawns `sh`, which spawns node. npm does forward the signals it receives,
# but that is a three-process chain whose behaviour varies by npm version, and the
# constraint on the graceful-shutdown work landing in server/main.ts is explicit:
# the entrypoint must deliver signals to the Node process and must not swallow
# them in a shell wrapper. So node is exec'd directly, with the working directory
# set to where `npm run start` would put it (/app/dist). `process.cwd()` — and
# therefore the views directory, `join(process.cwd(), 'dist/client')` — is
# identical to the documented start, so nothing about the app's behaviour changes.
WORKDIR /app/dist
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/scripts/entrypoint.sh"]
CMD ["node", "server/main.js"]
