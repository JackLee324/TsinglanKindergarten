/**
 * Server-side file metadata validation.
 * =====================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Uploads used to bypass the server completely: the browser called
 * `bucket.uploadFile(file)` against platform storage and only the *metadata*
 * ever reached the backend, if at all. Nothing validated the name, the size or
 * the actual bytes, so:
 *
 *   * `../../etc/passwd` — or `..\..\windows\system32` — was a perfectly
 *     acceptable `fileName`, and any code that later joined it onto a directory
 *     could be steered outside that directory;
 *   * a NUL byte or a control character in a name could truncate or corrupt a
 *     downstream path, header or log line;
 *   * any byte sequence at all could be declared `application/pdf`; the declared
 *     MIME type was taken at face value;
 *   * a file could be arbitrarily large.
 *
 * This module is the boundary that fixes that. It is PURE and dependency-free
 * (node:crypto only, for nothing — it imports nothing but Buffer) so it can be
 * unit-tested without a database, a server or a platform.
 *
 * TWO SEPARATE JOBS, deliberately kept apart:
 *
 *   1. `sanitizeFileName` / `isPathTraversalSafe` — make a hostile NAME safe.
 *   2. `validateUpload` — decide whether the BYTES are an acceptable file at all,
 *      by comparing the declared type with the bytes actually present.
 *
 * (2) is why magic-byte sniffing is here: a declared MIME type is a CLIENT
 * ASSERTION. `notes.pdf` containing `MZ\x90\x00` (a Windows executable) or an
 * HTML page has a perfectly valid `.pdf` extension and a perfectly valid
 * `application/pdf` declaration, and only the leading bytes tell the truth.
 *
 * WHY HTML AND SVG ARE NOT ALLOWED
 * --------------------------------
 * HTML and SVG are *active* formats: a browser renders `<script>` in both, and
 * SVG can embed `<script>` and event handlers. Files in this platform are stored
 * in a shared bucket and served back to other teachers' browsers, so allowing
 * either one would put a stored-XSS payload inside a trusted origin — one
 * teacher's "worksheet" becomes script execution in the principal's session,
 * where the session cookie lives. There is no legitimate kindergarten curriculum
 * need for an `.html`/`.svg` attachment, so the correct fix is to keep them out
 * of the allowlist entirely rather than to filter their contents: signature-based
 * sanitising of HTML is a well-known losing game.
 *
 * The same reasoning rejects `text/html`/`image/svg+xml` as *declared* types
 * (MIME_NOT_ALLOWED) and rejects payloads that are visibly markup at byte 0
 * (HTML_NOT_ALLOWED), including when they are renamed `.txt`.
 *
 * HONEST LIMITATION
 * -----------------
 * `head` must be REAL BYTES read by whoever calls this. When the caller is the
 * browser that also uploaded the file, the `head` it sends is a client assertion
 * too, and this check degrades to "the client claims the file starts with PDF
 * magic". Making it authoritative requires the bytes to be read server-side —
 * either by uploading through the server or by re-reading the stored object after
 * upload. That requires an object-storage backend that can read the stored bytes
 * (see `server/modules/files/object-storage.ts`), and this deployment has none;
 * see `registerFile()` in resources.service.ts.
 */

/** Maximum length of a sanitised file name, extension included. */
export const MAX_FILENAME_LENGTH = 200;
/** Returned by `sanitizeFileName` when nothing usable survives sanitisation. */
export const FALLBACK_FILENAME = 'unnamed-file';

/** Default upload ceiling: 50 MB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Hard ceiling. A configured value above this is clamped, never honoured. */
export const HARD_CAP_UPLOAD_BYTES = 200 * 1024 * 1024;
/** Environment variable overriding the ceiling. */
export const UPLOAD_MAX_BYTES_ENV = 'UPLOAD_MAX_BYTES';

/** Enough to identify every accepted format (webp/mp4 need 12 bytes). */
export const SNIFF_BYTES = 512;

/**
 * Effective upload ceiling.
 *
 * A too-large value is clamped to the hard cap (documented behaviour, reported
 * by the caller); an unparseable value throws, because silently falling back to
 * the default would leave an operator believing their limit was applied.
 */
