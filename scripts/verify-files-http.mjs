/**
 * scripts/verify-files-http.mjs — live HTTP verification of the phase-6
 * file upload / download / recycle-bin boundary.
 *
 * Requires a running server and AUTHZ_TEST_DB:
 *
 *   AUTHZ_TEST_DB=postgres://... node scripts/verify-files-http.mjs
 *
 * Asserts, over real HTTP:
 *   A. an unauthenticated caller cannot use the download endpoint at all
 *   B. GET /api/resources/:id/download returns a SIGNED, caller-bound token URL,
 *      and no longer the old bucket+path placeholder
 *   C. the token cannot be redeemed in this environment, and the failure is an
 *      explicit 503 naming the missing platform storage integration — never a
 *      silent success and never a fabricated link
 *   D. that token is REJECTED when replayed with another account's session
 *   E. a tampered payload / tampered signature / malformed token is rejected
 *   F. an EXPIRED token is rejected (see the server-TTL note below)
 *   G. the recycle bin hides a soft-deleted resource from every normal listing,
 *      and restore brings it back
 *   H. the recycle bin itself is refused to an account without `resource.restore`
 *   I. server-side upload validation rejects a mislabelled payload, an HTML/SVG
 *      payload, an oversize payload, a traversal path and a zero-byte file —
 *      and leaves the previously registered file intact
 *
 * SERVER TTL NOTE (why the expiry check is written the way it is)
 *   Proving expiry LIVE needs a token that is genuinely past its `exp`. Minting
 *   one would require the server's signing secret, and this suite deliberately
 *   does NOT ask for it — none of the live suites share secrets (verify-mfa
 *   computes TOTP independently for the same reason). Instead the suite DECODES
 *   the token it was given: the payload is base64url, not a cipher, so `exp` is
 *   readable without the key. It then waits the TTL out.
 *
 *   That is only practical for a short TTL, so the suite prints the effective TTL
 *   and, when it exceeds MAX_LIVE_TTL_SECONDS, says OUT LOUD that the live wait was
 *   skipped and points at tests/file-security.test.mjs, which covers expiry
 *   deterministically for any TTL. With a server started using
 *   DOWNLOAD_TOKEN_TTL_SECONDS=5 (as in the recorded gate run) the live assertion
 *   runs. The TTL bound itself (<= 3600s) is always asserted.
 *
 * Kept as a script rather than a test because it needs a live server and a
 * database; see PRODUCTION_READINESS.md for how it is run.
 */

const BASE = process.env.FILES_BASE || process.env.MFA_BASE || 'http://127.0.0.1:3200';
const PW = 'TestPassw0rd!';
/**
 * PER-RUN identity for the probe rows.
 *
 * The five live suites share ONE mutable database, and two copies of this suite
 * (or a suite plus a gate run) used to destroy each other: a shared literal title
 * prefix meant run B's cleanup deleted run A's probe resource, which surfaced as
 * "0 expected 1" / "404 expected 200" — a failure that says nothing about the
 * product. A per-process, per-run prefix makes each run's rows private to it.
 */
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const TITLE_PREFIX = `__files_http_probe_${RUN_ID}__`;
/** Longest TTL this suite is willing to sit and wait for. */
const MAX_LIVE_TTL_SECONDS = 30;

let jar = {};
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function store(res) {
  for (const c of (res.headers.getSetCookie?.() ?? [])) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
/**
 * One raw HTTP request. NO retry, NO recovery — `req()` wraps this.
 * `login()` must use this directly, or a recovery would recurse into a login.
 */
async function rawReq(method, path, body, extra = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (Object.keys(jar).length) headers['cookie'] = ch();
  if (jar['suda-csrf-token']) headers['x-suda-csrf-token'] = jar['suda-csrf-token'];
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  store(res);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // A 302 has no body; the storybook-cover endpoint streams an image. Draining
    // the body keeps the connection reusable instead of leaking it.
    try { await res.arrayBuffer(); } catch { /* nothing to drain */ }
  }
  return { status: res.status, data, headers: res.headers };
}

let currentUser = null;
let sessionRecoveries = 0;
const MAX_SESSION_RECOVERIES = 5;

