import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  configureApp,
  DrizzleDatabaseManager,
  FileService,
} from '@lark-apaas/fullstack-nestjs-core';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';
import http, { type Server } from 'http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HealthService } from './modules/health/health.module';
import {
  resolveTrustProxySetting,
  describeTrustProxy,
} from './common/http/client-ip';
import {
  securityHeaders,
  describeSecurityHeaders,
} from './common/http/security-headers.middleware';

// =============================================================================
// Graceful shutdown
// =============================================================================
//
// EXIT CODE CONTRACT (asserted by `scripts/verify-shutdown.sh`)
//   0  the process drained in-flight requests and closed everything it owns
//   1  shutdown was UNCLEAN: a close step failed, or the force-exit timeout fired
//      because something (typically a hung request) was still pending
//
// THE ORDER IS LOAD-BEARING, AND `app.close()` ALONE CANNOT DO IT
// ---------------------------------------------------------------
// Nest runs the teardown in this order (verified in the installed @nestjs/core
// 10.4.22, `nest-application-context.js`):
//
//   1. onModuleDestroy()          <- the platform's DataPaas provider closes the
//   2. beforeApplicationShutdown()   PostgreSQL pool HERE, before anything else
//   3. dispose()                  <- ONLY NOW does Nest stop the HTTP server
//   4. onApplicationShutdown()
//
// so `await app.close()` on its own closes the database while requests are still
// being served: every in-flight request that needs a row is torn down instead of
// drained. This file therefore drains FIRST — `httpServer.close()` stops accepting
// and invokes its callback only once every connection has ended — and runs the
// framework teardown afterwards. Under Node >= 19 a socket that is idle (keep-alive)
// is closed by `close()` itself, while a socket that is still sending a request or
// waiting for a response is NOT idle and is left alone, which is exactly the
// in-flight set; the periodic `closeIdleConnections()` sweep then releases sockets
// that BECOME idle after `close()` was called (the one that just finished its
// response) instead of waiting out their keep-alive timeout.
//
// MEASURED PLATFORM DEFECT: `app.close()` CANNOT COMPLETE IN THIS APPLICATION
// --------------------------------------------------------------------------
// `DRIZZLE_DATABASE` is not a database — it is a Proxy whose `get` trap calls
// `DrizzleDatabaseManager.getDatabase()` for EVERY property read:
//
//     provide: DRIZZLE_DATABASE,
//     useFactory: async (manager) => new Proxy({}, { get: (_t, prop) => {
//       const db = manager.getDatabase();          // throws once disconnected
//       ...
//
// (verified in node_modules/@lark-apaas/nestjs-datapaas/dist/index.cjs ~line 944).
// Nest, meanwhile, decides which hooks to run by READING A PROPERTY on every provider
// instance (`hasBeforeApplicationShutdownHook` -> `instance.beforeApplicationShutdown`
// -> ...). Because `onModuleDestroy()` has already disconnected the pool by then
// (step 1 above), that property read throws:
//
//     Error: Database not initialized. Call initialize() first.
//         at DrizzleDatabaseManager.getDatabase (nestjs-datapaas/dist/index.cjs:305)
//         at Object.get (nestjs-datapaas/dist/index.cjs:944)
//         at FilterIterator.hasBeforeApplicationShutdownHook
//             (@nestjs/core/hooks/before-app-shutdown.hook.js:13)
//         at callBeforeAppShutdownHook (@nestjs/core/hooks/before-app-shutdown.hook.js:42)
//
// Reproduced with a bare `NestFactory.create(AppModule)` + `app.close()` and NOTHING
// from this file in the picture, so it is the platform's, not this sequence's. Its
// consequences are handled explicitly below:
//   * `app.close()` rejects. That rejection is reported in full and, ONLY when this
//     process can still prove every resource is closed (database disconnected, HTTP
//     listener gone), it is downgraded from "failed step" to a reported WARN — a
//     shutdown that closed everything must not be reported to an orchestrator as
//     unclean. Any other failure stays a failed step and exits 1.
//   * Nest's `dispose()` never runs, so the HTTP server is closed by step 1 of this
//     file rather than by the framework. That is not a gap: it is the reason step 1
//     exists.
//   * `beforeApplicationShutdown`/`onApplicationShutdown` hooks in the tree do not
//     run. Nothing in this application implements either (verified: `grep -rn
//     onApplicationShutdown server/` is empty); the one platform provider that does
//     (`NestjsCacheModule`, disposing its store) is driven by `MIAODA_CACHE_URL`,
//     which is unset here — the platform logs "cache-service will be effectively
//     disabled" at boot. The WARN below names the hooks that were skipped so the
//     next person inherits the fact rather than the surprise.
//
// IDEMPOTENCE: the sequence runs at most once per process. A second signal while it
// is running is logged and ignored; it does not start a second teardown, cannot
// deadlock, and does not abandon the drain ("press Ctrl-C twice to kill it" would
// silently drop in-flight requests).
//
// THE SESSION-CLEANUP TIMER: `AuthService.onModuleInit()` starts an un-`unref()`ed
// `setInterval(..., 1h)`. That timer — and any other pending handle — is why the clean
// path ends with an explicit `process.exit(0)` instead of returning and letting the
// event loop decide: once every resource this process owns is closed, exiting is the
// defined outcome, whereas "wait for the loop to empty" would hang for an hour on a
// timer no code path here can reach (`server/modules/auth/**` is not this file's to
// change, and un-ref'ing it would change when sessions are pruned). If a close step or
// an in-flight request outlives the deadline, the force timer exits 1 instead — the
// process always terminates, and it always says how.

