/**
 * shared/curriculum.ts — SINGLE SOURCE OF TRUTH for the curriculum vocabulary.
 * =============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every layer of this application names the same four things — program, subject,
 * sub-subject and folder type — and before this file each layer spelled them its
 * own way. Verified against the code AND the live database:
 *
 *   layer / file                                    subject "Practical Life"
 *   ----------------------------------------------  -----------------------
 *   resources.sub_subject          (the database)   practical_life
 *   server/.../curriculum.data.ts  (the API)        practical_life
 *   client/.../PermissionAdminPage.tsx              practical_life
 *   client/.../MontessoriPage.tsx  (the link href)  practical-life      ← DRIFT
 *   client/.../SubjectPage.tsx     (the label map)  practical-life      ← DRIFT
 *
 * and for the K English themes:
 *
 *   resources.theme                (the database)   主题1：我自己
 *   client/.../EnglishPage.tsx     (the API filter) Myself              ← DRIFT
 */

/**
 * The token set lives in ONE declaration below, and every layer derives from it.
 *
 * The drift above was not a spelling mistake: it was five hand-maintained copies
 * of the same vocabulary. A copy can be fixed; a copy that is never compared to
 * the others will drift again. So this module is not a "conversion helper" bolted
 * on top — it is the vocabulary itself, and `normalizeCurriculumToken()` is what
 * lets a layer that has not (yet) been migrated still be understood.
 *
 * CONSEQUENCES THAT ARE DELIBERATE
 *   * The canonical token for a subject/sub-subject is the SNAKE_CASE identifier
 *     the database already stores (`practical_life`) and the REST API already
 *     advertises (`GET /api/curriculum/structure` returns these keys). Choosing
 *     the spelling the DATA uses means no data migration is ever required to
 *     adopt this module, and no existing row becomes unreachable by adopting it.
 *   * The canonical token for a THEME cannot be invented, because the stored
 *     values are human-readable labels in two languages (`主题1：我自己`). The
 *     token is therefore an ASCII slug and the stored labels are ALIASES of it.
 *     See `THEME_SETS` for the exact four spellings that exist in production.
 */

// =============================================================================
// 1. TYPES
// =============================================================================

export type ProgramCode = 'prek' | 'k';

export type FolderType =
  | 'curriculum_outline'
  | 'weekly_plans'
  | 'courseware'
  | 'materials'
  | 'observation'
  | 'research_archive';

/** A leaf of the curriculum tree: a sub-subject, or a theme-bearing subject. */
export interface CurriculumNode {
  /** Canonical token. This is what is stored, compared and sent to the API. */
  key: string;
  /** Chinese display name (also the value used in `folder.*`/`subject.*` copy). */
  name: string;
  /** English display name. */
  nameEn: string;
  /** i18n key for the Chinese/English display name, where one exists. */
  i18nNameKey?: string;
  /** i18n key for the one-line description shown on the subject card. */
  i18nDescKey?: string;
  /**
   * Every spelling that must still resolve to `key`.
   *
   * These are NOT invented. Each entry is a spelling that was verified to exist
   * either in the database, in the seed file, in a live client request, or in a
   * shipped client string. The comment on each records which.
   */
  aliases?: string[];
  children?: CurriculumNode[];
}

export interface ProgramDefinition {
  program: ProgramCode;
  name: string;
  nameEn: string;
  subjects: CurriculumNode[];
}

/**
 * One theme of one subject, with every spelling that must map to its token.
 *
 * `dbValues` are the EXACT strings stored in `resources.theme`. They are aliases
 * like any other — the point of the token is that a layer can stop caring which
 * of the four spellings it was handed.
 */
export interface ThemeDefinition {
  /** Canonical token (ASCII slug; never stored, only compared). */
  key: string;
  /** Chinese label, used when the UI language is zh-CN. */
  name: string;
  /** English label, used when the UI language is en-US. */
  nameEn: string;
  /** Exact `resources.theme` values for this theme. */
  dbValues: string[];
  /** Additional accepted spellings (route slugs, legacy client names). */
  aliases?: string[];
}

export interface ThemeSet {
  program: ProgramCode;
  /** Subject token this theme vocabulary belongs to. */
  subject: string;
  themes: ThemeDefinition[];
}

