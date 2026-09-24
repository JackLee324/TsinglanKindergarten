/**
 * server/modules/health/cover-assets.ts
 * =====================================
 * WHERE the Pre-K English storybook cover JPEGs live, and how that location is
 * decided. One place, one documented order, no guessing.
 *
 * WHY THIS FILE EXISTS (the defect it replaces)
 * --------------------------------------------
 * `resources.service.ts` used to resolve a cover with two hand-written guesses:
 *
 *     const possiblePaths = [
 *       join(__dirname, '../../../assets/prek-english-covers/', fileName),   // 1
 *       join(process.cwd(), 'server/assets/prek-english-covers/', fileName), // 2
 *     ];
 *
 * Both were measured wrong in a compiled build:
 *
 *   * (1) is ALWAYS wrong. `nest-cli.json` copies the covers to
 *     `dist/server/assets/prek-english-covers/` (`assets[].outDir = "dist/server"`),
 *     and a compiled module lives at `dist/server/modules/resources`, so
 *     `../../../assets` lands on `dist/assets/prek-english-covers/` — verified:
 *     `ls dist/assets` -> No such file or directory. One of the two candidates
 *     could never match, in any build, ever.
 *   * (2) worked only because the product is started with `cwd=dist`
 *     (package.json `start:prod`: `cd dist && node server/main.js`). Started any
 *     other way — systemd with `WorkingDirectory=/`, a supervisor, a test harness,
 *     a container entrypoint that does not `cd` — every cover became a bare 404
 *     with no diagnostic at all, and nothing in the logs said why.
 *
 * So the endpoint's correctness rested on an undocumented property of the working
 * directory, with no way to tell "the file is not in this deployment" apart from
 * "I looked in the wrong place".
 *
 * THE RULE NOW
 * ------------
 * The asset root is resolved from an EXPLICIT root, in a documented order, and the
 * result is logged at startup with the candidate that matched:
 *
 *   1. `STORYBOOK_COVER_ASSETS_DIR`                          (explicit; AUTHORITATIVE)
 *   2. `<moduleDir>/../../assets/prek-english-covers`        (compiled layout)
 *   3. `<appRoot>/server/assets/prek-english-covers`         (source / app-root layout)
 *
 * (1) is authoritative in the strict sense: when it is set, it is the ONLY
 * candidate. A configured-but-missing directory must NOT silently fall back to a
 * different tree — that would hide exactly the misconfiguration the variable was
 * set to fix, and the process would serve covers that the operator does not expect.
 * It fails, loudly, naming the configured value.
 *
 * (2) is anchored on the compiled module's own directory, so it does not depend on
 * the working directory at all. `resolve(__dirname, '..', '..')` is
 * `dist/server` for any module under `dist/server/modules/**`, which is where
 * `nest-cli.json` puts the asset tree.
 *
 * (3) is kept because it is genuinely useful in the source tree (`cwd` = repository
 * root) and it is also the same directory as (2) when the process runs from
 * `dist/` — but it is now the LAST resort, never the only hope.
 *
 * WHY THE FILE LIVES UNDER `modules/health/`
 * -----------------------------------------
 * Because "can this instance actually serve traffic?" is a readiness question: a
 * deployment with no cover assets answers 200 for every other route and 404s for
 * every cover. The readiness probe (`health.module.ts`) reports it as a check, and
 * the resource service imports these same functions, so the probe and the request
 * path can never disagree about where the covers are.
 *
 * The file is deliberately PURE: no Nest imports, no decorators, no `__dirname`
 * of its own. That is what lets `tests/cover-asset-root.test.mjs` import it
 * directly (Node's native type stripping) and assert the real resolution instead of
 * a re-implementation that could pass while the server is broken. Callers pass the
 * anchor they own, so the anchor is explicit rather than implicit.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Explicit asset-root override. When set it is authoritative — there is no fallback. */
export const COVER_ASSETS_DIR_ENV = 'STORYBOOK_COVER_ASSETS_DIR';