export function maxUploadBytes(): number {
  const raw = process.env[UPLOAD_MAX_BYTES_ENV];
  if (raw === undefined || raw === '') return DEFAULT_MAX_UPLOAD_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${UPLOAD_MAX_BYTES_ENV} must be a positive number of bytes; got "${raw}"`,
    );
  }
  return Math.min(Math.floor(parsed), HARD_CAP_UPLOAD_BYTES);
}

// ---------------------------------------------------------------------------
// 1. name sanitisation
// ---------------------------------------------------------------------------

/**
 * Characters that are removed from a file name.
 *
 * Kept deliberately narrow: Unicode letters (including CJK, which this platform
 * genuinely needs for 教案/绘本 names), digits, spaces and ordinary punctuation
 * survive untouched. What is removed is only what is dangerous in a path or a
 * response header:
 *   * C0/C1 control characters (including NUL, CR and LF);
 *   * both path separators, in both directions;
 *   * the Windows-reserved set `< > : " | ? *` plus the quote characters;
 *   * the Unicode line/paragraph separators, which some log and header parsers
 *     treat as line breaks.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const UNSAFE_CHARS = /[\\/<>:"|?*`'"\u2028\u2029]/g;

/**
 * Reduce an arbitrary client-supplied name to something that is safe to store,
 * safe to put in a header and safe to join onto a directory.
 *
 * Steps, in order:
 *   1. drop NUL and every other control character;
 *   2. keep the LAST path component only, splitting on BOTH `/` and `\`, so
 *      `../../etc/passwd` and `..\..\windows\system32` both collapse to their
 *      final segment instead of being passed through;
 *   3. remove characters that are unsafe in a path/header;
 *   4. strip leading dots, so no hidden file (`.htaccess`, `.env`) can be created;
 *   5. collapse internal whitespace runs and trim;
 *   6. reject a name that is only dots (`..`, `...`, `.`);
 *   7. enforce the length limit while PRESERVING the extension — the extension is
 *      what the allowlist reasons about, so truncating it away would change the
 *      file's type as far as every later check is concerned;
 *   8. return an ASCII-safe fallback when nothing usable is left.
 *
 * Never throws: a hostile name is expected input, so it is handled, not raised.
 */
export function sanitizeFileName(rawName: unknown): string {
  if (typeof rawName !== 'string') return FALLBACK_FILENAME;

  // (1) control / NUL characters
  let name = rawName.replace(CONTROL_CHARS, '');

  // (2) last path component only. Splitting on both separators is what defeats
  //     the Windows form on a POSIX server and vice versa.
  const segments = name.split(/[\\/]+/);
  name = segments[segments.length - 1] ?? '';

  // (3) unsafe characters
  name = name.replace(UNSAFE_CHARS, '');

  // (4) no hidden files. Done AFTER step 3 so that `..` is already visible as
  //     dots-only and handled by (6).
  name = name.replace(/^\.+/, '');

  // (5) whitespace: collapse runs, trim ends
  name = name.replace(/\s+/g, ' ').trim();

  // (6) dots only, or empty
  if (name.length === 0 || /^\.+$/.test(name)) return FALLBACK_FILENAME;

  // (7) length limit, extension preserved
  if (name.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    // `dot > 0` so a name that IS an extension (`".pdf"`) is not split into an
    // empty stem plus a whole-name "extension".
    const ext = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const room = MAX_FILENAME_LENGTH - ext.length;
    if (room <= 0) {
      // Pathological: the "extension" alone exceeds the limit. Keep a safe prefix
      // of it rather than returning something longer than the limit.
      return `${stem.slice(0, 20)}${ext.slice(0, MAX_FILENAME_LENGTH - 20)}`;
    }
    const trimmedStem = stem.slice(0, room).replace(/\s+$/, '');
    name = trimmedStem.length > 0 ? `${trimmedStem}${ext}` : `${FALLBACK_FILENAME}${ext}`;
  }

  // (8) final guard: sanitisation must never yield an empty string
  return name.length > 0 ? name : FALLBACK_FILENAME;
}

/**
 * Is a STORED path (e.g. `resources.file_path`) a safe BUCKET-RELATIVE key?
 *
 * Rejects:
 *   * NUL and control characters;
 *   * any `..` segment — the actual ascent primitive, in both separator styles;
 *   * any `.` segment (normalisation bait);
 *   * ANY leading separator (`/` or `\`), i.e. an absolute path;
 *   * a Windows drive prefix (`C:\…`) or UNC prefix (`\\server\share`);
 *   * a leading `~` (home expansion);
 *   * percent-encoded traversal (`%2e%2e`, `%2f`, `%5c`), so a value that is
 *     decoded later cannot turn into traversal after the check;
 *   * a trailing separator (an empty basename surprises every consumer);
 *   * empty input and anything longer than the column that stores it.
 *
 * WHY A LEADING SEPARATOR IS REJECTED — AND WHAT TO DO ABOUT THE PLATFORM'S
 * REAL KEY SHAPE (read this before "fixing" either side)
 * ------------------------------------------------------
 * A leading separator makes the path ABSOLUTE, and whether that is dangerous
 * depends entirely on how a consumer combines the value:
 *
 *     path.join('/bucket', '/etc/passwd')    -> '/bucket/etc/passwd'   (stays in)
 *     path.resolve('/bucket', '/etc/passwd') -> '/etc/passwd'          (escapes)
 *
 * A predicate that answers "is this value safe?" cannot know which of those a
 * future caller will write, so it must not answer `true` for a value that is only
 * safe under one of them. Accepting `/etc/passwd` while rejecting `//etc/passwd`
 * was an inconsistency, not a policy, and it made the function's name a lie for
 * anything absolute. Absolute input is therefore refused here, full stop.
 *
 * That alone would break REAL data in this repository: the seeded curriculum
 * stores storybook covers as
 *
 *     /curriculum-resources/prek-english-covers/1876907126277273.jpg
 *
 * (see seed-curriculum.sql) — a leading slash is the PLATFORM'S NORMAL SHAPE for
 * an object key. The answer is NOT to loosen this predicate; it is to normalise
 * the platform's shape explicitly, at the boundary, with
 * `toBucketRelativePath()` below — which is exactly what the platform's own
 * `parseFilePath()` does (`path.replace(/^\/+/, '')`) before it uses a stored key.
 * Validation stays strict; normalisation becomes a named, tested, visible step.
 *
 * A consumer that turns a stored value into a LOCAL filesystem path must still
 * take the BASENAME and sanitise it (see `ResourcesService.coverFileNameFrom`):
 * normalisation makes a leading slash irrelevant, taking the basename is what
 * makes the value harmless.
 */
export function isPathTraversalSafe(storedPath: unknown): boolean {
  if (typeof storedPath !== 'string') return false;
  if (storedPath.length === 0 || storedPath.length > 500) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(storedPath)) return false;
  if (/^[a-zA-Z]:/.test(storedPath)) return false;
  // Any leading backslash, and doubled leading separators, are not platform key
  // shapes. A SINGLE leading '/' is deliberately allowed — see the note above.
  if (storedPath.startsWith('\\') || storedPath.startsWith('//')) return false;
  if (storedPath.startsWith('~')) return false;
  if (/%2e|%2f|%5c/i.test(storedPath)) return false;

  const segments = storedPath.split(/[\\/]+/);
  // An empty FIRST segment means the value began with a separator, i.e. it is
  // absolute and not a bucket-relative key. (`//` and `\\\\` are already rejected
  // above; this catches the single-separator forms `/etc/passwd` and
  // `\\etc\\passwd`, plus the degenerate `/` and `\\`.)
  if (segments[0] === '') return false;
  if (segments.some((s) => s === '..' || s === '.')) return false;
  // A trailing separator would make the last segment empty; reject it so callers
  // cannot be surprised by an empty basename.
  if (segments[segments.length - 1] === '') return false;

  return true;
}