const SHUTDOWN_TIMEOUT_ENV = 'SHUTDOWN_TIMEOUT_MS';

/**
 * 10s by default: long enough for an ordinary request, short enough to stay well
 * inside the 30s `terminationGracePeriodSeconds` a Kubernetes deployment uses by
 * default, so the orchestrator never has to SIGKILL before this process reports.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** How often idle keep-alive sockets are released during the drain. */
const IDLE_CONNECTION_SWEEP_MS = 50;

/**
 * How long the process stays alive after the last shutdown line so that line actually
 * reaches the operator.
 *
 * MEASURED REASON: the platform's log pipeline is not synchronous. `AppLogger` is
 * pino with `level: 'silent'` outside development, and every record is exported by
 * `@lark-apaas/observable`'s OpenTelemetry `BatchLogRecordProcessor`
 * (`scheduledDelayMillis: 2000`, `maxExportBatchSize: 1`), whose exporter writes the
 * batch from a promise. `process.exit()` — which this file must call, see the header —
 * ends the process before that promise runs, and the records written in the last
 * moments are LOST. Observed before this window existed: a SIGTERM shutdown printed
 * "SIGTERM received…", "stopped accepting new connections…" and "database: PostgreSQL
 * pool closed…" and then the process exited **0 with no "finished cleanly" line at
 * all** — i.e. exactly the line an operator needs was the one that vanished, while the
 * exit code said everything was fine.
 *
 * 250ms is a bounded, explicit drain of the exporter rather than a guess: the batch is
 * flushed on the next tick (batch size 1), so this is ~100x the time the export needs,
 * and it is spent only after every resource is already closed. It is NOT a retry and
 * masks nothing — nothing is asserted after it.
 */
const LOG_FLUSH_WINDOW_MS = 250;

const EXIT_CODE_CLEAN = 0;
const EXIT_CODE_UNCLEAN = 1;

/**
 * The platform's throw-on-any-property-access Proxy defect (see the header).
 * Matched EXACTLY, so a different failure that happens to mention the database is
 * never mistaken for it.
 */
const PLATFORM_PROXY_SHUTDOWN_ERROR = 'Database not initialized. Call initialize() first.';

interface ShutdownTarget {
  app: NestExpressApplication;
  logger: Logger;
  timeoutMs: number;
}

