/**
 * tests/curriculum-tokens.test.mjs — canonical vocabulary + boundary normaliser
 * ===========================================================================
 * Run with:  npm test   (or: node --test tests/curriculum-tokens.test.mjs)
 *
 * WHAT THIS PROTECTS
 *   167 of the 347 seeded resources were UNREACHABLE through the UI, and every
 *   layer reported success while it happened:
 *
 *     * `client/.../MontessoriPage.tsx` linked to `/prek/montessori/practical-life`
 *       and `/prek/montessori/english-language`, and SubjectPage forwarded the
 *       route segment to `GET /api/resources?subSubject=practical-life`. The
 *       `resources.sub_subject` column holds `practical_life`. 80 + 43 = 123 rows
 *       matched nothing and the page rendered "暂无资源" with HTTP 200.
 *     * `client/.../EnglishPage.tsx` asked for `theme=Myself` … `theme=Around the
 *       World`; the column holds `主题1：我自己` … `主题6：环游世界`. All 44 K
 *       English rows were unreachable, every theme card read "0 个资源".
 *
 *   Both were a missing shared vocabulary, so these tests check the vocabulary
 *   itself rather than one symptom:
 *
 *     1. the canonical tokens still agree with what the DATABASE stores and with
 *        the seed file — derived from the real files and the real database, not
 *        from a list typed into this test;
 *     2. every spelling that was verified to exist in the shipped code or in the
 *        data still resolves (the backward-compatibility contract);
 *     3. an unknown spelling is REJECTED (null), never silently accepted or
 *        defaulted — the behaviour that turned a typo into an empty page;
 *     4. the tokens the previous code used to build `GET /api/curriculum/structure`
 *        are unchanged, so the refactor that introduced `@shared/curriculum` did
 *        not alter the API contract.
 *
 * WHY IT IMPORTS THE .ts SOURCES DIRECTLY
 *   Node >= 22.18 strips TypeScript types natively, so these tests exercise the
 *   same module the server and the browser bundle use. The alias loader is needed
 *   because `curriculum.data.ts` imports `@shared/curriculum` (a bundler alias).
 *
 * DATABASE PART
 *   The strongest assertions need the live database. When `DATABASE_URL` /
 *   `AUTHZ_TEST_DB` / `SUDA_DATABASE_URL` is set they run; when it is not, that
 *   group is reported as SKIPPED **loudly** with the reason, and the file-derived
 *   assertions still run. A green run must never mean "the database half was
 *   quietly not checked".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/ts-alias-loader.mjs', import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const curriculum = await import(
  new URL('../shared/curriculum.ts', import.meta.url).href
);
const curriculumData = await import(
  new URL('../server/modules/curriculum/curriculum.data.ts', import.meta.url).href
);

const {
  CURRICULUM,
  FOLDER_DEFINITIONS,
  FOLDER_TYPES,
  THEME_SETS,
  foldToken,
  normalizeFolderType,
  normalizeProgram,
  normalizeSubject,
  normalizeSubSubject,
  normalizeTheme,
  themeDbValue,
  findNode,
  subSubjectNodes,
} = curriculum;
const { PROGRAM_STRUCTURES, FOLDER_DEFINITIONS: SERVER_FOLDER_DEFINITIONS } = curriculumData;

const SEED_FILE = join(ROOT, 'server', 'database', 'seed-curriculum.sql');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Read every (program, subject, sub_subject, folder_type, theme) combination the
 * seed file inserts. This is the DATA side of the contract, extracted from the
 * real file so the test cannot drift from it.
 *
 * Parsed with a real (small) SQL string lexer rather than a regex, because the
 * seed data contains escaped quotes (`'Drawing one''s attention'`) that a naive
 * `'([^']*)'` reads as the end of the literal. A regex that silently mis-parses
 * would let this test pass while checking the wrong values, which is worse than
 * not checking at all — so an unreadable INSERT is a hard failure, not a skip.
 *
 * Two INSERT shapes exist in the file: one carries `sub_subject` and one carries
 * `theme` in its place, and the column ORDER differs between them.
 */