/**
 * Normalise a STORED platform object key into the bucket-relative form that
 * `isPathTraversalSafe()` accepts — or return `null` when it cannot be made safe.
 *
 * WHY THIS IS A SEPARATE, EXPLICIT STEP
 * The platform's real keys look absolute (`/curriculum-resources/…`), while this
 * module's contract is that a stored path is bucket-relative. Rather than weaken
 * the predicate to accommodate one shape, the conversion lives here: named,
 * unit-tested, and applied only by callers that KNOW the value is an object key
 * (not a filesystem path). It mirrors the platform's own `parseFilePath()`,
 * which strips leading slashes before using a stored key.
 *
 * Exactly ONE leading separator is removed. That matters:
 *   * `/curriculum-resources/x.jpg` -> `curriculum-resources/x.jpg`   (accepted)
 *   * `//host/share/x`              -> `/host/share/x` -> rejected by the
 *     predicate (still absolute, and UNC-shaped), so a doubled separator is NOT
 *     silently laundered into a relative key;
 *   * `\\host\share`                -> still leading-backslash -> rejected;
 *   * `/`, `\`, `''`, `'..'`, `C:\x`, `~/.ssh`, `a/../b`, `a\u0000b` -> null.
 *
 * Returns the normalised key on success, so a caller must USE the return value:
 * persisting the original string would re-introduce the absolute form.
 */
