/**
 * tests/file-security.test.mjs — file-name / file-content / download-token security
 * ================================================================================
 * Run with:  npm test          (or: node --test tests/file-security.test.mjs)
 *
 * WHAT THIS COVERS
 *   Phase 6 replaced two things that were actively dangerous:
 *
 *     1. `ResourcesService.getDownloadUrl()` returned
 *        `/api/__platform__/storage/download?bucket=…&path=…` — unauthenticated,
 *        non-expiring, and it disclosed the object's location in a PRIVATE bucket.
 *     2. Nothing validated uploads: the browser uploaded straight to platform
 *        storage and only metadata reached the server, so a name like
 *        `../../etc/passwd` or an executable renamed `notes.pdf` was accepted.
 *
 *   These tests exercise the pure replacements directly:
 *     * `server/common/crypto/download-token.ts`  — signed, expiring, caller-bound
 *       tokens (signature before payload, constant-time compare, hard TTL clamp).
 *     * `server/common/files/file-validation.ts`  — name sanitisation, path
 *       traversal, magic-byte sniffing and the extension/MIME/bytes allowlist.
 *
 * WHY IT IMPORTS THE .ts SOURCES DIRECTLY
 *   Node >= 22.18 strips TypeScript types natively (`--experimental-strip-types`
 *   is on by default since 22.18; this repo requires node >= 22), so the tests run
 *   against the SAME code the server runs — no copy, no re-implementation that
 *   could pass while the real implementation is broken. If a future runtime cannot
 *   load them, this file FAILS loudly at import time rather than silently testing
 *   nothing.
 *
 *   Like the other suites here, the tests are dependency-free (`node:test` +
 *   `node:assert/strict`) and need no database and no running server.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const fileValidation = await import(
  new URL('../server/common/files/file-validation.ts', import.meta.url).href
);
const downloadToken = await import(
  new URL('../server/common/crypto/download-token.ts', import.meta.url).href
);

const {
  sanitizeFileName,
  isPathTraversalSafe,
  toBucketRelativePath,
  sniffMagicBytes,
  normalizeMimeType,
  validateUpload,
  maxUploadBytes,
  isAllowedFileName,
  ALLOWED_EXTENSIONS,
  FALLBACK_FILENAME,
  MAX_FILENAME_LENGTH,
  DEFAULT_MAX_UPLOAD_BYTES,
  HARD_CAP_UPLOAD_BYTES,
  UPLOAD_MAX_BYTES_ENV,
} = fileValidation;

const {
  signDownloadToken,
  verifyDownloadToken,
  isDownloadTokenConfigured,
  downloadTokenConfigurationError,
  downloadTokenTtlSeconds,
  DOWNLOAD_TOKEN_SECRET_ENV,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
} = downloadToken;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run `fn` with a set of environment overrides, restoring them afterwards. */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A valid, unencrypted HMAC key (32 bytes) that satisfies the loader. */
const TEST_SECRET = crypto.randomBytes(32).toString('base64');

const b = (...bytes) => Buffer.from(bytes);
const s = (text) => Buffer.from(text, 'utf8');

/** Real leading bytes for each supported format. */
const HEADS = {
  pdf: s('%PDF-1.7\n%\xe2\xe3\xcf\xd3'),
  zip: Buffer.concat([b(0x50, 0x4b, 0x03, 0x04), b(0x14, 0x00, 0x00, 0x00)]),
  emptyZip: b(0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00),
  png: Buffer.concat([b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), s('IHDR')]),
  jpeg: Buffer.concat([b(0xff, 0xd8, 0xff, 0xe0), s('JFIF')]),
  gif: s('GIF89a'),
  gif87: s('GIF87a'),
  ole2: Buffer.concat([b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), s('x')]),
  webp: Buffer.concat([s('RIFF'), b(0x24, 0x00, 0x00, 0x00), s('WEBP')]),
  mp4: Buffer.concat([b(0x00, 0x00, 0x00, 0x18), s('ftypisom')]),
  mov: Buffer.concat([b(0x00, 0x00, 0x00, 0x14), s('ftypqt  ')]),
  mp3: Buffer.concat([s('ID3'), b(0x03, 0x00)]),
  mp3frame: b(0xff, 0xfb, 0x90, 0x00),
  txt: s('第 1 周教案\n目标：认识颜色\n'),
  html: s('<!DOCTYPE html><html><body>hi</body></html>'),
  svg: s('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
  exe: b(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00),
  random: crypto.randomBytes(64),
};

