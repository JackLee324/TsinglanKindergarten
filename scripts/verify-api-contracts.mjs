#!/usr/bin/env node
/**
 * scripts/verify-api-contracts.mjs — static client/server API contract check
 * ==========================================================================
 * WHY
 *   Six client/server mismatches shipped in v1.3.0 and were only found by reading
 *   both sides by hand:
 *     GET  /api/resources/mine                      -> no such route at all
 *     POST /api/review/resources/:id                -> server: /api/resources/:id/review
 *     GET  /api/review/resources/:id/history        -> server: /api/resources/:id/review-history
 *     PATCH /api/teachers/:id/permissions           -> server: POST
 *     GET  /api/resources/:id/download              -> server 302s, client expected JSON
 *   Each one made a whole feature silently unusable. Nothing in the build could
 *   catch them, because the two sides share TYPES but not ROUTES.
 *
 * WHAT IT DOES
 *   Parses the axios calls in client/src/api/*.ts and the NestJS route decorators
 *   in server/modules/**, normalises both into `METHOD /path/:param` form, and
 *   fails when a client call has no matching server route.
 *
 *   It is intentionally STATIC: it runs in milliseconds, needs no database or
 *   running server, and can therefore sit in a pre-commit hook or CI where the
 *   live HTTP suites cannot.
 *
 * LIMITATIONS (stated rather than hidden)
 *   * Matching is by path shape, not by response body. A route that exists but
 *     returns an unexpected shape (the download 302) is NOT caught here; that is
 *     covered by the live suites.
 *   * Only `client/src/api/*.ts` is parsed. Paths built inline elsewhere would be
 *     missed, which is itself a reason to keep all HTTP calls in that directory.
 *
 * USAGE
 *   node scripts/verify-api-contracts.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_API_DIR = join(ROOT, 'client', 'src', 'api');
const SERVER_MODULES = join(ROOT, 'server', 'modules');

const red = (s) => `\u001b[31m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

// ---------------------------------------------------------------------------
// 1. server routes
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

function serverRoutes() {
  const routes = new Set();
  for (const file of walk(SERVER_MODULES)) {
    const src = readFileSync(file, 'utf8');
    const base = /@Controller\(\s*'([^']*)'\s*\)/.exec(src);
    const prefix = base ? base[1] : '';
    const re = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const method = m[1].toUpperCase();
      const path = m[2] ?? '';
      const full = ('/' + [prefix, path].filter(Boolean).join('/')).replace(/\/+/g, '/');
      routes.add(`${method} ${full}`);
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// 2. client calls
// ---------------------------------------------------------------------------
/**
 * Normalise a client path to the same shape the server decorator produces, so a
 * `${id}` template and a `:id` param compare equal, and so a query string is
 * ignored (params are not part of the route).
 */
function normaliseClientPath(raw) {
  let p = raw.trim();
  // template literals: /api/resources/${id}/download  ->  /api/resources/:id/download
  p = p.replace(/\$\{[^}]+\}/g, ':param');
  // strip a query string
  p = p.split('?')[0];
  // strip a trailing slash (except root)
  p = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return p;
}

function clientCalls() {
  const calls = [];
  for (const f of readdirSync(CLIENT_API_DIR).filter((f) => f.endsWith('.ts'))) {
    const file = join(CLIENT_API_DIR, f);
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    // axiosForBackend.get('/api/...') / .post(`/api/...`) etc, possibly multi-line
    const re = /axiosForBackend\s*\.\s*(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(\s*(`[^`]*`|'[^']*')/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const method = m[1].toUpperCase();
      const path = normaliseClientPath(m[2].slice(1, -1));
      if (!path.startsWith('/api')) continue;
      const lineNo = src.slice(0, m.index).split('\n').length;
      calls.push({ file: `${f}:${lineNo}`, method, path, raw: lines[lineNo - 1]?.trim() ?? '' });
    }
  }
  return calls;
}

/** Does a client call match a server route, treating :param segments as wildcards? */
function matches(clientCall, serverRoute) {
  const [sm, sp] = serverRoute.split(' ');
  if (sm !== clientCall.method) return false;
  const a = clientCall.path.split('/').filter(Boolean);
  const b = sp.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === ':param' || b[i].startsWith(':') || seg === b[i]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const routes = serverRoutes();
const calls = clientCalls();

console.log(`\n  server routes discovered : ${routes.size}`);
console.log(`  client calls discovered  : ${calls.length}\n`);

const unmatched = [];
for (const call of calls) {
  const ok = [...routes].some((r) => matches(call, r));
  if (!ok) unmatched.push(call);
}

// Reported but not failed: client paths that are navigation targets (an <img src>
// or window.location) rather than axios calls are not parsed at all, so the only
// thing asserted here is that every axios call has a route.
if (unmatched.length === 0) {
  console.log(`  ${green('✓')} every client API call has a matching server route\n`);
  process.exit(0);
}

console.log(`  ${red('✗')} ${unmatched.length} client call(s) have NO matching server route:\n`);
for (const u of unmatched) {
  console.log(`    ${red(u.method)} ${u.path}`);
  console.log(`      ${dim(relative(ROOT, join(CLIENT_API_DIR, u.file.split(':')[0])) + ':' + u.file.split(':')[1])}`);
  console.log(`      ${dim(u.raw)}`);
}
console.log('\n  Fix by correcting whichever side is wrong — but fix BOTH sides in one');
console.log('  change, because this is exactly the drift that made 6 features unusable.\n');
process.exit(1);