function parseSeedCombinations() {
  const src = readFileSync(SEED_FILE, 'utf8');
  const statements = src.split('INSERT INTO resources').slice(1);
  const rows = [];

  for (const stmt of statements) {
    const selectAt = stmt.indexOf('SELECT');
    assert.ok(selectAt >= 0, `seed INSERT without a SELECT:\n${stmt.slice(0, 200)}`);

    // Read the COLUMN LIST rather than guessing the shape. The file contains two
    // different column orders (one has `sub_subject` where the other has `theme`),
    // and a previous version of this parser guessed by looking for the text
    // `sub_subject` in the statement — which also matches the row-level
    // `WHERE r.sub_subject = …` predicate, so it mis-detected the shape and read
    // titles as programs. Deriving the order from the header is unambiguous.
    const header = stmt.slice(0, selectAt);
    const headerMatch = /\(([^)]*)\)/.exec(header);
    assert.ok(headerMatch, `seed INSERT without a column list:\n${stmt.slice(0, 200)}`);
    const columns = headerMatch[1].split(',').map((c) => c.trim());

    // Only the SELECT LIST is of interest. Everything after the top-level FROM is
    // the INSERT…SELECT's source clause and its predicates, which also contain
    // identifiers and literals (`t.id`, `t.wecom_user_id`, `r.sub_subject`,
    // `'system_initializer'…`). Reading those would misalign columns.
    const afterSelect = stmt.slice(selectAt + 'SELECT'.length);
    const fromAt = findTopLevelKeyword(afterSelect, 'FROM');
    const selectList = fromAt === -1 ? afterSelect : afterSelect.slice(0, fromAt);

    const literals = readTopLevelLiterals(selectList);
    assert.equal(
      literals.length,
      columns.length,
      `seed INSERT has ${columns.length} columns but ${literals.length} values:\n${stmt.slice(0, 220)}`,
    );

    const row = {};
    columns.forEach((name, i) => { row[name] = literals[i]; });

    rows.push({
      program: row.program,
      subject: row.subject,
      subSubject: row.sub_subject ?? null,
      folderType: row.folder_type,
      theme: row.theme ?? null,
    });
  }
  return rows;
}


