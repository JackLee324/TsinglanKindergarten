/**
 * tests/exception-filter-requestid.test.mjs
 * =========================================
 *
 * WHY THIS EXISTS (audit finding B5 / Q-5)
 * ----------------------------------------
 * The response header `x-request-id` and the `requestId` in the JSON error body
 * must be THE SAME VALUE. They are how an operator ties what a teacher saw on
 * screen to the line in the server log; if they differ, that correlation is
 * broken and a support request becomes unanswerable.
 *
 * The defect: `GlobalExceptionFilter` computed an authoritative id near the top
 * of `catch()` as `res.locals.requestId ?? req.requestId`, used it for the header
 * and for every HttpException body, and then the unhandled-exception branch
 * RE-DECLARED `const requestId = request.requestId`, shadowing it. A 4xx matched;
 * a 5xx could answer with a body id that did not match its own header. The file's
 * own comment explains that the platform's request-id middleware overwrites
 * `req.requestId` later in the pipeline - precisely why the two sources can
 * disagree.
 *
 * TWO LAYERS, ON PURPOSE
 * ----------------------
 * 1. A STATIC guard that always runs and fails if the 5xx branch ever declares
 *    `requestId` again. It expresses the actual defect directly and is immune to
 *    build staleness - which matters because `npm test` runs BEFORE
 *    `npm run build` in scripts/verify-all.sh.
 * 2. A BEHAVIOURAL test against the compiled artifact, constructing the one
 *    condition that matters - `res.locals.requestId` differing from
 *    `req.requestId` - and asserting they cannot diverge in the response.
 *    It SKIPS rather than passes when the artifact is missing or older than the
 *    source, because a green test running stale code is worse than no test.
 *    It cannot import the `.ts` directly: that file uses `@Catch()`, and Node's
 *    native type stripping erases types but does not transform decorators.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'server/common/filters/exception.filter.ts');
const COMPILED = resolve(ROOT, 'dist/server/common/filters/exception.filter.js');

const HEADER_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const REQ_ID = 'bbbbbbbb-5555-6666-7777-888888888888';

describe('B5 static guard on the source (always runs)', () => {
  const source = readFileSync(SOURCE, 'utf8');

  test('the authoritative id prefers res.locals over req.requestId', () => {
    assert.ok(
      /locals\?\.requestId[\s\S]{0,40}\?\?[\s\S]{0,40}request\?\.requestId/.test(source),
      'expected `res.locals.requestId ?? req.requestId` to remain the authoritative source',
    );
  });

  test('`requestId` is declared EXACTLY ONCE in the whole filter', () => {
    const declarations = source
      .split('\n')
      .filter((l) => /^\s*const\s+requestId\s*=/.test(l));
    assert.equal(
      declarations.length,
      1,
      'expected exactly one `const requestId =` declaration, found ' +
        declarations.length +
        ':\n' +
        declarations.map((d) => '    ' + d.trim()).join('\n'),
    );
  });

  test('the overwritten request.requestId is not read for the response body', () => {
    assert.ok(
      !/const\s+requestId\s*=\s*\(\s*request\s+as/.test(source),
      'the shadowing declaration has been reintroduced',
    );
  });
});

function makeHost({ localsId, reqId } = {}) {
  const headers = {};
  const captured = { status: undefined, body: undefined };
  const response = {
    headersSent: false,
    locals: localsId === undefined ? {} : { requestId: localsId },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      captured.status = code;
      return this;
    },
    json(payload) {
      captured.body = payload;
      return this;
    },
  };
  const request = reqId === undefined ? {} : { requestId: reqId };
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    },
    headers,
    captured,
  };
}

describe('B5 behaviour on the compiled artifact', () => {
  const fresh =
    existsSync(COMPILED) && statSync(COMPILED).mtimeMs >= statSync(SOURCE).mtimeMs;
  const stale = 'compiled artifact missing or older than the source - run npm run build';
  const load = () => require(COMPILED).GlobalExceptionFilter;

  test('5xx: body requestId EQUALS the x-request-id header', (t) => {
    if (!fresh) return t.skip(stale);
    const Filter = load();
    const { host, headers, captured } = makeHost({ localsId: HEADER_ID, reqId: REQ_ID });
    new Filter().catch(new Error('boom'), host);
    assert.equal(captured.status, 500);
    assert.equal(headers['x-request-id'], HEADER_ID, 'header carries the authoritative id');
    assert.equal(
      captured.body?.error?.requestId,
      HEADER_ID,
      'body requestId must EQUAL the header, not the overwritten req.requestId',
    );
  });

  test('the two ids really differ, so the test above can fail', () => {
    assert.notEqual(HEADER_ID, REQ_ID);
  });

  test('5xx in production leaks no stack, cause, path or DSN', (t) => {
    if (!fresh) return t.skip(stale);
    const Filter = load();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { host, captured } = makeHost({ localsId: HEADER_ID, reqId: REQ_ID });
      const err = new Error('secret /Users/someone/app/dist/server/main.js');
      err.cause = 'connection string postgres://user:pw@host/db';
      new Filter().catch(err, host);
      const serialised = JSON.stringify(captured.body);
      assert.ok(!('stack' in (captured.body?.error ?? {})), 'stack must be absent');
      assert.ok(!('cause' in (captured.body?.error ?? {})), 'cause must be absent');
      assert.ok(!/\/Users\//.test(serialised), 'no absolute file path');
      assert.ok(!/postgres:\/\//.test(serialised), 'no connection string');
      assert.equal(captured.body?.error?.message, '服务器内部错误');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('falls back to req.requestId only when res.locals has none', (t) => {
    if (!fresh) return t.skip(stale);
    const Filter = load();
    const { host, headers, captured } = makeHost({ reqId: REQ_ID });
    new Filter().catch(new Error('boom'), host);
    assert.equal(headers['x-request-id'], REQ_ID);
    assert.equal(captured.body?.error?.requestId, REQ_ID);
  });
});
