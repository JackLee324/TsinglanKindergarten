import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';

/**
 * Per-request database role preamble.
 * ===================================
 *
 * WHY THIS EXISTS — AND WHY IT IS NOT PLATFORM CODE
 * -------------------------------------------------
 * On 妙搭, every HTTP request ran its SQL as the unprivileged `anon_` role:
 * `SqlExecutionContextMiddleware` put
 *
 *     SET LOCAL app.user_id = ''; SET LOCAL ROLE 'anon_';
 *     SET LOCAL app.role_ids = ''; SET LOCAL app.user_type = ''
 *
 * into an AsyncLocalStorage store, and `@lark-apaas/nestjs-datapaas` monkey-patched
 * `PostgresJsPreparedQuery.prototype.execute` so that EVERY drizzle statement ran
 * inside its own transaction with that preamble.
 *
 * That is not decoration. Migrations 0004/0005 build the RLS layer around those
 * roles, and 0005 narrows `anon_`'s UPDATE privilege on `teachers` to three
 * columns (`last_login_at`, `failed_login_attempts`, `locked_until`). The two
 * privileged password writes in `auth.service.ts` exist precisely because of it:
 * they deliberately hop onto the raw postgres.js client and re-issue
 * `SET LOCAL ROLE 'authenticated_'`, and the HTTP suites pin that repaired
 * behaviour (`scripts/verify-authz-http.mjs` section F,
 * `scripts/verify-mfa.mjs` section H, `tests/rbac-database.test.mjs`).
 *
 * If this preamble were dropped, every query would run as the pool's own login
 * role — which OWNS the tables and is a superuser in the shipped configuration —
 * and the column-level write narrowing would silently stop applying. That is a
 * loss of an existing database-level control, so the preamble is reproduced here
 * verbatim, with the same scope and the same trigger point.
 *
 * SCOPE, MATCHED EXACTLY
 * ----------------------
 *   * ONLY requests carry the preamble. The platform's middleware was mounted on
 *     routes (`forRoutes('/*')`), so statements issued outside a request — the
 *     `AuthService.onModuleInit()` seeding pass, for instance — ran WITHOUT it,
 *     as the pool's login role. That distinction is preserved: `store.getStore()`
 *     returns undefined outside a request and the statement is executed unchanged.
 *   * The preamble is transaction-local (`SET LOCAL`), so it cannot leak between
 *     pooled connections or between concurrent requests.
 *   * The raw client (`db.$client`) is NOT covered by the patch — that is the
 *     documented escape hatch the privileged writes use.
 *
 * WHAT CHANGED FROM THE PLATFORM VERSION: nothing behavioural. The platform
 * derived the preamble from a per-request user context that its own auth layer
 * supplied; off-platform that context is always empty, so the derived value is the
 * constant below. Deriving a constant from an always-empty input is indirection
 * without information, so it is a constant.
 */

const ROLE_PREAMBLE_LOGGER = new Logger('DatabaseRole');

/**
 * The exact statement list the platform issued, including the empty-string
 * settings, because migration 0003's `rbac_*` trigger functions read those GUCs
 * (`current_setting('app.rbac_actor_*', true)`) and a *stale* value from an
 * earlier transaction would change whether a super_admin write is allowed.
 */
export const ANON_ROLE_PREAMBLE =
  "SET LOCAL app.user_id = ''; " +
  "SET LOCAL ROLE 'anon_'; " +
  "SET LOCAL app.role_ids = ''; " +
  "SET LOCAL app.user_type = ''";

const preambleStore = new AsyncLocalStorage<string>();

/** Run `fn` such that every drizzle statement inside it carries the preamble. */
export function runWithDatabaseRolePreamble<T>(preamble: string, fn: () => T): T {
  return preambleStore.run(preamble, fn);
}

/** The preamble for the current async context, or undefined outside a request. */
export function currentDatabaseRolePreamble(): string | undefined {
  return preambleStore.getStore();
}

/** The slice of postgres.js this patch needs, structurally typed. */
interface TransactionCapableClient {
  begin?<T>(fn: (tx: TransactionCapableClient) => Promise<T>): Promise<T>;
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

interface PreparedQueryInternals {
  client: TransactionCapableClient;
}

let installed = false;

/**
 * Patch `PostgresJsPreparedQuery.prototype.execute` so that a statement issued
 * inside a request runs in its own transaction, preceded by the role preamble.
 *
 * Idempotent, and it REFUSES to install silently if drizzle's internals are not
 * the shape this patch depends on: a patch that quietly did nothing would leave
 * every request running with the pool's own privileges while the startup log said
 * otherwise, which is exactly the class of silent widening this file exists to
 * prevent.
 */
export function installDrizzleRolePreamble(): void {
  if (installed) return;

  const originalExecute = PostgresJsPreparedQuery.prototype.execute as unknown as (
    this: PreparedQueryInternals,
    ...args: unknown[]
  ) => Promise<unknown>;

  if (typeof originalExecute !== 'function') {
    throw new Error(
      'database role preamble: drizzle-orm/postgres-js no longer exposes ' +
        'PostgresJsPreparedQuery.prototype.execute, so the per-request `SET LOCAL ROLE` ' +
        'preamble cannot be installed. Every request would run with the pool login role\'s ' +
        'privileges. Refusing to start rather than silently widening database access.',
    );
  }

  PostgresJsPreparedQuery.prototype.execute = async function patchedExecute(
    this: PreparedQueryInternals,
    ...args: unknown[]
  ): Promise<unknown> {
    const preamble = preambleStore.getStore();
    if (!preamble) {
      // Outside a request: identical to the platform's behaviour, and the reason the
      // boot-time seeding pass is unaffected.
      return originalExecute.apply(this, args);
    }

    const client = this.client;
    if (typeof client?.begin !== 'function' || typeof client?.unsafe !== 'function') {
      // Not a transaction-capable postgres.js client (a mock, or a future driver
      // change). Reported loudly instead of silently running without the preamble.
      ROLE_PREAMBLE_LOGGER.error(
        'database role preamble: the drizzle client does not expose begin()/unsafe(), so this ' +
          'statement runs WITHOUT the `anon_` role preamble. The database-level restrictions of ' +
          'migrations 0004/0005 do not apply to it.',
      );
      return originalExecute.apply(this, args);
    }

    return client.begin(async (tx) => {
      const savedClient = this.client;
      this.client = tx;
      try {
        await tx.unsafe(preamble);
        return await originalExecute.apply(this, args);
      } finally {
        this.client = savedClient;
      }
    });
  } as typeof PostgresJsPreparedQuery.prototype.execute;

  installed = true;
}