/** The slice of the platform's DataPaas manager this file needs. */
interface ClosableDatabaseManager {
  isDatabaseConnected(): boolean;
  disconnect(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/**
 * Resolve the force-exit timeout.
 *
 * A configured-but-unusable value is REPORTED rather than silently replaced: an
 * operator who wrote `SHUTDOWN_TIMEOUT_MS=10s` (seconds where milliseconds are meant)
 * must be told which value was used, otherwise the only symptom is a shutdown that
 * takes longer — or shorter — than the one they asked for.
 */
function resolveShutdownTimeoutMs(logger: Logger): { ms: number; description: string } {
  const raw = process.env[SHUTDOWN_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return {
      ms: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      description:
        `shutdown timeout: ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms (default; ` +
        `set ${SHUTDOWN_TIMEOUT_ENV} to override) — after this the process force-exits with code ${EXIT_CODE_UNCLEAN}`,
    };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `${SHUTDOWN_TIMEOUT_ENV}="${raw}" is not a positive whole number of milliseconds; ` +
        `using the default ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms.`,
    );
    return {
      ms: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      description:
        `shutdown timeout: ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms (default; ${SHUTDOWN_TIMEOUT_ENV}="${raw}" was rejected as invalid)`,
    };
  }

  return {
    ms: parsed,
    description:
      `shutdown timeout: ${parsed}ms (from ${SHUTDOWN_TIMEOUT_ENV}) — after this the process force-exits with code ${EXIT_CODE_UNCLEAN}`,
  };
}

/**
 * Stop accepting connections and let in-flight requests finish.
 *
 * Returns a failure description, or null. A failed drain is reported rather than
 * thrown so the caller still closes the database (a stuck listener must not strand
 * the pool) — and still exits non-zero.
 */
async function drainHttpServer(httpServer: Server, logger: Logger): Promise<string | null> {
  if (!httpServer.listening) {
    logger.warn(
      '[shutdown] the HTTP server was not listening (the process was still starting); nothing to drain',
    );
    return null;
  }

  const startedAt = Date.now();
  const sweep = setInterval(() => httpServer.closeIdleConnections(), IDLE_CONNECTION_SWEEP_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    logger.log(
      `[shutdown] stopped accepting new connections; in-flight requests finished after ${Date.now() - startedAt}ms`,
    );
    return null;
  } catch (error) {
    const failure = `HTTP drain failed after ${Date.now() - startedAt}ms: ${errorMessage(error)}`;
    logger.error(`[shutdown] ${failure}`);
    return failure;
  } finally {
    clearInterval(sweep);
  }
}

/**
 * Close the PostgreSQL pool, or verify that the framework already did.
 *
 * This calls the platform's own manager rather than guessing at the postgres.js
 * client behind the Proxy, and it CHECKS the outcome — `disconnect()` that leaves
 * `isDatabaseConnected()` true is reported as a failure, not assumed to have worked.
 * On the normal path `app.close()`'s `onModuleDestroy` has already disconnected the
 * pool, so this is a verification; it becomes the actual close if that hook did not
 * run (a provider that throws earlier in the chain, or a future platform change).
 */
async function closeDatabase(
  manager: ClosableDatabaseManager | null,
  logger: Logger,
): Promise<string | null> {
  if (manager === null) {
    logger.warn(
      '[shutdown] database: no DataPaas database manager in the container; cannot verify the pool state',
    );
    return null;
  }

  try {
    if (manager.isDatabaseConnected()) {
      await manager.disconnect();
      logger.log('[shutdown] database: pool was still connected; closed it explicitly');
    }
  } catch (error) {
    const failure = `database close failed: ${errorMessage(error)}`;
    logger.error(`[shutdown] ${failure}`);
    return failure;
  }

  if (manager.isDatabaseConnected()) {
    const failure = 'the PostgreSQL pool is STILL connected after disconnect()';
    logger.error(`[shutdown] ${failure}`);
    return failure;
  }

  logger.log('[shutdown] database: PostgreSQL pool closed (isDatabaseConnected() === false)');
  return null;
}

/**
 * Close a local storage handle if this build has one.
 *
 * Storage here is dataloom, reached through the platform's `FileService`, which is an
 * HTTP client (`@lark-apaas/file-service`) — verified: neither it nor the `HttpClient`
 * it wraps exposes `close()`/`destroy()`/`end()`, so there is no pool or file handle
 * of ours to release and this is a no-op. It is written out rather than omitted so the
 * shutdown log STATES that fact, and so a future build that does hold a handle closes
 * it here instead of leaking it until the process dies.
 */
async function closeStorageHandleIfPresent(
  storage: unknown,
  logger: Logger,
): Promise<string | null> {
  if (storage === null || storage === undefined) {
    logger.log('[shutdown] storage: no FileService in the container; nothing to close');
    return null;
  }

  const closable = storage as { close?: () => unknown; destroy?: () => unknown };
  const close = closable.close ?? closable.destroy;
  if (typeof close !== 'function') {
    logger.log(
      '[shutdown] storage: FileService holds no local handle (HTTP client: no close()/destroy()); nothing to close',
    );
    return null;
  }

  try {
    await close.call(closable);
    logger.log('[shutdown] storage: closed');
    return null;
  } catch (error) {
    const failure = `storage close failed: ${errorMessage(error)}`;
    logger.error(`[shutdown] ${failure}`);
    return failure;
  }
}

/**
 * Give the platform's batched log exporter the chance to write what was just logged.
 *
 * See `LOG_FLUSH_WINDOW_MS` for the measurement behind this. A failure here cannot be
 * reported through the same logger (it is the thing that may be broken), so it goes to
 * `process.stderr` — the one channel that does not depend on it.
 */
async function flushPlatformLogs(logger: Logger): Promise<void> {
  try {
    await new Promise((resolve) => setTimeout(resolve, LOG_FLUSH_WINDOW_MS));
  } catch (error) {
    // setTimeout itself does not fail; unreachable, and reported rather than swallowed.
    process.stderr.write(`[shutdown] log flush window failed: ${errorMessage(error)}\n`);
    logger.error(`[shutdown] log flush window failed: ${errorMessage(error)}`);
  }
}

/**
 * The whole sequence. Returns the exit code; never throws, and never calls
 * `process.exit()` from a `finally` (an exit inside `finally` reports success for a
 * shutdown that failed — a defect this repository has already been burned by).
 */
async function runShutdown(target: ShutdownTarget, signal: string): Promise<number> {
  const { app, logger, timeoutMs } = target;
  const startedAt = Date.now();
  const failures: string[] = [];

  logger.log(
    `[shutdown] ${signal} received: draining (force-exit after ${timeoutMs}ms with code ${EXIT_CODE_UNCLEAN} if it does not finish)`,
  );

  const forceExit = setTimeout(() => {
    logger.error(
      `[shutdown] FORCE EXIT: the graceful sequence did not finish within ${timeoutMs}ms ` +
        `(still pending at ${Date.now() - startedAt}ms — typically a request that never completes). ` +
        `Exiting with code ${EXIT_CODE_UNCLEAN} so this shutdown is visible as UNCLEAN rather than as a clean exit.`,
    );
    process.exit(EXIT_CODE_UNCLEAN);
  }, timeoutMs);

  // Resolved BEFORE any teardown: after `app.close()` the container may be closing,
  // and these are the handles this sequence has to be able to reach afterwards.
  const httpServer = app.getHttpServer() as Server;
  let databaseManager: ClosableDatabaseManager | null = null;
  try {
    databaseManager = app.get(DrizzleDatabaseManager, { strict: false });
  } catch (error) {
    logger.warn(`[shutdown] could not resolve the DataPaas database manager: ${errorMessage(error)}`);
  }
  let storage: unknown = null;
  try {
    storage = app.get(FileService, { strict: false });
  } catch (error) {
    logger.warn(`[shutdown] could not resolve FileService: ${errorMessage(error)}`);
  }

  // 1. Stop accepting new connections, then wait for in-flight requests to finish.
  const drainFailure = await drainHttpServer(httpServer, logger);
  if (drainFailure) failures.push(drainFailure);

  // 2. Framework teardown. Expected to reject because of the platform Proxy defect
  //    documented in the header; what it does FIRST (onModuleDestroy) is what
  //    matters, and that outcome is verified in step 3 rather than assumed.
  let teardownError: unknown = null;
  try {
    await app.close();
    logger.log(
      '[shutdown] application context closed (module destroy hooks ran; the DataPaas database manager closed the PostgreSQL pool)',
    );
  } catch (error) {
    teardownError = error;
  }

  // 3. Database: verify, and close it here if the framework did not.
  const databaseFailure = await closeDatabase(databaseManager, logger);
  if (databaseFailure) failures.push(databaseFailure);

  // 4. Storage, if this build holds a handle.
  const storageFailure = await closeStorageHandleIfPresent(storage, logger);
  if (storageFailure) failures.push(storageFailure);

  clearTimeout(forceExit);

  // 5. Judge the framework teardown, using what was VERIFIED, not what was assumed.
  if (teardownError !== null) {
    const message = errorMessage(teardownError);
    const listenerClosed = !httpServer.listening;
    const benignPlatformDefect =
      message === PLATFORM_PROXY_SHUTDOWN_ERROR && databaseFailure === null && listenerClosed;

    if (benignPlatformDefect) {
      logger.warn(
        `[shutdown] app.close() reported "${message}" — the platform's DRIZZLE_DATABASE Proxy throws on ANY ` +
          'property read once the pool is disconnected, and Nest reads a property on every provider while ' +
          'choosing shutdown hooks (@nestjs/core/hooks/before-app-shutdown.hook.js). Every resource this ' +
          'process owns is closed and verified (database pool disconnected, HTTP listener closed), so this ' +
          'is reported and NOT counted as an unclean shutdown. Consequence: Nest beforeApplicationShutdown/' +
          'onApplicationShutdown hooks did not run — nothing in this application implements either.',
      );
      logger.warn(`[shutdown] app.close() stack (platform defect, reported for the record): ${errorStack(teardownError)}`);
    } else {
      const failure = `app.close() failed: ${message}`;
      failures.push(failure);
      logger.error(`[shutdown] ${failure}`);
      logger.error(`[shutdown] app.close() stack: ${errorStack(teardownError)}`);
    }
  }

  const elapsed = Date.now() - startedAt;
  if (failures.length === 0) {
    logger.log(`[shutdown] graceful shutdown finished cleanly in ${elapsed}ms; exit code ${EXIT_CODE_CLEAN}`);
    return EXIT_CODE_CLEAN;
  }

  logger.error(
    `[shutdown] UNCLEAN shutdown in ${elapsed}ms; exit code ${EXIT_CODE_UNCLEAN}. Failed step(s): ` +
      failures.join(' | '),
  );
  return EXIT_CODE_UNCLEAN;
}

/**
 * Install SIGTERM/SIGINT handling. Called once, before the socket is opened, so a
 * signal during `listen()` is handled too instead of killing the process outright.
 */
function installShutdownHandlers(target: ShutdownTarget): void {
  let phase: 'idle' | 'running' | 'finished' = 'idle';

  const handle = (signal: string): void => {
    if (phase !== 'idle') {
      // Idempotent by construction: this guard is the only thing that starts the
      // sequence, so two signals (or a signal during the drain) can neither run the
      // teardown twice nor deadlock waiting for itself.
      target.logger.warn(
        `[shutdown] ${signal} received while shutdown is already ${phase}; ignoring ` +
          '(the sequence runs exactly once; the drain in progress is not abandoned)',
      );
      return;
    }
    phase = 'running';

    runShutdown(target, signal)
      .then(async (code) => {
        phase = 'finished';
        await flushPlatformLogs(target.logger);
        process.exit(code);
      })
      .catch((error: unknown) => {
        // Unreachable by construction — every step inside `runShutdown` is guarded —
        // and never swallowed if it happens: report, then exit non-zero.
        target.logger.error(
          `[shutdown] shutdown sequence threw unexpectedly: ${errorMessage(error)}; exit code ${EXIT_CODE_UNCLEAN}`,
        );
        process.exit(EXIT_CODE_UNCLEAN);
      });
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => handle(signal));
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Cloud PaaS / standalone compatibility fallback (Zeabur / Render / Railway)
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_CONNECTION_STRING ||
    process.env.POSTGRES_URI ||
    process.env.SUDA_DATABASE_URL;
  if (dbUrl) {
    process.env.DATABASE_URL = process.env.DATABASE_URL || dbUrl;
    process.env.SUDA_DATABASE_URL = process.env.SUDA_DATABASE_URL || dbUrl;
  }
  if (!process.env.FORCE_AUTHN_INNERAPI_DOMAIN) {
    process.env.FORCE_AUTHN_INNERAPI_DOMAIN = 'https://127.0.0.1:1';
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
  });