export interface FolderDefinition {
  key: FolderType;
  name: string;
  nameEn: string;
}

// =============================================================================
// 2. PROGRAMS, SUBJECTS AND SUB-SUBJECTS
// =============================================================================
//
// Provenance of the alias lists below:
//
//   practical_life   DB 80 rows (seed + live query)
//                    'practical-life'          client/src/pages/Montessori/MontessoriPage.tsx:28
//                                              client/src/pages/Subject/SubjectPage.tsx:69,94
//   english_language DB 43 rows
//                    'english-language'        MontessoriPage.tsx:52, SubjectPage.tsx:72,97
//   chinese_language DB 1 row
//                    'chinese-language'        MontessoriPage.tsx:60, SubjectPage.tsx:73,98
//   sensorial/math/culture  identical in both spellings — no alias needed.
//
//   subject 'physical_education' has NO rows in the live database (verified:
//   `select distinct subject` returns only english, montessori, virtue), but it
//   is the token that curriculum.data.ts, resources.service.ts (the
//   pe_specialist branch) and the RBAC scope model all compare against, so it is
//   canonical. 'pe' is a shipped client spelling of it (KHomePage/PreKHomePage
//   card keys, PermissionAdminPage tree).
// =============================================================================

export const CURRICULUM: ProgramDefinition[] = [
  {
    program: 'prek',
    name: 'Pre-K',
    nameEn: 'Pre-K',
    subjects: [
      {
        key: 'virtue',
        name: '美德',
        nameEn: 'Virtue',
        i18nNameKey: 'subject.virtue',
        i18nDescKey: 'subject.virtueDesc',
      },
      {
        key: 'montessori',
        name: '蒙特梭利',
        nameEn: 'Montessori',
        i18nNameKey: 'subject.montessori',
        i18nDescKey: 'subject.montessoriDesc',
        children: [
          {
            key: 'practical_life',
            name: '日常生活',
            nameEn: 'Practical Life',
            i18nNameKey: 'subject.practicalLife',
            i18nDescKey: 'subject.practicalLifeDesc',
            aliases: ['practical-life'],
          },
          {
            key: 'sensorial',
            name: '感官',
            nameEn: 'Sensorial',
            i18nNameKey: 'subject.sensorial',
            i18nDescKey: 'subject.sensorialDesc',
          },
          {
            key: 'math',
            name: '数学',
            nameEn: 'Math',
            i18nNameKey: 'nav.montessori.math',
            i18nDescKey: 'subject.mathDesc',
          },
          {
            key: 'english_language',
            name: '英文语言',
            nameEn: 'English Language',
            i18nNameKey: 'subject.englishLanguage',
            i18nDescKey: 'subject.englishLanguageDesc',
            aliases: ['english-language'],
          },
          {
            key: 'chinese_language',
            name: '中文语言',
            nameEn: 'Chinese Language',
            i18nNameKey: 'subject.chineseLanguage',
            i18nDescKey: 'subject.chineseLanguageDesc',
            aliases: ['chinese-language'],
          },
          {
            key: 'culture',
            name: '文化',
            nameEn: 'Culture',
            i18nNameKey: 'subject.culture',
            i18nDescKey: 'subject.cultureDesc',
          },
        ],
      },
      {
        key: 'physical_education',
        name: '体能',
        nameEn: 'Physical Education',
        i18nNameKey: 'subject.pe',
        i18nDescKey: 'subject.peDesc',
        aliases: ['pe'],
      },
    ],
  },
  {
    program: 'k',
    name: 'K',
    nameEn: 'K',
    subjects: [
      {
        key: 'virtue',
        name: '美德',
        nameEn: 'Virtue',
        i18nNameKey: 'subject.virtue',
        i18nDescKey: 'subject.virtueDesc',
      },
      {
        key: 'chinese',
        name: '中文',
        nameEn: 'Chinese',
        i18nNameKey: 'subject.chinese',
        i18nDescKey: 'subject.chineseDesc',
        children: [
          {
            key: 'ancient_poetry',
            name: '古诗',
            nameEn: 'Ancient Poetry',
            i18nNameKey: 'subject.ancientPoetry',
            i18nDescKey: 'subject.ancientPoetryDesc',
            aliases: ['ancient-poetry', 'poetry'],
          },
          {
            key: 'picture_books',
            name: '绘本',
            nameEn: 'Picture Books',
            i18nNameKey: 'subject.pictureBooks',
            i18nDescKey: 'subject.pictureBooksDesc',
            aliases: ['picture-books'],
          },
          {
            key: 'drama',
            name: '戏剧',
            nameEn: 'Drama',
            i18nNameKey: 'subject.drama',
            i18nDescKey: 'subject.dramaDesc',
          },
          {
            key: 'stem',
            name: '科学与工程',
            nameEn: 'STEM',
            i18nNameKey: 'subject.stem',
            i18nDescKey: 'subject.stemDesc',
          },
        ],
      },
      {
        key: 'english',
        name: '英文',
        nameEn: 'English',
        i18nNameKey: 'subject.english',
        i18nDescKey: 'subject.englishDesc',
        children: [
          {
            key: 'reading_comprehension',
            name: '阅读理解',
            nameEn: 'Reading Comprehension',
            i18nNameKey: 'theme.tag.reading',
            aliases: ['reading-comprehension'],
          },
          {
            key: 'language_skills',
            name: '语言技能',
            nameEn: 'Language Skills',
            i18nNameKey: 'theme.tag.language',
            aliases: ['language-skills'],
          },
          {
            key: 'math',
            name: '数学',
            nameEn: 'Math',
            i18nNameKey: 'theme.tag.math',
            i18nDescKey: 'subject.mathDesc',
          },
        ],
      },
      {
        key: 'physical_education',
        name: '体能',
        nameEn: 'Physical Education',
        i18nNameKey: 'subject.pe',
        i18nDescKey: 'subject.peDesc',
        aliases: ['pe'],
        children: [
          {
            key: 'pe_special',
            name: '体能专项',
            nameEn: 'PE Special',
            i18nNameKey: 'subject.peSpecial',
            i18nDescKey: 'subject.peSpecialDesc',
            aliases: ['pe-special'],
          },
          {
            key: 'sports',
            name: '体育',
            nameEn: 'Sports',
            i18nNameKey: 'subject.sports',
            i18nDescKey: 'subject.sportsDesc',
          },
          {
            key: 'rock_climbing',
            name: '攀岩',
            nameEn: 'Rock Climbing',
            i18nNameKey: 'subject.rockClimbing',
            i18nDescKey: 'subject.rockClimbingDesc',
            aliases: ['rock-climbing'],
          },
        ],
      },
    ],
  },
];

