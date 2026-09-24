/**
 * tests/helpers/gate-lock-holder.mjs
 * ==================================
 * Holds the EXCLUSIVE advisory lock on the shared verification environment for as
 * long as this process lives, so `scripts/verify-all.sh` can own the environment
 * (database + the running server + `dist/`) for the whole gate.
 *
 * WHY A SEPARATE PROCESS
 *   A PostgreSQL advisory lock belongs to the connection that took it, so the gate
 *   cannot take it from bash. This helper takes it, reports readiness through a
 *   file, and blocks until the gate's EXIT trap terminates it.
 *
 * WHY AN ADVISORY LOCK AND NOT A LOCK FILE
 *   PostgreSQL releases the lock when the holding connection ends, including when
 *   the process is killed. A lock file left behind by a crashed gate would refuse
 *   every future gate until someone removed it by hand.
 *
 * USAGE
 *   node tests/helpers/gate-lock-holder.mjs <ready-file>
 *
 *   The ready file receives exactly one line:
 *     LOCKED                     the gate may proceed
 *     BUSY: <reason>             another gate or suite owns the environment
 */

import { acquireGateLock } from './reset-fixtures.mjs';

const readyFile = process.argv[2];
if (!readyFile) {
  console.error('usage: node tests/helpers/gate-lock-holder.mjs <ready-file>');
  process.exit(2);
}

const { writeFileSync } = await import('node:fs');

const dbUrl = process.env.AUTHZ_TEST_DB;
if (!dbUrl) {
  writeFileSync(readyFile, 'BUSY: AUTHZ_TEST_DB is not set\n');
  process.exit(1);
}

let lock;
try {
  lock = await acquireGateLock(dbUrl);
} catch (error) {
  writeFileSync(readyFile, `BUSY: ${error.message}\n`);
  process.exit(3);
}

writeFileSync(readyFile, 'LOCKED\n');
console.log('  gate lock  acquired (exclusive advisory lock on the shared environment)');

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  try {
    await lock.release();
  } catch (error) {
    // Never swallowed: a lock that cannot be released is worth knowing about.
    console.error(`  gate lock  release failed on ${signal}: ${error.message}`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

// Block forever; PostgreSQL holds the lock until this connection closes.
await new Promise(() => {});
