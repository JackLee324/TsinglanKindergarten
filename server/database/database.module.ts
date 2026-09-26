import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { installDrizzleRolePreamble } from './request-database-role';

/**
 * The application's own database layer.
 * =====================================
 *
 * This is the replacement for the 妙搭 platform's `DataPaasModule` and its
 * `DRIZZLE_DATABASE` token. It is deliberately SMALL, because the platform's
 * version was not:
 *
 *   * it read a rotating credential from a Kubernetes secret file
 *     (`/var/run/secrets/zti/credential`) and rebuilt the whole client whenever
 *     that file changed;
 *   * it routed every query through an observable/tracing proxy;
 *   * it exposed the database through a `Proxy` whose `get` trap called
 *     `getDatabase()` on EVERY property read — which is what made `app.close()`
 *     throw during shutdown, because Nest reads a property on every provider
 *     while choosing teardown hooks (see `server/main.ts`).
 *
 * None of that is needed here. What IS needed, and is kept deliberately:
 *
 *   1. The SAME token name ("DRIZZLE_DATABASE") and the SAME drizzle driver
 *      (`drizzle-orm/postgres-js` over postgres.js), so every service that
 *      injects it keeps working unchanged and the SQL that reaches PostgreSQL is
 *      byte-for-byte the SQL that reached it before.
 *   2. The SAME connection pool shape the platform used: 7 connections, 20s idle
 *      timeout, 10s connect timeout (`@lark-apaas/nestjs-datapaas`'s
 *      `parseConnectionInfo` defaults). Changing the pool size silently changes
 *      how many concurrent requests can hold a connection.
 *   3. The SAME `sslmode=require` → `ssl: 'require'` translation the platform
 *      performed, and only that translation. A deployment whose connection string
 *      carries `sslmode=require` keeps talking TLS; one that does not keeps
 *      talking plaintext, exactly as before.
 *   4. The SAME per-request database ROLE preamble (`SET LOCAL ROLE 'anon_'`,
 *      see `request-database-role.ts`). This is a real behavioural contract:
 *      under that role migration 0005 grants UPDATE on only three columns of
 *      `teachers`, and the application's two privileged password writes escape it
 *      by re-issuing `SET LOCAL ROLE 'authenticated_'` on the raw client. Dropping
 *      the preamble would silently widen what every other query may write.
 *
 * WHAT IS NOT HERE (and must not be added back): no credential-file watching, no
 * OTel/trace proxy, no `Proxy` around the instance. The instance returned by
 * `DatabaseService.db` is the real drizzle object, so `db.$client` is the real
 * postgres.js client and the privileged password writes reach it directly.
 */

/** The injection token. Identical string to the platform's, on purpose. */
export const DRIZZLE_DATABASE = 'DRIZZLE_DATABASE';

/**
 * Re-exported so services keep importing the type from ONE place. This is
 * drizzle's own type, not a platform re-declaration — the platform merely
 * re-exported it (`@lark-apaas/nestjs-datapaas` → `drizzle-orm/postgres-js`).
 */
export type { PostgresJsDatabase };

/** The postgres.js client type behind `PostgresJsDatabase.$client`. */
export type PostgresClient = ReturnType<typeof postgres>;

/**
 * Environment variables that may carry the connection string, in priority order.
 *
 * The first four are the names this project has always accepted
 * (`server/main.ts` and `server/app.module.ts` both resolved them before the
 * module graph was even built). `SUDA_DATABASE_URL` is the platform-era name that
 * the container entrypoint still exports and that
 * `scripts/verify-e2e-deploy.sh` sets, so it must keep working. The alias is
 * resolved to the canonical `DATABASE_URL` in `main.ts`, before this module is
 * instantiated, so a single lookup here is enough — but the list is kept as a
 * fallback for any process that boots the Nest app directly (the integration
 * tests do exactly that).
 */
const CONNECTION_STRING_ENV_VARS = [
  'DATABASE_URL',
  'POSTGRES_CONNECTION_STRING',
  'POSTGRESQL_CONNECTION_STRING',
  'POSTGRES_URI',
  'SUDA_DATABASE_URL',
] as const;

export interface ResolvedDatabaseUrl {
  url: string;
  /** Which environment variable supplied it — for the startup log, never the value. */
  source: string;
  /** True when `sslmode=require`, i.e. when the pool must speak TLS. */
  sslRequired: boolean;
}