// ===========================================================================
// 1. file name sanitisation
// ===========================================================================
describe('sanitizeFileName', () => {
  test('strips a POSIX directory traversal down to the base name', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFileName('/etc/shadow'), 'shadow');
    assert.equal(sanitizeFileName('a/b/c/lesson.pdf'), 'lesson.pdf');
  });

  test('strips a WINDOWS directory traversal (backslashes are separators too)', () => {
    // Splitting on `/` only — which is what a POSIX-minded implementation does —
    // would leave `..\..\windows\system32` completely intact.
    assert.equal(sanitizeFileName('..\\..\\windows\\system32'), 'system32');
    assert.equal(sanitizeFileName('C:\\Users\\x\\evil.pdf'), 'evil.pdf');
    assert.equal(sanitizeFileName('..\\..\\..\\..\\etc\\hosts'), 'hosts');
  });

  test('removes NUL bytes and control characters', () => {
    assert.equal(sanitizeFileName('notes\u0000.pdf'), 'notes.pdf');
    assert.equal(sanitizeFileName('a\u0001b\u0002c.pdf'), 'abc.pdf');
    // A trailing NUL used to be the classic way to truncate a path or a header.
    assert.equal(sanitizeFileName('lesson.pdf\u0000.exe'), 'lesson.pdf.exe');
    assert.ok(!sanitizeFileName('x\u0000y.pdf').includes('\u0000'));
  });

  test('keeps Unicode names (this platform is bilingual) but removes unsafe characters', () => {
    assert.equal(sanitizeFileName('第一周教案.pdf'), '第一周教案.pdf');
    assert.equal(sanitizeFileName('教案 <final>?.pdf'), '教案 final.pdf');
    assert.equal(sanitizeFileName('report\u2028name.pdf'), 'reportname.pdf');
  });

  test('removes leading dots, so no hidden file can be created', () => {
    assert.equal(sanitizeFileName('.htaccess'), 'htaccess');
    assert.equal(sanitizeFileName('...env'), 'env');
    assert.equal(sanitizeFileName('....pdf'), 'pdf');
  });

  test('refuses names that are only dots or empty', () => {
    assert.equal(sanitizeFileName('..'), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName('...'), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName('.'), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName(''), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName('   '), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName('///'), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName(null), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName(undefined), FALLBACK_FILENAME);
    assert.equal(sanitizeFileName(12345), FALLBACK_FILENAME);
  });

  test('collapses whitespace', () => {
    assert.equal(sanitizeFileName('  my   lesson \t plan.pdf  '), 'my lesson plan.pdf');
  });

  test('enforces the length limit while PRESERVING the extension', () => {
    const long = `${'教'.repeat(400)}.pdf`;
    const out = sanitizeFileName(long);
    assert.ok(out.length <= MAX_FILENAME_LENGTH, `got length ${out.length}`);
    assert.ok(out.endsWith('.pdf'), 'the extension must survive: every later check reasons about it');
    // extension-only names that would otherwise overflow
    const silly = `a.${'x'.repeat(400)}`;
    assert.ok(sanitizeFileName(silly).length <= MAX_FILENAME_LENGTH);
  });

  test('is idempotent (sanitising a sanitised name changes nothing)', () => {
    for (const raw of ['../../etc/passwd', '..\\..\\x.pdf', '教案 <1>.pdf', '..', '']) {
      const once = sanitizeFileName(raw);
      assert.equal(sanitizeFileName(once), once, `not idempotent for ${JSON.stringify(raw)}`);
    }
  });
});

