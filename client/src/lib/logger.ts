/**
 * The application's logger.
 * ========================
 *
 * WHAT THIS REPLACES, AND WHY IT LOOKS LIKE THIS
 * ----------------------------------------------
 * Every client file used to import `logger` from
 * `@lark-apaas/client-toolkit/logger`. That logger was console output PLUS a
 * production-only telemetry sink: with `NODE_ENV === 'production'` every
 * `info`/`warn`/`error` call also shipped its arguments to the platform's
 * `observable` pipeline. Off the platform there is no pipeline, so the sink is
 * gone and what remains is the part that was always doing the work: a level-gated
 * console write.
 *
 * THE LEVELS ARE THE SAME ONES, WITH THE SAME THRESHOLD
 * ----------------------------------------------------
 * The toolkit configured `level: 'debug'` in development and `'error'` in
 * production, so in a production build only `error` reaches the console. That is
 * preserved deliberately: raising it would turn every caught-and-degraded warning
 * into console noise for teachers using the platform, and lowering it would hide
 * the errors that are worth seeing in a bug report.
 *
 * The `[QLS]` prefix replaces the toolkit's `[MiaoDa]`. It appears only in a
 * browser console, and it is the one string in this file that had to change: an
 * application that no longer depends on 妙搭 should not label its own logs with it.
 *
 * NOTHING HERE TOUCHES THE NETWORK, and nothing here is allowed to throw: a
 * logger that fails must never be the reason a page breaks.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Development: everything. Production: errors only. Same rule as the toolkit's. */
const MIN_LEVEL: LogLevel = process.env.NODE_ENV === 'development' ? 'debug' : 'error';

const PREFIX = '[QLS]';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(MIN_LEVEL);
}

function emit(level: LogLevel, message: unknown, args: unknown[]): void {
  if (!shouldLog(level)) return;
  const tag = `${PREFIX} [${level.toUpperCase()}]`;
  // `error` goes to stderr so a browser's console error filter and an automated
  // test harness see it; everything else is an ordinary console line.
  if (level === 'error') console.error(tag, message, ...args);
  else console.log(tag, message, ...args);
}

export const logger = {
  debug(message: unknown, ...args: unknown[]): void {
    emit('debug', message, args);
  },
  info(message: unknown, ...args: unknown[]): void {
    emit('info', message, args);
  },
  warn(message: unknown, ...args: unknown[]): void {
    emit('warn', message, args);
  },
  error(message: unknown, ...args: unknown[]): void {
    emit('error', message, args);
  },
};