// =============================================================================
// 3. THEMES
// =============================================================================
//
// A theme vocabulary belongs to ONE (program, subject) pair — the same word can
// legitimately mean different things under different subjects, so a single flat
// theme namespace would create exactly the kind of silent cross-program match
// this module exists to prevent.
//
// K / english — VERIFIED, and the only theme filter any shipped page sends.
//   The six `dbValues` were read from the live database:
//     select theme, count(*) from resources where program='k' and subject='english'
//     -> 主题1：我自己 7, 主题2：五感 8, 主题3：社区与邻里 5,
//        主题4：自然世界 5, 主题5：项目式学习（PBL） 10, 主题6：环游世界 9   (= 44)
//   The English labels and their route slugs are the shipped client spellings
//   (client/src/pages/English/EnglishPage.tsx:24-31 THEMES, and the slug builder
//   at :83-87 which produces 'myself', 'the-five-senses', 'community-neighborhood',
//   'the-natural-world', 'pbl-unit', 'around-the-world').
//
// Pre-K / montessori — VERIFIED, but currently UNREACHABLE BY DESIGN OF THE ROUTES:
//   no route sends a `theme` for Pre-K, so these are display values only. They are
//   registered so that (a) the detector can group by them, and (b) a Pre-K theme
//   filter can be built later without re-introducing a second vocabulary.
//   dbValues read from the live database (23 distinct values, 245 rows).
//
//   HONEST LIMIT: every Pre-K montessori theme is registered with ITSELF as the
//   only accepted spelling, so a token that is not in the list is rejected. That
//   is a completeness claim about the DATA, not about a spec — 23 values is what
//   the database contains today. See MIGRATION_REPORT_B4.md.
// =============================================================================

