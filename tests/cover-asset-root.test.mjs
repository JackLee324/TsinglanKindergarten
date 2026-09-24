/**
 * tests/cover-asset-root.test.mjs
 * ===============================
 * Proves the storybook-cover endpoint resolves its JPEG from the COMPILED layout
 * (`dist/server/assets/prek-english-covers/`) and that a missing asset produces a
 * diagnosable failure instead of an unexplained 404.
 *
 * THE DEFECT UNDER TEST
 *   `resources.service.ts` used to look for a cover with two hand-written guesses:
 *
 *       join(__dirname, '../../../assets/prek-english-covers/', fileName)
 *       join(process.cwd(), 'server/assets/prek-english-covers/', fileName)
 *
 *   Measured: the first resolves to `dist/assets/prek-english-covers/` (three levels
 *   up from `dist/server/modules/resources`) and that directory DOES NOT EXIST —
 *   `nest-cli.json` publishes the asset tree to `dist/server`. So one candidate could
 *   never match, and the endpoint worked only through the second one, i.e. only while
 *   the process happened to be started with `cwd=dist`. Started any other way —
 *   systemd, a supervisor, a test harness, a container entrypoint without `cd` — every
 *   cover became a bare 404, with nothing in the log to distinguish "not in this
 *   deployment" from "looked in the wrong place".
 *
 * WHAT IS ASSERTED HERE, IN THREE LAYERS
 *   1. RESOLUTION (pure module: no server, no database). The order, the anchors, the
 *      cwd-independence, the authoritative override and every diagnostic are asserted
 *      against the real implementation, imported straight from the TypeScript source
 *      through Node's native type stripping — the way `file-security.test.mjs` imports
 *      `file-validation.ts`. A re-implementation could pass while the server is broken,
 *      so no re-implementation is used.
 *   2. THE BUILT ARTIFACT. The COMPILED resolver (`dist/.../cover-assets.js`) must
 *      resolve the built tree, and the built tree must hold exactly the covers the
 *      source tree holds. This is the "verify the path after a build" half: `npm run
 *      build` begins with `rm -rf dist/`, so a build that copies the modules but not
 *      the assets has to fail HERE, loudly, instead of 404ing at request time.
 *      Skipped — loudly, never silently — only when the artifact is absent or older
 *      than its source, because a green test running stale code is worse than no test
 *      (the same rule as `exception-filter-requestid.test.mjs`).
 *   3. THE LIVE ENDPOINT. The compiled server is started with a working directory that
 *      is neither `dist/` nor the repository root — the case the old code could not
 *      serve — and the REAL seeded resource row is fetched over real HTTP:
 *        * 200 and real JPEG bytes when the compiled asset tree is present;
 *        * 404 naming the file when the root exists but that file does not;
 *        * 503 naming the problem when the configured root does not exist;
 *      plus the readiness probe reporting the same resolution.
 *      No probe resource row is created and no fake asset file is written: the row
 *      under test is one of the 347 seeded rows and the only files involved are the
 *      shipped covers. Fixture ACCOUNTS come from `tests/helpers/reset-fixtures.mjs`
 *      (per-run, deleted by this same run) because the endpoint is permission-gated.
 *
 * Run:  npm test          (or: node --test tests/cover-asset-root.test.mjs)
 * Needs: PostgreSQL with the seeded curriculum, and a completed `npm run build`
 *        for layers 2 and 3.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_COVERS = join(ROOT, 'server', 'assets', 'prek-english-covers');
const BUILT_COVERS = join(ROOT, 'dist', 'server', 'assets', 'prek-english-covers');
const BUILT_SERVER = join(ROOT, 'dist', 'server', 'main.js');
const SEED_FILE = join(ROOT, 'server', 'database', 'seed-curriculum.sql');
const COVER_ASSETS_SOURCE = join(ROOT, 'server', 'modules', 'health', 'cover-assets.ts');
const COVER_ASSETS_BUILT = join(ROOT, 'dist', 'server', 'modules', 'health', 'cover-assets.js');

/**
 * The database the live layer runs against.
 *
 * The fallback matches every other suite in this repository (see
 * `tests/helpers/legacy-fixture.mjs`, which hardcodes the same local instance on
 * 55432). Inside the gate `AUTHZ_TEST_DB` is exported and always wins, and it must be
 * the same database the booted server uses — so both are taken from this one value.
 */