export function toBucketRelativePath(storedPath: unknown): string | null {
  if (typeof storedPath !== 'string') return null;
  if (storedPath.length === 0) return null;

  const withoutOneLeadingSeparator = /^[/\\]/.test(storedPath)
    ? storedPath.slice(1)
    : storedPath;

  // A value that was only a separator (`/`, `\`) becomes empty here, and a value
  // that is only whitespace is not a usable object key either. (The PREDICATE
  // still accepts whitespace: it answers "is this safe?", and `'   '` cannot
  // escape anything. Requiring USABLE content is this function's job.)
  if (withoutOneLeadingSeparator.trim().length === 0) return null;
  if (!isPathTraversalSafe(withoutOneLeadingSeparator)) return null;

  return withoutOneLeadingSeparator;
}

// ---------------------------------------------------------------------------
// 2. magic-byte sniffing
// ---------------------------------------------------------------------------

/**
 * The type actually present in the leading bytes. A *family*, not a MIME type:
 * DOCX/XLSX/PPTX are ZIP containers and cannot be told apart from a plain ZIP by
 * magic bytes alone (that needs the central directory), so all four share the
 * `zip` family and are validated against it.
 */
export type DetectedKind =
  | 'pdf'
  | 'zip'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'ole2'
  | 'webp'
  | 'ftyp'
  | 'mp3'
  | 'html'
  | 'text'
  | 'unknown';

function toBuffer(head: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(head)) return head;
  if (typeof head === 'string') return Buffer.from(head, 'binary');
  return Buffer.from(head);
}

function hasAt(buf: Buffer, offset: number, bytes: number[] | string): boolean {
  const sig = typeof bytes === 'string' ? Buffer.from(bytes, 'binary') : Buffer.from(bytes);
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Decode as UTF-8, tolerating a multibyte character cut off at the end. */
function decodesAsUtf8(buf: Buffer): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let drop = 0; drop <= 3 && drop < buf.length; drop += 1) {
    try {
      decoder.decode(buf.subarray(0, buf.length - drop));
      return true;
    } catch {
      /* try a shorter slice */
    }
  }
  return false;
}

/**
 * Identify the leading bytes.
 *
 * Signature checks come first: a PDF whose first line happens to look like text
 * must be reported as a PDF, not as text. Markup detection is second and the
 * UTF-8 text fallback last.
 */
