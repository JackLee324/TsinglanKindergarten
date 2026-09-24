import type { Request, Response, NextFunction } from 'express';

/**
 * Security response headers (audit finding §Q-6).
 *
 * WHY THIS IS HAND-WRITTEN AND NOT `helmet`:
 * -----------------------------------------------------------------------------
 * `helmet` is not a dependency of this project (verified: `package.json` has no
 * `helmet` and no `cors`). Installing it is not a safe operation in this
 * repository: `package-lock.json` was generated on a linux/x64 machine and
 * contains platform-specific optional dependencies for linux only. Any
 * `npm install` re-resolves the tree and prunes the five darwin/arm64 native
 * binaries this project needs to build at all
 * (`@swc/core-darwin-arm64`, `@rolldown/binding-darwin-arm64`,
 * `lightningcss-darwin-arm64`, `@napi-rs/nice-darwin-arm64`,
 * `@tailwindcss/oxide-darwin-arm64`), leaving a project that no longer builds.
 * A previous round lost time to exactly that failure.
 *
 * The headers below need no dependency, so we set them ourselves. That is
 * strictly better than leaving the application with no headers at all, and it
 * keeps the dependency tree untouched and reproducible.
 *
 * WHAT EACH HEADER DEFENDS AGAINST, IN THIS SPECIFIC APPLICATION:
 *
 *   X-Content-Type-Options: nosniff
 *     A browser that sniffs a response body can be tricked into executing it as
 *     a type we did not intend. This matters here because the platform serves
 *     user-influenced bytes (uploaded curriculum files, storybook cover images)
 *     and because `/api/files/download` redirects to object storage. Without
 *     nosniff, a mislabelled upload can become script.
 *
 *   X-Frame-Options: DENY  +  frame-ancestors 'none'
 *     Clickjacking. The admin surfaces (`/admin/teachers`, `/admin/permissions`,
 *     `/admin/audit`) and the review workbench perform state-changing actions;
 *     framing them lets a third-party page overlay invisible controls. There is
 *     no legitimate framing use case for this internal platform, so DENY rather
 *     than SAMEORIGIN.
 *
 *   Referrer-Policy: strict-origin-when-cross-origin
 *     Phase 6 introduced short-lived, caller-bound signed download URLs. A
 *     signed URL in a navigated-to link would otherwise be sent in the `Referer`
 *     header to any third-party origin the page later requests — handing an
 *     attacker a working download token for its whole TTL. This policy sends the
 *     full URL only for same-origin requests and strips it cross-origin.
 *
 *   Cross-Origin-Opener-Policy: same-origin
 *     Severs the `window.opener` handle a cross-origin page would otherwise
 *     retain, which otherwise enables reverse tabnabbing against the admin UI.
 *
 *   Cross-Origin-Resource-Policy: same-origin
 *     Stops other origins from embedding this application's responses as
 *     subresources (a cross-origin `<img>`/`<script>` probe can leak whether a
 *     resource exists for the current session).
 *
 *   Permissions-Policy
 *     This application uses none of camera/microphone/geolocation. Denying them
 *     removes the capability from any injected or third-party code.
 *
 *   Strict-Transport-Security
 *     Only emitted when TLS is actually terminating in front of us, because HSTS
 *     sent over plain HTTP is ignored by browsers and sending it while TLS is
 *     misconfigured can lock users out of a working HTTP deployment. Gated behind
 *     HTTPS_ENABLED / TRUST_PROXY being set — i.e. "there is a proxy in front",
 *     which is the deployment shape this platform uses. See main.ts.
 *
 *   Content-Security-Policy
 *     Shipped in REPORT-ONLY mode by default.
 *     The owner's standing instruction is that UI changes are only permitted
 *     where security requires them, and an enforcing CSP that is wrong is a
 *     self-inflicted outage (a blocked bundle means a blank page for every
 *     teacher). We cannot verify the full inline-style/inline-script surface of
 *     the built SPA from here, so we start by *observing* violations rather than
 *     breaking the application: the browser reports violations and applies
 *     nothing. An operator who has read the reports can switch to enforcing with
 *     CSP_MODE=enforce. This is an honest partial control, not a finished one —
 *     recorded as such in SECURITY.md.
 *
 *   x-powered-by
 *     Express advertises itself by default. Removing it denies an attacker free
 *     fingerprinting of the framework and version family; it is not a
 *     vulnerability on its own, but it is free to remove.
 */

/** Reported-only by default; set `CSP_MODE=enforce` to actually block. */
function resolveCspMode(): 'report-only' | 'enforce' | 'off' {
  const raw = (process.env.CSP_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'enforce') return 'enforce';
  return 'report-only';
}

/**
 * Whether TLS termination is in front of this process.
 *
 * HSTS is only meaningful (and only safe) once the site is genuinely reachable
 * over HTTPS. We infer that from the same signal the trust-proxy logic uses:
 * a proxy is configured. `HTTPS_ENABLED` is honoured explicitly as well.
 */
function isBehindTls(): boolean {
  const https = (process.env.HTTPS_ENABLED ?? '').trim().toLowerCase();
  if (https === 'true' || https === '1' || https === 'yes') return true;
  const proxy = (process.env.TRUST_PROXY ?? '').trim();
  return proxy !== '' && proxy.toLowerCase() !== 'false' && proxy !== '0';
}

/**
 * Policy for the built client.
 *
 * `'self'` only for scripts — the Vite build emits hashed external bundles, not
 * inline script. `style-src` needs `'unsafe-inline'` because React/Tailwind
 * component libraries routinely set the `style` attribute at runtime, and
 * blocking that would visibly break layout. `img-src`/`font-src` allow `data:`
 * for inlined small assets. `frame-ancestors 'none'` mirrors X-Frame-Options.
 * `connect-src 'self'` is what actually matters: it stops exfiltration via
 * `fetch` to an attacker origin even if script execution is somehow achieved.
 */
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express sets this at the framework level before any middleware runs.
  res.removeHeader('X-Powered-By');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );

  if (isBehindTls()) {
    // 180 days, and preload is deliberately NOT asserted: this is an internal
    // platform whose domain an operator may need to move, and preload is hard to
    // reverse.
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains',
    );
  }

  const cspMode = resolveCspMode();
  if (cspMode === 'enforce') {
    res.setHeader('Content-Security-Policy', CSP_POLICY);
  } else if (cspMode === 'report-only') {
    res.setHeader('Content-Security-Policy-Report-Only', CSP_POLICY);
  }

  next();
}

/**
 * Report the resolved configuration once at boot so the operator can see which
 * headers are actually active rather than assuming. Called from main.ts.
 */
export function describeSecurityHeaders(): string {
  return (
    `security headers: on (csp=${resolveCspMode()}, ` +
    `hsts=${isBehindTls() ? 'on' : 'off — set HTTPS_ENABLED=true or TRUST_PROXY behind TLS'})`
  );
}
