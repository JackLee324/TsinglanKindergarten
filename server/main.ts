import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { __express as hbsExpressEngine } from 'hbs';
import http, { type Server } from 'http';

import { AppModule } from './app.module';
import { HealthService } from './modules/health/health.module';
import { DatabaseService } from './database/database.module';
import {
  resolveTrustProxySetting,
  describeTrustProxy,
} from './common/http/client-ip';
import {
  securityHeaders,
  describeSecurityHeaders,
} from './common/http/security-headers.middleware';
import { csrfTokenMiddleware } from './common/http/csrf-token.middleware';

// =============================================================================
// The standalone bootstrap
// =============================================================================
//
// THIS FILE OWNS THE HTTP SHELL NOW.
//
// Until this migration the shell was installed by `configureApp()` from
// `@lark-apaas/fullstack-nestjs-core`, which — verified by reading the installed
// bundle at `dist/index.js:36723` — did all of the following, in this order:
//
//     app.useLogger(app.get(AppLogger))          // pino + an OTel batch exporter
//     app.flushLogs()
//     app.use(express.json({ limit: '1mb' }))
//     app.use(express.urlencoded({ limit: '1mb', extended: true }))
//     app.use(cookieParser())
//     app.use(createLegacyPathRedirectMiddleware())
//     app.use(createPublicAssetsMiddleware())    // serves <cwd>/dist/client
//     app.setGlobalPrefix(process.env.CLIENT_BASE_PATH ?? '')
//     app.set('trust proxy', true)               // <-- unconditionally, see below
//
// Every one of those responsibilities is reproduced here, in this file, with two
// deliberate differences and one deliberate omission:
//
//   * **`trust proxy` is NOT `true`.** It is `resolveTrustProxySetting()`, whose
//     default is the safe one. `X-Forwarded-For` is client-supplied; believing all
//     of it lets an attacker choose their own `req.ip`, which is what feeds the
//     per-IP login rate limit and every `audit_logs.ip_address` row. The platform
//     set `true` because its ingress always overwrote the header — there is no
//     such ingress here, and this application must not inherit that assumption.
//     This is the one place where matching the platform would have been wrong.
//
//   * **The CSRF token is issued by this application.** The platform's
//     `CsrfTokenMiddleware` + `ViewContextMiddleware` pair is replaced by
//     `common/http/csrf-token.middleware.ts`; without it, every mutating
//     `POST /api/*` answers 403, because this application's own
//     `CsrfCheckMiddleware` demands a cookie/header pair nothing else would mint.
//
//   * **Omitted: the platform's HTTP trace interceptor**, which logged the request
//     and response BODY of every request — including the plaintext temporary
//     password returned by `POST /api/teachers`, every login body and every token
//     response. Logging is now the standard Nest `Logger`, which records messages,
//     never payloads.
//
// The platform's log flush existed because its exporter batched asynchronously.
// A bounded stdout drain is kept anyway, for a different and still-real reason:
// `process.stdout` is ASYNCHRONOUS when it is a pipe (which is what both Docker
// and the shutdown test use), so `process.exit()` can truncate the last lines —
// and "the last line" is exactly the one an operator needs.
//
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
// Nest runs its teardown in this order (verified in the installed @nestjs/core
// 10.4.22, `nest-application-context.js`):
//
//   1. onModuleDestroy()             <- DatabaseService closes the PostgreSQL
//   2. beforeApplicationShutdown()      pool HERE, before anything else
//   3. dispose()                     <- ONLY NOW does Nest stop the HTTP server
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
// A PLATFORM DEFECT THIS FILE USED TO WORK AROUND IS GONE
// ------------------------------------------------------
// `app.close()` used to reject with "Database not initialized. Call initialize()
// first." because the platform's `DRIZZLE_DATABASE` was a `Proxy` whose `get` trap
// called `getDatabase()` on every property read, and Nest reads a property on
// every provider while choosing shutdown hooks — after `onModuleDestroy` had
// already disconnected the pool. `DatabaseService` is a plain class holding a real
// drizzle instance (see `server/database/database.module.ts`), so the framework
// teardown now completes normally, `beforeApplicationShutdown`/
// `onApplicationShutdown` hooks run for whatever needs them, and every failure of
// `app.close()` is a real failure again — reported and counted, with no
// "expected defect" exemption to hide behind.
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
 * Upper bound on waiting for stdout to drain before `process.exit()`. See the
 * header: the drain is a real guarantee (the callback fires once the buffered
 * chunks have been written), and the timeout only exists so a broken stream can
 * never turn a clean shutdown into a hang.
 */
const STDOUT_FLUSH_TIMEOUT_MS = 500;