const DB_URL =
  process.env.AUTHZ_TEST_DB ||
  'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005';

const coverAssets = await import(
  new URL('../server/modules/health/cover-assets.ts', import.meta.url).href
);
const fileValidation = await import(
  new URL('../server/common/files/file-validation.ts', import.meta.url).href
);

const {
  COVER_ASSETS_DIR_ENV,
  COVER_ASSETS_DIR_NAME,
  countCoverFiles,
  coverAssetsCandidates,
  describeCoverAssetsResolution,
  describeMissingCoverAsset,
  isCoverAssetsFound,
  resolveCoverAssets,
} = coverAssets;
const { toBucketRelativePath } = fileValidation;

/** Every distinct cover FILE NAME the shipped seed references. */
function seededCoverNames() {
  const sql = readFileSync(SEED_FILE, 'utf8');
  const matches = sql.match(/\/curriculum-resources\/prek-english-covers\/[^"'\\\s]+?\.jpg/g) ?? [];
  return [...new Set(matches.map((value) => value.split('/').pop()))].sort();
}

function jpgFilesIn(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.jpg'))
        .sort()
    : null;
}

/** A throwaway application tree shaped exactly like the build output. */
function makeBuildTree() {
  const root = mkdtempSync(join(tmpdir(), 'qls-cover-root-'));
  const moduleDir = join(root, 'dist', 'server', 'modules', 'resources');
  const builtDir = join(root, 'dist', 'server', 'assets', COVER_ASSETS_DIR_NAME);
  const sourceDir = join(root, 'server', 'assets', COVER_ASSETS_DIR_NAME);
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(builtDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(builtDir, 'built-cover.jpg'), 'built');
  writeFileSync(join(sourceDir, 'source-cover.jpg'), 'source');
  return { root, moduleDir, builtDir, sourceDir };
}

// =============================================================================
// 1. Resolution — the order, the anchors, the diagnostics
// =============================================================================

describe('cover asset root: resolution order (pure module)', () => {
  test('the compiled layout is resolved from the module directory, NOT the working directory', () => {
    const tree = makeBuildTree();
    try {
      const resolution = resolveCoverAssets({
        moduleDir: tree.moduleDir,
        // An app root unrelated to this tree: if the result depended on the working
        // directory (the old defect) it would not resolve to the compiled tree.
        appRoot: join(tmpdir(), 'qls-unrelated-app-root'),
        env: {},
      });

      assert.equal(isCoverAssetsFound(resolution), true, 'a compiled tree next to the module must be found');
      assert.equal(resolution.source, 'compiled');
      assert.equal(
        resolution.dir,
        tree.builtDir,
        'the compiled candidate must be <moduleDir>/../../assets/prek-english-covers',
      );
      assert.equal(resolution.fileCount, 1);
      assert.ok(existsSync(join(resolution.dir, 'built-cover.jpg')));
      // The source-tree candidate exists here too and must NOT have won: the compiled
      // tree is what a build publishes, and it is checked first on purpose.
      assert.ok(!resolution.dir.startsWith(tree.sourceDir));
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test('the removed `dist/assets/...` guess (the old first candidate) is not a candidate any more', () => {
    const tree = makeBuildTree();
    try {
      const candidates = coverAssetsCandidates({
        moduleDir: tree.moduleDir,
        appRoot: tree.root,
        env: {},
      });

      // `__dirname/../../../assets` — what the old code used — resolves HERE:
      const oldGuess = resolve(tree.moduleDir, '..', '..', '..', 'assets', COVER_ASSETS_DIR_NAME);
      assert.equal(
        oldGuess,
        join(tree.root, 'dist', 'assets', COVER_ASSETS_DIR_NAME),
        'the regression case must be the measured one: dist/assets, not dist/server/assets',
      );
      assert.ok(
        !candidates.some((candidate) => candidate.path === oldGuess),
        `no candidate may point at ${oldGuess}: the build never produces that directory`,
      );
      assert.deepEqual(
        candidates.map((candidate) => candidate.source),
        ['compiled', 'source-tree'],
        'exactly two unconfigured candidates, in the documented order',
      );
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test('an explicit STORYBOOK_COVER_ASSETS_DIR is authoritative and wins over the compiled tree', () => {
    const tree = makeBuildTree();
    const override = mkdtempSync(join(tmpdir(), 'qls-cover-override-'));
    try {
      writeFileSync(join(override, 'explicit-cover.jpg'), 'explicit');
      const resolution = resolveCoverAssets({
        moduleDir: tree.moduleDir,
        appRoot: tree.root,
        env: { [COVER_ASSETS_DIR_ENV]: override },
      });

      assert.equal(isCoverAssetsFound(resolution), true);
      assert.equal(resolution.source, 'env');
      assert.equal(resolution.dir, override);
      assert.equal(
        resolution.candidates.length,
        1,
        'an explicit root is the ONLY candidate: a fallback could mask the misconfiguration',
      );
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
      rmSync(override, { recursive: true, force: true });
    }
  });

  test('a configured-but-missing root FAILS instead of silently falling back', () => {
    const tree = makeBuildTree();
    const configured = join(tmpdir(), 'qls-cover-configured-but-absent');
    try {
      const resolution = resolveCoverAssets({
        moduleDir: tree.moduleDir,
        appRoot: tree.root,
        env: { [COVER_ASSETS_DIR_ENV]: configured },
      });

      assert.equal(isCoverAssetsFound(resolution), false, 'the compiled tree must not be used as a fallback');
      assert.equal(resolution.reason, 'configured-missing');
      const diagnostic = describeCoverAssetsResolution(resolution);
      assert.match(diagnostic, /MISSING/);
      assert.ok(diagnostic.includes(configured), 'the diagnostic must name the configured path');
      assert.ok(diagnostic.includes(COVER_ASSETS_DIR_ENV), 'the diagnostic must name the variable');
      assert.match(diagnostic, /nothing else is tried/i);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test('a missing asset tree reports every candidate it checked, never a bare "not found"', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qls-cover-empty-'));
    try {
      const moduleDir = join(empty, 'dist', 'server', 'modules', 'health');
      mkdirSync(moduleDir, { recursive: true });
      const resolution = resolveCoverAssets({ moduleDir, appRoot: join(empty, 'app'), env: {} });

      assert.equal(isCoverAssetsFound(resolution), false);
      assert.equal(resolution.reason, 'not-found');
      const diagnostic = describeCoverAssetsResolution(resolution);
      for (const candidate of resolution.candidates) {
        assert.ok(
          diagnostic.includes(candidate.path),
          `the diagnostic must list ${candidate.path}: an operator cannot act on "not found"`,
        );
      }
      assert.ok(diagnostic.includes('compiled layout'));
      assert.ok(diagnostic.includes('app-root layout'));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a file missing from a healthy root is diagnosed with the root, not just 404-ed', () => {
    const tree = makeBuildTree();
    try {
      const resolution = resolveCoverAssets({ moduleDir: tree.moduleDir, appRoot: tree.root, env: {} });
      assert.equal(isCoverAssetsFound(resolution), true);

      const message = describeMissingCoverAsset('1876907126277273.jpg', resolution);
      assert.ok(message.includes('1876907126277273.jpg'), 'the missing FILE must be named');
      assert.ok(message.includes(resolution.dir), 'the searched DIRECTORY must be named');
      assert.ok(message.includes(resolution.source), 'the source that directory came from must be named');
      assert.match(message, /holds 1 \.jpg file/);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test('every cover the shipped seed references is present in the shipped asset tree', () => {
    const names = seededCoverNames();
    assert.ok(
      names.length > 0,
      'the seed must reference prek-english-covers paths, otherwise this guard is vacuous',
    );

    const missing = names.filter((name) => !existsSync(join(SOURCE_COVERS, name)));
    assert.deepEqual(
      missing,
      [],
      `the seed points at cover(s) that are not shipped in ${SOURCE_COVERS}: ${missing.join(', ')}. ` +
        'Each of those rows would answer 404 with no way to tell it from a lookup bug.',
    );

    // The REAL stored path shape must survive normalisation into exactly these names.
    // The regression that once turned every Pre-K English cover into HTTP 400 lived in
    // this step (`toBucketRelativePath`), so it is asserted here on a real value.
    const sample = '/curriculum-resources/prek-english-covers/1876907126277273.jpg';
    assert.equal(
      toBucketRelativePath(sample),
      'curriculum-resources/prek-english-covers/1876907126277273.jpg',
    );
    const lastSegment = String(toBucketRelativePath(sample))
      .split(/[\\/]+/)
      .pop();
    assert.equal(lastSegment, '1876907126277273.jpg');
    assert.ok(names.includes(lastSegment), 'the cover the live layer fetches must be one of the seeded names');
  });

  test('counting covers in a directory that is not there is 0, not a throw', () => {
    assert.equal(countCoverFiles(join(tmpdir(), 'qls-cover-absent-directory')), 0);
  });
});

// =============================================================================
// 2. The built artifact — "verify the path after a build"
// =============================================================================

describe('cover asset root: the built artifact', () => {
  test('the compiled resolver and the built asset tree agree with the source', (t) => {
    if (!existsSync(BUILT_SERVER) || !existsSync(COVER_ASSETS_BUILT)) {
      t.skip(
        `SKIPPED (loudly, not silently): ${COVER_ASSETS_BUILT} does not exist, so there is no build to ` +
          'verify. Run `npm run build` and re-run. (`npm test` runs BEFORE `npm run build` in ' +
          'scripts/verify-all.sh, so a first gate run from a clean checkout legitimately lands here.)',
      );
      return;
    }

    const sourceMtime = statSync(COVER_ASSETS_SOURCE).mtimeMs;
    const builtMtime = statSync(COVER_ASSETS_BUILT).mtimeMs;
    if (builtMtime < sourceMtime) {
      t.skip(
        `SKIPPED (loudly, not silently): ${COVER_ASSETS_BUILT} is OLDER than ${COVER_ASSETS_SOURCE} ` +
          `(${new Date(builtMtime).toISOString()} < ${new Date(sourceMtime).toISOString()}), so it would ` +
          'assert the behaviour of code that is not in the tree. Run `npm run build`.',
      );
      return;
    }

    // `require`, not `import`: the build emits CommonJS (same as
    // exception-filter-requestid.test.mjs loading the compiled filter).
    const built = require(COVER_ASSETS_BUILT);
    assert.equal(typeof built.resolveCoverAssets, 'function', 'the compiled module must export the resolver');

    // The compiled module's own directory is <build>/server/modules/health, so this is
    // EXACTLY the anchor the running server uses. `appRoot` is deliberately unrelated.
    const resolution = built.resolveCoverAssets({
      moduleDir: join(ROOT, 'dist', 'server', 'modules', 'health'),
      appRoot: join(tmpdir(), 'qls-unrelated-app-root'),
      env: {},
    });

    assert.equal(built.isCoverAssetsFound(resolution), true, built.describeCoverAssetsResolution(resolution));
    assert.equal(resolution.source, 'compiled');
    assert.equal(resolution.dir, BUILT_COVERS);

    // ---- the post-build completeness check ---------------------------------
    // A build that copies the modules but drops (or truncates) the asset tree is
    // exactly the failure this layer exists to catch, so once a build exists this is
    // a hard assertion with no skip path.
    const sourceFiles = jpgFilesIn(SOURCE_COVERS);
    const builtFiles = jpgFilesIn(BUILT_COVERS);
    assert.ok(sourceFiles !== null && sourceFiles.length > 0, `no covers in ${SOURCE_COVERS}`);
    assert.deepEqual(
      builtFiles,
      sourceFiles,
      `the built asset tree ${BUILT_COVERS} does not match ${SOURCE_COVERS}. A cover present in the source ` +
        'tree but absent from the build is a 404 in production and nothing in the log would say so. ' +
        'Re-run `npm run build` (and check that nest-cli.json still declares ' +
        'assets/prek-english-covers/*.jpg with outDir dist/server).',
    );
    assert.equal(
      resolution.fileCount,
      builtFiles.length,
      'the compiled resolver must count the files that are actually in the built tree',
    );
  });
});

// =============================================================================
// 3. The live endpoint — from a working directory that is neither dist/ nor the root
// =============================================================================

/** A port nobody is using, obtained by binding and releasing it. */
function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = net.createServer();
    probe.once('error', rejectPromise);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePromise(port));
    });
  });
}

async function databaseReachable() {
  let sql;
  try {
    sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
    await sql`select 1`;
    await sql.end({ timeout: 5 });
    return null;
  } catch (error) {
    try {
      if (sql) await sql.end({ timeout: 5 });
    } catch {
      // Closing a connection that never opened is not an additional failure; the
      // original error is what the caller needs, and it is returned below.
    }
    return error;
  }
}

/** Start the COMPILED server with an explicit working directory. */
async function startServer({ port, cwd, extraEnv = {} }) {
  const env = { ...process.env };
  delete env[COVER_ASSETS_DIR_ENV];
  Object.assign(
    env,
    {
      NODE_ENV: 'production',
      SERVER_HOST: '127.0.0.1',
      SERVER_PORT: String(port),
      SUDA_DATABASE_URL: DB_URL,
      FORCE_AUTHN_INNERAPI_DOMAIN: 'https://127.0.0.1:1',
      MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      DOWNLOAD_TOKEN_SECRET: randomBytes(32).toString('base64'),
      DOWNLOAD_TOKEN_TTL_SECONDS: '10',
      // This suite logs in once per boot; the in-process per-IP limiter is shared by
      // every request from 127.0.0.1, so the default of 30/window is left well behind.
      LOGIN_IP_RATE_LIMIT_MAX: '100000',
    },
    extraEnv,
  );

  const child = spawn(process.execPath, [BUILT_SERVER], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  const handle = {
    port,
    cwd,
    log: () => output,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const finished = await Promise.race([
          exited,
          new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 15_000)),
        ]);
        if (finished === null) {
          child.kill('SIGKILL');
          await exited;
          return { code: null, signal: 'SIGKILL', forced: true };
        }
        return { ...finished, forced: false };
      }
      return { ...(await exited), forced: false };
    },
  };

  // Liveness (it touches no dependency) is the ready signal: `/api/health/ready` is
  // deliberately allowed to answer 503 in two of the scenarios below.
  const deadline = Date.now() + 40_000;
  for (;;) {
    const exitedEarly = await Promise.race([
      exited,
      new Promise((resolvePending) => setTimeout(() => resolvePending(null), 0)),
    ]);
    if (exitedEarly !== null) {
      throw new Error(
        `the server exited during startup (code=${exitedEarly.code}, signal=${exitedEarly.signal}), cwd=${cwd}\n` +
          `--- server output ---\n${output}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) {
        await res.arrayBuffer();
        return handle;
      }
    } catch {
      // Not listening yet; the deadline below decides when to give up.
    }
    if (Date.now() > deadline) {
      await handle.stop();
      throw new Error(
        `the server did not answer /api/health within 40s (cwd=${cwd})\n--- server output ---\n${output}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

/** Minimal cookie jar + request helper (CSRF header included once the cookie exists). */
function makeSession(base) {
  const jar = {};
  return {
    async request(method, path, body) {
      const headers = { 'content-type': 'application/json' };
      const cookie = Object.entries(jar)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
      if (cookie) headers.cookie = cookie;
      if (jar['suda-csrf-token']) headers['x-suda-csrf-token'] = jar['suda-csrf-token'];
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
      }
      // The body is read as bytes once and exposed both ways: a cover is binary
      // (magic bytes matter) while an error from the same endpoint is JSON (the
      // message matters). Reading it twice is not possible.
      const bytes = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        bytes,
        text: bytes.toString('utf8'),
        contentType: res.headers.get('content-type'),
      };
    },
  };
}

describe('cover asset root: the live endpoint', () => {
  test('the seeded cover is served from the compiled layout with cwd neither dist/ nor the repo root', async (t) => {
    if (!existsSync(BUILT_SERVER)) {
      t.skip(
        `SKIPPED (loudly, not silently): ${BUILT_SERVER} does not exist. Run \`npm run build\` first — this ` +
          'layer boots the COMPILED server, and testing an absent build would prove nothing.',
      );
      return;
    }

    const dbError = await databaseReachable();
    if (dbError) {
      t.skip(
        `SKIPPED (loudly, not silently): PostgreSQL is not reachable at ` +
          `${DB_URL.replace(/:[^:@/]*@/, ':***@')} (${dbError.message}). This layer needs the seeded ` +
          'curriculum, and it creates no row of it.',
      );
      return;
    }

    const { startVerificationRun } = await import('./helpers/reset-fixtures.mjs');
    let run;
    try {
      run = await startVerificationRun(DB_URL, { suite: 'coverassets', accounts: ['admin'] });
    } catch (error) {
      // A gate holds the EXCLUSIVE lock while it rebuilds dist/, and this layer boots a
      // server that serves files out of dist/. A fake failure would be worse than
      // saying so, and the lock error already explains the situation.
      t.skip(`SKIPPED (loudly, not silently): ${error.message}`);
      return;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'qls-cover-live-'));
    const emptyOverride = join(scratch, 'empty-root');
    mkdirSync(emptyOverride, { recursive: true });
    const missingOverride = join(scratch, 'configured-but-absent');
    const emptyCwd = join(scratch, 'cwd');
    mkdirSync(emptyCwd, { recursive: true });
    // The view directory is created because the CSRF cookie this application demands
    // on POST /api/* is issued by the platform's CsrfTokenMiddleware, which is
    // mounted on the VIEW routes only (verified in the platform's `configure()`:
    // `.exclude('/api/(.*)', ...)`) — so the login used below needs `GET /` to
    // render. It holds one throwaway HTML file and nothing else; no cover, no
    // `server/assets` tree, and nothing in the repository is touched.
    mkdirSync(join(emptyCwd, 'dist', 'client'), { recursive: true });
    writeFileSync(join(emptyCwd, 'dist', 'client', 'index.html'), '<html><body>cover-asset-root test</body></html>');

    const boots = [];
    async function boot(label, extraEnv) {
      const port = await freePort();
      const handle = await startServer({ port, cwd: emptyCwd, extraEnv });
      boots.push({ label, handle });
      return { handle, session: makeSession(`http://127.0.0.1:${port}`) };
    }

    try {
      // -----------------------------------------------------------------------
      // The shipped seed row under test (read-only).
      // -----------------------------------------------------------------------
      const rows = await run.sql`
        select id, description from resources
        where description like '%prek-english-covers%' and status = 'published'`;
      let pick = null;
      for (const row of rows) {
        let storybooks = [];
        try {
          storybooks = JSON.parse(row.description ?? '{}').storybooks ?? [];
        } catch {
          continue; // not a storybook row
        }
        for (let index = 0; index < storybooks.length; index += 1) {
          const stored = String(storybooks[index]?.filePath ?? '');
          if (!stored.startsWith('/')) continue; // the shape that used to 400
          const base = stored.split(/[\\/]+/).pop();
          if (base && existsSync(join(SOURCE_COVERS, base))) {
            pick = { id: row.id, index, stored, base };
            break;
          }
        }
        if (pick) break;
      }
      assert.ok(
        pick,
        'no seeded published storybook row with a leading-slash cover path was found, so the live assertion ' +
          'cannot run. That is a fixture problem and is reported as one instead of being skipped.',
      );
      t.diagnostic(`seeded row under test: ${pick.id} index=${pick.index} stored=${pick.stored}`);

      // -----------------------------------------------------------------------
      // Boot 1 — no override. This working directory is the decisive one.
      // -----------------------------------------------------------------------
      // The OLD lookup tried <cwd>/server/assets/... and found nothing here, so this
      // exact request answered 404 before the fix. Asserting that absence keeps the
      // test honest about what it proves.
      assert.equal(
        existsSync(join(emptyCwd, 'server', 'assets', COVER_ASSETS_DIR_NAME)),
        false,
        'the working directory must NOT contain a server/assets tree, or this boot would also pass with the ' +
          'old cwd-dependent candidate and would prove nothing',
      );

      const boot1 = await boot('no override', {});
      const ready1 = await boot1.session.request('GET', '/api/health/ready');
      assert.equal(ready1.status, 200, `readiness must be 200 with a complete build: ${ready1.text}`);
      assert.deepEqual(
        JSON.parse(ready1.text).checks.assets,
        { ok: true, source: 'compiled', files: (jpgFilesIn(BUILT_COVERS) ?? []).length },
        'readiness must report the COMPILED candidate and the real file count (and never the path)',
      );
      assert.ok(
        !ready1.text.includes(BUILT_COVERS) && !ready1.text.includes(ROOT),
        'a public readiness body must not leak filesystem paths',
      );
      assert.ok(
        boot1.handle.log().includes(`cover assets: FOUND via compiled layout (cwd-independent) -> ${BUILT_COVERS}`),
        `the startup log must state where the covers were found. Log was:\n${boot1.handle.log()}`,
      );

      // Log in with a per-run account, then fetch the REAL seeded cover over HTTP.
      // GET / is a VIEW route, and the platform mounts CsrfTokenMiddleware on the view
      // routes only (verified: `.exclude('/api/(.*)', ...)`), while this application's own
      // CsrfCheckMiddleware demands that cookie on every POST /api/*. /api/health does NOT
      // set it, so the login below depends on this page rendering.
      const csrfPage1 = await boot1.session.request('GET', '/');
      assert.equal(csrfPage1.status, 200, `GET / must render so the CSRF cookie is issued: ${csrfPage1.text}`);
      const admin = run.account('admin');
      const login1 = await boot1.session.request('POST', '/api/auth/login', {
        username: admin.username,
        password: admin.password,
      });
      assert.equal(login1.status, 201, `login failed: ${login1.status} ${login1.text}`);

      const cover1 = await boot1.session.request(
        'GET',
        `/api/resources/${pick.id}/storybook-cover/${pick.index}`,
      );
      assert.equal(
        cover1.status,
        200,
        `the seeded cover must be served from the COMPILED layout (cwd was ${emptyCwd}): ` +
          `${cover1.status} ${cover1.text ?? ''}`,
      );
      assert.match(String(cover1.contentType), /^image\/jpeg/, 'the response must be a JPEG');
      assert.ok(
        cover1.bytes && cover1.bytes.length > 1000,
        `the body must be a real image (got ${cover1.bytes?.length} bytes)`,
      );
      assert.deepEqual(
        [...cover1.bytes.subarray(0, 3)],
        [0xff, 0xd8, 0xff],
        'the body must start with the JPEG SOI marker',
      );

      const stopped1 = await boot1.handle.stop();
      assert.equal(stopped1.code, 0, `the server must shut down cleanly:\n${boot1.handle.log()}`);

      // -----------------------------------------------------------------------
      // Boot 2 — the root exists but the file does not: a diagnosable 404.
      // -----------------------------------------------------------------------
      const boot2 = await boot('empty override', { [COVER_ASSETS_DIR_ENV]: emptyOverride });
      const ready2 = await boot2.session.request('GET', '/api/health/ready');
      assert.equal(ready2.status, 503, 'an asset root with no covers must make the instance NOT ready');
      assert.deepEqual(JSON.parse(ready2.text).checks.assets, {
        ok: false,
        error: 'cover_assets_empty',
      });

      await boot2.session.request('GET', '/'); // obtain the CSRF cookie
      const login2 = await boot2.session.request('POST', '/api/auth/login', {
        username: admin.username,
        password: admin.password,
      });
      assert.equal(login2.status, 201, `login failed: ${login2.status} ${login2.text}`);

      const cover2 = await boot2.session.request(
        'GET',
        `/api/resources/${pick.id}/storybook-cover/${pick.index}`,
      );
      assert.equal(cover2.status, 404);
      assert.ok(
        cover2.text.includes(pick.base),
        `the 404 must name the missing file (${pick.base}) so it can be told apart from a lookup bug: ${cover2.text}`,
      );
      assert.ok(
        /ERROR[^\n]*cover file '.*' is not present in the resolved cover asset directory/.test(boot2.handle.log()),
        `the server log must explain the miss with the resolved directory. Log was:\n${boot2.handle.log()}`,
      );
      const stopped2 = await boot2.handle.stop();
      assert.equal(stopped2.code, 0, `the server must shut down cleanly:\n${boot2.handle.log()}`);

      // -----------------------------------------------------------------------
      // Boot 3 — the configured root does not exist: fail loudly, never guess.
      // -----------------------------------------------------------------------
      const boot3 = await boot('missing override', { [COVER_ASSETS_DIR_ENV]: missingOverride });
      const ready3 = await boot3.session.request('GET', '/api/health/ready');
      assert.equal(ready3.status, 503);
      assert.deepEqual(JSON.parse(ready3.text).checks.assets, {
        ok: false,
        error: 'cover_assets_missing',
      });
      assert.ok(
        boot3.handle
          .log()
          .includes(`${COVER_ASSETS_DIR_ENV} is set to a directory that does not exist: ${missingOverride}`),
        `the startup log must name the configured-but-missing directory. Log was:\n${boot3.handle.log()}`,
      );

      await boot3.session.request('GET', '/'); // obtain the CSRF cookie
      const login3 = await boot3.session.request('POST', '/api/auth/login', {
        username: admin.username,
        password: admin.password,
      });
      assert.equal(login3.status, 201, `login failed: ${login3.status} ${login3.text}`);

      const cover3 = await boot3.session.request(
        'GET',
        `/api/resources/${pick.id}/storybook-cover/${pick.index}`,
      );
      assert.equal(
        cover3.status,
        503,
        'a missing asset ROOT is a deployment fault (503), not a "this cover does not exist" (404)',
      );
      assert.ok(
        !cover3.text.includes(missingOverride) && !cover3.text.includes(ROOT),
        `the response body must not leak filesystem paths: ${cover3.text}`,
      );
      assert.ok(
        /ERROR[^\n]*storybook cover unavailable: cover assets: MISSING/.test(boot3.handle.log()),
        `the failure must be logged in full. Log was:\n${boot3.handle.log()}`,
      );
      const stopped3 = await boot3.handle.stop();
      assert.equal(stopped3.code, 0, `the server must shut down cleanly:\n${boot3.handle.log()}`);
    } finally {
      // Every child is stopped even if an assertion threw above: a leaked server would
      // hold its port and its database connections for the rest of the run.
      for (const { label, handle } of boots) {
        try {
          const result = await handle.stop();
          if (result.forced) t.diagnostic(`server '${label}' had to be SIGKILLed`);
        } catch (error) {
          t.diagnostic(`could not stop the server started for '${label}': ${error.message}`);
        }
      }
      rmSync(scratch, { recursive: true, force: true });
      const cleaned = await run.cleanup();
      assert.ok(cleaned.ok, `fixture cleanup failed: ${cleaned.error?.message ?? 'unknown error'}`);
    }
  });
});