// ===========================================================================
// 2. stored-path traversal
// ===========================================================================
describe('isPathTraversalSafe', () => {
  test('rejects ABSOLUTE paths (leading / or \\) — a stored file_path must be bucket-relative', () => {
    // A predicate that answers "is this value safe?" cannot know whether a future
    // consumer will `path.join` (leading separator harmless) or `path.resolve`
    // (leading separator DISCARDS the bucket). It must therefore never answer
    // `true` for an absolute value. The old behaviour accepted `/etc/passwd`
    // while rejecting `//etc/passwd` — an inconsistency, not a policy.
    assert.equal(isPathTraversalSafe('/etc/passwd'), false);
    assert.equal(isPathTraversalSafe('/etc/shadow'), false);
    assert.equal(isPathTraversalSafe('\\etc\\passwd'), false);
    assert.equal(isPathTraversalSafe('/'), false);
    assert.equal(isPathTraversalSafe('\\'), false);
    assert.equal(isPathTraversalSafe('/uploads/2024/lesson.pdf'), false);
    // ...even when the traversal is hidden behind the leading separator
    assert.equal(isPathTraversalSafe('/uploads/../../etc/passwd'), false);
    assert.equal(isPathTraversalSafe('/../etc/passwd'), false);
  });

  test('accepts ordinary bucket-relative stored paths', () => {
    assert.equal(isPathTraversalSafe('uploads/2026/plan.pdf'), true);
    assert.equal(isPathTraversalSafe('uploads/2024/lesson.pdf'), true);
    assert.equal(isPathTraversalSafe('bucket_123/教案.pdf'), true);
    assert.equal(isPathTraversalSafe('a/b.txt'), true);
  });

  test('rejects doubled separators, drive letters, home and UNC shapes', () => {
    assert.equal(isPathTraversalSafe('//etc/passwd'), false);
    assert.equal(isPathTraversalSafe('//host/share/x'), false);
    assert.equal(isPathTraversalSafe('\\\\windows\\system32'), false);
    assert.equal(isPathTraversalSafe('\\\\server\\share\\x'), false);
    assert.equal(isPathTraversalSafe('C:\\Windows\\system32'), false);
    assert.equal(isPathTraversalSafe('~/x.pdf'), false);
  });

  test('rejects traversal, escapes and normalisation bait', () => {
    assert.equal(isPathTraversalSafe('../../etc/passwd'), false);
    assert.equal(isPathTraversalSafe('a/../../b'), false);
    assert.equal(isPathTraversalSafe('a/b/../c.pdf'), false);
    assert.equal(isPathTraversalSafe('a/./b'), false);
    assert.equal(isPathTraversalSafe('..\\..\\windows\\system32'), false);
    assert.equal(isPathTraversalSafe('uploads/trailing/'), false);
  });

  test('rejects NUL bytes and percent-encoded traversal (defence in depth)', () => {
    assert.equal(isPathTraversalSafe('uploads/a\u0000.pdf'), false);
    assert.equal(isPathTraversalSafe('uploads/%2e%2e/secret'), false);
    assert.equal(isPathTraversalSafe('uploads/%2E%2E%2Fsecret'), false);
  });

  test('rejects non-strings, empty input and over-length values', () => {
    assert.equal(isPathTraversalSafe(''), false);
    assert.equal(isPathTraversalSafe(null), false);
    assert.equal(isPathTraversalSafe(undefined), false);
    assert.equal(isPathTraversalSafe(42), false);
    assert.equal(isPathTraversalSafe(`a/${'b'.repeat(600)}`), false);
  });
});