export function sniffMagicBytes(head: Buffer | Uint8Array | string): DetectedKind {
  const buf = toBuffer(head);
  if (buf.length === 0) return 'unknown';

  // --- binary signatures ---------------------------------------------------
  if (hasAt(buf, 0, '%PDF-')) return 'pdf';
  if (hasAt(buf, 0, [0x50, 0x4b, 0x03, 0x04])) return 'zip'; // PK\x03\x04
  if (hasAt(buf, 0, [0x50, 0x4b, 0x05, 0x06])) return 'zip'; // PK\x05\x06 (empty archive)
  if (hasAt(buf, 0, [0x50, 0x4b, 0x07, 0x08])) return 'zip'; // PK\x07\x08 (spanned)
  if (hasAt(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (hasAt(buf, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (hasAt(buf, 0, 'GIF87a') || hasAt(buf, 0, 'GIF89a')) return 'gif';
  // OLE2 compound document: legacy .doc / .xls / .ppt
  if (hasAt(buf, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2';
  // RIFF....WEBP
  if (hasAt(buf, 0, 'RIFF') && hasAt(buf, 8, 'WEBP')) return 'webp';
  // ISO base media file (MP4 / MOV / M4A): a size field, then 'ftyp' at offset 4.
  if (hasAt(buf, 4, 'ftyp')) return 'ftyp';
  // MP3: an ID3 tag, or a raw MPEG audio frame sync.
  if (hasAt(buf, 0, 'ID3')) return 'mp3';
  if (
    hasAt(buf, 0, [0xff, 0xfb]) ||
    hasAt(buf, 0, [0xff, 0xfa]) ||
    hasAt(buf, 0, [0xff, 0xf3]) ||
    hasAt(buf, 0, [0xff, 0xf2]) ||
    hasAt(buf, 0, [0xff, 0xf9])
  ) {
    return 'mp3';
  }

  // --- markup --------------------------------------------------------------
  // Anything that a browser would parse as HTML/SVG. Checked as a *prefix* of the
  // visible content so a renamed `.txt` full of markup is caught: the extension
  // and the declared MIME are claims, the bytes are not.
  //
  // The UTF-8 BOM must be stripped at the BYTE level, before decoding. Decoding
  // latin1 first turns the three BOM bytes into the characters 'ï»¿', which no
  // amount of string-level '\uFEFF' stripping removes — that is exactly how a
  // BOM-prefixed HTML file was classified as `text` and accepted as a .txt
  // (found by this module's own test suite, then confirmed as a real bypass).
  let markupProbe = buf.subarray(0, 512);
  if (
    markupProbe.length >= 3 &&
    markupProbe[0] === 0xef &&
    markupProbe[1] === 0xbb &&
    markupProbe[2] === 0xbf
  ) {
    markupProbe = markupProbe.subarray(3);
  }
  const prefix = markupProbe
    .toString('latin1')
    .replace(/^\uFEFF/, '')
    .replace(/^[\s\u0000]+/, '')
    .toLowerCase();
  if (
    prefix.startsWith('<!doctype html') ||
    prefix.startsWith('<html') ||
    prefix.startsWith('<head') ||
    prefix.startsWith('<body') ||
    prefix.startsWith('<script') ||
    prefix.startsWith('<svg') ||
    prefix.startsWith('<?xml-stylesheet')
  ) {
    return 'html';
  }

  // --- plain text ----------------------------------------------------------
  // No NUL bytes and it decodes as UTF-8: treat as text. UTF-16 is deliberately
  // NOT accepted: it is full of NUL bytes, it is not what any of the allowed text
  // formats uses, and accepting it would require trusting a BOM to reinterpret
  // the payload.
  if (!buf.includes(0x00) && decodesAsUtf8(buf)) return 'text';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// 3. allowlist and upload validation
// ---------------------------------------------------------------------------

export interface AllowedType {
  extension: string;
  /** Declared MIME types accepted for this extension (canonical form). */
  mimeTypes: string[];
  /** Byte families that may legitimately carry this extension. */
  kinds: DetectedKind[];
  /** Human label used in rejection messages. */
  label: string;
}

/**
 * The allowlist for a kindergarten curriculum platform.
 *
 * Every entry is a *document, image, plain-text or media* format that teachers
 * actually attach. Executables, scripts, HTML/SVG, and archive-oriented formats
 * beyond ZIP are absent on purpose. `.zip` is allowed because resource packs
 * (素材包) are a real workflow; it is a stored container, never served inline.
 */
export const ALLOWED_TYPES: AllowedType[] = [
  { extension: 'pdf', mimeTypes: ['application/pdf'], kinds: ['pdf'], label: 'PDF' },
  {
    extension: 'docx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    kinds: ['zip'],
    label: 'Word (docx)',
  },
  { extension: 'doc', mimeTypes: ['application/msword'], kinds: ['ole2'], label: 'Word (doc)' },
  {
    extension: 'xlsx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    kinds: ['zip'],
    label: 'Excel (xlsx)',
  },
  { extension: 'xls', mimeTypes: ['application/vnd.ms-excel'], kinds: ['ole2'], label: 'Excel (xls)' },
  {
    extension: 'pptx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    kinds: ['zip'],
    label: 'PowerPoint (pptx)',
  },
  {
    extension: 'ppt',
    mimeTypes: ['application/vnd.ms-powerpoint'],
    kinds: ['ole2'],
    label: 'PowerPoint (ppt)',
  },
  { extension: 'jpg', mimeTypes: ['image/jpeg'], kinds: ['jpeg'], label: 'JPEG' },
  { extension: 'jpeg', mimeTypes: ['image/jpeg'], kinds: ['jpeg'], label: 'JPEG' },
  { extension: 'png', mimeTypes: ['image/png'], kinds: ['png'], label: 'PNG' },
  { extension: 'gif', mimeTypes: ['image/gif'], kinds: ['gif'], label: 'GIF' },
  { extension: 'webp', mimeTypes: ['image/webp'], kinds: ['webp'], label: 'WebP' },
  { extension: 'txt', mimeTypes: ['text/plain'], kinds: ['text'], label: 'Text' },
  { extension: 'md', mimeTypes: ['text/markdown'], kinds: ['text'], label: 'Markdown' },
  { extension: 'mp4', mimeTypes: ['video/mp4'], kinds: ['ftyp'], label: 'MP4' },
  { extension: 'mov', mimeTypes: ['video/quicktime'], kinds: ['ftyp'], label: 'QuickTime' },
  { extension: 'mp3', mimeTypes: ['audio/mpeg'], kinds: ['mp3'], label: 'MP3' },
  { extension: 'zip', mimeTypes: ['application/zip'], kinds: ['zip'], label: 'ZIP' },
];

const TYPE_BY_EXTENSION = new Map(ALLOWED_TYPES.map((t) => [t.extension, t]));

export const ALLOWED_EXTENSIONS: string[] = ALLOWED_TYPES.map((t) => t.extension);

const ALLOWED_MIME_TYPES = new Set(ALLOWED_TYPES.flatMap((t) => t.mimeTypes));

/**
 * MIME aliases normalised to the canonical form. Browsers and OSes really do send
 * these (`image/jpg` from older Windows, `image/pjpeg` from IE-era code); mapping
 * them keeps a legitimate upload working without widening the allowlist, because
 * the alias is normalised BEFORE it is checked.
 */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-citrix-png': 'image/png',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'text/x-markdown': 'text/markdown',
  'text/x-web-markdown': 'text/markdown',
  'application/x-pdf': 'application/pdf',
  'application/x-zip-compressed': 'application/zip',
};

/** Strip parameters (`; charset=utf-8`), lowercase, trim, apply aliases. */
export function normalizeMimeType(rawMimeType: unknown): string {
  if (typeof rawMimeType !== 'string') return '';
  const base = rawMimeType.split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
}

export type UploadRejectionCode =
  | 'EMPTY_FILE'
  | 'TOO_LARGE'
  | 'INVALID_FILENAME'
  | 'EXTENSION_NOT_ALLOWED'
  | 'MIME_NOT_ALLOWED'
  | 'MIME_EXTENSION_MISMATCH'
  | 'MAGIC_BYTES_MISSING'
  | 'HTML_NOT_ALLOWED'
  | 'TYPE_MISMATCH';

export interface UploadValidationInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** The real leading bytes of the file. */
  head: Buffer | Uint8Array | string;
}

export type UploadValidationResult =
  | {
      ok: true;
      /** The sanitised name — the caller MUST persist THIS, not the input. */
      fileName: string;
      extension: string;
      mimeType: string;
      kind: DetectedKind;
      sizeBytes: number;
    }
  | { ok: false; code: UploadRejectionCode; message: string };

function reject(code: UploadRejectionCode, message: string): UploadValidationResult {
  return { ok: false, code, message };
}

/**
 * Decide whether an upload is acceptable.
 *
 * Checks, in order (each one is a real rejection, none is advisory):
 *   1. size 0, or no bytes at all                  -> EMPTY_FILE
 *   2. size above the configured ceiling           -> TOO_LARGE
 *   3. nothing usable left after sanitisation      -> INVALID_FILENAME
 *   4. extension present and in the allowlist      -> EXTENSION_NOT_ALLOWED
 *   5. declared MIME in the allowlist              -> MIME_NOT_ALLOWED
 *   6. declared MIME is a valid type for the ext   -> MIME_EXTENSION_MISMATCH
 *   7. no leading bytes supplied                   -> MAGIC_BYTES_MISSING
 *   8. bytes are not markup                        -> HTML_NOT_ALLOWED
 *   9. bytes match the declared type (ANTI-SPOOF)  -> TYPE_MISMATCH
 *
 * (9) is the check that makes the allowlist mean something: without it, the
 * allowlist only constrains what the client SAYS the file is.
 */
export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return reject('EMPTY_FILE', '文件大小非法');
  }

  const headBuffer = input.head === undefined || input.head === null
    ? Buffer.alloc(0)
    : toBuffer(input.head);

  // (1) empty file
  if (sizeBytes === 0) {
    return reject('EMPTY_FILE', '文件为空（0 字节），不允许上传空文件');
  }

  // (1b) A non-empty file with no bytes to inspect cannot be validated. Reported
  //      separately from EMPTY_FILE so the reason is not misattributed.
  if (headBuffer.length === 0) {
    return reject(
      'MAGIC_BYTES_MISSING',
      '未提供文件头部字节，无法校验文件的真实类型',
    );
  }

  // (2) size ceiling. A broken configuration throws here on purpose: it must not
  //     silently disable the limit.
  const limit = maxUploadBytes();
  if (sizeBytes > limit) {
    const limitMb = (limit / (1024 * 1024)).toFixed(1);
    return reject('TOO_LARGE', `文件超过大小上限 ${limitMb} MB`);
  }

  // (3) name
  const candidate = typeof input.fileName === 'string' ? input.fileName : '';
  const fileName = sanitizeFileName(candidate);
  if (candidate.trim().length === 0 || fileName === FALLBACK_FILENAME) {
    return reject('INVALID_FILENAME', '文件名非法或为空');
  }

  // (4) extension. The dot must not be the first character — that would be a
  //     hidden file, which sanitisation already removed.
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const allowed = extension ? TYPE_BY_EXTENSION.get(extension) : undefined;
  if (!allowed) {
    return reject(
      'EXTENSION_NOT_ALLOWED',
      `不支持的文件扩展名：${extension ? `.${extension}` : '(无扩展名)'}。` +
        `允许：${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(' ')}`,
    );
  }

  // (5) declared MIME
  const mimeType = normalizeMimeType(input.mimeType);
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) || !ALLOWED_MIME_TYPES.has(mimeType)) {
    return reject(
      'MIME_NOT_ALLOWED',
      `不支持的文件类型声明：${mimeType || '(空)'}`,
    );
  }

  // (6) MIME must belong to THIS extension (`.doc` may not claim to be an Excel file)
  if (!allowed.mimeTypes.includes(mimeType)) {
    return reject(
      'MIME_EXTENSION_MISMATCH',
      `扩展名 .${extension} 与声明的类型 ${mimeType} 不一致`,
    );
  }

  // (7) actual bytes
  const kind = sniffMagicBytes(headBuffer.subarray(0, SNIFF_BYTES));

  // (8) markup can never be accepted, whatever it claims to be
  if (kind === 'html') {
    return reject(
      'HTML_NOT_ALLOWED',
      '内容为 HTML/SVG 标记：此类文件会在浏览器中以脚本执行（存储型 XSS），一律拒绝',
    );
  }

  if (kind === 'unknown') {
    return reject(
      'TYPE_MISMATCH',
      `文件内容无法识别为 ${allowed.label}（声明的类型是 ${mimeType}）`,
    );
  }

  // (9) anti-spoofing: the bytes must be a family this type can legitimately have
  if (!allowed.kinds.includes(kind)) {
    return reject(
      'TYPE_MISMATCH',
      `文件内容与声明的类型不符：声明 ${mimeType}（.${extension}），实际字节为 ${kind}。` +
        '拒绝保存被改名的文件',
    );
  }

  return { ok: true, fileName, extension, mimeType, kind, sizeBytes };
}

/** Is one of the accepted file names? Used by tests and by operator tooling. */
export function isAllowedFileName(fileName: string): boolean {
  const sanitized = sanitizeFileName(fileName);
  const dot = sanitized.lastIndexOf('.');
  if (dot <= 0) return false;
  return TYPE_BY_EXTENSION.has(sanitized.slice(dot + 1).toLowerCase());
}