  // ---------------------------------------------------------------------------
  // Trust proxy  (audit finding D-10)
  // ---------------------------------------------------------------------------
  // `X-Forwarded-For` is client-supplied. Express derives `req.ip` by walking the
  // forwarded chain from the RIGHT and discarding untrusted hops — but only when
  // told which hops to trust. `common/http/client-ip.ts` returns `req.ip` and
  // never parses the header, so the application's behaviour is entirely governed
  // by this setting.
  //
  // The default (unset -> false) is the SAFE one: Express ignores the header and
  // `req.ip` is the unforgeable socket address. That matters because the client IP
  // feeds the per-IP login rate limit and every `audit_logs.ip_address` row; if it
  // can be forged, brute-force protection is bypassed and intrusions cannot be
  // attributed.
  const trustProxy = resolveTrustProxySetting();

  // ---------------------------------------------------------------------------
  // 根路径跳转到 /app/ —— 独立部署必需
  // ---------------------------------------------------------------------------
  // 平台把 React Router 的 basename 写死成 "/app/"：它注入到 index.html 里的脚本
  // 包含 `window.__BASENAME__ = "/app/"` 与 `__platform__.basename = "/app/"`。
  //
  // 因此在独立部署直接访问 `/` 时，路由用 basename=/app/ 去匹配路径 "/"，匹配不到
  // 任何路由，React 什么都不渲染 —— 页面白屏。
  //
  // 危险之处在于它「看起来完全正常」：`/` 与 `/app/` 返回的是同一份 HTML（都是 200、
  // 同样字节数），资源请求也全部 200、Content-Type 正确。状态码、日志、健康检查
  // 全绿，只有真正用一个浏览器渲染才能发现。实测：远程渲染 / 得到空 #root，
  // 渲染 /app/ 得到完整登录页。
  //
  // 这里把根路径（以及任何未带 /app 前缀的页面路径）302 跳到 /app/ 下，让独立部署
  // 与平台行为一致，也避免每个访问根域名的人以为部署挂了。
  //
  // 注册在 configureApp() 之前，以便先于平台的视图回退执行；静态资源、API 与平台
  // 自身前缀全部放行不做跳转。
  {
    const expressApp = app.getHttpAdapter().getInstance() as {
      use: (fn: (req: { path: string; url: string }, res: {
        redirect: (code: number, url: string) => void;
      }, next: () => void) => void) => void;
    };
    const PASSTHROUGH = [
      '/app',
      '/api',
      '/bundle',
      '/assets',
      '/static',
      '/openapi',
      '/__innerapi__',
      '/__runtime__',
      '/dev',
      '/polyfills.js',
      '/favicon.ico',
      '/favicon.svg',
      '/routes.json',
      '/spark',
    ];
    expressApp.use((req, res, next) => {
      const path = req.path || '/';
      if (PASSTHROUGH.some((p) => path === p || path.startsWith(`${p}/`))) {
        return next();
      }
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      if (path === '/') {
        return res.redirect(302, `/app/${query}`);
      }
      // 任何其它页面路径（如 /login）同样带上前缀，而不是白屏。
      return res.redirect(302, `/app${path}${query}`);
    });
  }