// ---------------------------------------------------------------------------
// small character predicates
// ---------------------------------------------------------------------------
// Written as explicit comparisons rather than `/[...]/.test(ch)` on purpose:
// those one-liners are built from a multibyte source file, and a regex built from
// a multibyte character compiles to an EMPTY character class that matches
// nothing — silently changing control flow instead of failing. That is exactly
// what happened while writing this parser.
function isAsciiLetter(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAsciiDigit(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

/**
 * Index of the first top-level occurrence of a SQL keyword, or -1.
 * Top-level = not inside quotes and not inside parentheses, so a `FROM` inside a
 * JSON description string or a function call is not mistaken for the clause.
 */
function findTopLevelKeyword(text, keyword) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(') { depth += 1; i += 1; continue; }
    if (ch === ')') { depth -= 1; i += 1; continue; }
    if (depth === 0 && isAsciiLetter(ch)) {
      let k = i;
      while (k < text.length && (isAsciiLetter(text[k]) || text[k] === '_')) k += 1;
      const word = text.slice(i, k);
      if (word.toUpperCase() === keyword.toUpperCase()) return i;
      i += word.length;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Read the top-level items of a SELECT list.
 *
 * The list is split on TOP-LEVEL commas (a comma inside quotes or inside
 * parentheses belongs to the item), and each item is then classified:
 *   * `'…'`  -> the literal's value, with `''` decoded back to a single quote;
 *   * `NULL` -> null;
 *   * anything else (an identifier such as `t.id`, a number, a function call) ->
 *     null, because the test cannot read it and does not need to. It still counts
 *     as an item, which is what keeps the value list aligned with the column list.
 *
 * Splitting on commas rather than pushing as it walks is deliberate: it makes the
 * item count structurally equal to `commas + 1`, so a mis-parse shows up as a
 * count mismatch instead of silently dropping an item. The first version of this
 * parser pushed while walking and lost an item, which the column-count assertion
 * then caught — this shape makes that class of bug impossible.
 */
function readTopLevelLiterals(text) {
  const items = [];
  let current = '';
  let depth = 0;
  let i = 0;

  const push = () => {
    items.push(current.trim());
    current = '';
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "'") {
      // Keep the quotes in place so the item is still recognisable as a literal.
      current += ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { current += "''"; i += 2; continue; }
        current += text[i];
        if (text[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }

    if (ch === '(') { depth += 1; current += ch; i += 1; continue; }
    if (ch === ')') { depth -= 1; current += ch; i += 1; continue; }

    if (ch === ',' && depth === 0) { push(); i += 1; continue; }

    current += ch;
    i += 1;
  }
  if (current.trim() !== '') push();

  return items.map((item) => {
    if (item.length >= 2 && item.startsWith("'") && item.endsWith("'")) {
      return item.slice(1, -1).split("''").join("'");
    }
    if (item.toUpperCase() === 'NULL') return null;
    return null;
  });
}

const SEED_ROWS = parseSeedCombinations();

function resolveDbUrl() {
  const url =
    process.env.AUTHZ_TEST_DB ||
    process.env.DATABASE_URL ||
    process.env.SUDA_DATABASE_URL ||
    process.env.MIGRATION_DATABASE_URL;
  return url && url.trim() !== '' ? url : null;
}

// ---------------------------------------------------------------------------
// 1. the vocabulary itself
// ---------------------------------------------------------------------------

describe('canonical curriculum vocabulary', () => {
  test('is the only declaration: the server tree derives from it', () => {
    // PROGRAM_STRUCTURES is what GET /api/curriculum/structure returns. It must be
    // a pure projection of CURRICULUM — same programs, same subjects, same
    // children — or the API and the vocabulary have drifted apart again.
    assert.deepEqual(
      PROGRAM_STRUCTURES.map((p) => p.program),
      CURRICULUM.map((p) => p.program),
    );

    for (const program of CURRICULUM) {
      const served = PROGRAM_STRUCTURES.find((p) => p.program === program.program);
      assert.ok(served, `structure is missing program ${program.program}`);
      assert.deepEqual(
        served.subjects.map((s) => s.key),
        program.subjects.map((s) => s.key),
      );
      for (const subject of program.subjects) {
        const servedSubject = served.subjects.find((s) => s.key === subject.key);
        assert.deepEqual(
          (servedSubject.children ?? []).map((c) => c.key),
          (subject.children ?? []).map((c) => c.key),
          `${program.program}/${subject.key} children drifted`,
        );
      }
    }
  });

  test('the API contract for paths and names is unchanged', () => {
    // Byte-for-byte the values the pre-refactor hand-written literal produced.
    // A path is now DERIVED from the token instead of typed next to it; this
    // asserts the derivation produced the same strings.
    assert.deepEqual(
      PROGRAM_STRUCTURES.map((p) => [p.program, p.name, p.nameEn]),
      [
        ['prek', 'Pre-K', 'Pre-K'],
        ['k', 'K', 'K'],
      ],
    );

    const prek = PROGRAM_STRUCTURES.find((p) => p.program === 'prek');
    assert.deepEqual(
      prek.subjects.map((s) => [s.key, s.path]),
      [
        ['virtue', 'virtue'],
        ['montessori', 'montessori'],
        ['physical_education', 'physical_education'],
      ],
    );
    const montessori = prek.subjects.find((s) => s.key === 'montessori');
    assert.deepEqual(
      montessori.children.map((c) => [c.key, c.path]),
      [
        ['practical_life', 'montessori/practical_life'],
        ['sensorial', 'montessori/sensorial'],
        ['math', 'montessori/math'],
        ['english_language', 'montessori/english_language'],
        ['chinese_language', 'montessori/chinese_language'],
        ['culture', 'montessori/culture'],
      ],
    );

    const k = PROGRAM_STRUCTURES.find((p) => p.program === 'k');
    const pe = k.subjects.find((s) => s.key === 'physical_education');
    assert.deepEqual(
      pe.children.map((c) => [c.key, c.path]),
      [
        ['pe_special', 'physical_education/pe_special'],
        ['sports', 'physical_education/sports'],
        ['rock_climbing', 'physical_education/rock_climbing'],
      ],
    );
  });

  test('folder types match the six the product defines, in order', () => {
    assert.deepEqual(FOLDER_TYPES, [
      'curriculum_outline',
      'weekly_plans',
      'courseware',
      'materials',
      'observation',
      'research_archive',
    ]);
    assert.deepEqual(
      SERVER_FOLDER_DEFINITIONS.map((f) => f.key),
      FOLDER_TYPES,
      'the server folder list must be the canonical list',
    );
    assert.deepEqual(
      FOLDER_DEFINITIONS.map((f) => f.nameEn),
      [
        'Curriculum Outline',
        'Weekly Lesson Plans',
        'Courseware & Demonstration',
        'Materials & Worksheets',
        'Observation & Assessment',
        'Teaching Research Archive',
      ],
    );
  });

  test('every seeded (program, subject, folder) triple resolves canonically', () => {
    assert.ok(SEED_ROWS.length > 300, `expected the seed file to hold the full dataset, got ${SEED_ROWS.length}`);

    const bad = [];
    for (const row of SEED_ROWS) {
      const program = normalizeProgram(row.program);
      if (program === null || program !== row.program) bad.push(`program ${row.program}`);
      const subject = program ? normalizeSubject(program, row.subject) : null;
      if (subject !== row.subject) bad.push(`subject ${row.program}/${row.subject}`);
      if (row.subSubject) {
        const sub = normalizeSubSubject(row.program, row.subject, row.subSubject);
        if (sub !== row.subSubject) {
          bad.push(`sub_subject ${row.program}/${row.subject}/${row.subSubject} -> ${sub}`);
        }
      }
      const folder = normalizeFolderType(row.folderType);
      if (folder !== row.folderType) bad.push(`folder_type ${row.folderType}`);
    }
    assert.deepEqual([...new Set(bad)], [], 'seeded values that are NOT canonical');
  });

  test('every seeded theme resolves to itself through the theme vocabulary', () => {
    const themed = SEED_ROWS.filter((r) => r.theme !== null && r.theme !== 'published' && r.theme !== 'S1' && r.theme !== 'S2');
    assert.ok(themed.length > 0, 'expected the seed file to contain themed rows');

    const bad = [];
    for (const row of themed) {
      const stored = themeDbValue(row.program, row.subject, row.theme);
      if (stored !== row.theme) {
        bad.push(`${row.program}/${row.subject} theme "${row.theme}" -> ${stored}`);
      }
    }
    assert.deepEqual(
      [...new Set(bad)],
      [],
      'a stored theme value must round-trip: it is the value the query compares against',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. backward compatibility: every spelling that existed must still work
// ---------------------------------------------------------------------------

describe('normalizeSubject / normalizeSubSubject accept every shipped spelling', () => {
  const SUB_CASES = [
    // [program, subject, raw, expected canonical token, where the spelling came from]
    ['prek', 'montessori', 'practical_life', 'practical_life', 'database + curriculum.data.ts'],
    ['prek', 'montessori', 'practical-life', 'practical_life', 'MontessoriPage link, SubjectPage label map'],
    ['prek', 'montessori', 'Practical Life', 'practical_life', 'display name'],
    ['prek', 'montessori', 'english_language', 'english_language', 'database'],
    ['prek', 'montessori', 'english-language', 'english_language', 'MontessoriPage link'],
    ['prek', 'montessori', 'chinese_language', 'chinese_language', 'database'],
    ['prek', 'montessori', 'chinese-language', 'chinese_language', 'MontessoriPage link'],
    ['prek', 'montessori', 'sensorial', 'sensorial', 'identical in every layer'],
    ['prek', 'montessori', 'math', 'math', 'identical in every layer'],
    ['prek', 'montessori', 'culture', 'culture', 'identical in every layer'],
    ['k', 'chinese', 'ancient_poetry', 'ancient_poetry', 'curriculum.data.ts'],
    ['k', 'chinese', 'ancient-poetry', 'ancient_poetry', 'ChinesePage link'],
    ['k', 'chinese', 'poetry', 'ancient_poetry', 'PermissionAdminPage tree key'],
    ['k', 'chinese', 'picture-books', 'picture_books', 'ChinesePage link'],
    ['k', 'chinese', 'drama', 'drama', 'identical'],
    ['k', 'chinese', 'stem', 'stem', 'identical'],
    ['k', 'english', 'reading_comprehension', 'reading_comprehension', 'EnglishPage tag'],
    ['k', 'english', 'language_skills', 'language_skills', 'EnglishPage tag'],
    ['k', 'physical_education', 'pe_special', 'pe_special', 'curriculum.data.ts'],
    ['k', 'physical_education', 'pe-special', 'pe_special', 'PEPage link'],
    ['k', 'physical_education', 'sports', 'sports', 'identical'],
    ['k', 'physical_education', 'rock_climbing', 'rock_climbing', 'identical'],
    ['k', 'physical_education', 'rock-climbing', 'rock_climbing', 'PEPage link'],
  ];

  for (const [program, subject, raw, expected, provenance] of SUB_CASES) {
    test(`"${raw}" under ${program}/${subject} -> ${expected}  (${provenance})`, () => {
      assert.equal(normalizeSubSubject(program, subject, raw), expected);
    });
  }

  test('a sub-subject is resolved INSIDE its subject, not globally', () => {
    // 'math' is a sub-subject of prek/montessori AND of k/english. Resolving it
    // without the subject would be a coin flip, so the subject is required and a
    // wrong pairing must fail rather than pick one.
    assert.equal(normalizeSubSubject('prek', 'montessori', 'math'), 'math');
    assert.equal(normalizeSubSubject('k', 'english', 'math'), 'math');
    assert.equal(normalizeSubSubject('prek', 'virtue', 'math'), null);
    assert.equal(normalizeSubSubject('k', 'chinese', 'math'), null);
    assert.equal(normalizeSubSubject('k', 'montessori', 'math'), null, 'that program has no montessori');
  });

  test("subject 'pe' is accepted as an alias of 'physical_education'", () => {
    // KHomePage / PreKHomePage card keys and the permission-matrix tree use 'pe';
    // the database, the DTO enum and the RBAC scope model use 'physical_education'.
    assert.equal(normalizeSubject('prek', 'pe'), 'physical_education');
    assert.equal(normalizeSubject('k', 'pe'), 'physical_education');
    assert.equal(normalizeSubject('k', 'physical_education'), 'physical_education');
  });

  test('case and separators do not matter, spelling does', () => {
    assert.equal(foldToken('Practical-Life'), 'practical_life');
    assert.equal(foldToken('  PRACTICAL_LIFE  '), 'practical_life');
    assert.equal(foldToken('practical life'), 'practical_life');
    assert.equal(normalizeSubSubject('prek', 'Montessori', 'Practical-Life'), 'practical_life');
  });
});

describe('normalizeTheme accepts every shipped spelling, per subject', () => {
  test('the six K English themes resolve from slug, English label and stored value', () => {
    // [route slug, English label, stored value, canonical token]
    // The slug uses hyphens (it is a URL segment and is kept stable for existing
    // links); the canonical token uses underscores. Both must resolve.
    const cases = [
      ['myself', 'Myself', '主题1：我自己', 'myself'],
      ['the-five-senses', 'The Five Senses', '主题2：五感', 'the_five_senses'],
      ['community-neighborhood', 'Community & Neighborhood', '主题3：社区与邻里', 'community_neighborhood'],
      ['the-natural-world', 'The Natural World', '主题4：自然世界', 'the_natural_world'],
      ['pbl-unit', 'PBL Unit', '主题5：项目式学习（PBL）', 'pbl_unit'],
      ['around-the-world', 'Around the World', '主题6：环游世界', 'around_the_world'],
    ];
    for (const [slug, label, stored, token] of cases) {
      assert.equal(normalizeTheme('k', 'english', slug), token, `slug ${slug}`);
      assert.equal(normalizeTheme('k', 'english', label), token, `label ${label}`);
      assert.equal(normalizeTheme('k', 'english', stored), token, `stored ${stored}`);
      assert.equal(normalizeTheme('k', 'english', token), token, `token ${token}`);
      assert.equal(themeDbValue('k', 'english', label), stored, `label -> stored ${label}`);
      assert.equal(themeDbValue('k', 'english', slug), stored, `slug -> stored ${slug}`);
    }
  });

  test('THE FIX: "Myself" now maps to the stored value, it does not pass through', () => {
    // This is the exact request the shipped EnglishPage used to send. Before the
    // fix the raw string went into `WHERE theme = 'Myself'` and matched 0 of 44
    // rows; now it is translated into the spelling those rows already hold.
    assert.equal(themeDbValue('k', 'english', 'Myself'), '主题1：我自己');
    assert.notEqual(themeDbValue('k', 'english', 'Myself'), 'Myself');
  });

  test('a Pre-K montessori theme resolves from its stored value', () => {
    assert.equal(normalizeTheme('prek', 'montessori', '动物'), 'culture_animals');
    assert.equal(themeDbValue('prek', 'montessori', '动物'), '动物');
    assert.equal(normalizeTheme('prek', 'montessori', '几何'), null, 'not a value in the data');
  });

  test('theme vocabularies do not leak across subjects', () => {
    // '动物' is a Pre-K montessori theme; asking for it under K English must fail
    // rather than match by string equality somewhere else.
    assert.equal(normalizeTheme('k', 'english', '动物'), null);
    assert.equal(normalizeTheme('k', 'virtue', 'myself'), null);
    assert.equal(normalizeTheme('prek', 'montessori', 'Myself'), null);
  });
});

// ---------------------------------------------------------------------------
// 3. unknown values FAIL — they are never silently accepted or defaulted
// ---------------------------------------------------------------------------

describe('unknown values are rejected, never silently defaulted', () => {
  const UNKNOWN = ['', '   ', 'nope', 'practical', 'practical_lif', 'physical-education-x', '../../etc/passwd', "'; drop table resources; --"];

  for (const raw of UNKNOWN) {
    test(`sub-subject ${JSON.stringify(raw)} -> null`, () => {
      assert.equal(normalizeSubSubject('prek', 'montessori', raw), null);
    });
    test(`theme ${JSON.stringify(raw)} -> null`, () => {
      assert.equal(normalizeTheme('k', 'english', raw), null);
    });
    test(`folder type ${JSON.stringify(raw)} -> null`, () => {
      assert.equal(normalizeFolderType(raw), null);
    });
  }

  test('a prefix of a real token is not a match (no fuzzy fallback)', () => {
    assert.equal(normalizeSubSubject('prek', 'montessori', 'practical'), null);
    assert.equal(normalizeSubSubject('prek', 'montessori', 'english'), null);
    assert.equal(normalizeSubject('k', 'eng'), null);
    assert.equal(normalizeTheme('k', 'english', 'the-five'), null);
  });

  test('"Math" resolves under k/english but a bare "Math" subject does not exist', () => {
    assert.equal(normalizeSubject('k', 'Math'), null, 'math is a sub-subject, not a subject of k');
    assert.equal(normalizeSubSubject('k', 'english', 'Math'), 'math');
  });

  test('normalizers do not throw on non-string input — they return null', () => {
    // Defensive: these are called with values straight off an HTTP query string,
    // a route param and a form field, any of which can be undefined.
    assert.equal(normalizeSubSubject('prek', 'montessori', undefined), null);
    assert.equal(normalizeTheme('k', 'english', undefined), null);
    assert.equal(normalizeFolderType(undefined), null);
    assert.equal(normalizeProgram(undefined), null);
    assert.equal(normalizeSubject('prek', ''), null);
  });
});

// ---------------------------------------------------------------------------
// 4. labels come from the vocabulary, not from a second mapping table
// ---------------------------------------------------------------------------

describe('i18n keys live with the tokens', () => {
  test('every montessori sub-subject carries the key SubjectPage renders', () => {
    const expected = {
      practical_life: ['subject.practicalLife', 'subject.practicalLifeDesc'],
      sensorial: ['subject.sensorial', 'subject.sensorialDesc'],
      math: ['nav.montessori.math', 'subject.mathDesc'],
      english_language: ['subject.englishLanguage', 'subject.englishLanguageDesc'],
      chinese_language: ['subject.chineseLanguage', 'subject.chineseLanguageDesc'],
      culture: ['subject.culture', 'subject.cultureDesc'],
    };
    for (const node of subSubjectNodes('prek', 'montessori')) {
      const [nameKey, descKey] = expected[node.key];
      assert.equal(node.i18nNameKey, nameKey, `${node.key} name key`);
      assert.equal(node.i18nDescKey, descKey, `${node.key} desc key`);
      assert.equal(findNode('prek', 'montessori', node.key)?.name, node.name);
    }
  });

  test('the K PE branch and K Chinese branch carry their keys', () => {
    assert.deepEqual(
      subSubjectNodes('k', 'physical_education').map((n) => [n.key, n.i18nNameKey]),
      [
        ['pe_special', 'subject.peSpecial'],
        ['sports', 'subject.sports'],
        ['rock_climbing', 'subject.rockClimbing'],
      ],
    );
    assert.deepEqual(
      subSubjectNodes('k', 'chinese').map((n) => [n.key, n.i18nNameKey]),
      [
        ['ancient_poetry', 'subject.ancientPoetry'],
        ['picture_books', 'subject.pictureBooks'],
        ['drama', 'subject.drama'],
        ['stem', 'subject.stem'],
      ],
    );
  });

  test('every i18n key referenced by the vocabulary EXISTS in translations.ts', async () => {
    // A key that does not exist renders as the literal key string in the UI
    // ("subject.practicalLife" instead of "日常生活"). Nothing type-checks that,
    // because the translation table is a plain Record<string, string>.
    const { translations } = await import(
      new URL('../client/src/i18n/translations.ts', import.meta.url).href
    );
    const missing = [];
    for (const program of CURRICULUM) {
      for (const subject of program.subjects) {
        for (const node of [subject, ...(subject.children ?? [])]) {
          for (const key of [node.i18nNameKey, node.i18nDescKey]) {
            if (key === undefined) continue;
            if (!(key in translations['zh-CN'])) missing.push(`zh-CN ${key}`);
            if (!(key in translations['en-US'])) missing.push(`en-US ${key}`);
          }
        }
      }
    }
    for (const folder of FOLDER_DEFINITIONS) {
      const key = `folder.${folder.key}`;
      if (!(key in translations['zh-CN'])) missing.push(`zh-CN ${key}`);
      if (!(key in translations['en-US'])) missing.push(`en-US ${key}`);
    }
    assert.deepEqual(missing, []);
  });
});

// ---------------------------------------------------------------------------
// 5. against the live database
// ---------------------------------------------------------------------------

const DB_URL = resolveDbUrl();

describe('canonical tokens agree with the live database', { skip: DB_URL ? false : 'no DATABASE_URL/AUTHZ_TEST_DB set — the database half of this suite was NOT checked' }, () => {
  let sql;

  before(async () => {
    const postgres = (await import('postgres')).default;
    // Explicit timeouts: a suite that waits forever on a database is worse than
    // one that fails, because `npm test` (and the gate that runs it) then hangs
    // with no output instead of reporting which check could not be performed.
    sql = postgres(DB_URL, {
      max: 2,
      onnotice: () => {},
      connect_timeout: 10,
      idle_timeout: 5,
    });
  });

  // Without this the pool stays open and `node --test` never exits once the
  // database group has run — the suite hangs after printing its results.
  after(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  test('a query built from canonical tokens reaches EVERY seeded group', async () => {
    // The end-to-end shape of the bug: for each (program, subject, sub_subject)
    // group that actually holds rows, resolving the value the UI sends must
    // produce a token, and the filtered query must return that group's rows.
    const groups = await sql`
      select program, subject, sub_subject, count(*)::int as n
      from resources
      where deleted_at is null and sub_subject is not null
      group by 1, 2, 3
      order by 1, 2, 3
    `;
    assert.ok(groups.length > 0, 'expected the database to contain sub-subject rows');

    for (const g of groups) {
      const token = normalizeSubSubject(g.program, g.subject, g.sub_subject);
      assert.equal(
        token,
        g.sub_subject,
        `${g.program}/${g.subject}/${g.sub_subject} is not canonical or does not resolve`,
      );
      const [{ n }] = await sql`
        select count(*)::int as n from resources
        where deleted_at is null and program = ${g.program}
          and subject = ${g.subject} and sub_subject = ${token}
      `;
      assert.equal(n, g.n, `filtered query returned a different count for ${g.sub_subject}`);
    }
  });

  test('the stored theme values are exactly the ones the vocabulary declares', async () => {
    const rows = await sql`
      select program, subject, theme, count(*)::int as n
      from resources
      where deleted_at is null and theme is not null
      group by 1, 2, 3
      order by 1, 2, 3
    `;
    assert.ok(rows.length > 0, 'expected themed rows');

    const unresolved = [];
    for (const r of rows) {
      const stored = themeDbValue(r.program, r.subject, r.theme);
      if (stored !== r.theme) {
        unresolved.push(`${r.program}/${r.subject} theme "${r.theme}" (${r.n} rows) -> ${stored}`);
      }
    }
    assert.deepEqual(
      unresolved,
      [],
      'every stored theme must resolve; an unresolved one is a group of rows that no filter can reach',
    );
  });

  test("the UI's English theme labels reach the K English rows", async () => {
    // Exactly what client/src/pages/English/EnglishPage.tsx now sends.
    const labels = ['Myself', 'The Five Senses', 'Community & Neighborhood', 'The Natural World', 'PBL Unit', 'Around the World'];
    let reached = 0;
    for (const label of labels) {
      const stored = themeDbValue('k', 'english', label);
      assert.notEqual(stored, null, `${label} must resolve`);
      const [{ n }] = await sql`
        select count(*)::int as n from resources
        where deleted_at is null and program = 'k' and subject = 'english' and theme = ${stored}
      `;
      assert.ok(n > 0, `${label} resolved to "${stored}" but matched no rows`);
      reached += n;
    }
    const [{ total }] = await sql`
      select count(*)::int as total from resources
      where deleted_at is null and program = 'k' and subject = 'english'
    `;
    assert.equal(
      reached,
      total,
      'the six themes must account for every K English row — none may be left unreachable',
    );
  });

  test('a non-canonical spelling that the UI used to send matches ZERO rows (the bug)', async () => {
    // Guards the premise of the whole fix: if this ever starts returning rows, the
    // analysis behind the change no longer applies and the compatibility note in
    // MIGRATION_REPORT_B4.md is wrong.
    const [{ n }] = await sql`
      select count(*)::int as n from resources
      where deleted_at is null and program = 'prek' and subject = 'montessori'
        and sub_subject = 'practical-life'
    `;
    assert.equal(n, 0, "'practical-life' must not exist as a stored value");

    const [{ m }] = await sql`
      select count(*)::int as m from resources
      where deleted_at is null and program = 'k' and subject = 'english' and theme = 'Myself'
    `;
    assert.equal(m, 0, "'Myself' must not exist as a stored theme value");
  });

  test('every resource has a definite has_stored_file value (migration 0008)', async () => {
    const [{ missing_column }] = await sql`
      select count(*)::int as missing_column from information_schema.columns
      where table_schema = 'public' and table_name = 'resources' and column_name = 'has_stored_file'
    `;
    if (missing_column === 0) {
      assert.fail(
        'resources.has_stored_file is absent — migration 0008 is not applied to this database',
      );
    }

    const [{ total, nulls, with_file, without_file }] = await sql`
      select count(*)::int as total,
             count(*) filter (where has_stored_file is null)::int as nulls,
             count(*) filter (where has_stored_file)::int as with_file,
             count(*) filter (where not has_stored_file)::int as without_file
      from resources
    `;
    assert.equal(nulls, 0, 'has_stored_file must be two-valued: NULL would mean "unknown"');
    assert.equal(
      with_file + without_file,
      total,
      'every row must be classified exactly once',
    );

    // The generated column must equal an independent recomputation. If this ever
    // fails, the database's flag and the download predicate have diverged.
    const [{ mismatched }] = await sql`
      select count(*)::int as mismatched from resources
      where has_stored_file is distinct from
            (coalesce(btrim(file_path), '') <> '' and coalesce(btrim(file_bucket_id), '') <> '')
    `;
    assert.equal(mismatched, 0, 'has_stored_file disagrees with file_path/file_bucket_id');
  });
});
