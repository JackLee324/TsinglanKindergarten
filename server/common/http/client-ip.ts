import type { Request } from 'express';

/**
 * Resolve the client IP address for rate limiting and audit records.
 * =================================================================
 *
 * WHY THIS EXISTS (audit finding D-10)
 * ------------------------------------
 * Three places used to parse the header by hand:
 *
 *     const forwarded = req.headers['x-forwarded-for'];
 *     return forwarded.split(',')[0].trim();      // auth.controller.ts
 *
 * `X-Forwarded-For` is **client-supplied**. Anyone can send
 *
 *     curl -H 'X-Forwarded-For: 1.2.3.4' https://app/api/auth/login
 *
 * and choosing the FIRST element of the list is the worst possible choice: it is
 * the value the client itself wrote. Consequences, all security-relevant:
 *
 *   * the per-IP login rate limit (30/min) could be bypassed by rotating the
 *     header, turning a brute-force brake into a no-op;
 *   * every audit row (`ip_address`) could be forged, so an intrusion could not
 *     be attributed — and the audit log is the artefact an investigator relies on;
 *   * account lockout behaviour became attacker-controlled.
 *
 * Express already solves this correctly. With `app.set('trust proxy', …)`
 * configured (see main.ts), `req.ip` is derived by walking the forwarded chain
 * from the RIGHT and discarding hops that are not trusted proxies, so only values
 * appended by infrastructure the operator controls are believed.
 *
 * This helper therefore returns `req.ip` and NEVER reads the header itself.
 */
export function getClientIp(req: Request): string {
  // `req.ip` is undefined only when Express is used outside the normal request
  // pipeline; fall back to the socket rather than to a forgeable header.
  const ip = req.ip || req.socket?.remoteAddress || '';

  // Normalise IPv4-mapped IPv6 addresses ("::ffff:203.0.113.7" -> "203.0.113.7")
  // so that one client does not occupy two buckets in the rate limiter, and so
  // audit rows store a stable, human-readable form.
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length);

  return ip;
}

/**
 * Read `TRUST_PROXY` and translate it into the value Express expects.
 *
 * Default (unset / "false") is `false`: trust NO proxy, so `req.ip` is the
 * socket address and cannot be influenced by the client at all. This is the safe
 * default — an operator who forgets to configure it gets correct behaviour rather
 * than a silently bypassable rate limiter.
 *
 *   TRUST_PROXY=false        -> false        (no proxy; default)
 *   TRUST_PROXY=loopback     -> 'loopback'   (proxy on 127.0.0.1, typical nginx)
 *   TRUST_PROXY=1            -> 1            (exactly one trusted hop)
 *   TRUST_PROXY=true         -> true         (trust all — only behind a single
 *                                             proxy you fully control, e.g. a
 *                                             Kubernetes ingress that strips
 *                                             inbound XFF)
 *   TRUST_PROXY=<cidr,list>  -> that string  (e.g. '10.0.0.0/8,192.168.0.0/16')
 *
 * ⚠ `true` is dangerous when the app is reachable directly: the client's own
 *   X-Forwarded-For then becomes `req.ip` again, re-introducing exactly the bug
 *   this module fixes.
 */
export function resolveTrustProxySetting(): boolean | number | string {
  const raw = (process.env.TRUST_PROXY ?? '').trim();

  if (raw === '' || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;

  // A bare integer is a hop count.
  if (/^\d+$/.test(raw)) return Number(raw);

  // Anything else is passed through: Express accepts a comma-separated list of
  // addresses, subnets or the keywords 'loopback' / 'linklocal' / 'uniquelocal'.
  return raw;
}

/**
 * Describe the trust-proxy configuration for startup logging, so an operator can
 * see at a glance whether client IPs are trustworthy in this deployment.
 */
export function describeTrustProxy(setting: boolean | number | string): string {
  if (setting === false) return 'disabled (req.ip = socket address; X-Forwarded-For ignored)';
  if (setting === true) {
    return 'TRUSTING ALL PROXIES — every X-Forwarded-For hop is believed. ' +
      'Only safe when a trusted proxy always strips/overwrites the header.';
  }
  return `trusting ${String(setting)}`;
}