  await configureApp(app, {
    disableSwagger: true,
  });

  // ---------------------------------------------------------------------------
  // Trust proxy — MUST be set AFTER configureApp()
  // ---------------------------------------------------------------------------
  // `configureApp()` from @lark-apaas/fullstack-nestjs-core ends with
  //     app.set('trust proxy', true)
  // (verified in the installed package, dist/index.js). Setting the value before
  // calling it is therefore silently discarded, and Express then believes EVERY
  // hop of the client-supplied `X-Forwarded-For` chain.
  //
  // Observed live before this fix: a request sending
  //     X-Forwarded-For: 203.0.113.99, 10.0.0.1
  // was recorded in `audit_logs.ip_address` as 203.0.113.99 — an attacker-chosen
  // value. That makes the per-IP login rate limit bypassable by rotating the
  // header and makes every audit row unattributable (audit finding D-10).
  //
  // On the 妙搭 platform this default is presumably harmless because their ingress
  // overwrites the header. It is NOT safe for a standalone / VPS deployment, which
  // is why the application must own this setting explicitly.
  //
  // Default (TRUST_PROXY unset -> false) is the safe one: Express ignores the
  // header and `req.ip` is the unforgeable socket address.
  app.set('trust proxy', trustProxy);

  // ---------------------------------------------------------------------------
  // Security response headers (audit finding Q-6)
  // ---------------------------------------------------------------------------
  // `configureApp()` does NOT install `helmet`, and neither this project's
  // `package.json` nor the platform package depends on it (verified). Before this
  // middleware the application sent NO security headers at all: no nosniff, no
  // frame protection, no referrer policy, no HSTS, no CSP - and it advertised
  // itself via `X-Powered-By`.
  //
  // Deliberately dependency-free; see security-headers.middleware.ts for why
  // installing `helmet` is unsafe for this repository's lockfile.
  //
  // Registered with `app.use()` BEFORE `app.listen()` because Nest mounts its
  // router during listen; middleware added afterwards would not run for matched
  // routes.
  app.use(securityHeaders);

