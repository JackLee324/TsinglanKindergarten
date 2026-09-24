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
const TITLE_PREFIX = '__files_http_probe__';
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
async function req(method, path, body, extra = {}) {
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
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(62) + '-> ' + String(actual) + (ok ? '' : '   expected ' + expected));
  ok ? pass++ : fail++;
}
async function login(user) {
  jar = {};
  await req('GET', '/'); // obtain the suda-csrf-token cookie
  const r = await req('POST', '/api/auth/login', { username: user, password: PW });
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

  check('DELETE /api/resources/:id succeeds (soft delete)', (await req('DELETE', `/api/resources/${resourceId}`)).status, 200);
  check('it disappears from the normal listing', (await req('GET', `/api/resources?keyword=${keyword}`)).data?.total, 0);
  check('it is 404 on direct read', (await req('GET', `/api/resources/${resourceId}`)).status, 404);
  const mine = await req('GET', '/api/resources/mine?pageSize=100');
  check('it disappears from "my resources"', (mine.data?.items ?? []).some((i) => i.id === resourceId), false);
  check('it cannot be downloaded while in the bin', (await req('GET', `/api/resources/${resourceId}/download`)).status, 404);
  check('the dashboard still answers with the resource deleted', (await req('GET', '/api/dashboard/stats')).status, 200);

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

  const badBucket = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'ok.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    head: PDF_HEAD_B64,
    fileBucketId: 'bucket/../../escape',
    filePath: 'uploads/probe/ok.pdf',
  });
  check('a malformed bucket id is REJECTED', badBucket.status, 400);

  // Every rejection above must have left the ONE valid file untouched.
  check('rejections left the previously registered file intact', (await req('GET', `/api/resources/${resourceId}/download`)).status, 302);

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
          coverPick = { id: row.id, index: i, stored };
          break;
        }
      }
    } catch { /* not a storybook row */ }
    if (coverPick) break;
  }
  if (coverPick) {
    console.log('       stored path under test: ' + coverPick.stored);
    const cover = await req('GET', `/api/resources/${coverPick.id}/storybook-cover/${coverPick.index}`);
    check('a leading-slash platform cover path is ACCEPTED (not 400)', cover.status, 200);
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
    await sql`delete from resources where title like ${TITLE_PREFIX + '%'}`;
  } catch (error) {
    console.log('  WARNING: probe cleanup failed: ' + error.message);
  }

  console.log('\n=== RESULT ===');
  console.log('  pass=' + pass + ' fail=' + fail);
  await sql.end();
  process.exit(fail ? 1 : 0);
}
