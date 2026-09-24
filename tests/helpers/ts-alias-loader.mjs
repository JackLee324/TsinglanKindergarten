/**
 * tests/helpers/ts-alias-loader.mjs
 * =================================
 * Lets the `node --test` suites import the SAME TypeScript modules the server
 * and client import, even though those modules use the bundler path aliases
 * (`@shared/...`, `@server/...`, `@client/...`) that only tsconfig/vite resolve.
 *
 * WHY THIS IS NEEDED
 *   `tests/file-security.test.mjs` already imports `../server/common/files/...`
 *   directly (Node >= 22.18 strips types natively), which is how those tests run
 *   against the real implementation instead of a re-implementation that could
 *   pass while the real one is broken. That trick stops working as soon as the
 *   imported module itself uses an alias: `server/modules/curriculum/curriculum.data.ts`
 *   imports `@shared/curriculum`, and a bare `@shared` is not a package.
 *
 *   This loader is registered for one test file via
 *   `module.register('./helpers/ts-alias-loader.mjs', import.meta.url)`, so it
 *   changes resolution for that suite only and touches nothing else.
 *
 * It deliberately does NOT rewrite or compile anything: it maps a prefix to a
 * directory, so the imported code is byte-for-byte the code that ships.
 */

import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALIASES = [
  ['@shared/', join(ROOT, 'shared')],
  ['@server/', join(ROOT, 'server')],
  ['@client/', join(ROOT, 'client')],
];

/** Try the exact path, then the TypeScript conventions Node does not apply itself. */
function candidates(base) {
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
}

export function resolve(specifier, context, nextResolve) {
  for (const [prefix, dir] of ALIASES) {
    if (!specifier.startsWith(prefix)) continue;
    const rest = specifier.slice(prefix.length);
    for (const candidate of candidates(join(dir, rest))) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    // Fall through to the default resolver so a genuinely missing alias fails with
    // Node's own "Cannot find module" message rather than a silent empty result.
  }
  return nextResolve(specifier, context);
}