/**
 * Request-body limit. 1mb is not a preference — it is what the platform passed
 * (`DEFAULT_BODY_LIMIT = '1mb'`, `dist/index.js:36719`), and changing it changes
 * which uploads are accepted: measured before this migration, a 900KB JSON body
 * reaches the handler while a 1.5MB one is refused by the parser (which surfaces
 * as a 500 through the exception filter, because `PayloadTooLargeError` is not a
 * Nest `HttpException`). `BODY_SIZE_LIMIT` keeps overriding it, as it did.
 */
const DEFAULT_BODY_LIMIT = '1mb';

const EXIT_CODE_CLEAN = 0;
const EXIT_CODE_UNCLEAN = 1;

interface ShutdownTarget {
  app: NestExpressApplication;
  logger: Logger;
  timeoutMs: number;
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
 * `DatabaseService.onModuleDestroy()` closes the pool during `app.close()`, so on
 * the normal path this is a verification. It becomes the actual close if that hook
 * did not run — and either way the OUTCOME is checked rather than assumed:
 * `disconnect()` that leaves `isDatabaseConnected()` true is a failure, not a
 * success.
 */
async function closeDatabase(
  database: DatabaseService | null,
  logger: Logger,
): Promise<string | null> {
  if (database === null) {
    logger.warn(
      '[shutdown] database: DatabaseService is not in the container; cannot verify the pool state',
    );
    return null;
  }

  try {
    if (database.isDatabaseConnected()) {
      await database.disconnect();
      logger.log('[shutdown] database: pool was still connected; closed it explicitly');
    }
  } catch (error) {
    const failure = `database close failed: ${errorMessage(error)}`;
    logger.error(`[shutdown] ${failure}`);
    return failure;
  }

  if (database.isDatabaseConnected()) {
    const failure = 'the PostgreSQL pool is STILL connected after disconnect()';
    logger.error(`[shutdown] ${failure}`);
    return failure;
  }

  logger.log('[shutdown] database: PostgreSQL pool closed (isDatabaseConnected() === false)');
  return null;
}

/**
 * Give stdout a bounded chance to drain before `process.exit()`.
 *
 * See `STDOUT_FLUSH_TIMEOUT_MS` and the header. A failure here cannot be reported
 * through `logger` alone — the logger writes to the very stream that may be broken
 * — so it also goes to `process.stderr`.
 */
async function flushStdout(logger: Logger): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, STDOUT_FLUSH_TIMEOUT_MS);
    try {
      // Writing an empty chunk and waiting for ITS callback proves every
      // previously written chunk has been flushed: a Node stream invokes write
      // callbacks in order.
      process.stdout.write('', finish);
    } catch (error) {
      process.stderr.write(`[shutdown] stdout flush failed: ${errorMessage(error)}\n`);
      logger.error(`[shutdown] stdout flush failed: ${errorMessage(error)}`);
      finish();
    }
  });
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
  let database: DatabaseService | null = null;
  try {
    database = app.get(DatabaseService, { strict: false }) ?? null;
  } catch (error) {
    logger.warn(`[shutdown] could not resolve DatabaseService: ${errorMessage(error)}`);
  }

  // 1. Stop accepting new connections, then wait for in-flight requests to finish.
  const drainFailure = await drainHttpServer(httpServer, logger);
  if (drainFailure) failures.push(drainFailure);

  // 2. Framework teardown. Runs `onModuleDestroy` (which closes the pool), then
  //    dispose(), then the shutdown hooks. Any rejection here is a real failure:
  //    the platform's Proxy defect that used to make this expected is gone.
  try {
    await app.close();
    logger.log(
      '[shutdown] application context closed (module destroy hooks ran; DatabaseService closed the PostgreSQL pool)',
    );
  } catch (error) {
    const failure = `app.close() failed: ${errorMessage(error)}`;
    failures.push(failure);
    logger.error(`[shutdown] ${failure}`);
    logger.error(`[shutdown] app.close() stack: ${errorStack(error)}`);
  }

  // 3. Database: verify, and close it here if the framework did not.
  const databaseFailure = await closeDatabase(database, logger);
  if (databaseFailure) failures.push(databaseFailure);

  clearTimeout(forceExit);

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
        await flushStdout(target.logger);
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

/**
 * `/app/...` → `/...`.
 *
 * WHY, AND WHY THIS IS NOT THE OLD WORKAROUND COMING BACK
 * ------------------------------------------------------
 * The previous revision of this file redirected `/` to `/app/`, because the
 * platform forced React Router's basename to `/app/` and a request to `/` matched
 * no route (a 200 response whose `#root` was empty — a white screen). That
 * workaround is GONE: the basename is `/`, `/` renders the index route, and
 * `scripts/verify-e2e-deploy.sh` asserts the render instead of the status code.
 *
 * This is the mirror image and a courtesy, not a requirement: every URL a user may
 * have bookmarked or linked during the platform era lives under `/app/...`
 * (`/app/`, `/app/login`, `/app/admin/teachers`), and those paths mean nothing to
 * this router. Rather than show them the application's own "page not found", they
 * are translated to the real path. No route in `client/src/app.tsx` begins with
 * `/app`, so nothing can be shadowed — asserted, incidentally, by the E2E check
 * that `/app/login` lands on `/login` and that `/login` itself still works.
 *
 * Query strings are preserved: the K-English and Montessori pages are driven by
 * `?theme=` / `?subSubject=`.
 */
