#!/usr/bin/env node
/**
 * postinstall — guarded platform capability-plugin initialisation
 * =============================================================
 * WHY THIS FILE EXISTS
 * --------------------
 * The shipped `postinstall` was the literal command:
 *
 *     fullstack-cli action-plugin init
 *
 * `fullstack-cli` is **not** declared in `dependencies`/`devDependencies` and no
 * installed package provides that bin, so `npm install` aborted with:
 *
 *     sh: fullstack-cli: command not found
 *     npm error code 127
 *
 * Verified consequence (macOS arm64, clean tree): because npm aborted during
 * the postinstall phase, the platform-native optional dependencies were left
 * uninstalled, and BOTH `npm run build:server` and `npm run build:client`
 * then failed with MODULE_NOT_FOUND on native bindings
 * (@swc/core-darwin-arm64, @rolldown/binding-darwin-arm64,
 *  lightningcss-darwin-arm64, @napi-rs/nice-darwin-arm64,
 *  @tailwindcss/oxide-darwin-arm64).
 *
 * A fresh clone therefore could not be built at all, from one root cause.
 *
 * There is a public npm package literally named `fullstack-cli`, but it is NOT
 * the lark-apaas tool: running it prints an interactive prompt
 * ("What do you want to create? front / back / catalog") and hangs in a
 * non-TTY environment. Downloading it via `npx` would be both wrong and unsafe.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 *  1. If the project has no `capabilities/` directory, there is nothing for the
 *     action-plugin initialiser to do, so it is skipped with a clear notice.
 *  2. If `capabilities/` exists, the real platform CLI is invoked **only when it
 *     is already resolvable locally** (`npx --no-install`). This never triggers
 *     a network download of an unrelated package.
 *  3. If the CLI is required but unavailable, it prints an actionable warning and
 *     exits 0, so a developer or a non-platform CI can still install and build.
 *     It never pretends the step succeeded.
 *
 * Set QLS_STRICT_PLATFORM_CLI=1 to turn the "CLI unavailable" warning into a
 * hard failure. Platform CI that genuinely requires the plugin init should set
 * this so a missing toolchain cannot silently pass.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPABILITIES_DIR = join(ROOT, 'capabilities');
const STRICT = process.env.QLS_STRICT_PLATFORM_CLI === '1';
const CLI = 'fullstack-cli';

function notice(msg) {
  console.log(`[postinstall] ${msg}`);
}

function warn(msg) {
  console.warn(`[postinstall] WARNING: ${msg}`);
}

function cliIsLocallyAvailable() {
  // --no-install guarantees no network fetch of an unrelated same-named package.
  const probe = spawnSync('npx', ['--no-install', CLI, '--version'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: false,
  });
  return probe.status === 0;
}

function main() {
  if (!existsSync(CAPABILITIES_DIR)) {
    notice(
      'no capabilities/ directory in this project — ' +
        'skipping `action-plugin init` (nothing to initialise).',
    );
    return;
  }

  if (!cliIsLocallyAvailable()) {
    const detail =
      `\`${CLI}\` is not available locally, but capabilities/ exists, so the ` +
      'platform action-plugin step could not be run.';
    if (STRICT) {
      console.error(`[postinstall] ERROR: ${detail}`);
      console.error(
        '[postinstall] QLS_STRICT_PLATFORM_CLI=1 is set, so this is fatal. ' +
          'Install the lark-apaas platform toolchain, or unset it to continue.',
      );
      process.exit(1);
    }
    warn(detail);
    warn(
      'Continuing anyway so that install/build can complete. ' +
        'If you are on the platform and capabilities are required, install the ' +
        'real lark-apaas toolchain and re-run (or set QLS_STRICT_PLATFORM_CLI=1 ' +
        'to make this failure fatal).',
    );
    return;
  }

  notice(`running \`${CLI} action-plugin init\` (local binary found)`);
  const run = spawnSync('npx', ['--no-install', CLI, 'action-plugin', 'init'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (run.status !== 0) {
    console.error(
      `[postinstall] ERROR: \`${CLI} action-plugin init\` failed with exit code ${run.status}.`,
    );
    process.exit(run.status ?? 1);
  }
  notice('action-plugin init completed.');
}

main();