/** Directory name and file suffix of the shipped cover assets. */
export const COVER_ASSETS_DIR_NAME = 'prek-english-covers';
export const COVER_ASSETS_FILE_SUFFIX = '.jpg';

/** How the winning directory was chosen. Reported in logs and by the readiness probe. */
export type CoverAssetsSource = 'env' | 'compiled' | 'source-tree';

/** One place the resolver looked, with the reason it is a candidate at all. */
export interface CoverAssetsCandidate {
  source: CoverAssetsSource;
  /** Absolute path that was probed. */
  path: string;
  /** Why this path is a legitimate candidate — printed verbatim in diagnostics. */
  why: string;
}

export interface CoverAssetsFound {
  ok: true;
  source: CoverAssetsSource;
  /** Absolute path of the directory the covers are served from. */
  dir: string;
  /** Number of `*.jpg` files in it. 0 is reported as-is: a directory that exists but
   *  holds no covers is a broken deployment, not a working one. */
  fileCount: number;
  candidates: CoverAssetsCandidate[];
}

export interface CoverAssetsMissing {
  ok: false;
  /**
   * `configured-missing` — `STORYBOOK_COVER_ASSETS_DIR` was set and does not exist.
   * `not-found`          — no candidate exists at all.
   */
  reason: 'configured-missing' | 'not-found';
  candidates: CoverAssetsCandidate[];
  /** Operator-facing, single-line-per-fact diagnostic. Safe for the LOG, not for a response body. */
  message: string;
}

export type CoverAssetsResolution = CoverAssetsFound | CoverAssetsMissing;

/**
 * The only safe way to narrow `CoverAssetsResolution` in this repository.
 *
 * `tsconfig.node.json` extends the platform preset, which sets `"strict": false`,
 * and TypeScript disables boolean-discriminant narrowing without `strictNullChecks`.
 * A plain `if (resolution.ok)` therefore does NOT narrow here — verified: it made
 * `resolution.reason` a compile error — so the guard is spelled out once and reused.
 */
export function isCoverAssetsFound(
  resolution: CoverAssetsResolution,
): resolution is CoverAssetsFound {
  return resolution.ok === true;
}

export interface ResolveCoverAssetsOptions {
  /**
   * Directory of the COMPILED module doing the lookup — pass that module's
   * `__dirname`. Required on purpose: an implicit anchor is what made the old code
   * depend on the working directory.
   */
  moduleDir: string;
  /** Application root used by the last-resort candidate. Pass `process.cwd()`. */
  appRoot: string;
  /** Environment source. Defaults to `process.env`; injectable so tests stay hermetic. */
  env?: Record<string, string | undefined>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // Not existing, or not stat-able (permissions): "not a usable directory" either
    // way, and the caller reports the probe as a miss with its full path.
    return false;
  }
}

/** `*.jpg` entries in `dir`. Returns 0 for an absent directory; never throws. */
export function countCoverFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith(COVER_ASSETS_FILE_SUFFIX)).length;
  } catch {
    return 0;
  }
}

/**
 * Every place the resolver may look, in order, for the given anchors.
 *
 * Exported so the ORDER itself is testable and so diagnostics can print the whole
 * list instead of only "not found".
 */
export function coverAssetsCandidates(
  options: ResolveCoverAssetsOptions,
): CoverAssetsCandidate[] {
  const { moduleDir, appRoot } = options;
  const env = options.env ?? process.env;
  const configured = env[COVER_ASSETS_DIR_ENV];

  if (configured !== undefined && configured.trim() !== '') {
    const configuredPath = isAbsolute(configured) ? configured : resolve(appRoot, configured);
    return [
      {
        source: 'env',
        path: configuredPath,
        why:
          `${COVER_ASSETS_DIR_ENV} is set, and an explicit root is authoritative: ` +
          'no other directory is consulted, so a wrong value fails loudly instead of ' +
          'being masked by a fallback.',
      },
    ];
  }

  return [
    {
      source: 'compiled',
      // `nest-cli.json` -> compilerOptions.assets[].outDir = "dist/server", and the
      // compiled module sits at "dist/server/modules/<name>": two levels up is the
      // asset tree. Anchored on __dirname, NOT on the working directory.
      path: resolve(moduleDir, '..', '..', 'assets', COVER_ASSETS_DIR_NAME),
      why: 'compiled layout: <moduleDir>/../../assets/<dir> (nest-cli assets outDir = dist/server)',
    },
    {
      source: 'source-tree',
      path: resolve(appRoot, 'server', 'assets', COVER_ASSETS_DIR_NAME),
      why: 'app-root layout: <appRoot>/server/assets/<dir> (source tree, or dist/ when the server runs from dist/)',
    },
  ];
}

