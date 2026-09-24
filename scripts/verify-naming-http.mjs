#!/usr/bin/env node
/**
 * scripts/verify-naming-http.mjs — live HTTP verification of the B4 boundary
 * ==========================================================================
 * Requires a running server and AUTHZ_TEST_DB:
 *
 *   AUTHZ_TEST_DB=postgres://... node scripts/verify-naming-http.mjs
 *
 * WHY THIS EXISTS
 *   The naming fix has two halves that no static check can prove together:
 *
 *     1. `normalizeSubSubject()` turning `practical-life` into `practical_life`
 *        is a pure-function claim. tests/curriculum-tokens.test.mjs proves the
 *        function; it cannot prove the SERVER calls it, or that the request the
 *        browser actually issues therefore returns the 80 rows that exist.
 *     2. `resources.has_stored_file` (migration 0008) is a database claim. It
 *        cannot prove the API reports it per row, nor that a file-less resource
 *        still answers 404 rather than something that looks downloadable.
 *
 *   So this suite drives REAL HTTP against the seeded data and asserts the
 *   outcomes, including the ones that must NOT happen (an unknown spelling must
 *   be 400, not 200 with an empty list).
 *
 * WHAT IT ASSERTS
 *   A. every shipped spelling of a sub-subject reaches its rows through the API,
 *      and the count equals the count the DATABASE reports for that group —
 *      computed here from SQL, not typed in, so the suite cannot drift from the
 *      data. This is the "147 rows were unreachable" finding, checked end to end.
 *   B. every shipped spelling of a K English theme reaches its rows, and the six
 *      themes together account for every K English resource.
 *   C. an unknown sub-subject / theme is refused with 400 — the previous
 *      behaviour was 200 + `{items: [], total: 0}`, which is indistinguishable
 *      from an empty folder and is what made the bug invisible.
 *   D. a resource with no file is reported as `hasFile: false` and its download
 *      answers 404 ·资源文件不存在·, while a resource whose file IS registered is
 *      NOT refused with that 404 — proving the flag is real and not a constant.
 *   E. the same reads still work when they are NOT normalised (a client that has
 *      not been updated still finds its rows), which is the backward-compatibility
 *      requirement.
 *
 * INDEPENDENCE
 *   Uses tests/helpers/reset-fixtures.mjs for a per-run `principal` account and a
 *   per-run probe resource (title carries the run id), all removed at the end. It
 *   never writes to a seeded row.
 */

const BASE = process.env.B4_BASE || process.env.FILES_BASE || process.env.MFA_BASE || 'http://127.0.0.1:3200';

const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const TITLE_PREFIX = `__naming_probe_${RUN_ID}__`;

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
    try { await res.arrayBuffer(); } catch { /* nothing to drain */ }
  }
  return { status: res.status, data, headers: res.headers };
}

let pass = 0;
let fail = 0;
/** Set when something other than an assertion failed; forces a non-zero exit. */
let FATAL = null;

function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log(
    '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(66) +
      '-> ' + String(actual) + (ok ? '' : '   expected ' + expected),
  );
  ok ? pass++ : fail++;
}

async function login(account) {
  jar = {};
  await req('GET', '/');
  return req('POST', '/api/auth/login', {
    username: account.username,
    password: account.password,
  });
}

/** `GET /api/resources?...` with the given filter object as a query string. */
async function list(params) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== ''),
  ).toString();
  return req('GET', `/api/resources?${qs}`);
}

const errMessage = (r) => String(r?.data?.error?.message ?? r?.data?.message ?? '');

const PDF_HEAD_B64 = Buffer.from('%PDF-1.7\n1 0 obj\n', 'utf8').toString('base64');

const { startVerificationRun } = await import('../tests/helpers/reset-fixtures.mjs');
const run = await startVerificationRun(process.env.AUTHZ_TEST_DB, {
  suite: 'naming',
  accounts: ['admin'],
});
const sql = run.sql;
const admin = run.account('admin');

const createdResourceIds = [];