// ===========================================================================
// 2b. the platform's real key shape, normalised EXPLICITLY
// ===========================================================================
describe('toBucketRelativePath', () => {
  test('normalises the real leading-slash platform key (evidence, not theory)', () => {
    // VERIFIED REAL DATA: the seeded curriculum stores storybook covers as
    //   "filePath": "/curriculum-resources/prek-english-covers/1876907126277273.jpg"
    // (server/database/seed-curriculum.sql) and the storybook-cover endpoint feeds
    // exactly that value through this module. Strict validation + an explicit
    // normaliser keeps that working; loosening the predicate would have made it
    // accept /etc/passwd too.
    assert.equal(
      toBucketRelativePath('/curriculum-resources/prek-english-covers/1876907126277273.jpg'),
      'curriculum-resources/prek-english-covers/1876907126277273.jpg',
    );
    assert.equal(
      isPathTraversalSafe(toBucketRelativePath('/curriculum-resources/prek-english-covers/1876907126277273.jpg')),
      true,
    );
    // A single leading backslash is the Windows spelling of the same shape.
    assert.equal(toBucketRelativePath('\\uploads\\x.pdf'), 'uploads\\x.pdf');
  });

  test('returns null for anything that cannot be made safe', () => {
    for (const bad of [
      '/', '\\', '', '   ',
      '/etc/../etc/passwd',
      '../../etc/passwd',
      '//etc/passwd',          // doubled separator is NOT laundered into a key
      '\\\\host\\share\\x',
      'C:\\Windows\\system32',
      '~/.ssh/id_rsa',
      'a/b/../c.pdf',
      'uploads/%2e%2e/secret',
      'uploads/trailing/',
      'a\u0000b.pdf',
    ]) {
      assert.equal(toBucketRelativePath(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    assert.equal(toBucketRelativePath(null), null);
    assert.equal(toBucketRelativePath(7), null);
  });

  test('is idempotent on an already-normalised key', () => {
    const once = toBucketRelativePath('/uploads/2026/plan.pdf');
    assert.equal(once, 'uploads/2026/plan.pdf');
    assert.equal(toBucketRelativePath(once), 'uploads/2026/plan.pdf');
  });
});

// ===========================================================================
// 3. magic-byte sniffing
// ===========================================================================
describe('sniffMagicBytes', () => {
  test('detects PDF', () => {
    assert.equal(sniffMagicBytes(HEADS.pdf), 'pdf');
  });

  test('detects the ZIP family (also docx/xlsx/pptx containers)', () => {
    assert.equal(sniffMagicBytes(HEADS.zip), 'zip');
    assert.equal(sniffMagicBytes(HEADS.emptyZip), 'zip');
    assert.equal(sniffMagicBytes(b(0x50, 0x4b, 0x07, 0x08)), 'zip');
  });

  test('detects PNG', () => {
    assert.equal(sniffMagicBytes(HEADS.png), 'png');
  });

  test('detects JPEG', () => {
    assert.equal(sniffMagicBytes(HEADS.jpeg), 'jpeg');
    assert.equal(sniffMagicBytes(b(0xff, 0xd8, 0xff, 0xdb)), 'jpeg');
  });

  test('detects both GIF variants', () => {
    assert.equal(sniffMagicBytes(HEADS.gif), 'gif');
    assert.equal(sniffMagicBytes(HEADS.gif87), 'gif');
  });

  test('detects OLE2 (legacy doc/xls/ppt)', () => {
    assert.equal(sniffMagicBytes(HEADS.ole2), 'ole2');
  });

  test('detects WebP and ISO base media (mp4/mov)', () => {
    assert.equal(sniffMagicBytes(HEADS.webp), 'webp');
    assert.equal(sniffMagicBytes(HEADS.mp4), 'ftyp');
    assert.equal(sniffMagicBytes(HEADS.mov), 'ftyp');
  });

  test('detects MP3 (ID3 tag and raw frame sync)', () => {
    assert.equal(sniffMagicBytes(HEADS.mp3), 'mp3');
    assert.equal(sniffMagicBytes(HEADS.mp3frame), 'mp3');
  });

  test('falls back to text for UTF-8 content without NUL bytes', () => {
    assert.equal(sniffMagicBytes(HEADS.txt), 'text');
    assert.equal(sniffMagicBytes(s('plain ascii notes')), 'text');
    assert.equal(sniffMagicBytes(s('# Markdown\n- item\n')), 'text');
    // A multi-byte character cut off by the 512-byte window must not flip the
    // result to `unknown`.
    assert.equal(sniffMagicBytes(Buffer.concat([s('中文'.repeat(200)), b(0xe4, 0xb8)])), 'text');
  });

  test('classifies markup as html, never as text', () => {
    assert.equal(sniffMagicBytes(HEADS.html), 'html');
    assert.equal(sniffMagicBytes(HEADS.svg), 'html');
    assert.equal(sniffMagicBytes(s('  \n\t<html>')), 'html');
    assert.equal(sniffMagicBytes(s('<svg/>')), 'html');
    assert.equal(sniffMagicBytes(Buffer.concat([b(0xef, 0xbb, 0xbf), s('<html>')])), 'html');
  });

  test('returns unknown for binaries it cannot identify', () => {
    assert.equal(sniffMagicBytes(HEADS.exe), 'unknown');
    assert.equal(sniffMagicBytes(HEADS.random), 'unknown');
    assert.equal(sniffMagicBytes(Buffer.alloc(0)), 'unknown');
    // UTF-16 text is full of NUL bytes and is NOT accepted as text.
    assert.equal(sniffMagicBytes(Buffer.from('hello', 'utf16le')), 'unknown');
  });
});

// ===========================================================================
// 4. validateUpload — the allowlist and the anti-spoofing check
// ===========================================================================
describe('validateUpload — accepted files', () => {
  const ACCEPTED = [
    ['lesson.pdf', 'application/pdf', HEADS.pdf, 'pdf'],
    ['plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', HEADS.zip, 'zip'],
    ['legacy.doc', 'application/msword', HEADS.ole2, 'ole2'],
    ['grades.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', HEADS.zip, 'zip'],
    ['legacy.xls', 'application/vnd.ms-excel', HEADS.ole2, 'ole2'],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', HEADS.zip, 'zip'],
    ['legacy.ppt', 'application/vnd.ms-powerpoint', HEADS.ole2, 'ole2'],
    ['photo.jpg', 'image/jpeg', HEADS.jpeg, 'jpeg'],
    ['photo.jpeg', 'image/jpeg', HEADS.jpeg, 'jpeg'],
    ['logo.png', 'image/png', HEADS.png, 'png'],
    ['anim.gif', 'image/gif', HEADS.gif, 'gif'],
    ['modern.webp', 'image/webp', HEADS.webp, 'webp'],
    ['notes.txt', 'text/plain', HEADS.txt, 'text'],
    ['readme.md', 'text/markdown', HEADS.txt, 'text'],
    ['video.mp4', 'video/mp4', HEADS.mp4, 'ftyp'],
    ['clip.mov', 'video/quicktime', HEADS.mov, 'ftyp'],
    ['song.mp3', 'audio/mpeg', HEADS.mp3, 'mp3'],
    ['pack.zip', 'application/zip', HEADS.zip, 'zip'],
  ];

  for (const [fileName, mimeType, head, kind] of ACCEPTED) {
    test(`accepts .${fileName.split('.').pop()} declared as ${mimeType}`, () => {
      const result = validateUpload({ fileName, mimeType, sizeBytes: head.length, head });
      assert.equal(result.ok, true, `rejected: ${JSON.stringify(result)}`);
      assert.equal(result.kind, kind);
      assert.equal(result.fileName, fileName);
    });
  }

  test('accepts a MIME type with parameters and an uppercase form', () => {
    const a = validateUpload({ fileName: 'n.txt', mimeType: 'text/plain; charset=utf-8', sizeBytes: 5, head: s('hello') });
    assert.equal(a.ok, true);
    const c = validateUpload({ fileName: 'n.png', mimeType: 'IMAGE/PNG', sizeBytes: 9, head: HEADS.png });
    assert.equal(c.ok, true);
  });

  test('normalises known browser MIME aliases without widening the allowlist', () => {
    assert.equal(normalizeMimeType('image/jpg'), 'image/jpeg');
    assert.equal(normalizeMimeType('image/pjpeg'), 'image/jpeg');
    assert.equal(normalizeMimeType('audio/mp3'), 'audio/mpeg');
    assert.equal(normalizeMimeType('  Text/Plain ; charset=UTF-8 '), 'text/plain');
    const aliased = validateUpload({ fileName: 'p.jpg', mimeType: 'image/jpg', sizeBytes: 12, head: HEADS.jpeg });
    assert.equal(aliased.ok, true);
  });

  test('stores the SANITISED name it validated, not the raw input', () => {
    const result = validateUpload({
      fileName: '../../etc/notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12,
      head: HEADS.pdf,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fileName, 'notes.pdf');
  });
});

describe('validateUpload — rejections', () => {
  test('a TEXT payload declared as application/pdf is REJECTED (anti-spoofing)', () => {
    const result = validateUpload({
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 20,
      head: s('this is plainly not a PDF'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TYPE_MISMATCH');
  });

  test('an executables renamed .pdf is REJECTED', () => {
    const result = validateUpload({ fileName: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 64, head: HEADS.exe });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TYPE_MISMATCH');
  });

  test('a PNG declared as image/gif is REJECTED (bytes win over the claim)', () => {
    const result = validateUpload({ fileName: 'x.gif', mimeType: 'image/gif', sizeBytes: 12, head: HEADS.png });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TYPE_MISMATCH');
  });

  test('HTML and SVG are rejected — by extension, by MIME, and by content', () => {
    // .html is not an allowed extension at all
    const byExt = validateUpload({ fileName: 'x.html', mimeType: 'text/html', sizeBytes: 20, head: HEADS.html });
    assert.equal(byExt.ok, false);
    assert.equal(byExt.code, 'EXTENSION_NOT_ALLOWED');

    // text/html is not an allowed MIME type
    const byMime = validateUpload({ fileName: 'x.txt', mimeType: 'text/html', sizeBytes: 20, head: HEADS.html });
    assert.equal(byMime.ok, false);
    assert.equal(byMime.code, 'MIME_NOT_ALLOWED');

    // image/svg+xml is not allowed either
    const svgMime = validateUpload({ fileName: 'x.svg', mimeType: 'image/svg+xml', sizeBytes: 20, head: HEADS.svg });
    assert.equal(svgMime.ok, false);
    assert.equal(svgMime.code, 'EXTENSION_NOT_ALLOWED');

    // markup RENAMED as plain text is caught by the bytes
    const byContent = validateUpload({ fileName: 'x.txt', mimeType: 'text/plain', sizeBytes: 42, head: HEADS.html });
    assert.equal(byContent.ok, false);
    assert.equal(byContent.code, 'HTML_NOT_ALLOWED');

    const svgAsTxt = validateUpload({ fileName: 'notes.txt', mimeType: 'text/plain', sizeBytes: 60, head: HEADS.svg });
    assert.equal(svgAsTxt.ok, false);
    assert.equal(svgAsTxt.code, 'HTML_NOT_ALLOWED');
  });

  test('script-ish extensions are never in the allowlist', () => {
    for (const ext of ['exe', 'sh', 'js', 'mjs', 'php', 'jsp', 'bat', 'cmd', 'ps1', 'jar', 'svg', 'html', 'htm']) {
      assert.equal(ALLOWED_EXTENSIONS.includes(ext), false, `.${ext} must not be allowed`);
      assert.equal(isAllowedFileName(`payload.${ext}`), false);
    }
  });

  test('rejects a zero-byte file', () => {
    const result = validateUpload({ fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 0, head: Buffer.alloc(0) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EMPTY_FILE');
  });

  test('rejects a file whose head bytes were not supplied', () => {
    const result = validateUpload({ fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 1024, head: Buffer.alloc(0) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MAGIC_BYTES_MISSING', 'a non-empty file with no bytes to inspect cannot be validated');
  });

  test('rejects an oversize file, and accepts the largest allowed size', () => {
    withEnv({ [UPLOAD_MAX_BYTES_ENV]: undefined }, () => {
      const over = validateUpload({
        fileName: 'big.pdf',
        mimeType: 'application/pdf',
        sizeBytes: DEFAULT_MAX_UPLOAD_BYTES + 1,
        head: HEADS.pdf,
      });
      assert.equal(over.ok, false);
      assert.equal(over.code, 'TOO_LARGE');

      const atLimit = validateUpload({
        fileName: 'big.pdf',
        mimeType: 'application/pdf',
        sizeBytes: DEFAULT_MAX_UPLOAD_BYTES,
        head: HEADS.pdf,
      });
      assert.equal(atLimit.ok, true, 'the limit itself must be inclusive');
    });
  });

  test('honours UPLOAD_MAX_BYTES but can never exceed the hard cap', () => {
    withEnv({ [UPLOAD_MAX_BYTES_ENV]: '1024' }, () => {
      assert.equal(maxUploadBytes(), 1024);
      const result = validateUpload({ fileName: 'x.txt', mimeType: 'text/plain', sizeBytes: 1025, head: s('hello') });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'TOO_LARGE');
    });
    withEnv({ [UPLOAD_MAX_BYTES_ENV]: String(HARD_CAP_UPLOAD_BYTES * 100) }, () => {
      assert.equal(maxUploadBytes(), HARD_CAP_UPLOAD_BYTES, 'a huge configured value is clamped');
    });
    withEnv({ [UPLOAD_MAX_BYTES_ENV]: 'not-a-number' }, () => {
      assert.throws(() => maxUploadBytes(), /UPLOAD_MAX_BYTES/, 'a broken limit must fail loudly, not default silently');
    });
  });

  test('rejects an unknown extension and a name with no extension', () => {
    const unknown = validateUpload({ fileName: 'x.bin', mimeType: 'application/octet-stream', sizeBytes: 10, head: HEADS.random });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'EXTENSION_NOT_ALLOWED');

    const noExt = validateUpload({ fileName: 'LICENSE', mimeType: 'text/plain', sizeBytes: 10, head: s('text here') });
    assert.equal(noExt.ok, false);
    assert.equal(noExt.code, 'EXTENSION_NOT_ALLOWED');
  });

  test('rejects a name that sanitisation cannot rescue', () => {
    const result = validateUpload({ fileName: '..', mimeType: 'application/pdf', sizeBytes: 10, head: HEADS.pdf });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_FILENAME');
  });

  test('rejects an extension that does not match the declared type', () => {
    // A real GIF, correctly sniffed, but declared as a PDF and named .pdf:
    // caught by the extension/MIME pairing before the byte check.
    const result = validateUpload({ fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 6, head: HEADS.gif });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TYPE_MISMATCH');
  });

  test('rejects a .doc that claims to be an Excel file', () => {
    const result = validateUpload({ fileName: 'x.doc', mimeType: 'application/vnd.ms-excel', sizeBytes: 12, head: HEADS.ole2 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MIME_EXTENSION_MISMATCH');
  });

  test('rejects a .docx declared as a plain ZIP (the pairing is exact)', () => {
    const result = validateUpload({ fileName: 'x.docx', mimeType: 'application/zip', sizeBytes: 12, head: HEADS.zip });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MIME_EXTENSION_MISMATCH');
  });

  test('rejects a negative or non-numeric size', () => {
    const negative = validateUpload({ fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: -1, head: HEADS.pdf });
    assert.equal(negative.ok, false);
    assert.equal(negative.code, 'EMPTY_FILE');
    const nan = validateUpload({ fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: Number.NaN, head: HEADS.pdf });
    assert.equal(nan.ok, false);
  });

  test('NO rejection path returns ok:true with a hostile name', () => {
    const attempts = [
      { fileName: '../../../../etc/passwd', mimeType: 'text/plain', sizeBytes: 5, head: s('hello') },
      { fileName: '..\\..\\windows\\system32\\cmd.exe', mimeType: 'application/pdf', sizeBytes: 5, head: s('%PDF-') },
      { fileName: '.env', mimeType: 'text/plain', sizeBytes: 5, head: s('hello') },
    ];
    for (const attempt of attempts) {
      const result = validateUpload(attempt);
      if (result.ok) {
        assert.ok(!result.fileName.includes('/'), 'no separators may survive');
        assert.ok(!result.fileName.includes('\\'), 'no separators may survive');
        assert.ok(!result.fileName.startsWith('.'), 'no hidden files');
      }
    }
  });
});

// ===========================================================================
// 5. download tokens
// ===========================================================================
describe('download tokens — configuration', () => {
  test('refuses to work without DOWNLOAD_TOKEN_SECRET (no hardcoded fallback)', () => {
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: undefined }, () => {
      assert.equal(isDownloadTokenConfigured(), false);
      assert.match(downloadTokenConfigurationError(), /DOWNLOAD_TOKEN_SECRET/);
      assert.throws(
        () => signDownloadToken({ resourceId: 'r', teacherId: 't' }),
        /DOWNLOAD_TOKEN_SECRET/,
        'signing must fail loudly rather than fall back to a built-in key',
      );
    });
  });

  test('refuses a key that is too short to be an HMAC-SHA256 key', () => {
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: 'short-secret' }, () => {
      assert.equal(isDownloadTokenConfigured(), false);
      assert.match(downloadTokenConfigurationError(), /32 bytes/);
    });
  });

  test('accepts a base64 32-byte secret and a 64-hex-character secret', () => {
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: crypto.randomBytes(32).toString('base64') }, () => {
      assert.equal(isDownloadTokenConfigured(), true);
    });
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: crypto.randomBytes(32).toString('hex') }, () => {
      assert.equal(isDownloadTokenConfigured(), true);
    });
  });

  test('TTL defaults to 300s and is clamped to 3600s', () => {
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: TEST_SECRET, DOWNLOAD_TOKEN_TTL_SECONDS: undefined }, () => {
      assert.equal(downloadTokenTtlSeconds(), DEFAULT_TTL_SECONDS);
      assert.equal(DEFAULT_TTL_SECONDS, 300);
      const token = signDownloadToken({ resourceId: 'r', teacherId: 't', now: 1_000_000 });
      const verified = verifyDownloadToken(token, { now: 1_000_000 });
      assert.equal(verified.ok, true);
      assert.equal(verified.payload.exp, 1_000_000 + 300);
    });
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: TEST_SECRET, DOWNLOAD_TOKEN_TTL_SECONDS: '999999' }, () => {
      assert.equal(downloadTokenTtlSeconds(), MAX_TTL_SECONDS);
      assert.equal(MAX_TTL_SECONDS, 3600);
    });
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: TEST_SECRET, DOWNLOAD_TOKEN_TTL_SECONDS: '120' }, () => {
      assert.equal(downloadTokenTtlSeconds(), 120);
    });
  });

  test('a malformed TTL setting fails loudly instead of silently using the default', () => {
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: TEST_SECRET, DOWNLOAD_TOKEN_TTL_SECONDS: 'abc' }, () => {
      assert.throws(() => downloadTokenTtlSeconds(), /DOWNLOAD_TOKEN_TTL_SECONDS/);
    });
  });
});