function describeCandidates(candidates: CoverAssetsCandidate[]): string {
  return candidates
    .map((candidate, index) => `  ${index + 1}. [${candidate.source}] ${candidate.path}\n     ${candidate.why}`)
    .join('\n');
}

/**
 * Resolve the cover asset root, in the documented order, with no silent guessing.
 *
 * Returns a value (never throws): a missing asset tree is a DEPLOYMENT state that
 * must be reported, not an exception that unwinds a request with no context.
 */
export function resolveCoverAssets(options: ResolveCoverAssetsOptions): CoverAssetsResolution {
  const candidates = coverAssetsCandidates(options);

  for (const candidate of candidates) {
    if (!isDirectory(candidate.path)) continue;
    return {
      ok: true,
      source: candidate.source,
      dir: candidate.path,
      fileCount: countCoverFiles(candidate.path),
      candidates,
    };
  }

  const configured = candidates[0].source === 'env';
  const message = configured
    ? `${COVER_ASSETS_DIR_ENV} is set to a directory that does not exist: ${candidates[0].path}. ` +
      'An explicit root is authoritative, so nothing else is tried — fix the variable ' +
      'or remove it to fall back to the compiled/source candidates.'
    : 'no cover asset directory was found. Candidates, in order:\n' + describeCandidates(candidates);

  return {
    ok: false,
    reason: configured ? 'configured-missing' : 'not-found',
    candidates,
    message,
  };
}

/**
 * Full diagnostic for a resolution, for the LOG (absolute paths included).
 *
 * Never put this in an HTTP response body: it is filesystem layout, and the
 * project's rule for diagnostics that reach a client is STATE, never CONFIGURATION
 * (see the leak documented as audit finding G-11 in `health.module.ts`).
 */
export function describeCoverAssetsResolution(resolution: CoverAssetsResolution): string {
  if (isCoverAssetsFound(resolution)) {
    const via =
      resolution.source === 'env'
        ? `${COVER_ASSETS_DIR_ENV} (explicit)`
        : resolution.source === 'compiled'
          ? 'compiled layout (cwd-independent)'
          : 'app-root layout';
    return (
      `cover assets: FOUND via ${via} -> ${resolution.dir} ` +
      `(${resolution.fileCount} ${COVER_ASSETS_FILE_SUFFIX} file(s))`
    );
  }
  return `cover assets: MISSING (${resolution.reason}). ${resolution.message}`;
}

/**
 * Diagnostic for "the root is fine, this one file is not in it".
 *
 * A 404 alone cannot be acted on: it cannot be told apart from a wrong asset root,
 * a forgotten build step, or a row that points at a file nobody ever shipped. This
 * message names the file, the root that was searched and the source that root came
 * from, so the answer is in the log next to the request.
 */
export function describeMissingCoverAsset(
  fileName: string,
  resolution: CoverAssetsFound,
): string {
  return (
    `cover file '${fileName}' is not present in the resolved cover asset directory ` +
    `(${resolution.source}) ${resolution.dir} — the directory exists and holds ` +
    `${resolution.fileCount} ${COVER_ASSETS_FILE_SUFFIX} file(s). ` +
    'Either the deployment did not copy this file, or the resource row points at a cover ' +
    'that was never shipped.'
  );
}