/**
 * Resolve the connection string, or return null.
 *
 * Never logs or returns the string itself outside this module: a DSN contains the
 * database password, and this project has already had one 5xx-body credential
 * leak (audit finding G-11).
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): ResolvedDatabaseUrl | null {
  for (const name of CONNECTION_STRING_ENV_VARS) {
    const raw = env[name];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    let sslRequired = false;
    try {
      sslRequired = new URL(trimmed).searchParams.get('sslmode') === 'require';
    } catch {
      // Not a parseable URL. Reported by the caller as a startup failure with the
      // variable NAME; the value is never echoed.
      return { url: trimmed, source: name, sslRequired: false };
    }
    return { url: trimmed, source: name, sslRequired };
  }
  return null;
}

/**
 * Owns the postgres.js pool and the drizzle instance for the whole process.
 *
 * Created ONCE (Nest instantiates it as a singleton provider). The platform's
 * version was re-created on credential rotation; there is no rotation here, so a
 * single pool is both simpler and cheaper.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private closed = false;

  readonly client: PostgresClient;
  readonly db: PostgresJsDatabase;

  /**
   * Whether this process still owns an open pool. Used by the shutdown sequence in
   * `main.ts`, which VERIFIES the pool is closed rather than assuming the framework
   * closed it.
   */
  isDatabaseConnected(): boolean {
    return !this.closed;
  }

  constructor() {
    const resolved = resolveDatabaseUrl();
    if (resolved === null) {
      throw new Error(
        'No database connection string: set DATABASE_URL (or SUDA_DATABASE_URL / ' +
          'POSTGRES_CONNECTION_STRING / POSTGRESQL_CONNECTION_STRING / POSTGRES_URI). ' +
          'Refusing to start without a database instead of running a site that cannot log anyone in.',
      );
    }

    // postgres.js does not understand the platform's `schema` query parameter (it
    // was the platform's role-schema selector), so it is removed before the URL is
    // handed to the driver. Everything else is passed through untouched.
    let connectionString = resolved.url;
    try {
      const parsed = new URL(connectionString);
      if (parsed.searchParams.has('schema')) {
        parsed.searchParams.delete('schema');
        connectionString = parsed.toString();
      }
    } catch {
      // Left as-is: the driver reports an unparseable string itself, with the
      // variable name already logged by the failure above.
      this.logger.warn(
        `the connection string from ${resolved.source} is not a parseable URL; passing it to postgres.js unchanged`,
      );
    }

    // Pool shape copied from the platform so concurrency behaviour does not change.
    const maxConnections = readPositiveInt('DATABASE_POOL_MAX', 7);
    const idleTimeoutSeconds = readPositiveInt('DATABASE_IDLE_TIMEOUT_SECONDS', 20);
    const connectTimeoutSeconds = readPositiveInt('DATABASE_CONNECT_TIMEOUT_SECONDS', 10);

    this.client = postgres(connectionString, {
      max: maxConnections,
      idle_timeout: idleTimeoutSeconds,
      connect_timeout: connectTimeoutSeconds,
      // Only `sslmode=require` turns TLS on, which is exactly what the platform did
      // (`ssl: options.ssl || (sslModeRequired ? 'require' : false)`).
      ssl: resolved.sslRequired ? 'require' : false,
    });

    this.db = drizzle(this.client, {
      // Query logging was development-only on the platform and stays that way: a
      // production log that records every statement would write the contents of
      // every password hash update and every audit insert.
      logger:
        process.env.NODE_ENV === 'development'
          ? {
              logQuery: (query: string) => this.logger.debug(query),
            }
          : false,
    });

    // Installed once per process, before any query runs. See request-database-role.ts.
    installDrizzleRolePreamble();

    this.logger.log(
      `database pool created (${maxConnections} connections max, idle ${idleTimeoutSeconds}s, ` +
        `connect timeout ${connectTimeoutSeconds}s, TLS ${resolved.sslRequired ? 'required' : 'off'}; ` +
        `connection string from ${resolved.source})`,
    );
  }

  /**
   * Close the pool. Called by Nest's `onModuleDestroy` during `app.close()`, and
   * again — as a verification — by the shutdown sequence in `main.ts`.
   *
   * Idempotent: postgres.js's `end()` on an already-ended client resolves, but the
   * guard makes that explicit rather than incidental.
   */
  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.end({ timeout: 5 });
    this.logger.log('database pool closed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Global, like the platform's `PlatformModule` was: twelve services inject
 * `DRIZZLE_DATABASE` without importing a provider module, and making the token
 * global keeps that working without touching every feature module's imports.
 */
@Global()
@Module({
  providers: [
    DatabaseService,
    {
      provide: DRIZZLE_DATABASE,
      useFactory: (service: DatabaseService): PostgresJsDatabase => service.db,
      inject: [DatabaseService],
    },
  ],
  exports: [DRIZZLE_DATABASE, DatabaseService],
})
export class DatabaseModule {}
