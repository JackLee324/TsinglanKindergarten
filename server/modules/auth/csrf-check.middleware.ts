import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const COOKIE_KEY = 'suda-csrf-token';
const HEADER_KEY = 'x-suda-csrf-token';

@Injectable()
export class CsrfCheckMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const cookieToken = req.cookies?.[COOKIE_KEY];
    if (!cookieToken) {
      res.status(403).send('Forbidden，csrf token not found in cookie.');
      return;
    }
    const headerToken = req.headers[HEADER_KEY];
    if (!headerToken) {
      res.status(403).send('Forbidden，csrf token not found in header.');
      return;
    }
    if (cookieToken !== headerToken) {
      res.status(403).send('Forbidden，csrf token not match.');
      return;
    }
    next();
  }
}