try {
  // =========================================================================
  console.log('=== A. SUB-SUBJECT SPELLINGS REACH THEIR ROWS ===');
  // =========================================================================
  check('login as principal', (await login(admin)).status, 201);

  // Ground truth straight from the database, so the expected counts are the
  // DATA's, not numbers typed into this file.
  const groups = await sql`
    select program, subject, sub_subject, count(*)::int as n
    from resources
    where deleted_at is null and status = 'published' and sub_subject is not null
    group by 1, 2, 3
    order by 1, 2, 3
  `;
  if (groups.length === 0) {
    check('the database contains sub-subject rows to check', groups.length, '> 0');
  }

  // For each group, request the rows using EVERY spelling the shipped client has
  // ever sent (snake_case, kebab-case, display name) and require the same count.
  const SPELLINGS = {
    practical_life: ['practical_life', 'practical-life', 'Practical Life'],
    english_language: ['english_language', 'english-language', 'English Language'],
    chinese_language: ['chinese_language', 'chinese-language', 'Chinese Language'],
    sensorial: ['sensorial'],
    math: ['math'],
    culture: ['culture'],
  };

  for (const group of groups) {
    const spellings = SPELLINGS[group.sub_subject];
    if (!spellings) {
      check(`the suite knows a spelling for the seeded sub-subject ${group.sub_subject}`, false, true);
      continue;
    }
    for (const spelling of spellings) {
      const res = await list({
        program: group.program,
        subject: group.subject,
        subSubject: spelling,
        pageSize: 100,
      });
      check(
        `${group.program}/${group.subject}?subSubject=${spelling} -> ${group.n} rows`,
        res.status === 200 ? res.data?.total : `HTTP ${res.status} ${errMessage(res)}`,
        group.n,
      );
    }
  }

  // =========================================================================
  console.log('\n=== B. K ENGLISH THEME SPELLINGS REACH THEIR ROWS ===');
  // =========================================================================
  const themes = await sql`
    select theme, count(*)::int as n
    from resources
    where deleted_at is null and status = 'published'
      and program = 'k' and subject = 'english'
    group by 1 order by 1
  `;

  const THEME_SPELLINGS = {
    '主题1：我自己': ['主题1：我自己', 'myself', 'Myself', 'the-self'],
    '主题2：五感': ['主题2：五感', 'the-five-senses', 'The Five Senses'],
    '主题3：社区与邻里': ['主题3：社区与邻里', 'community-neighborhood', 'Community & Neighborhood'],
    '主题4：自然世界': ['主题4：自然世界', 'the-natural-world', 'The Natural World'],
    '主题5：项目式学习（PBL）': ['主题5：项目式学习（PBL）', 'pbl-unit', 'PBL Unit'],
    '主题6：环游世界': ['主题6：环游世界', 'around-the-world', 'Around the World'],
  };

  let reached = 0;
  for (const row of themes) {
    const spellings = THEME_SPELLINGS[row.theme];
    if (!spellings) {
      check(`the suite knows a spelling for the seeded theme ${row.theme}`, false, true);
      continue;
    }
    for (const spelling of spellings) {
      // 'the-self' is deliberately NOT a spelling of theme 1: it must fail, and
      // that is asserted in section C instead. Skipping it here keeps this loop
      // about accepted spellings only.
      if (spelling === 'the-self') continue;
      const res = await list({ program: 'k', subject: 'english', theme: spelling, pageSize: 100 });
      check(
        `k/english?theme=${spelling} -> ${row.n} rows`,
        res.status === 200 ? res.data?.total : `HTTP ${res.status} ${errMessage(res)}`,
        row.n,
      );
      if (spelling === row.theme) reached += res.data?.total ?? 0;
    }
  }

  const totalK = await sql`
    select count(*)::int as n from resources
    where deleted_at is null and status = 'published' and program = 'k' and subject = 'english'
  `;
  check(
    'the six themes account for every K English row (none left unreachable)',
    reached,
    totalK[0].n,
  );

  // =========================================================================
  console.log('\n=== C. AN UNKNOWN SPELLING IS REFUSED, NOT SILENTLY EMPTY ===');
  // =========================================================================
  const unknownSub = await list({ program: 'prek', subject: 'montessori', subSubject: 'practical' });
  check('unknown sub-subject -> 400 (not 200 with an empty list)', unknownSub.status, 400);
  check(
    '  -> the message explains what to use instead',
    /未知的子科目/.test(errMessage(unknownSub)),
    true,
  );

  const unknownTheme = await list({ program: 'k', subject: 'english', theme: 'the-self' });
  check('unknown theme -> 400 (not 200 with an empty list)', unknownTheme.status, 400);
  check('  -> the message explains what to use instead', /未知的主题/.test(errMessage(unknownTheme)), true);

  // A sub-subject that exists under ANOTHER subject must not resolve here.
  const wrongSubject = await list({ program: 'prek', subject: 'virtue', subSubject: 'math' });
  check('a sub-subject from another subject -> 400', wrongSubject.status, 400);

  // =========================================================================
  console.log('\n=== D. "HAS A REAL FILE" IS REPORTED HONESTLY ===');
  // =========================================================================
  const created = await req('POST', '/api/resources', {
    title: `${TITLE_PREFIX} metadata-only lesson plan`,
    titleEn: 'Naming probe lesson plan',
    program: 'prek',
    subject: 'virtue',
    folderType: 'curriculum_outline',
    description: 'created by scripts/verify-naming-http.mjs',
  });
  check('POST /api/resources creates the probe resource', created.status, 201);
  const resourceId = created.data?.id;
  if (!resourceId) throw new Error('probe resource was not created: ' + JSON.stringify(created.data));
  createdResourceIds.push(resourceId);

  check('  -> a new resource reports hasFile=false', created.data?.hasFile, false);

  const noFileDownload = await req('GET', `/api/resources/${resourceId}/download`);
  check('  -> downloading a file-less resource is 404', noFileDownload.status, 404);
  check(
    '  -> the refusal names the missing file, not a generic failure',
    /资源文件不存在/.test(errMessage(noFileDownload)),
    true,
  );

  const registered = await req('POST', `/api/resources/${resourceId}/file`, {
    fileName: 'probe-lesson.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    head: PDF_HEAD_B64,
    fileBucketId: 'bucket_naming_probe',
    filePath: 'uploads/naming-probe/lesson.pdf',
  });
  check('POST /api/resources/:id/file registers a real file', registered.status, 201);
  check('  -> the response reports hasFile=true', registered.data?.hasFile, true);

  const stored = await sql`
    select has_stored_file, btrim(file_path) <> '' as path_ok, btrim(file_bucket_id) <> '' as bucket_ok
    from resources where id = ${resourceId}
  `;
  check('  -> the DATABASE column agrees', stored[0]?.has_stored_file, true);
  check('  -> and it agrees with an independent recomputation', stored[0]?.path_ok && stored[0]?.bucket_ok, true);

  const withFileDownload = await req('GET', `/api/resources/${resourceId}/download`);
  check(
    '  -> a resource WITH a file is NOT refused with 404 资源文件不存在',
    withFileDownload.status === 404 && /资源文件不存在/.test(errMessage(withFileDownload)) ? 'still 404' : 'passed the file check',
    'passed the file check',
  );

  // =========================================================================
  console.log('\n=== E. UNNORMALISED (CANONICAL) REQUESTS STILL WORK ===');
  // =========================================================================
  // An old client that already sent `practical_life` must be unaffected. Same
  // for the stored theme value, which is what the previous release's theme
  // dictionary would have had to use.
  const canonicalSub = await list({
    program: 'prek',
    subject: 'montessori',
    subSubject: 'practical_life',
    pageSize: 100,
  });
  const canonicalSubCount = canonicalSub.status === 200 ? canonicalSub.data?.total : -1;
  const kebabSub = await list({
    program: 'prek',
    subject: 'montessori',
    subSubject: 'practical-life',
    pageSize: 100,
  });
  check(
    'snake_case and kebab-case return the SAME rows',
    kebabSub.status === 200 ? kebabSub.data?.total : -1,
    canonicalSubCount,
  );

  const storedTheme = await list({
    program: 'k',
    subject: 'english',
    theme: '主题1：我自己',
    pageSize: 100,
  });
  const slugTheme = await list({ program: 'k', subject: 'english', theme: 'myself', pageSize: 100 });
  check(
    'the stored theme value and its English slug return the SAME rows',
    slugTheme.status === 200 ? slugTheme.data?.total : -1,
    storedTheme.status === 200 ? storedTheme.data?.total : -1,
  );

  // A resource row must carry the flag in every list response too, not only in
  // the create response — the UI reads lists.
  const listed = await list({ program: 'prek', subject: 'virtue', pageSize: 100 });
  if (listed.status === 200 && Array.isArray(listed.data?.items)) {
    const missing = listed.data.items.filter((r) => typeof r.hasFile !== 'boolean');
    check('every listed resource carries a boolean hasFile', missing.length, 0);
  } else {
    check('GET /api/resources?program=prek&subject=virtue succeeds', listed.status, 200);
  }
} catch (error) {
  FATAL = error;
  console.log('\n  FATAL  ' + (error?.stack ?? String(error)));
} finally {
  // Remove the probe rows this run created. The suite's cleanup() then removes
  // the per-run accounts; `resources.uploader_id` is NO ACTION, so the rows must
  // be gone before the account delete or it fails.
  try {
    if (createdResourceIds.length > 0) {
      await sql`delete from audit_logs where resource_id in ${sql(createdResourceIds)}`;
      await sql`delete from resources where id in ${sql(createdResourceIds)}`;
    }
  } catch (error) {
    FATAL = FATAL ?? error;
    console.log('  FATAL  probe cleanup failed: ' + (error?.message ?? error));
  }

  const cleanup = await run.cleanup();
  if (!cleanup.ok) {
    FATAL = FATAL ?? cleanup.error;
    console.log('  FATAL  fixture cleanup failed: ' + (cleanup.error?.message ?? cleanup.error));
  }
}

console.log(`\n  pass=${pass} fail=${fail}`);
if (FATAL) {
  console.log('  ❌ 存在失败项 (fatal error above)');
  process.exit(1);
}
if (fail > 0) {
  console.log('  ❌ 存在失败项');
  process.exit(1);
}
console.log('  ✅ 全部通过');
