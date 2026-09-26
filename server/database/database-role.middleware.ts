import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ANON_ROLE_PREAMBLE, runWithDatabaseRolePreamble } from './request-database-role';

/**
 * Puts every request's SQL on the unprivileged `anon_` database role.
 *
 * Direct replacement for the platform's `SqlExecutionContextMiddleware`, mounted
 * the same way (all routes, in `AppModule.configure`). The reasoning for keeping
 * this at all — and the exact scope it must have — is in
 * `request-database-role.ts`; the short version is that migrations 0004/0005 build
 * the row-level-security layer around that role and migration 0005 narrows what it
 * may UPDATE on `teachers`.
 *
 * `AsyncLocalStorage` rather than a request property, because the value has to
 * reach `PostgresJsPreparedQuery.execute` several async frames later, with no
 * request object in scope.
 */
@Injectable()
export class DatabaseRoleMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    runWithDatabaseRolePreamble(ANON_ROLE_PREAMBLE, () => next());
  }
}
