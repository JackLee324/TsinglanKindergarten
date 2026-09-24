#!/usr/bin/env node
/**
 * scripts/verify-security-headers.mjs — live security-header verification
 * =======================================================================
 *
 * Before this suite existed, the application sent NO security headers at all and
 * advertised itself with `X-Powered-By`. Asserting the headers in a unit test
 * would only prove that a function returns an object; these headers are only
 * meaningful if they actually reach the wire, so this checks real HTTP responses
 * from a running instance.
 *
 * WHAT IT CHECKS
 *   - the response carries the headers we intend
 *   - `x-powered-by` is GONE (Express advertises itself by default)
 *   - the headers are present on BOTH an API response and a static/HTML response,
 *     because a header that only covers `/api/*` still leaves the SPA frameable
 *   - the CSP mode matches the configured `CSP_MODE`
 *   - the HSTS decision matches whether TLS/an upstream proxy is configured
 *
 * Run against a running instance:  MFA_BASE=http://127.0.0.1:3200 node scripts/verify-security-headers.mjs
 */

const BASE = process.env.MFA_BASE || 'http://127.0.0.1:3200';

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok =
    Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}-> ${String(actual)}${
      ok ? '' : `   expected ${expected}`
    }`,
  );
  ok ? pass++ : fail++;
}

function isTruthyEnv(v) {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}
function expectHsts() {
  if (isTruthyEnv(process.env.HTTPS_ENABLED)) return true;
  const proxy = (process.env.TRUST_PROXY ?? '').trim();
  return proxy !== '' && proxy.toLowerCase() !== 'false' && proxy !== '0';
}

async function probe(path) {
  const res = await fetch(BASE + path, { redirect: 'manual' });
  // Drain so the connection can be reused/closed cleanly.
  try {
    await res.text();
  } catch {
    /* body may be empty on a redirect */
  }
  return res;
}

console.log('=== A. API response headers ===');
let api;
try {
  api = await probe('/api/health');
} catch (error) {
  console.error(
    `\n  Cannot reach ${BASE}. Start the application first, or set MFA_BASE.\n  ${error.message}`,
  );
  process.exit(1);
}
check('/api/health responds', [200, 503].includes(api.status), true);

check(
  'x-content-type-options: nosniff',
  api.headers.get('x-content-type-options'),
  'nosniff',
);
check('x-frame-options: DENY', api.headers.get('x-frame-options'), 'DENY');
check(
  'referrer-policy',
  api.headers.get('referrer-policy'),
  'strict-origin-when-cross-origin',
);
check(
  'cross-origin-opener-policy',
  api.headers.get('cross-origin-opener-policy'),
  'same-origin',
);
check(
  'cross-origin-resource-policy',
  api.headers.get('cross-origin-resource-policy'),
  'same-origin',
);
check(
  'permissions-policy present',
  (api.headers.get('permissions-policy') ?? '').includes('camera=()'),
  true,
);
check('x-powered-by is REMOVED', api.headers.get('x-powered-by'), null);

console.log('\n=== B. Content-Security-Policy mode ===');
const cspMode = (process.env.CSP_MODE ?? '').trim().toLowerCase();
const enforce = cspMode === 'enforce';
const off = cspMode === 'off' || cspMode === 'false' || cspMode === '0';
if (enforce) {
  check('CSP enforcing header set', !!api.headers.get('content-security-policy'), true);
  check(
    'CSP report-only header NOT set',
    api.headers.get('content-security-policy-report-only'),
    null,
  );
} else if (off) {
  check(
    'CSP enforcing header absent (CSP_MODE=off)',
    api.headers.get('content-security-policy'),
    null,
  );
  check(
    'CSP report-only header absent (CSP_MODE=off)',
    api.headers.get('content-security-policy-report-only'),
    null,
  );
} else {
  // Default. Report-only is a deliberate, documented partial control.
  const ro = api.headers.get('content-security-policy-report-only');
  check('CSP report-only header set (default)', !!ro, true);
  check(
    'report-only policy denies framing',
    (ro ?? '').includes("frame-ancestors 'none'"),
    true,
  );
  check(
    'report-only policy pins connect-src',
    (ro ?? '').includes("connect-src 'self'"),
    true,
  );
  check(
    'CSP is NOT enforcing by default',
    api.headers.get('content-security-policy'),
    null,
  );
}

console.log('\n=== C. HSTS tracks TLS configuration ===');
console.log(
  '  NOTE: this assertion reads TRUST_PROXY/HTTPS_ENABLED from THIS process, so',
);
console.log(
  '        the suite and the server under test must be started from the same',
);
console.log(
  '        environment. Run both from one shell, or export the vars for both.',
);
const hsts = api.headers.get('strict-transport-security');
if (expectHsts()) {
  check('HSTS present (proxy/TLS configured)', !!hsts, true);
  check('HSTS max-age >= 180d', /max-age=(\d+)/.test(hsts ?? '') && Number((hsts.match(/max-age=(\d+)/) ?? [])[1]) >= 15552000, true);
  check('HSTS does NOT assert preload', (hsts ?? '').includes('preload'), false);
} else {
  check(
    'HSTS correctly ABSENT when no proxy/TLS is configured',
    hsts,
    null,
  );
}

console.log('\n=== D. headers also cover the HTML/SPA response ===');
const html = await probe('/');
check('GET / returns a response', html.status !== undefined, true);
check(
  'html: x-content-type-options nosniff',
  html.headers.get('x-content-type-options'),
  'nosniff',
);
check('html: x-frame-options DENY', html.headers.get('x-frame-options'), 'DENY');
check('html: x-powered-by is REMOVED', html.headers.get('x-powered-by'), null);

console.log('\n=== E. error responses carry the headers too ===');
const errRes = await probe('/api/resources/00000000-0000-0000-0000-000000000000');
check('error path returns a 4xx/5xx', [400, 401, 403, 404, 500].includes(errRes.status), true);
check(
  'error: nosniff still set',
  errRes.headers.get('x-content-type-options'),
  'nosniff',
);
check(
  'error: x-frame-options still set',
  errRes.headers.get('x-frame-options'),
  'DENY',
);

console.log('\n=== RESULT ===');
console.log(`  pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log('  security header verification FAILED');
  process.exit(1);
}
console.log('  security header verification passed');