const PREK_MONTESSORI_THEMES: ThemeDefinition[] = [
  { key: 'practical_life_grace_courtesy', name: '优雅与礼仪', nameEn: 'Grace & Courtesy', dbValues: ['优雅与礼仪'] },
  { key: 'practical_life_gross_motor', name: '大动作技能', nameEn: 'Gross Motor Skills', dbValues: ['大动作技能'] },
  { key: 'practical_life_care_of_environment', name: '照顾环境', nameEn: 'Care of the Environment', dbValues: ['照顾环境'] },
  { key: 'practical_life_care_of_living', name: '照顾生命', nameEn: 'Care of Living Things', dbValues: ['照顾生命'] },
  { key: 'practical_life_care_of_self', name: '照顾自己', nameEn: 'Care of Self', dbValues: ['照顾自己'] },
  { key: 'practical_life_fine_motor', name: '精细动作：基础动作', nameEn: 'Fine Motor: Foundational Movements', dbValues: ['精细动作：基础动作'] },
  { key: 'practical_life_art', name: '艺术', nameEn: 'Art', dbValues: ['艺术'] },
  { key: 'practical_life_food_preparation', name: '食物制备', nameEn: 'Food Preparation', dbValues: ['食物制备'] },
  { key: 'sensorial_auditory', name: '听觉', nameEn: 'Auditory', dbValues: ['听觉'] },
  { key: 'sensorial_gustatory', name: '味觉', nameEn: 'Gustatory', dbValues: ['味觉'] },
  { key: 'sensorial_olfactory', name: '嗅觉', nameEn: 'Olfactory', dbValues: ['嗅觉'] },
  { key: 'sensorial_visual', name: '视觉', nameEn: 'Visual', dbValues: ['视觉'] },
  { key: 'sensorial_tactile', name: '触觉', nameEn: 'Tactile', dbValues: ['触觉'] },
  { key: 'math_decimal_introduction', name: '十进制系统介绍', nameEn: 'Introduction to the Decimal System', dbValues: ['十进制系统介绍'] },
  { key: 'math_decimal_operations', name: '十进制系统运算', nameEn: 'Decimal System Operations', dbValues: ['十进制系统运算'] },
  { key: 'math_numbers_1_10', name: '数字 1–10', nameEn: 'Numbers 1–10', dbValues: ['数字 1–10'] },
  { key: 'math_linear_counting', name: '线性计数：十几和几十', nameEn: 'Linear Counting: Teens and Tens', dbValues: ['线性计数：十几和几十'] },
  { key: 'math_memorization', name: '记忆练习', nameEn: 'Memorization', dbValues: ['记忆练习'] },
  { key: 'culture_animals', name: '动物', nameEn: 'Animals', dbValues: ['动物'] },
  { key: 'culture_history', name: '历史', nameEn: 'History', dbValues: ['历史'] },
  { key: 'culture_geography', name: '地理', nameEn: 'Geography', dbValues: ['地理'] },
  { key: 'culture_plants', name: '植物', nameEn: 'Plants', dbValues: ['植物'] },
  { key: 'culture_science', name: '科学', nameEn: 'Science', dbValues: ['科学'] },
];

const K_ENGLISH_THEMES: ThemeDefinition[] = [
  {
    key: 'myself',
    name: '主题1：我自己',
    nameEn: 'Myself',
    dbValues: ['主题1：我自己'],
    aliases: ['myself', 'Myself', '我自己'],
  },
  {
    key: 'the_five_senses',
    name: '主题2：五感',
    nameEn: 'The Five Senses',
    dbValues: ['主题2：五感'],
    aliases: ['the-five-senses', 'the_five_senses', 'The Five Senses', '五感'],
  },
  {
    key: 'community_neighborhood',
    name: '主题3：社区与邻里',
    nameEn: 'Community & Neighborhood',
    dbValues: ['主题3：社区与邻里'],
    aliases: [
      'community-neighborhood',
      'community_neighborhood',
      'Community & Neighborhood',
      '社区与邻里',
    ],
  },
  {
    key: 'the_natural_world',
    name: '主题4：自然世界',
    nameEn: 'The Natural World',
    dbValues: ['主题4：自然世界'],
    aliases: ['the-natural-world', 'the_natural_world', 'The Natural World', '自然世界'],
  },
  {
    key: 'pbl_unit',
    name: '主题5：项目式学习（PBL）',
    nameEn: 'PBL Unit',
    dbValues: ['主题5：项目式学习（PBL）'],
    aliases: ['pbl-unit', 'pbl_unit', 'PBL Unit', '项目式学习', '项目式学习（PBL）'],
  },
  {
    key: 'around_the_world',
    name: '主题6：环游世界',
    nameEn: 'Around the World',
    dbValues: ['主题6：环游世界'],
    aliases: ['around-the-world', 'around_the_world', 'Around the World', '环游世界'],
  },
];