describe('download tokens — round trip and tampering', () => {
  before(() => {
    process.env[DOWNLOAD_TOKEN_SECRET_ENV] = TEST_SECRET;
  });
  after(() => {
    delete process.env[DOWNLOAD_TOKEN_SECRET_ENV];
  });

  test('round trip preserves the bound resource and account', () => {
    const token = signDownloadToken({ resourceId: 'res-1', teacherId: 'teacher-1' });
    const result = verifyDownloadToken(token);
    assert.equal(result.ok, true);
    assert.equal(result.payload.resourceId, 'res-1');
    assert.equal(result.payload.teacherId, 'teacher-1');
    assert.ok(result.payload.exp > Math.floor(Date.now() / 1000));
    assert.ok(result.payload.nonce.length >= 16, 'a nonce makes each token unique');
  });

  test('the token format is <base64url payload>.<base64url signature> and is URL-safe', () => {
    const token = signDownloadToken({ resourceId: 'res-1', teacherId: 'teacher-1' });
    const parts = token.split('.');
    assert.equal(parts.length, 2);
    assert.match(parts[0], /^[A-Za-z0-9_-]+$/);
    assert.match(parts[1], /^[A-Za-z0-9_-]+$/);
    assert.equal(encodeURIComponent(token), token, 'the token must survive a query string unchanged');
    // The payload carries no secret, but it IS readable — asserted so nobody
    // starts putting something confidential in it.
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    assert.deepEqual(Object.keys(payload).sort(), ['exp', 'nonce', 'resourceId', 'teacherId']);
  });

  test('two tokens for the same resource and account differ (nonce)', () => {
    const a = signDownloadToken({ resourceId: 'r', teacherId: 't' });
    const bToken = signDownloadToken({ resourceId: 'r', teacherId: 't' });
    assert.notEqual(a, bToken);
  });

  test('an EXPIRED token is rejected with reason "expired"', () => {
    const token = signDownloadToken({ resourceId: 'r', teacherId: 't', ttlSeconds: 60, now: 1_000_000 });
    const result = verifyDownloadToken(token, { now: 1_000_000 + 61 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
    // ... and is still valid one second before the boundary
    assert.equal(verifyDownloadToken(token, { now: 1_000_000 + 59 }).ok, true);
  });

  test('a TAMPERED PAYLOAD is rejected — and never reported as merely expired', () => {
    const token = signDownloadToken({ resourceId: 'r', teacherId: 't', now: 1_000_000 });
    const [body, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));

    // (a) extend the expiry — the classic "make the link last longer" edit
    const extended = Buffer.from(
      JSON.stringify({ ...payload, exp: payload.exp + 10_000_000 }),
      'utf8',
    ).toString('base64url');
    const extendedResult = verifyDownloadToken(`${extended}.${signature}`, { now: 1_000_000 });
    assert.equal(extendedResult.ok, false);
    assert.equal(extendedResult.reason, 'bad_signature');

    // (b) point the token at a DIFFERENT resource
    const otherResource = Buffer.from(
      JSON.stringify({ ...payload, resourceId: 'someone-elses-file' }),
      'utf8',
    ).toString('base64url');
    const otherResult = verifyDownloadToken(`${otherResource}.${signature}`);
    assert.equal(otherResult.ok, false);
    assert.equal(otherResult.reason, 'bad_signature');
  });

  test('a TAMPERED SIGNATURE is rejected', () => {
    const token = signDownloadToken({ resourceId: 'r', teacherId: 't' });
    const [body, signature] = token.split('.');
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    const result = verifyDownloadToken(`${body}.${flipped}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  });

  test('a token signed with a DIFFERENT key is rejected', () => {
    const token = signDownloadToken({ resourceId: 'r', teacherId: 't' });
    withEnv({ [DOWNLOAD_TOKEN_SECRET_ENV]: crypto.randomBytes(32).toString('base64') }, () => {
      const result = verifyDownloadToken(token);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    });
  });

  test('CROSS-USER: a token is bound to exactly one account, and cannot be re-pointed', () => {
    const forA = signDownloadToken({ resourceId: 'shared-resource', teacherId: 'teacher-A' });
    const forB = signDownloadToken({ resourceId: 'shared-resource', teacherId: 'teacher-B' });

    const a = verifyDownloadToken(forA);
    const bResult = verifyDownloadToken(forB);
    assert.equal(a.ok, true);
    assert.equal(bResult.ok, true);
    // The two tokens authorize DIFFERENT accounts for the SAME resource. This is
    // what /api/files/download compares against the session, so a URL leaked from
    // account A cannot be replayed by account B.
    assert.equal(a.payload.teacherId, 'teacher-A');
    assert.equal(bResult.payload.teacherId, 'teacher-B');
    assert.notEqual(a.payload.teacherId, bResult.payload.teacherId);

    // Rewriting the account inside A's token invalidates it.
    const [body, signature] = forA.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const swapped = Buffer.from(
      JSON.stringify({ ...payload, teacherId: 'teacher-B' }),
      'utf8',
    ).toString('base64url');
    const swappedResult = verifyDownloadToken(`${swapped}.${signature}`);
    assert.equal(swappedResult.ok, false);
    assert.equal(swappedResult.reason, 'bad_signature');
  });

  test('malformed tokens are rejected as "malformed" (never crashing the verifier)', () => {
    for (const bad of ['', '.', 'nodot', 'a.b.c', 'a.', '.b', '!!!.???', 'AAAA', 'x'.repeat(4000)]) {
      const result = verifyDownloadToken(bad);
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad.slice(0, 20))}`);
      assert.equal(result.reason, 'malformed');
    }
  });

  test('a well-signed but structurally wrong payload is rejected as "malformed"', () => {
    // Signed with the real key, so the signature check PASSES and the payload
    // shape check is what must catch it.
    const key = Buffer.from(TEST_SECRET, 'base64');
    const bodies = [
      JSON.stringify({ resourceId: 'r', teacherId: 't' }), // no exp, no nonce
      JSON.stringify({ resourceId: '', teacherId: 't', exp: 9e9, nonce: 'n' }),
      JSON.stringify({ resourceId: 'r', teacherId: 't', exp: 'soon', nonce: 'n' }),
      JSON.stringify({ resourceId: 'r', teacherId: 't', exp: 9e9 }), // no nonce
      JSON.stringify(['r', 't', 9e9, 'n']),
      'not json at all',
    ];
    for (const raw of bodies) {
      const body = Buffer.from(raw, 'utf8').toString('base64url');
      const signature = crypto
        .createHmac('sha256', key)
        .update(body)
        .digest('base64url');
      const result = verifyDownloadToken(`${body}.${signature}`);
      assert.equal(result.ok, false, `expected rejection for ${raw}`);
      assert.equal(result.reason, 'malformed');
    }
  });

  test('signing without a resource or an account is a programming error', () => {
    assert.throws(() => signDownloadToken({ resourceId: '', teacherId: 't' }), /resourceId/);
    assert.throws(() => signDownloadToken({ resourceId: 'r', teacherId: '' }), /teacherId/);
  });
});
