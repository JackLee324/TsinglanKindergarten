/**
 * Which request paths are API surfaces, and which are page (view) surfaces.
 * ========================================================================
 *
 * Two things depend on this distinction, and they must agree, because a path that
 * is an API for one and a view for the other is how a JSON client ends up parsing
 * the SPA shell:
 *
 *   1. The SPA fallback. `ViewController` owns the catch-all `@Get(['/', '*'])`
 *      route, so ANY unmatched path reaches it — including `/api/typo`. An API
 *      path must answer 404-as-JSON there, never 200-as-HTML. The platform did
 *      this by overriding `res.render` for its API prefixes; this repository does
 *      it inside the view handler, which is the same rule stated once.
 *
 *   2. The CSRF token middleware. It runs on PAGE routes only (the platform's
 *      configuration excluded `/api/(.*)`, `/openapi/(.*)` and `/static/(.*)`
 *      verbatim), because its job is to hand the rendered document a token the
 *      client can echo in `x-suda-csrf-token`. An API response has no document to
 *      put it in.
 *
 * The prefix list is deliberately the platform's, unextended: `/bundle/*` assets
 * still receive the token cookie exactly as they did before, so a browser that
 * already holds the cookie from the document keeps sending the same value.
 */

/** Paths that are JSON APIs, not pages. */
const API_PATH_PREFIXES = ['/api', '/openapi'] as const;

/**
 * Paths on which the CSRF token is NOT issued. A superset of the API prefixes
 * plus the static route the platform served through `StaticModule`.
 */
const CSRF_EXCLUDED_PREFIXES = ['/api', '/openapi', '/static'] as const;

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * True for JSON API paths (`/api`, `/api/...`, `/openapi`, `/openapi/...`).
 *
 * Both the bare prefix and the prefixed form match. The platform's version only
 * matched `"/api/"` (with the trailing slash), so a request to exactly `/api`
 * rendered the SPA; that was an oversight, not a contract, and `GET /api` now
 * answers 404 JSON like every other unknown API path.
 */
export function isApiRequestPath(path: string): boolean {
  return API_PATH_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

/** True on the paths where the CSRF token cookie is issued (i.e. page-ish routes). */
export function isCsrfTokenPath(path: string): boolean {
  return !CSRF_EXCLUDED_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}
