/**
 * scripts/probe-file-validation.mjs — independent adversarial probe
 * =================================================================
 *
 * This deliberately tests the BUILT artifact (dist/server/common/files/
 * file-validation.js) rather than the TypeScript source, because the source is
 * not what ships. Run `npm run build:server` first.
 *
 * It exists because a validator that looks correct in review can still have a
 * hole. The checks below were written by attacking the module rather than by
 * reading it, and they found a real one: `isPathTraversalSafe('/etc/passwd')`
 * returned true — a POSIX-absolute path was accepted as "safe" while the UNC
 * form `//etc/passwd` was correctly rejected, so the intent to reject a leading
 * separator was present but incomplete.
 *
 * Exit code 0 = every check passed; 1 = at least one failed.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = resolve(ROOT, 'dist/server/common/files/file-validation.js');

if (!existsSync(BUILT)) {
  console.error(
    `Cannot find ${BUILT}.
Run 'npm run build:server' first - this probe tests the built artifact on purpose.`,
  );
  process.exit(2);
}

const V = require(BUILT);

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}-> ${String(actual)}${ok ? '' : `   expected ${expected}`}`);
  ok ? pass++ : fail++;
};

const buf = (...bytes) => Buffer.from(bytes);
const PDF  = Buffer.concat([buf(0x25,0x50,0x44,0x46,0x2d), Buffer.alloc(40, 0x20)]);
const ZIP  = Buffer.concat([buf(0x50,0x4b,0x03,0x04), Buffer.alloc(40, 0)]);
const PNG  = Buffer.concat([buf(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a), Buffer.alloc(40,0)]);
const JPEG = Buffer.concat([buf(0xff,0xd8,0xff,0xe0), Buffer.alloc(40, 0)]);
const OLE2 = Buffer.concat([buf(0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1), Buffer.alloc(40,0)]);
const HTML = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');
const EXE  = buf(0x4d,0x5a,0x90,0x00,0x03,0x00,0x00,0x00);

console.log('=== A. filename sanitisation (path traversal / injection) ===');
check('../../etc/passwd keeps no slash', V.sanitizeFileName('../../etc/passwd').includes('/'), false);
check('../../etc/passwd resolves to basename', V.sanitizeFileName('../../etc/passwd'), 'passwd');
check('..\\\\..\\\\windows\\\\system32\\\\cmd.exe -> cmd.exe', V.sanitizeFileName('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');
check('NUL byte removed', V.sanitizeFileName('a\u0000b.pdf').includes('\u0000'), false);
check('leading dot stripped (no hidden file)', V.sanitizeFileName('.htaccess').startsWith('.'), false);
check('".." alone is not returned as a usable name', ['..','', V.FALLBACK_FILENAME].includes(V.sanitizeFileName('..')), true);
check('empty -> fallback', V.sanitizeFileName(''), V.FALLBACK_FILENAME);
check('over-long name is truncated', V.sanitizeFileName('x'.repeat(500) + '.pdf').length <= V.MAX_FILENAME_LENGTH, true);
check('extension preserved when truncating', V.sanitizeFileName('x'.repeat(500) + '.pdf').endsWith('.pdf'), true);
check('newline stripped', V.sanitizeFileName('a\nb.pdf').includes('\n'), false);

console.log('\n=== B. magic-byte sniffing ===');
check('PDF detected', V.sniffMagicBytes(PDF), 'pdf');
check('ZIP detected', V.sniffMagicBytes(ZIP), 'zip');
check('PNG detected', V.sniffMagicBytes(PNG), 'png');
check('JPEG detected', V.sniffMagicBytes(JPEG), 'jpeg');
check('OLE2 (legacy Office) detected', V.sniffMagicBytes(OLE2), 'ole2');

console.log('\n=== C. content/declaration mismatch (anti-spoofing) ===');
const spoof = V.validateUpload({ fileName:'notes.pdf', mimeType:'application/pdf', sizeBytes:PDF.length, head:EXE });
check('EXE bytes named .pdf REJECTED', spoof.ok, false);
const htmlAsPdf = V.validateUpload({ fileName:'a.pdf', mimeType:'application/pdf', sizeBytes:HTML.length, head:HTML });
check('HTML named .pdf REJECTED', htmlAsPdf.ok, false);
const txtAsPdf = V.validateUpload({ fileName:'a.pdf', mimeType:'application/pdf', sizeBytes:100, head:Buffer.alloc(100, 0x41) });
check('text named .pdf REJECTED', txtAsPdf.ok, false);
const zipAsPdf = V.validateUpload({ fileName:'a.pdf', mimeType:'application/pdf', sizeBytes:ZIP.length, head:ZIP });
check('ZIP named .pdf REJECTED', zipAsPdf.ok, false);

console.log('\n=== D. allowlist / size ===');
for (const [name, mime] of [['x.html','text/html'],['x.svg','image/svg+xml'],['x.js','application/javascript'],['x.exe','application/x-msdownload']]) {
  const r = V.validateUpload({ fileName:name, mimeType:mime, sizeBytes:100, head:HTML });
  check(`${name} REJECTED (stored-XSS / executable)`, r.ok, false);
}
const goodPdf = V.validateUpload({ fileName:'plan.pdf', mimeType:'application/pdf', sizeBytes:PDF.length, head:PDF });
check('genuine PDF ACCEPTED', goodPdf.ok, true);
const goodJpg = V.validateUpload({ fileName:'c.jpg', mimeType:'image/jpeg', sizeBytes:JPEG.length, head:JPEG });
check('genuine JPEG ACCEPTED', goodJpg.ok, true);
check('empty file REJECTED', V.validateUpload({ fileName:'e.pdf', mimeType:'application/pdf', sizeBytes:0, head:Buffer.alloc(0) }).ok, false);
const big = V.validateUpload({ fileName:'b.pdf', mimeType:'application/pdf', sizeBytes:V.HARD_CAP_UPLOAD_BYTES + 1, head:PDF });
check('oversize REJECTED', big.ok, false);

console.log('\n=== E. stored-path traversal ===');
check('"../../etc/passwd" flagged', V.isPathTraversalSafe('../../etc/passwd'), false);
check('"/etc/passwd" flagged', V.isPathTraversalSafe('/etc/passwd'), false);
check('"a/b/../c.pdf" flagged', V.isPathTraversalSafe('a/b/../c.pdf'), false);
check('"uploads/2026/plan.pdf" allowed', V.isPathTraversalSafe('uploads/2026/plan.pdf'), true);

console.log(`\n=== RESULT ===\n  pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
