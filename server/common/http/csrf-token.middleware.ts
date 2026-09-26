import { randomBytes, createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { isCsrfTokenPath } from './request-paths';

/**
 * Issues the double-submit CSRF token, on page routes only.
 * ========================================================
 *
 * THE CONTRACT, WHICH MUST NOT CHANGE (three separate places depend on it)
 * -----------------------------------------------------------------------
 * The application's own `CsrfCheckMiddleware` demands, on every mutating
 * `POST`/`PUT`/`PATCH`/`DELETE` under `/api/*`, that the `suda-csrf-token` COOKIE
 * equals the `x-suda-csrf-token` HEADER:
 *
 *     const cookieToken = req.cookies?.[COOKIE_KEY];
 *     const headerToken = req.headers[HEADER_KEY];
 *     if (cookieToken !== headerToken) -> 403
 *
 * The cookie half is issued here. The header half comes from the browser, which
 * reads `window.csrfToken` — a value the HBS document gets from `res.locals`, which
 * this middleware writes. That chain was the platform's
 * `CsrfTokenMiddleware` + `ViewContextMiddleware` pair; both are reproduced in this
 * one file:
 *
 *     GET /            -> Set-Cookie: suda-csrf-token=<t>; res.locals.csrfToken = <t>
 *     dist/client/index.html -> window.csrfToken = "{{csrfToken}}"
 *     client axios     -> x-suda-csrf-token: window.csrfToken
 *
 * VERIFIED ON THE RUNNING PLATFORM BUILD (port 3400, before this migration):
 *
 *     $ curl -s -D - http://127.0.0.1:3400/app/ | grep -i set-cookie
 *     Set-Cookie: suda-csrf-token=80f8b018…-1790386624; Max-Age=2592000; Path=/; Secure; Partitioned; SameSite=None
 *     $ curl -s http://127.0.0.1:3400/app/ | grep -o 'window.csrfToken = "[^"]*"'
 *     window.csrfToken = "80f8b018…-1790386624"
 *
 * WHY `res.locals` AND NOT A TEMPLATE VARIABLE
 *   `@Render('index')` returns an empty context, but Express's `res.render` merges
 *   `res.locals` into it, so the document can interpolate `{{csrfToken}}` without
 *   the controller passing anything. That is the mechanism the platform used and
 *   the mechanism the integration test `tests/cover-asset-root.test.mjs` relies on
 *   ("GET / must render so the CSRF cookie is issued"): it boots the COMPILED server
 *   against a scratch working directory and logs in through it.
 *
 * COOKIE ATTRIBUTES ARE UNCHANGED — and they are not decoration:
 *   * `secure: true` + `sameSite: 'none'` because the deployment is behind a TLS
 *     terminator that may be cross-site to the app;
 *   * `partitioned: true` for the same reason (CHIPS);
 *   * `httpOnly: false` is REQUIRED: the token is not a credential, it is a
 *     double-submit nonce that the page itself must be able to read;
 *   * `maxAge` 30 days, `path` `/`.
 * Curl treats http://127.0.0.1 as a secure context, which is why the local
 * verification suites can carry this cookie over plain HTTP.
 */

const COOKIE_KEY = 'suda-csrf-token';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const COOKIE_PATH = '/';

/**
 * Token format copied verbatim from the platform's `genToken()`: `<sha1>-<unix
 * seconds>`. The timestamp is not validated anywhere (the cookie's own `Max-Age`
 * is what expires it), but changing the SHAPE would change what the suites and any
 * external integration see in the cookie, so it is reproduced as-is.
 */
function generateToken(): string {
  const seconds = Math.floor(Date.now() / 1000);
  const random = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
  const digest = createHash('sha1').update(`${random}.${seconds}`).digest('hex');
  return `${digest}-${seconds}`;
}

/**
 * Express middleware. Registered with `app.use()` in `main.ts` before the router is
 * mounted, so it runs on every page request — including the SPA fallback, which is
 * where a first-time visitor gets their token.
 */
export function csrfTokenMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isCsrfTokenPath(req.path || '/')) {
    next();
    return;
  }

  // `cookie-parser` has already run, so this is an ordinary object lookup. Note the
  // lower-case key: cookie-parser normalises names, and `suda-csrf-token` is already
  // lower case, so `.toLowerCase()` (which the platform applied defensively) is a
  // no-op kept for clarity of intent.
  const existing = (req.cookies ?? {})[COOKIE_KEY.toLowerCase()];
  const token = typeof existing === 'string' && existing.length > 0 ? existing : generateToken();

  if (token !== existing) {
    res.cookie(COOKIE_KEY, token, {
      maxAge: COOKIE_MAX_AGE_MS,
      path: COOKIE_PATH,
      httpOnly: false,
      secure: true,
      sameSite: 'none',
      partitioned: true,
    });
  }

  // Always re-published, whether the token was just minted or came from the cookie:
  // a request that already holds the cookie still needs the value in the document.
  res.locals = { ...(res.locals ?? {}), csrfToken: token };

  next();
}