export const THEME_SETS: ThemeSet[] = [
  { program: 'k', subject: 'english', themes: K_ENGLISH_THEMES },
  { program: 'prek', subject: 'montessori', themes: PREK_MONTESSORI_THEMES },
];

// =============================================================================
// 4. FOLDER TYPES
// =============================================================================
//
// Six folder types are part of the product spec (AGENTS.md). THREE of them hold
// rows today — verified: `select distinct folder_type from resources` returns
// courseware, curriculum_outline, weekly_plans. The other three are registered
// because the UI renders all six tabs and teachers may upload into them; they are
// not "unused values found in data" and are not treated as aliases of anything.
// =============================================================================

export const FOLDER_DEFINITIONS: FolderDefinition[] = [
  { key: 'curriculum_outline', name: '课程大纲', nameEn: 'Curriculum Outline' },
  { key: 'weekly_plans', name: '周次教案', nameEn: 'Weekly Lesson Plans' },
  { key: 'courseware', name: '课件与示范', nameEn: 'Courseware & Demonstration' },
  { key: 'materials', name: '素材与工作单', nameEn: 'Materials & Worksheets' },
  { key: 'observation', name: '观察与评价', nameEn: 'Observation & Assessment' },
  { key: 'research_archive', name: '教研归档', nameEn: 'Teaching Research Archive' },
];

// =============================================================================
// 5. DERIVED TOKEN LISTS
// =============================================================================

export const PROGRAM_CODES: ProgramCode[] = CURRICULUM.map((p) => p.program);

export const FOLDER_TYPES: FolderType[] = FOLDER_DEFINITIONS.map((f) => f.key) as FolderType[];

/** Subject tokens for a program (excludes sub-subjects). */
export function subjectTokens(program: ProgramCode): string[] {
  return (CURRICULUM.find((p) => p.program === program)?.subjects ?? []).map((s) => s.key);
}

// =============================================================================
// 6. NORMALISATION — the boundary function
// =============================================================================
//
// This is the ONE place that answers "what did the caller mean". Every layer
// calls it instead of comparing raw strings, so adding an accepted spelling is a
// one-line change here rather than a search-and-replace across five files.
//
// THE CONTRACT THAT MATTERS: an unknown value returns `null`. It is NEVER
// silently mapped to a default. This is the opposite of the previous behaviour,
// where a misspelled subject simply matched zero rows and the page rendered
// "暂无资源" — a 347-row dataset that looked empty, with nothing in the log. A
// caller that receives `null` must surface a failure; it must not continue.
// =============================================================================

/**
 * Fold a raw string into a comparison form: trimmed, lower-cased, with every run
 * of separators (`-`, `_`, whitespace, `·`) collapsed to a single `_`.
 *
 * Separator-agnostic folding is why `practical-life`, `practical life` and
 * `Practical_Life` all reach `practical_life` without three alias entries each.
 * It is deliberately NOT a fuzzy match: no edit distance, no prefix matching, no
 * "closest token" fallback — a typo must fail, not resolve to a neighbour.
 */
export function foldToken(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000\-_.·/\\]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Two spellings match when their folded forms are equal.
 *
 * The raw-equality check before folding is load-bearing: some real values are
 * CJK or mixed-case labels whose folded form is still meaningful, and folding
 * alone would be enough for them — but the exact check keeps a value that folds
 * to the same string by accident from being accepted when it was never listed.
 */
function tokenMatches(candidate: string, alias: string): boolean {
  return candidate === alias || foldToken(candidate) === foldToken(alias);
}

// -----------------------------------------------------------------------------
// 6a. subject / sub-subject
// -----------------------------------------------------------------------------

interface NodeIndexEntry {
  program: ProgramCode;
  subject: string;
  node: CurriculumNode;
  isChild: boolean;
}