function legacyPlatformPathRedirect(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const path = req.path || '/';
  if (path !== '/app' && !path.startsWith('/app/')) {
    next();
    return;
  }
  const queryIndex = req.originalUrl.indexOf('?');
  const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
  const rest = path.slice('/app'.length);
  res.redirect(302, `${rest === '' ? '/' : rest}${query}`);
}

/**
 * Static assets of the built client.
 *
 * `index: false` is not cosmetic and must not be "simplified": with the default,
 * `express.static` answers `GET /` with the raw `index.html`, bypassing the HBS
 * render — which is where `window.csrfToken` is interpolated. The page would then
 * load, look perfect, and fail every mutating API call with 403 because
 * `window.csrfToken` was still the literal string `{{csrfToken}}`. Documents are
 * served by the view engine, assets by this middleware.
 */
function clientAssetMiddleware(clientDir: string): express.RequestHandler {
  return express.static(clientDir, {
    index: false,
    // A dotfile in the published client tree would be a build accident, not content.
    dotfiles: 'ignore',
  });
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

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
  //
  // Until this migration the platform's `configureApp()` ended with
  // `app.set('trust proxy', true)` and this assignment had to come AFTER it or be
  // silently discarded. There is no longer anything to override: this is the only
  // place the setting is written, and it is written before the router exists.
  const trustProxy = resolveTrustProxySetting();
  app.set('trust proxy', trustProxy);

  // ---------------------------------------------------------------------------
  // Request parsing — same three parsers, same limit, same order as the platform
  // ---------------------------------------------------------------------------
  // `cookie-parser` is what makes `req.cookies` exist, which both the CSRF check
  // and the session lookup read. The parsers are registered here, after
  // `NestFactory.create()` and before `listen()`, so they run ahead of Nest's own
  // built-in body parser — which skips a body another parser already consumed.
  // That ordering is why the observed effective limit is 1mb and not Nest's 100kb
  // default; measured on the platform build: a 900KB body was accepted and a
  // 1.5MB body was refused.
  const bodyLimit = process.env.BODY_SIZE_LIMIT || DEFAULT_BODY_LIMIT;
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ limit: bodyLimit, extended: true }));
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // Security response headers (audit finding Q-6)
  // ---------------------------------------------------------------------------
  // Installed FIRST of the application's own middleware so that every response it
  // can influence carries them — including the ones produced by the parsers above
  // (a 413 from an oversized body) and by the SPA fallback.
  //
  // `configureApp()` did NOT install `helmet`, and neither this project's
  // `package.json` nor the platform package depends on it (verified). Before this
  // middleware the application sent NO security headers at all: no nosniff, no
  // frame protection, no referrer policy, no HSTS, no CSP — and it advertised
  // itself via `X-Powered-By`.
  //
  // Deliberately dependency-free; see security-headers.middleware.ts for why
  // installing `helmet` is unsafe for this repository's lockfile.
  //
  // Registered with `app.use()` BEFORE `app.listen()` because Nest mounts its
  // router during listen; middleware added afterwards would not run for matched
  // routes.
  app.use(securityHeaders);

  // ---------------------------------------------------------------------------
  // CSRF token issuance (page routes only)
  // ---------------------------------------------------------------------------
  // Must run before the router, because the value it puts on `res.locals` is read
  // by the view render several steps later. See csrf-token.middleware.ts.
  app.use(csrfTokenMiddleware);

  // ---------------------------------------------------------------------------
  // Legacy platform URLs, then the built client's assets
  // ---------------------------------------------------------------------------
  app.use(legacyPlatformPathRedirect);
  const clientDir = join(process.cwd(), 'dist/client');
  app.use(clientAssetMiddleware(clientDir));

  const host = process.env.SERVER_HOST || '0.0.0.0';
  const parsedPort = Number(process.env.PORT || process.env.SERVER_PORT || '3000');
  const port = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3000;

  // The SPA fallback renders `client/index.html` (with the CSRF token merged in
  // from `res.locals`). The directory is `dist/client` relative to the process
  // working directory, and the app starts with cwd = `dist/` — the Dockerfile sets
  // that working directory explicitly, and `tests/cover-asset-root.test.mjs` boots
  // the compiled server from a scratch directory to prove the resolution is
  // cwd-relative rather than module-relative.
  app.setBaseViewsDir(clientDir);
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
  logger.log(`request body limit: ${bodyLimit}`);
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
