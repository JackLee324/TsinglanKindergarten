import { logger } from '@client/src/lib/logger';
import axios, { type AxiosError, type AxiosInstance } from 'axios';

/**
 * The application's HTTP client.
 * ==============================
 *
 * WHAT THIS REPLACES
 * ------------------
 * `axiosForBackend` used to come from `@lark-apaas/client-toolkit`. That export was
 * an axios instance built by `getAxiosForBackend()`, whose request interceptor did
 * four things, only ONE of which this application ever needed:
 *
 *   1. `X-Suda-Csrf-Token: window.csrfToken`              <- required, see below
 *   2. `X-Page-Route: window.location.pathname`           <- platform observability
 *   3. `Rpc-Persist-Apaas-Observability-Referer-Path`      <- platform observability
 *      and `…-Api` (a route-id lookup against the platform's generated route tables)
 *   4. telemetry to Slardar on every error response        <- platform observability
 *
 * (1) is the CSRF half of the double-submit check the SERVER enforces on every
 * mutating `/api/*` call (`server/modules/auth/csrf-check.middleware.ts` compares
 * this header against the `suda-csrf-token` COOKIE). `window.csrfToken` is written
 * into the document by `server/common/http/csrf-token.middleware.ts` through
 * `res.locals.csrfToken` — see `client/index.html`. Losing this header would make
 * every write in the product fail with 403.
 *
 * (2)–(4) are reproduced as nothing: they were consumed by the platform's own
 * backend and observability pipeline, and nothing in this repository reads them.
 *
 * THE `403` BEHAVIOUR IS COPIED DELIBERATELY, NOT BY ACCIDENT
 * ----------------------------------------------------------
 * The toolkit's response interceptor RESOLVED a 403 with its response object
 * instead of rejecting:
 *
 *     if (error.response?.status === 403) { …; return error.response; }
 *
 * That is unusual, and it means the `status === 403` branch in `handleApiError`
 * below is unreachable through this instance. It is preserved anyway, because it is
 * the behaviour the shipped UI was written and tested against, and changing it
 * would alter what a user sees on the (rare) path where the server refuses a write
 * after the client already believed it was allowed to make it. It is recorded here
 * so the next reader does not have to reverse-engineer it a second time.
 *
 * THE EXPORTED NAME IS UNCHANGED (`axiosForBackend`) so the ten modules that import
 * it need no edit. It is this file's own instance now; there is no "backend" for it
 * to be for.
 */

export const AUTH_UNAUTHORIZED_EVENT = 'qls:auth:unauthorized';
/** The token travels in the same cookie/header names the server issues and checks. */
export const CSRF_COOKIE_NAME = 'suda-csrf-token';
export const CSRF_HEADER_NAME = 'x-suda-csrf-token';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

function extractErrorMessage(error: AxiosError): string {
  const data = error.response?.data as { error?: { message?: string } } | undefined;
  return data?.error?.message || error.message || 'Request failed';
}

function createHttpClient(): AxiosInstance {
  // `baseURL: '/'` is not decoration: every call site passes an absolute API path
  // (`/api/...`), and this keeps them independent of wherever the app is mounted.
  // Until the de-platforming the value was `process.env.CLIENT_BASE_PATH || '/'`,
  // i.e. `/app/` on 妙搭; it is `/` now, which is what the router uses too.
  const instance = axios.create({ baseURL: '/' });

  instance.interceptors.request.use(
    (config) => {
      // `window.csrfToken` is the value the served document carries. Without it the
      // server's CSRF check refuses every POST/PATCH/DELETE with 403.
      const token = typeof window === 'undefined' ? undefined : window.csrfToken;
      if (token) {
        config.headers[CSRF_HEADER_NAME] = token;
      }
      return config;
    },
    (error) => Promise.reject(error),
  );

  instance.interceptors.response.use(
    (response) => response,
    (error: AxiosError) => {
      // See "THE 403 BEHAVIOUR" above: this is the toolkit's behaviour, kept on purpose.
      if (error?.response?.status === 403) {
        return error.response;
      }
      return Promise.reject(error);
    },
  );

  return instance;
}

export const axiosForBackend = createHttpClient();

/**
 * Was this "response" actually the server refusing the request?
 *
 * Needed because of the deliberate 403 behaviour documented above: a 403 arrives
 * at the call site as a RESOLVED axios response, not as a rejection. Every caller
 * that writes `const { items } = await api.list()` therefore reads `undefined`
 * the moment the server says no, and the ordinary `try/catch` around it never
 * runs — the failure is invisible until something downstream touches it.
 *
 * That is not theoretical. On the deployed instance the subject pages did exactly
 * this and died with
 *   TypeError: Cannot read properties of undefined (reading 'length')
 * at `pages/Subject/SubjectPage.tsx:252` (`resources.length === 0`), rendering the
 * full-page 「页面出现错误」 instead of an empty or "no permission" state.
 */
export function isForbiddenResponse(resp: unknown): boolean {
  return (
    !!resp &&
    typeof resp === 'object' &&
    (resp as { status?: unknown }).status === 403
  );
}

/**
 * Read `{ items, total }` out of a list response, tolerating the resolved-403 case.
 *
 * Use this instead of destructuring `resp.items` directly. A 403 becomes an empty
 * list plus an explicit `forbidden: true`, so a page can say "no permission"
 * rather than crash — and, critically, so the failure is never silent: it is
 * logged here even if the caller ignores the flag.
 */
export function readListResponse<T>(
  resp: unknown,
  context: string,
): { items: T[]; total: number; forbidden: boolean } {
  if (isForbiddenResponse(resp)) {
    logger.warn(`[API] ${context}: forbidden (403) — list treated as empty`);
    return { items: [], total: 0, forbidden: true };
  }
  const body = (resp ?? {}) as { items?: unknown; total?: unknown };
  return {
    items: Array.isArray(body.items) ? (body.items as T[]) : [],
    total: typeof body.total === 'number' ? body.total : 0,
    forbidden: false,
  };
}

export const handleApiError = (error: unknown, context: string): never => {
  const err = error as AxiosError;
  const status = err.response?.status;
  const message = extractErrorMessage(err);
  if (status === 401) {
    logger.debug(`[API] ${context}: unauthorized (401)`);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
    }
    throw new UnauthorizedError(message);
  }
  if (status === 403) {
    logger.warn(`[API] ${context}: forbidden (403)`);
    throw new ForbiddenError(message);
  }
  logger.error(`[API] ${context}`, message);
  throw error;
};

export const handleSilentUnauthorized = (
  error: unknown,
  context: string,
): null => {
  const err = error as AxiosError;
  const status = err.response?.status;
  if (status === 401) {
    logger.debug(`[API] ${context}: unauthorized (401), silent`);
    return null;
  }
  logger.error(`[API] ${context}`, extractErrorMessage(err));
  throw error;
};