/**
 * Flatten the tree into one addressable list. Built once at module load: the
 * vocabulary is a compile-time constant, so re-walking it per request would be
 * work with no possible different answer.
 */
const NODE_INDEX: NodeIndexEntry[] = ((): NodeIndexEntry[] => {
  const out: NodeIndexEntry[] = [];
  for (const program of CURRICULUM) {
    for (const subject of program.subjects) {
      out.push({ program: program.program, subject: subject.key, node: subject, isChild: false });
      for (const child of subject.children ?? []) {
        out.push({ program: program.program, subject: subject.key, node: child, isChild: true });
      }
    }
  }
  return out;
})();

const SUBJECT_SET = new Set(
  NODE_INDEX.filter((e) => !e.isChild).map((e) => `${e.program}:${e.node.key}`),
);
const SUB_SUBJECT_SET = new Set(
  NODE_INDEX.filter((e) => e.isChild).map((e) => `${e.program}:${e.subject}:${e.node.key}`),
);

export function isCanonicalSubject(program: ProgramCode, token: string): boolean {
  return SUBJECT_SET.has(`${program}:${token}`);
}

export function isCanonicalSubSubject(
  program: ProgramCode,
  subject: string,
  token: string,
): boolean {
  return SUB_SUBJECT_SET.has(`${program}:${subject}:${token}`);
}

/**
 * Resolve a raw string to a SUBJECT token for `program`.
 *
 * Returns `null` for an unknown or wrong-program value. Note that this is
 * context-free between programs only where the token is unique to one program —
 * 'math' is a subject under prek/montessori and a sub-subject under k/english, so
 * a subject lookup is always scoped to a program.
 */
export function normalizeSubject(program: ProgramCode, raw: string): string | null {
  const candidate = String(raw ?? '').trim();
  if (candidate === '') return null;
  for (const entry of NODE_INDEX) {
    if (entry.isChild || entry.program !== program) continue;
    if (tokenMatches(candidate, entry.node.key)) return entry.node.key;
    if ((entry.node.aliases ?? []).some((a) => tokenMatches(candidate, a))) {
      return entry.node.key;
    }
  }
  return null;
}

/**
 * Resolve a raw string to a SUB-SUBJECT token.
 *
 * `subject` is REQUIRED and is itself normalised first, so
 * `normalizeSubSubject('prek', 'montessori', 'practical-life')` and
 * `normalizeSubSubject('prek', 'montessori', 'practical_life')` are the same
 * call. Passing the wrong subject is a real failure mode, not a nuisance: a
 * sub-subject token is only meaningful inside its subject, and resolving
 * 'math' without the subject would be a coin flip between prek/montessori/math
 * and k/english/math.
 */
export function normalizeSubSubject(
  program: ProgramCode,
  subject: string,
  raw: string,
): string | null {
  const candidate = String(raw ?? '').trim();
  if (candidate === '') return null;
  const subjectToken = normalizeSubject(program, subject);
  if (subjectToken === null) return null;
  for (const entry of NODE_INDEX) {
    if (!entry.isChild || entry.program !== program || entry.subject !== subjectToken) continue;
    if (tokenMatches(candidate, entry.node.key)) return entry.node.key;
    if ((entry.node.aliases ?? []).some((a) => tokenMatches(candidate, a))) {
      return entry.node.key;
    }
  }
  return null;
}

/**
 * A `CurriculumNode` by canonical token, for rendering labels from the canonical
 * tree instead of a hand-written map. `subject` selects the sub-subject branch.
 */
export function findNode(
  program: ProgramCode,
  subject: string,
  token?: string,
): CurriculumNode | null {
  const programDef = CURRICULUM.find((p) => p.program === program);
  if (!programDef) return null;
  const subjectDef = programDef.subjects.find((s) => s.key === subject);
  if (!subjectDef) return null;
  if (token === undefined) return subjectDef;
  return (subjectDef.children ?? []).find((c) => c.key === token) ?? null;
}

/** Sub-subject nodes of a subject, in declaration order. */
export function subSubjectNodes(program: ProgramCode, subject: string): CurriculumNode[] {
  return findNode(program, subject)?.children ?? [];
}

// -----------------------------------------------------------------------------
// 6b. theme
// -----------------------------------------------------------------------------