/**
 * Request with bounded SESSION RECOVERY.
 *
 * WHY: every live suite starts with `resetFixtures()`, which revokes ALL sessions
 * and bumps `permissions_version`. When two suites (or two copies of this one, or
 * a suite and a gate run) overlap, the other process invalidates this run's
 * session mid-flight, and a 401 is NOT a finding about the code under test.
 * Reproduced deliberately: two concurrent runs of this suite both collapsed into
 * a cascade of 401s (`pass=50 fail=22`).
 *
 * So a 401 on an authenticated request re-authenticates ONCE and repeats the
 * request, loudly. This does not hide a real authz regression: a genuine broken
 * session/token/permission path fails identically after re-authentication, and
 * the recovery is only attempted for 401 (never 403/400/404 — those are the
 * product behaviours this suite asserts). Repeated recoveries mean the
 * environment is wrong, and the run says so instead of reporting a fake cascade.
 */
async function req(method, path, body, extra = {}) {
  const res = await rawReq(method, path, body, extra);
  const authenticating = path.startsWith('/api/auth/login') || path === '/';
  if (res.status !== 401 || currentUser === null || authenticating) return res;

  sessionRecoveries += 1;
  console.log(
    `  WARN  401 from ${method} ${path} — the shared fixture was reset under this run ` +
      `(another live suite/gate is active). Re-authenticating.`,
  );
  if (sessionRecoveries > MAX_SESSION_RECOVERIES) {
    throw new Error(
      `the shared fixture was invalidated ${sessionRecoveries} times during this run: ` +
        'another live suite or gate is running concurrently against the same database. ' +
        'Re-run with no other suite active — this is an ENVIRONMENT failure, not a product one.',
    );
  }
  const relogin = await login(currentUser);
  if (relogin.status !== 201) {
    console.log('  WARN  re-authentication failed; returning the original 401');
    return res;
  }
  return rawReq(method, path, body, extra);
}
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(62) + '-> ' + String(actual) + (ok ? '' : '   expected ' + expected));
  ok ? pass++ : fail++;
}
async function login(user) {
  currentUser = user;
  jar = {};
  await rawReq('GET', '/'); // obtain the suda-csrf-token cookie
  const r = await rawReq('POST', '/api/auth/login', { username: user, password: PW });
  if (r.status !== 201) {
    console.log('  LOGIN FAILED for ' + user + ': ' + r.status + ' ' + JSON.stringify(r.data));
  }
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMessage = (r) => String(r?.data?.error?.message ?? '');

/** The payload half of a token is base64url JSON — decodable WITHOUT the secret. */
function decodeTokenPayload(token) {
  const [body] = String(token).split('.');
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
function tokenFromLocation(location) {
  const m = /[?&]token=([^&]+)/.exec(String(location ?? ''));
  return m ? decodeURIComponent(m[1]) : null;
}
/** Mint a download URL for `id` as the CURRENT session and return its token. */
async function mintToken(id) {
  const res = await req('GET', `/api/resources/${id}/download`);
  if (res.status !== 302) {
    throw new Error(`expected a 302 with a signed URL, got ${res.status} ${JSON.stringify(res.data)}`);
  }
  const token = tokenFromLocation(res.headers.get('location'));
  if (!token) throw new Error('no token in Location: ' + String(res.headers.get('location')));
  return { token, location: res.headers.get('location') };
}

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COVER_ASSETS_DIR = join(ROOT, 'server', 'assets', 'prek-english-covers');

const Pg = (await import('postgres')).default;
const { resetFixtures: sharedReset } = await import('../tests/helpers/reset-fixtures.mjs');
const sql = Pg(process.env.AUTHZ_TEST_DB, { onnotice: () => {} });

// Shared fixture reset so this suite can run after any other suite, in any order.
// See tests/helpers/reset-fixtures.mjs — and never delete __rbac_keeper.
await sharedReset(process.env.AUTHZ_TEST_DB, { password: PW });

const createdResourceIds = [];
/** A real PDF header, base64. */
const PDF_HEAD_B64 = Buffer.from('%PDF-1.7\n1 0 obj\n', 'utf8').toString('base64');

try {
  // =========================================================================
  console.log('=== A. UNAUTHENTICATED ACCESS IS REFUSED ===');
  // =========================================================================
  await req('GET', '/');
  check('GET /api/files/download without a session', (await req('GET', '/api/files/download?token=whatever.signature')).status, 401);
  check('GET /api/files/download without even a token', (await req('GET', '/api/files/download')).status, 401);
  check('GET /api/resources/recycle-bin without a session', (await req('GET', '/api/resources/recycle-bin')).status, 401);

  // =========================================================================
  console.log('\n=== B. SIGNED, CALLER-BOUND DOWNLOAD URL ===');
  // =========================================================================
  check('login as principal (qlsadmin)', (await login('qlsadmin')).status, 201);
  const ownerId = (await req('GET', '/api/auth/me')).data?.id;

  const created = await req('POST', '/api/resources', {
    title: TITLE_PREFIX + ' lesson plan',
    titleEn: 'Files probe lesson plan',
    program: 'prek',
    subject: 'virtue',
    folderType: 'curriculum_outline',
    semester: 'S1',
    weekNumber: 1,
    description: 'created by scripts/verify-files-http.mjs',
  });
  check('POST /api/resources creates the probe resource', created.status, 201);
  const resourceId = created.data?.id;
  if (!resourceId) throw new Error('probe resource was not created: ' + JSON.stringify(created.data));
  createdResourceIds.push(resourceId);

  check('download of a resource with no file is refused', (await req('GET', `/api/resources/${resourceId}/download`)).status, [400, 404]);

  const registered = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: '../教材 第1周.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    head: PDF_HEAD_B64,
    fileBucketId: 'bucket_probe_0001',
    filePath: 'uploads/probe/lesson.pdf',
  });
  check('POST /api/resources/:id/file accepts a real PDF', registered.status, 201);
  check('  -> the stored name is sanitised (no ../ prefix)', registered.data?.fileName, '教材 第1周.pdf');

  const first = await mintToken(resourceId);
  check('GET /api/resources/:id/download redirects', /^\/api\/files\/download\?token=/.test(String(first.location)), true);
  check('  -> the URL no longer leaks bucket= / path=', /bucket=|path=/.test(String(first.location)), false);
  const payload = decodeTokenPayload(first.token);
  check('  -> the token names the resource', payload?.resourceId, resourceId);
  check('  -> the token is bound to the CALLING account', payload?.teacherId, ownerId);
  const ttlSeconds = payload ? payload.exp - Math.floor(Date.now() / 1000) : -1;
  console.log('       effective download-token TTL: ' + ttlSeconds + 's');
  check('  -> TTL is positive and bounded (<= 3600s)', ttlSeconds > 0 && ttlSeconds <= 3600, true);
  check('  -> two tokens for the same resource differ (nonce)', (await mintToken(resourceId)).token !== first.token, true);

  // =========================================================================
  console.log('\n=== C. NO SILENT SUCCESS WITHOUT A STORAGE BACKEND ===');
  // =========================================================================
  // The token is valid, the session matches, the permission is held — the ONLY
  // thing that can still fail is the platform object store, which is genuinely
  // unreachable here. This is the check that forbids a fabricated placeholder URL.
  const redeem = await req('GET', `/api/files/download?token=${encodeURIComponent(first.token)}`);
  check('redemption cannot silently succeed', redeem.status, 503);
  check('  -> the error names the missing platform integration', /@lark-apaas\/file-service/.test(errMessage(redeem)), true);
  check('  -> no fabricated link is returned', /downloadUrl|signedURL|https?:/.test(JSON.stringify(redeem.data ?? {})), false);
  console.log('       response: ' + redeem.status + ' ' + errMessage(redeem).slice(0, 110) + '…');

  // =========================================================================
  console.log('\n=== D. CROSS-USER REPLAY IS REFUSED ===');
  // =========================================================================
  const forOwner = await mintToken(resourceId);
  // prek-teacher01 holds resource.download + storage.download, so a refusal here
  // cannot be an artefact of a missing permission on the route.
  check('login as a DIFFERENT account (prek-teacher01)', (await login('prek-teacher01')).status, 201);
  const perms = (await req('GET', '/api/auth/me/permissions')).data;
  check('  -> that account holds resource.download', perms?.permissions?.includes('resource.download'), true);
  const replayed = await req('GET', `/api/files/download?token=${encodeURIComponent(forOwner.token)}`);
  check("the owner's token is REJECTED for another account", replayed.status, 403);
  const ownerStillFresh = decodeTokenPayload(forOwner.token).exp > Math.floor(Date.now() / 1000);
  if (ownerStillFresh) {
    check('  -> refused because it belongs to another account', /其他账号/.test(errMessage(replayed)), true);
  } else {
    console.log('  NOTE  the token had already expired when replayed, so the refusal reason is');
    console.log('        expiry rather than account mismatch. The status assertion still holds.');
  }
  console.log('       response: ' + replayed.status + ' ' + errMessage(replayed).slice(0, 110));

  // =========================================================================
  console.log('\n=== E. TAMPERED / MALFORMED TOKENS ARE REFUSED ===');
  // =========================================================================
  check('login as the token owner again', (await login('qlsadmin')).status, 201);
  const owned = await mintToken(resourceId);
  const [body, signature] = owned.token.split('.');
  const ownedPayload = decodeTokenPayload(owned.token);

  const extended = Buffer.from(JSON.stringify({ ...ownedPayload, exp: ownedPayload.exp + 100000 }), 'utf8').toString('base64url');
  const reSigned = await req('GET', `/api/files/download?token=${encodeURIComponent(`${extended}.${signature}`)}`);
  check('extending exp with the old signature is refused', reSigned.status, 403);

  const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  check('a tampered signature is refused', (await req('GET', `/api/files/download?token=${encodeURIComponent(`${body}.${flipped}`)}`)).status, 403);
  check('a malformed token is refused', (await req('GET', '/api/files/download?token=not-a-token')).status, 400);

  // =========================================================================
  console.log('\n=== F. EXPIRED TOKEN IS REFUSED ===');
  // =========================================================================
  const expiring = await mintToken(resourceId);
  const expiringPayload = decodeTokenPayload(expiring.token);
  const liveTtl = expiringPayload.exp - Math.floor(Date.now() / 1000);
  if (liveTtl >= 0 && liveTtl <= MAX_LIVE_TTL_SECONDS) {
    const waitMs = Math.max((liveTtl + 1) * 1000, 1000);
    console.log('       waiting ' + waitMs + 'ms for exp=' + expiringPayload.exp);
    await sleep(waitMs);
    const expired = await req('GET', `/api/files/download?token=${encodeURIComponent(expiring.token)}`);
    check('an expired token is refused', expired.status, 403);
    check('  -> the message says it expired', /过期/.test(errMessage(expired)), true);
  } else {
    console.log('  NOTE  the running server issued a ' + liveTtl + 's TTL, longer than this suite will');
    console.log('        wait (' + MAX_LIVE_TTL_SECONDS + 's), so the live expiry wait did NOT run here.');
    console.log('        Deterministic coverage: tests/file-security.test.mjs ->');
    console.log('        "an EXPIRED token is rejected with reason expired".');
    console.log('        To run it live: start the server with DOWNLOAD_TOKEN_TTL_SECONDS=5.');
  }

  // =========================================================================
  console.log('\n=== G. RECYCLE BIN: HIDDEN WHEN DELETED, VISIBLE AGAIN AFTER RESTORE ===');
  // =========================================================================
  const keyword = encodeURIComponent(TITLE_PREFIX + ' lesson plan');
  check('the resource is listed before deletion', (await req('GET', `/api/resources?keyword=${keyword}`)).data?.total, 1);

  // The review queue and the dashboard counts live in OTHER services
  // (review.service.ts / dashboard.service.ts) and are the easiest places to
  // forget the soft-delete predicate — a deleted resource that stays "pending
  // review" forever can never be cleared, and dashboard tiles that ignore the
  // deletion contradict the list right below them. Asserted end-to-end here.
  check('POST /api/resources/:id/submit-review works', (await req('POST', `/api/resources/${resourceId}/submit-review`)).status, 201);
  const statsBefore = (await req('GET', '/api/dashboard/stats')).data;
  const pendingBefore = (await req('GET', '/api/review/pending?pageSize=100')).data;
  check('it is in the review queue before deletion', (pendingBefore?.items ?? []).some((i) => i.id === resourceId), true);
  const recentBefore = (await req('GET', '/api/dashboard/recent?limit=50')).data;
  check('it is in the dashboard recent list before deletion', (recentBefore?.items ?? []).some((i) => i.id === resourceId), true);
  console.log('       dashboard myResources before delete: ' + statsBefore?.myResources);

  check('DELETE /api/resources/:id succeeds (soft delete)', (await req('DELETE', `/api/resources/${resourceId}`)).status, 200);
  check('it disappears from the normal listing', (await req('GET', `/api/resources?keyword=${keyword}`)).data?.total, 0);
  check('it is 404 on direct read', (await req('GET', `/api/resources/${resourceId}`)).status, 404);
  const mine = await req('GET', '/api/resources/mine?pageSize=100');
  check('it disappears from "my resources"', (mine.data?.items ?? []).some((i) => i.id === resourceId), false);
  check('it cannot be downloaded while in the bin', (await req('GET', `/api/resources/${resourceId}/download`)).status, 404);
  const statsAfter = (await req('GET', '/api/dashboard/stats')).data;
  check('the dashboard "my resources" count drops by exactly 1', (statsBefore?.myResources ?? 0) - (statsAfter?.myResources ?? 0), 1);
  check('it leaves the review queue', ((await req('GET', '/api/review/pending?pageSize=100')).data?.items ?? []).some((i) => i.id === resourceId), false);
  check('it leaves the dashboard recent list', ((await req('GET', '/api/dashboard/recent?limit=50')).data?.items ?? []).some((i) => i.id === resourceId), false);

  const bin = await req('GET', '/api/resources/recycle-bin?pageSize=100');
  check('GET /api/resources/recycle-bin works (route ORDER: declared before :id)', bin.status, 200);
  const binItem = (bin.data?.items ?? []).find((i) => i.id === resourceId);
  check('  -> the deleted resource is IN the bin', Boolean(binItem), true);
  check('  -> the bin records when it was deleted', Boolean(binItem?.deletedAt), true);
  check('  -> the bin records when it will be purged', Boolean(binItem?.purgeAfter), true);
  if (binItem?.deletedAt && binItem?.purgeAfter) {
    const retentionDays = (new Date(binItem.purgeAfter) - new Date(binItem.deletedAt)) / 86400000;
    check('  -> the retention window is a positive number of days', retentionDays > 0, true);
    console.log('       retention window: ' + retentionDays.toFixed(2) + ' days');
  }

  check('POST /api/resources/:id/restore succeeds', (await req('POST', `/api/resources/${resourceId}/restore`)).status, 201);
  check('the resource is listed again after restore', (await req('GET', `/api/resources?keyword=${keyword}`)).data?.total, 1);
  check('  -> and is readable again', (await req('GET', `/api/resources/${resourceId}`)).status, 200);
  check('  -> the dashboard count recovers', (await req('GET', '/api/dashboard/stats')).data?.myResources, statsBefore?.myResources);
  check('  -> it is back in the review queue', ((await req('GET', '/api/review/pending?pageSize=100')).data?.items ?? []).some((i) => i.id === resourceId), true);
  check('  -> and is downloadable again', (await req('GET', `/api/resources/${resourceId}/download`)).status, 302);
  check('restoring a resource that is not in the bin is refused', (await req('POST', `/api/resources/${resourceId}/restore`)).status, 404);

  // =========================================================================
  console.log('\n=== H. RECYCLE BIN IS REFUSED WITHOUT resource.restore ===');
  // =========================================================================
  check('login as prek-teacher01 (no resource.restore)', (await login('prek-teacher01')).status, 201);
  const teacherPerms = (await req('GET', '/api/auth/me/permissions')).data;
  check('  -> confirmed: no resource.restore', teacherPerms?.permissions?.includes('resource.restore'), false);
  check('GET /api/resources/recycle-bin is forbidden', (await req('GET', '/api/resources/recycle-bin')).status, 403);
  check('POST /api/resources/:id/restore is forbidden', (await req('POST', `/api/resources/${resourceId}/restore`)).status, 403);
  check('DELETE /api/resources/:id is forbidden', (await req('DELETE', `/api/resources/${resourceId}`)).status, 403);
  check('POST /api/resources/:id/file is forbidden', (await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10, head: PDF_HEAD_B64,
    fileBucketId: 'bucket_probe_0001', filePath: 'uploads/probe/x.pdf',
  })).status, 403);

  // =========================================================================
  console.log('\n=== I. SERVER-SIDE UPLOAD VALIDATION ===');
  // =========================================================================
  check('login as principal again', (await login('qlsadmin')).status, 201);

  const spoof = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 32,
    head: Buffer.from('this is not a pdf at all, honestly', 'utf8').toString('base64'),
    fileBucketId: 'bucket_probe_0001',
    filePath: 'uploads/probe/notes.pdf',
  });
  check('a TEXT payload declared application/pdf is REJECTED', spoof.status, 400);

  const markup = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'worksheet.txt',
    mimeType: 'text/plain',
    sizeBytes: 54,
    head: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'utf8').toString('base64'),
    fileBucketId: 'bucket_probe_0001',
    filePath: 'uploads/probe/worksheet.txt',
  });
  check('an SVG/HTML payload renamed .txt is REJECTED', markup.status, 400);
  check('  -> the reason names the stored-XSS risk', /HTML|SVG|标记/.test(errMessage(markup)), true);

  const oversize = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'huge.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 300 * 1024 * 1024,
    head: PDF_HEAD_B64,
    fileBucketId: 'bucket_probe_0001',
    filePath: 'uploads/probe/huge.pdf',
  });
  check('an oversize file is REJECTED', oversize.status, 400);

  const traversal = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'ok.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    head: PDF_HEAD_B64,
    fileBucketId: 'bucket_probe_0001',
    filePath: '../../../etc/passwd',
  });
  check('a path-traversal filePath is REJECTED', traversal.status, 400);

  const emptyFile = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'empty.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 0,
    head: '',
    fileBucketId: 'bucket_probe_0001',
    filePath: 'uploads/probe/empty.pdf',
  });
  check('a zero-byte upload is REJECTED', emptyFile.status, 400);

  // A LEADING-SLASH path is the platform's real key shape. The strict predicate
  // refuses it, so the registration boundary must NORMALISE it (as the platform's
  // own parseFilePath does) and persist the bucket-relative form — never store the
  // absolute one. This is the check that keeps the strict predicate from breaking
  // real platform data.
  const absolutePath = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'cover.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    head: PDF_HEAD_B64,
    fileBucketId: 'bucket_probe_0001',
    filePath: '/curriculum-resources/probe/cover.pdf',
  });
  check('a leading-slash platform path is ACCEPTED (normalised, not rejected)', absolutePath.status, 201);
  check('  -> the stored path is bucket-relative', absolutePath.data?.filePath, 'curriculum-resources/probe/cover.pdf');

  const badBucket = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'ok.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    head: PDF_HEAD_B64,
    fileBucketId: 'bucket/../../escape',
    filePath: 'uploads/probe/ok.pdf',
  });
  check('a malformed bucket id is REJECTED', badBucket.status, 400);

  // Everything above either succeeded with a normalised path or was rejected, and
  // the resource still downloads.
  check('the resource still downloads after the validation matrix', (await req('GET', `/api/resources/${resourceId}/download`)).status, 302);

  const auditRows = await sql`
    select action, success from audit_logs
    where resource_id = ${resourceId}
      and action in ('resource_file_register', 'file_validation_rejected', 'resource_delete', 'resource_restore')
    order by _created_at`;
  const actions = auditRows.map((r) => r.action + (r.success ? '' : ':denied'));
  check('the accepted upload was audited', actions.includes('resource_file_register'), true);
  check('  -> the rejected uploads were audited too', actions.filter((a) => a === 'file_validation_rejected:denied').length >= 4, true);
  check('  -> the soft delete was audited', actions.includes('resource_delete'), true);
  check('  -> the restore was audited', actions.includes('resource_restore'), true);
  console.log('       audit actions: ' + actions.join(', '));
  // =========================================================================
  console.log('\n=== J. REAL PLATFORM PATH SHAPES STILL WORK (regression guard) ===');
  // =========================================================================
  // The seeded curriculum stores storybook covers as
  //   "/curriculum-resources/prek-english-covers/<id>.jpg"
  // — with a LEADING SLASH. An earlier revision of isPathTraversalSafe rejected
  // every absolute-looking stored path, which turned each of these real covers
  // into a 400. This check pushes the REAL value from the REAL row through the
  // REAL endpoint, so the mistake cannot come back unnoticed.
  const coverRows = await sql`
    select id, description from resources
    where description like '%prek-english-covers%' and status = 'published'`;
  let coverPick = null;
  for (const row of coverRows) {
    try {
      const storybooks = JSON.parse(row.description ?? '{}').storybooks ?? [];
      for (let i = 0; i < storybooks.length; i += 1) {
        const stored = String(storybooks[i]?.filePath ?? '');
        if (!stored.startsWith('/')) continue; // the shape under test
        const base = stored.split(/[\\/]+/).pop();
        if (base && existsSync(join(COVER_ASSETS_DIR, base))) {
          coverPick = { id: row.id, index: i, stored, base };
          break;
        }
      }
    } catch { /* not a storybook row */ }
    if (coverPick) break;
  }
  if (coverPick) {
    console.log('       stored path under test: ' + coverPick.stored);
    // The endpoint serves the cover from the SERVER's own asset tree
    // (`dist/server/assets/...` or `dist/assets/...`, depending on __dirname vs
    // cwd), NOT from the source tree. A concurrent `npm run build` deletes dist,
    // so a 404 there is a BUILD artifact, not a product failure. Distinguish the
    // two: 400 is the regression this guard exists for (the stored platform path
    // being rejected by validation), 404 is "the asset is not on disk right now".
    const serverSeesAsset = [
      join(ROOT, 'dist', 'server', 'assets', 'prek-english-covers', coverPick.base),
      join(ROOT, 'dist', 'assets', 'prek-english-covers', coverPick.base),
    ].some((candidate) => existsSync(candidate));

    let cover = await req('GET', `/api/resources/${coverPick.id}/storybook-cover/${coverPick.index}`);
    if (cover.status === 404 && serverSeesAsset) {
      // One bounded retry: a build that was mid-flight when the request was
      // served can leave the file momentarily absent.
      await sleep(1500);
      cover = await req('GET', `/api/resources/${coverPick.id}/storybook-cover/${coverPick.index}`);
    }

    check('a leading-slash platform cover path is not REJECTED by validation', cover.status !== 400, true);
    if (serverSeesAsset) {
      check('  -> and the real seeded cover renders', cover.status, 200);
    } else {
      console.log('  NOTE  the server\'s own asset tree (dist/...) has no such cover right now, so the');
      console.log('        byte-level 200 was NOT asserted (a build is probably in flight). The path');
      console.log('        policy IS asserted above: 400 would mean the real platform shape was rejected.');
    }
  } else {
    console.log('  NOTE  no seeded storybook cover with a local asset was found, so this check did');
    console.log('        NOT run here. tests/file-security.test.mjs asserts the path shape itself');
    console.log('        unconditionally, so the policy is still covered.');
  }
} finally {
  // -------------------------------------------------------------------------
  // CLEANUP — remove only the rows THIS suite created (a hard delete, because a
  // soft-deleted probe row would accumulate in a shared fixture database).
  // Nothing else is touched: the 347 seeded resources and every fixture account
  // stay exactly as they were.
  // -------------------------------------------------------------------------
  try {
    if (createdResourceIds.length > 0) {
      await sql`delete from audit_logs where resource_id in ${sql(createdResourceIds)}`;
      await sql`delete from resources where id in ${sql(createdResourceIds)}`;
      console.log('\n  (cleaned up ' + createdResourceIds.length + ' probe resource(s) and their audit rows)');
    }
    // Only THIS run's rows (the prefix carries the run id): a concurrent run's
    // rows are left alone, which is what makes two runs non-destructive.
    await sql`delete from resources where title like ${TITLE_PREFIX + '%'}`;
  } catch (error) {
    console.log('  WARNING: probe cleanup failed: ' + error.message);
  }

  console.log('\n=== RESULT ===');
  if (sessionRecoveries > 0) {
    console.log(
      '  NOTE  this run had to re-authenticate ' + sessionRecoveries + ' time(s): the shared ' +
        'fixture was reset by another process mid-run. Results are still valid, but the ' +
        'environment was not isolated — do not run two gates at once.',
    );
  }
  console.log('  pass=' + pass + ' fail=' + fail);
  await sql.end();
  process.exit(fail ? 1 : 0);
}