  const host = process.env.SERVER_HOST || '0.0.0.0';
  const parsedPort = Number(process.env.PORT || process.env.SERVER_PORT || '3000');
  const port = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3000;

  // 注册视图引擎, 渲染 client 目录下的 html 文件
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  // Installed BEFORE the socket is opened: a SIGTERM that arrives while `listen()` is
  // still pending would otherwise use Node's default disposition and kill the process
  // mid-boot, which looks to an orchestrator exactly like a crash loop.
  const shutdownTimeout = resolveShutdownTimeoutMs(logger);
  installShutdownHandlers({ app, logger, timeoutMs: shutdownTimeout.ms });

  await app.listen(port, host);

  // 兼容云平台多端口或默认端口转发（例如 Zeabur 转发 3000 或 8080），杜绝 502 Port Mismatch
  const fallbackPorts = [3000, 8080].filter((p) => p !== port);
  for (const altPort of fallbackPorts) {
    try {
      const altServer = http.createServer((req, res) => {
        const clientReq = http.request(
          {
            host: '127.0.0.1',
            port: port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (clientRes) => {
            res.writeHead(clientRes.statusCode || 200, clientRes.headers);
            clientRes.pipe(res);
          },
        );
        clientReq.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end('Gateway Forwarding Error');
        });
        req.pipe(clientReq);
      });
      altServer.listen(altPort, host, () => {
        logger.log(`Secondary listener forwarding ${altPort} -> ${port}`);
      });
      altServer.on('error', () => {
        // ignore if port is occupied
      });
    } catch {
      // ignore
    }
  }

  logger.log(`Server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
  logger.log(`trust proxy: ${describeTrustProxy(trustProxy)}`);
  logger.log(describeSecurityHeaders());
  logger.log(shutdownTimeout.description);
  logger.log(
    `environment: NODE_ENV=${process.env.NODE_ENV ?? 'undefined'} ` +
      `HTTPS_ENABLED=${process.env.HTTPS_ENABLED ?? 'unset'}`,
  );

  // ---------------------------------------------------------------------------
  // Cover asset tree — say out loud whether it was found, and where.
  // ---------------------------------------------------------------------------
  // The storybook-cover endpoint streams a JPEG off the served filesystem, so a
  // deployment that copied the modules but not `assets/prek-english-covers/` answers
  // 200 everywhere except on every Pre-K English cover. This is the startup half of
  // the answer (the readiness probe reports the same resolution as a check, and the
  // request path resolves it through the same function — see
  // `server/modules/health/cover-assets.ts` for the documented order).
  const health = app.get(HealthService, { strict: false });
  const coverAssets = health.coverAssetsReport();
  if (coverAssets.ok) {
    logger.log(coverAssets.diagnostic);
  } else {
    logger.error(coverAssets.diagnostic);
  }

  if (trustProxy === true && process.env.NODE_ENV === 'production') {
    logger.warn(
      'TRUST_PROXY=true in production: every X-Forwarded-For hop is believed. ' +
        'This is only correct when a reverse proxy you control always strips or ' +
        'overwrites the header. Prefer TRUST_PROXY=loopback or an explicit CIDR list.',
    );
  }
}

bootstrap().catch((error: unknown) => {
  // Never swallowed. A failed bootstrap must not present itself as a running service,
  // so the failure is logged with its stack and the process exits non-zero.
  new Logger('Bootstrap').error(
    `bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exit(EXIT_CODE_UNCLEAN);
});