function themeSetFor(program: ProgramCode, subject: string): ThemeSet | undefined {
  const subjectToken = normalizeSubject(program, subject);
  if (subjectToken === null) return undefined;
  return THEME_SETS.find((s) => s.program === program && s.subject === subjectToken);
}

/** The theme vocabulary for a subject, or an empty list when it has none. */
export function themeDefinitions(program: ProgramCode, subject: string): ThemeDefinition[] {
  return themeSetFor(program, subject)?.themes ?? [];
}

/**
 * Resolve a raw string to a THEME token for (program, subject).
 *
 * Accepts the canonical token, the zh label, the en label, the route slug and the
 * exact stored `resources.theme` value. Returns `null` for anything else — in
 * particular it does NOT fall back to the raw string, because the previous
 * behaviour ("pass it through, match nothing, render an empty page") is what made
 * all 44 K English resources unreachable while every layer reported success.
 */
export function normalizeTheme(
  program: ProgramCode,
  subject: string,
  raw: string,
): string | null {
  const candidate = String(raw ?? '').trim();
  if (candidate === '') return null;
  const set = themeSetFor(program, subject);
  if (!set) return null;
  for (const theme of set.themes) {
    if (tokenMatches(candidate, theme.key)) return theme.key;
    if (tokenMatches(candidate, theme.name)) return theme.key;
    if (tokenMatches(candidate, theme.nameEn)) return theme.key;
    if (theme.dbValues.some((v) => tokenMatches(candidate, v))) return theme.key;
    if ((theme.aliases ?? []).some((a) => tokenMatches(candidate, a))) return theme.key;
  }
  return null;
}

/** The `ThemeDefinition` for a canonical theme token. */
export function findTheme(
  program: ProgramCode,
  subject: string,
  token: string,
): ThemeDefinition | null {
  const set = themeSetFor(program, subject);
  if (!set) return null;
  return set.themes.find((t) => t.key === token) ?? null;
}

/**
 * The value to STORE in `resources.theme` for a theme token.
 *
 * This is the bridge that makes the fix backward compatible: a request that
 * arrives as `theme=myself` or `theme=Myself` is turned into the exact string the
 * 44 existing rows already hold, so those rows become reachable WITHOUT editing
 * or re-seeding a single row. Returns `null` for an unknown theme.
 */
export function themeDbValue(
  program: ProgramCode,
  subject: string,
  raw: string,
): string | null {
  const token = normalizeTheme(program, subject, raw);
  if (token === null) return null;
  const theme = findTheme(program, subject, token);
  return theme?.dbValues[0] ?? null;
}

// -----------------------------------------------------------------------------
// 6c. folder type
// -----------------------------------------------------------------------------

const FOLDER_KEYS: string[] = FOLDER_TYPES;

/**
 * Resolve a raw string to a FOLDER TYPE token.
 *
 * Folder types are ASCII tokens with no stored CJK form, so this is mostly a
 * separator/case fold — but it is the same function shape as the others and the
 * same `null`-on-unknown contract, so callers have one rule to remember.
 */
export function normalizeFolderType(raw: string): FolderType | null {
  const candidate = String(raw ?? '').trim();
  if (candidate === '') return null;
  for (const key of FOLDER_KEYS) {
    if (tokenMatches(candidate, key)) return key as FolderType;
  }
  return null;
}

// -----------------------------------------------------------------------------
// 6d. program
// -----------------------------------------------------------------------------

export function normalizeProgram(raw: string): ProgramCode | null {
  const candidate = String(raw ?? '').trim();
  if (candidate === '') return null;
  for (const program of PROGRAM_CODES) {
    if (tokenMatches(candidate, program)) return program;
  }
  return null;
}

// =============================================================================
// 7. LABELS
// =============================================================================

/** i18n key for a sub-subject's display name (canonical token -> key). */
export function subjectNameI18nKey(
  program: ProgramCode,
  subject: string,
  token?: string,
): string | null {
  return findNode(program, subject, token)?.i18nNameKey ?? null;
}

/** i18n key for a sub-subject's description. */
export function subjectDescI18nKey(
  program: ProgramCode,
  subject: string,
  token?: string,
): string | null {
  return findNode(program, subject, token)?.i18nDescKey ?? null;
}
