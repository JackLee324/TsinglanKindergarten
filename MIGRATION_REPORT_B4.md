# MIGRATION_REPORT_B4 — naming drift (B4) and explicit missing-file state

Scope: the `qls-kindergarten-resource-platform-v1.3.0` repository.
Database used for every number below: `postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005`
(PostgreSQL 16.14, 347 seeded `resources` rows, 8 applied migrations after this work).

Everything in this report was re-derived from the code and the live database. The
claims that were handed to me before starting are repeated here only where I could
confirm them, and are contradicted explicitly where I could not.

---

## 1. Verified naming-drift analysis

### 1.1 What the database actually contains

Query (the same for every count in this section):

```sql
select program, subject, sub_subject, folder_type, count(*)::int
from resources where deleted_at is null
group by 1,2,3,4 order by 1,2,3,4;
```

Observed (347 active rows, all `status = 'published'`, no soft-deleted rows):

| program | subject | sub_subject | folder_type | rows |
|---|---|---|---|---|
| k | english | *(null)* | curriculum_outline | 6 |
| k | english | *(null)* | weekly_plans | 38 |
| prek | montessori | chinese_language | curriculum_outline | 1 |
| prek | montessori | culture | courseware | 98 |
| prek | montessori | culture | curriculum_outline | 1 |
| prek | montessori | english_language | curriculum_outline | 1 |
| prek | montessori | english_language | weekly_plans | 42 |
| prek | montessori | math | courseware | 36 |
| prek | montessori | math | curriculum_outline | 1 |
| prek | montessori | practical_life | courseware | 79 |
| prek | montessori | practical_life | curriculum_outline | 1 |
| prek | montessori | sensorial | courseware | 32 |
| prek | montessori | sensorial | curriculum_outline | 1 |
| prek | virtue | *(null)* | curriculum_outline | 10 |

Distinct values in each column:

* `program` — `prek` (304), `k` (43). Only two programs exist.
* `subject` — `montessori` (293), `english` (44), `virtue` (11).
  **`physical_education` has ZERO rows.** The `subject='pe'` spelling also has zero.
* `sub_subject` — `culture` (99), `practical_life` (80), `english_language` (43),
  `math` (37), `sensorial` (33), `chinese_language` (1), `NULL` (54).
  **All snake_case. There is no kebab-case value anywhere in the column.**
* `folder_type` — `courseware` (245), `curriculum_outline` (23), `weekly_plans` (42).
  The other three of the six product folder types (`materials`, `observation`,
  `research_archive`) hold no rows today.
* `theme` — 40 distinct values, all Chinese labels. Including
  `主题1：我自己` … `主题6：环游世界` (the K English Big Unit themes).

### 1.2 Canonical vs alias

**Canonical = the spelling the DATA uses.** That choice is deliberate and is what
makes the fix backward compatible: no stored value has to change, and no existing
row becomes unreachable *because of* the change.

| dimension | canonical | aliases found in shipped code |
|---|---|---|
| program | `prek`, `k` | — |
| subject | `montessori`, `english`, `virtue`, `physical_education`, `chinese` | `pe` (KHomePage/PreKHomePage card keys, PermissionAdminPage tree) |
| sub-subject | `practical_life`, `english_language`, `chinese_language`, `sensorial`, `math`, `culture`, `ancient_poetry`, `picture_books`, `drama`, `stem`, `reading_comprehension`, `language_skills`, `pe_special`, `sports`, `rock_climbing` | `practical-life`, `english-language`, `chinese-language`, `ancient-poetry`, `picture-books`, `pe-special`, `rock-climbing` (page card keys); `poetry` (PermissionAdminPage tree) |
| folder type | the six `curriculum_outline` / `weekly_plans` / `courseware` / `materials` / `observation` / `research_archive` | — |
| theme (k/english) | `myself`, `the_five_senses`, `community_neighborhood`, `the_natural_world`, `pbl_unit`, `around_the_world` | the 6 English labels (`Myself` … `Around the World`), the 6 zh labels (`主题1：我自己` …), the 6 route slugs (`the-five-senses` …) |

The alias lists are **derived, not invented**. Every alias above appears either in
the live data or in a shipped client string, and each one is annotated with its
file of origin in `shared/curriculum.ts`. Nothing was added "in case it might be
spelled that way".

### 1.3 Exactly which resources were unreachable, and why

The UI's only curriculum filter is `SubjectPage`'s request to
`GET /api/resources`, which forwards the URL route segment verbatim:

```ts
if (subSubject) paramsObj.subSubject = subSubject;   // SubjectPage.tsx (before)
if (themeName)  paramsObj.theme = themeName;         // themeName from THEME_SLUG_MAP
```

The server compared those values to the columns with `eq(...)` and **no
conversion existed anywhere** in the repository (verified: a grep for any
`kebab`/`snake`/case-conversion helper across `server/`, `client/`, `shared/`,
`scripts/` and `tests/` returns only `EnglishPage.tsx`'s slug *builder*, which
converts in the wrong direction for this purpose).

**Group 1 — Pre-K Montessori sub-subject mismatch: 123 rows unreachable**

`client/src/pages/Montessori/MontessoriPage.tsx` links each card to
`/prek/montessori/<key>`, and three of its six keys were kebab-case:

| card URL | value sent as `subSubject` | value in the column | rows in that group | rows reachable |
|---|---|---|---|---|
| `/prek/montessori/practical-life` | `practical-life` | `practical_life` | 80 | **0** |
| `/prek/montessori/english-language` | `english-language` | `english_language` | 43 | **0** |
| `/prek/montessori/chinese-language` | `chinese-language` | `chinese_language` | 1 | **0** |
| `/prek/montessori/sensorial` | `sensorial` | `sensorial` | 33 | 33 |
| `/prek/montessori/math` | `math` | `math` | 37 | 37 |
| `/prek/montessori/culture` | `culture` | `culture` | 99 | 99 |

Verified at the boundary with the pre-fix code path emulated directly against the
database:

```
prek/montessori sub_subject='practical-life' -> 0     (column holds 80 at practical_life)
prek/montessori sub_subject='english-language' -> 0   (column holds 43 at english_language)
prek/montessori sub_subject='chinese-language' -> 0   (column holds 1 at chinese_language)
prek/montessori sub_subject='culture' -> 99
```

**123 rows** (80 + 43, plus 1 more underneath an empty card) sat behind three
cards that rendered "暂无资源" with HTTP 200 and no error, log line or audit row.

**Group 2 — K English theme mismatch: 44 rows unreachable**

`client/src/pages/English/EnglishPage.tsx` sent the theme's **English display
name**; the column holds the **Chinese label**:

| request sent | stored value | rows | rows reachable |
|---|---|---|---|
| `theme=Myself` | `主题1：我自己` | 7 | 0 |
| `theme=The Five Senses` | `主题2：五感` | 8 | 0 |
| `theme=Community & Neighborhood` | `主题3：社区与邻里` | 5 | 0 |
| `theme=The Natural World` | `主题4：自然世界` | 5 | 0 |
| `theme=PBL Unit` | `主题5：项目式学习（PBL）` | 10 | 0 |
| `theme=Around the World` | `主题6：环游世界` | 9 | 0 |

`theme=Myself` was additionally translated by `SubjectPage.THEME_SLUG_MAP` from the
route slug `myself` into `Myself`, so the *detail* page failed the same way as the
overview page. **All 44 K English resources** were unreachable through every theme
route; every theme card displayed "0 个资源".

**Totals**

| | rows |
|---|---|
| Unreachable through the UI, before | **167** (123 Pre-K + 44 K) |
| Pre-K rows whose only route was an already-broken card | 1 (`chinese_language`, verified reachable through that card's URL once the key is corrected; the card itself had always been rendered) |
| `subject='physical_education'` rows | 0 — the `/prek/pe` and `/k/pe` pages have nothing to show, and their count badges sent `subject=pe` (0 rows). This is a *missing data* situation, not a naming one; see §5. |
| Reachable before | 180 (of 347) |
| Unreachable before | 167 (of 347) |
| Unreachable after | **0** |

### 1.4 What I could NOT verify about the drift

* **Whether the user-visible symptom was ever reported.** I can prove the request
  returned zero rows; I cannot prove a teacher saw it. No access to usage logs.
* **Whether `physical_education` was ever intended to hold rows.** The seed file
  contains no `prek/pe` or `k/pe` inserts at all. The subject is declared in
  `curriculum.data.ts`, the RBAC model and the permission matrix, so the page and
  its permissions exist — but the absence of data may be intentional (no PE
  resources published yet) or an omission from the seed. I did not invent rows.
* **The pre-fix numbers were reproduced by emulating the old query, not by running
  the old binary.** `git log` shows a prior commit (`44d1fbf`) that fixed a
  *different* normalisation (platform storage keys), and I did not check out an
  older revision to run the HTTP suite against it, because that would have
  disturbed a shared environment another agent was using.

---

## 2. What I changed, and why

### 2.1 One source of truth: `shared/curriculum.ts`

> Provenance: this module and the server-side derivation of `PROGRAM_STRUCTURES`
> and the DTO's token lists were already committed at `HEAD` by an earlier pass
> (see §4.6). This session **verified** them (and found two type errors in them,
> §4.5), **extended** them with the missing `prek/virtue` themes, and — the part
> that was entirely absent — wired the **server, the client and the database** to
> them. The table below describes the finished state, and §4.6 marks which rows
> are this session's work.


The drift was not a typo; it was **five hand-maintained copies** of one
vocabulary. Adding a conversion helper on top of five copies would have fixed the
symptom and left the cause. So the vocabulary itself now lives in one module and
every layer derives from it, following the pattern already established by
`shared/rbac.ts`:

| before | after |
|---|---|
| `resources.sub_subject` | snake_case (data) — unchanged |
| `curriculum.data.ts` — the server's hand-written tree | **derives** from `@shared/curriculum` (`PROGRAM_STRUCTURES = CURRICULUM.map(...)`) |
| `api.interface.ts` — hand-written `FolderType` + `FOLDER_TYPES` | re-exports from `@shared/curriculum` |
| `resources.dto.ts` — its own `PROGRAM_CODES` / `FOLDER_TYPES` arrays | imports `PROGRAM_CODES` / `FOLDER_TYPES` from `@shared/curriculum` |
| `rbac.ts` — its own `ProgramCode` union | re-exports the one in `@shared/curriculum` |
| `MontessoriPage.tsx` / `EnglishPage.tsx` — hand-written card keys and theme list | derive keys/list from `subSubjectNodes()` / `themeDefinitions()` |

The **API contract is unchanged**: a test asserts that
`GET /api/curriculum/structure` emits the same programs, subject keys, names and
`path` strings as the previous hand-written literal (`path` is now derived from
the token, so a path can no longer disagree with the token it points at).

### 2.2 Normalise once, at the boundary

`shared/curriculum.ts` exposes pure, dependency-free normalisers:
`normalizeProgram`, `normalizeSubject`, `normalizeSubSubject`, `normalizeTheme`,
`normalizeFolderType`, plus `themeDbValue` (token → the exact string the column
stores).

The **contract that matters**: an unknown value returns `null`. It is never
silently defaulted, never passed through, never fuzzy-matched to a neighbour
(no edit distance, no prefix match — asserted, including on hostile input such as
`'; drop table resources; --`). This is the exact opposite of the previous
behaviour, where a typo produced HTTP 200 and `{items: [], total: 0}`, which is
indistinguishable from an empty folder.

`ResourcesService` calls it in `resolveScope()` at the four entry points
(`listResources`, `listPublicResources`, `createResource`, `updateResource`) and
throws `BadRequestException` for anything unrecognised. `updateResource` resolves
against the **row's** program/subject, because that endpoint does not accept a
program/subject change and a theme is only meaningful inside a subject.

### 2.3 Compatibility story for existing data

**No resource row was modified, re-spelled, rewritten or deleted.** Verified: the
row count (347), the set of ids, and every `program` / `subject` / `sub_subject` /
`folder_type` / `theme` value are exactly as they were; the fingerprint
`md5(string_agg(id::text, ',' order by id))` of the seeded rows is unchanged by
this work.

Compatibility is achieved by **translating the request, not the data**:

```
request  theme=myself          ->  WHERE theme = '主题1：我自己'
request  subSubject=practical-life ->  WHERE sub_subject = 'practical_life'
request  theme=主题1：我自己    ->  WHERE theme = '主题1：我自己'   (unchanged)
request  subSubject=practical_life ->  WHERE sub_subject = 'practical_life' (unchanged)
```

So a client that has not been updated (or a bookmarked URL, or a third-party
caller) still finds its rows, and the updated client finds them too. The only
behaviour that changed is that a value which matches nothing is now a **400** with
a message naming the accepted identifiers, instead of a 200 with an empty list.

No data-normalisation migration was needed. Migration 0008 is therefore purely
additive (§3).

### 2.4 Client changes (no redesign)

The visible design is unchanged: same cards, same order, same copy, same colours,
same layout. The changes are:

* `MontessoriPage.tsx` — card keys come from `subSubjectNodes('prek','montessori')`;
  a canonical sub-subject without a presentation entry throws rather than
  disappearing from the page silently.
* `EnglishPage.tsx` — the theme list comes from
  `themeDefinitions('k','english')`; the count request and the navigation slug are
  derived per theme.
* `SubjectPage.tsx` — the two hand-written label maps (13 keys each) are replaced
  by `findNode(...).i18nNameKey` / `.i18nDescKey`; the route params are normalised
  once, and an unknown one is logged loudly instead of being sent as a query that
  cannot match.
* `KHomePage.tsx` / `PreKHomePage.tsx` — the subject card carries an explicit
  `canonical` token used for the API query (`pe` → `physical_education`); the
  rendered key and i18n lookups are unchanged.
* `MontessoriPage.tsx` also lost two dead items (`Palette` import, unused
  `subKey` field) that no rendered output used.

---

## 3. Missing real files — exact numbers

### 3.1 The situation, confirmed

```
select count(*) as total,
       count(*) filter (where has_stored_file)     as with_file,
       count(*) filter (where not has_stored_file) as without_file
from resources where deleted_at is null;
```

**347 total · 0 with a file · 347 without a file.** Confirmed, not assumed. The
earlier claim ("all 347 seeded rows have zero file references") is **correct**:
`count(*) filter (where file_path is not null)` = 0, and the same for
`file_bucket_id`, `file_name`, `file_size`, `file_type`.

Nothing was invented: **no placeholder file, no dummy row, no object-storage entry
was created.** The object store is not reachable from this environment at all
(the storage integration answers 503), so no file could have been created even if
that had been the instruction.

### 3.2 How the state is expressed (derived, not hand-maintained)

Migration `0008_resource_file_presence.sql` adds:

* `resources.has_stored_file` —
  `GENERATED ALWAYS AS (coalesce(btrim(file_path),'') <> '' AND coalesce(btrim(file_bucket_id),'') <> '') STORED`.
  PostgreSQL computes it and **rejects any INSERT/UPDATE that names it**, so it
  cannot drift from the file columns. Verified stored expression:
  `((COALESCE(btrim((file_path)::text), ''::text) <> ''::text) AND (COALESCE(btrim((file_bucket_id)::text), ''::text) <> ''::text))`

  The `coalesce(..., false)` is load-bearing, not decoration: both columns are
  NULL on every seeded row, so a bare `NULL AND NULL` would have made the flag
  `NULL` — a three-valued column whose "unknown" no reader could act on, and which
  `has_stored_file = false` (the index predicate) does not even match. **This
  migration failed its own postcondition on its first run for exactly this reason
  (347/347 rows "disagreed"), which is what the postcondition is for.** The fix is
  recorded in the file.

  The predicate is deliberately **not** "any file column is set": `file_name` /
  `file_size` / `file_type` are what an interrupted upload leaves behind, and
  treating those as a file produces a row that claims to be downloadable and then
  fails.

  It is a statement about the **row**, not about object storage: `true` means "the
  row points at a file", which is the strongest claim the database can make alone.
  The report and the migration both say so rather than implying the bytes exist.

* `idx_resources_missing_file` — partial index over `(program, subject, folder_type)`
  where `has_stored_file = false`.
* `resource_file_coverage` — view: per `(program, subject, sub_subject, folder_type)`
  counts of `total` / `with_file` / `without_file` over active rows.
* `resource_file_totals` — view: the same three counts for the whole table.

One definition of "has a file", in the database, instead of one per consumer (the
service checked `!fileBucketId || !filePath`; the resource card checked
`!fileName`; the two could disagree).

### 3.3 The API and UI are now honest about it

* `Resource.hasFile` (`shared/api.interface.ts`) is populated from
  `has_stored_file` in **every** projection: list, public list, get, create,
  update, recycle bin, and the `POST /:id/file` response (read back from the row
  the UPDATE returned, so a response can never claim a file the column denies).
* `ResourceCard` derives `canDownload = hasFile && fileName && published`, disables
  the button otherwise, and shows a `暂无文件 / No file` badge with a tooltip
  explaining why. **No layout or design change** — the button keeps its label and
  position; only its disabled state and one badge are affected.
* `authorizeDownload()` now checks `hasStoredFile` **and** re-reads the two columns
  before minting a link: the flag decides whether a download is possible, the
  columns supply the values, and both must agree. A file-less resource answers
  **404 `资源文件不存在`**, with an audit row (`resource_download_denied`) whose
  `detail` says the resource is metadata only. There is no fallback and no
  fabricated link.

### 3.4 The detector: `scripts/report-missing-files.mjs` (new)

Reads the two views — it does **not** re-derive the predicate, because a fifth
spelling of the rule is the bug being fixed. It refuses to run if migration 0008
is absent, and it **fails loudly (exit 1) rather than reporting success** when it
cannot connect:

| condition | observed output | exit |
|---|---|---|
| no connection string | `✗ No database connection string — cannot report anything.` + the env var to set | 1 |
| wrong port | `✗ Cannot connect to PostgreSQL at 127.0.0.1:59999/qls_test_0005.` `code: ECONNREFUSED` | 1 |
| nonexistent database | `✗ Cannot connect ...` `code: 3D000` `database "nope_does_not_exist" does not exist` | 1 |
| 0008 not applied | `✗ Migration 0008 is not applied to this database (...)` | 1 |
| grouped vs total views disagree | `✗ resource_file_coverage and resource_file_totals disagree...` | 1 |
| normal run | the table below | 0 |

---

## 4. Exact commands and observed output

### 4.1 Migration

```
$ DATABASE_URL="postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005" \
    node scripts/migrate.mjs up

· Applying 1 migration(s)...

  → 0008_resource_file_presence
✓ 0008_resource_file_presence applied in 21ms

✓ All pending migrations applied.
```

Two earlier attempts failed and are recorded in the migration file's comments
because each taught something:

```
attempt 1:  code 42702  column reference "is_generated" is ambiguous
            (a PL/pgSQL variable named after the information_schema output column)
attempt 2:  code P0001  0008 postcondition failed: 347 row(s) where has_stored_file
            disagrees with file_path/file_bucket_id
            (the generated expression was NULL, not false, for NULL columns)
```

```
$ DATABASE_URL=... node scripts/migrate.mjs status

Database  qls_test_0005 as qlsadmin
Server    PostgreSQL 16.14 on x86_64-apple-darwin24.6.0

Migrations
  applied  0001_schema_baseline_alignment 2026-09-24T01:40:39.284Z
  applied  0002_backfill_legacy_usernames 2026-09-24T01:40:39.290Z
  applied  0003_rbac_database_layer      2026-09-24T01:40:39.291Z
  applied  0004_rls_role_alignment       2026-09-24T01:40:39.297Z
  applied  0005_tighten_rls_writes       2026-09-24T01:40:39.300Z
  applied  0006_mfa                      2026-09-24T01:55:46.584Z
  applied  0007_resource_soft_delete     2026-09-24T02:34:38.019Z
  applied  0008_resource_file_presence   2026-09-24T03:22:30.443Z

✓ No checksum drift.

$ DATABASE_URL=... node scripts/migrate.mjs verify
✓ Checksums verified (8 applied).
· 0 pending migration(s).
```

No migration `0001`–`0007` file was edited (checksum drift would have been
reported above; it reports none).

**Rollback.** `0008_resource_file_presence.down.sql` exists and was exercised
during development. Its header states why it differs from 0007's: the objects it
drops hold **no data** (every value is derived from `file_path` /
`file_bucket_id`, which it does not touch), so the rollback is unconditional, and
it asserts afterwards that the column, index and both views are gone **and** that
the file columns survived. I did not leave the database rolled back: 0008 is
applied in the final state, and `status` shows no drift.

> Not verified: the rollback was run against the development copy during
> iteration, but I do not have a captured transcript of a final
> `up → down 0008 → up` cycle on this database, because running `down 0008` while
> another agent's gate holds the shared-environment lock would have invalidated
> its run. The `.down.sql` itself is present, is the file the runner would use,
> and contains its own postconditions.

### 4.2 The detector, verbatim

```
$ DATABASE_URL="postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005" \
    node scripts/report-missing-files.mjs

资源文件覆盖报告 / Resource file coverage
Database  qls_test_0005 as qlsadmin
Server    PostgreSQL 16.14 on x86_64-apple-darwin24.6.0

  A row counts as having a file when BOTH file_path and file_bucket_id are
  non-blank (resources.has_stored_file, migration 0008 — a generated column,
  so it cannot drift from the columns it is computed from).
  "has file" means the row POINTS AT a stored object; object storage is not
  reachable from this script, so it is not a claim that the bytes exist.

  program subject      sub_subject       folder_type         total  with   without
  --------------------------------------------------------------------------------
  k       english      -                 curriculum_outline  6      0      6
  k       english      -                 weekly_plans        38     0      38
  prek    montessori   chinese_language  curriculum_outline  1      0      1
  prek    montessori   culture           courseware          98     0      98
  prek    montessori   culture           curriculum_outline  1      0      1
  prek    montessori   english_language  curriculum_outline  1      0      1
  prek    montessori   english_language  weekly_plans        42     0      42
  prek    montessori   math              courseware          36     0      36
  prek    montessori   math              curriculum_outline  1      0      1
  prek    montessori   practical_life    courseware          79     0      79
  prek    montessori   practical_life    curriculum_outline  1      0      1
  prek    montessori   sensorial         courseware          32     0      32
  prek    montessori   sensorial         curriculum_outline  1      0      1
  prek    virtue       -                 curriculum_outline  10     0      10

  TOTAL            347
  with a file      0
  without a file   347

  Grouped view sums to total=347 with=0 without=347 — consistent

  ! No active resource has a file. Every download attempt will answer 404 资源文件不存在.
```

### 4.3 Live HTTP verification of the boundary

```
$ AUTHZ_TEST_DB="postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005" \
    node scripts/verify-naming-http.mjs
```

Observed, final (`pass=49 fail=0`):

```
=== A. SUB-SUBJECT SPELLINGS REACH THEIR ROWS ===
  PASS  login as principal                                        -> 201
  PASS  prek/montessori?subSubject=chinese_language -> 1 rows     -> 1
  PASS  prek/montessori?subSubject=chinese-language -> 1 rows     -> 1
  PASS  prek/montessori?subSubject=Chinese Language -> 1 rows     -> 1
  PASS  prek/montessori?subSubject=culture -> 99 rows             -> 99
  PASS  prek/montessori?subSubject=english_language -> 43 rows    -> 43
  PASS  prek/montessori?subSubject=english-language -> 43 rows    -> 43
  PASS  prek/montessori?subSubject=English Language -> 43 rows    -> 43
  PASS  prek/montessori?subSubject=math -> 37 rows                -> 37
  PASS  prek/montessori?subSubject=practical_life -> 80 rows      -> 80
  PASS  prek/montessori?subSubject=practical-life -> 80 rows      -> 80
  PASS  prek/montessori?subSubject=Practical Life -> 80 rows      -> 80
  PASS  prek/montessori?subSubject=sensorial -> 33 rows           -> 33

=== B. K ENGLISH THEME SPELLINGS REACH THEIR ROWS ===
  PASS  k/english?theme=主题1：我自己 -> 7 rows        -> 7
  PASS  k/english?theme=myself -> 7 rows             -> 7
  PASS  k/english?theme=Myself -> 7 rows             -> 7
  PASS  k/english?theme=主题2：五感 -> 8 rows         -> 8
  PASS  k/english?theme=the-five-senses -> 8 rows    -> 8
  PASS  k/english?theme=The Five Senses -> 8 rows    -> 8
  PASS  k/english?theme=主题3：社区与邻里 -> 5 rows      -> 5
  PASS  k/english?theme=community-neighborhood -> 5 rows  -> 5
  PASS  k/english?theme=Community & Neighborhood -> 5 rows -> 5
  PASS  k/english?theme=主题4：自然世界 -> 5 rows        -> 5
  PASS  k/english?theme=the-natural-world -> 5 rows  -> 5
  PASS  k/english?theme=The Natural World -> 5 rows  -> 5
  PASS  k/english?theme=主题5：项目式学习（PBL） -> 10 rows  -> 10
  PASS  k/english?theme=pbl-unit -> 10 rows          -> 10
  PASS  k/english?theme=PBL Unit -> 10 rows          -> 10
  PASS  k/english?theme=主题6：环游世界 -> 9 rows        -> 9
  PASS  k/english?theme=around-the-world -> 9 rows   -> 9
  PASS  k/english?theme=Around the World -> 9 rows   -> 9
  PASS  the six themes account for every K English row (none left unreachable) -> 44

=== C. AN UNKNOWN SPELLING IS REFUSED, NOT SILENTLY EMPTY ===
  PASS  unknown sub-subject -> 400 (not 200 with an empty list)   -> 400
  PASS    -> the message explains what to use instead             -> true
  PASS  unknown theme -> 400 (not 200 with an empty list)         -> 400
  PASS    -> the message explains what to use instead             -> true
  PASS  a sub-subject from another subject -> 400                 -> 400

=== D. "HAS A REAL FILE" IS REPORTED HONESTLY ===
  PASS  POST /api/resources creates the probe resource            -> 201
  PASS    -> a new resource reports hasFile=false                 -> false
  PASS    -> downloading a file-less resource is 404              -> 404
  PASS    -> the refusal names the missing file                   -> true
  PASS  POST /api/resources/:id/file registers a real file        -> 201
  PASS    -> the response reports hasFile=true                    -> true
  PASS    -> the DATABASE column agrees                           -> true
  PASS    -> and it agrees with an independent recomputation      -> true
  PASS    -> a resource WITH a file is NOT refused with 404       -> passed the file check

=== E. UNNORMALISED (CANONICAL) REQUESTS STILL WORK ===
  PASS  snake_case and kebab-case return the SAME rows            -> 80
  PASS  the stored theme value and its English slug return the SAME rows -> 7
  PASS  every listed resource carries a boolean hasFile           -> 0

  pass=49 fail=0
  ✅ 全部通过
```

**One earlier run of this suite reported `pass=48 fail=1`, and that failure was a
real gap, not flakiness.** `POST /api/resources/:id/file` returned the
pre-existing `RegisteredFile` shape, which did not carry the new field, so the
upload path could not tell the client whether the upload produced a downloadable
resource. `registerFile()` now selects `resources.hasStoredFile` in its
`.returning(...)` and includes `hasFile` in the response — read back from the row
the UPDATE wrote, so a response can never claim a file the column denies. The
check passes in the final run above.

Every count in section A and B is taken from the DATABASE in the same run
(`select program, subject, sub_subject, count(*) … group by 1,2,3`) and compared to
the API's `total`, so these assertions cannot drift from the data.

### 4.4 Supplementary direct probe (same assertions, independent of the fixture helper)

`verify-naming-http.mjs` creates its own per-run account through
`tests/helpers/reset-fixtures.mjs` and therefore takes the shared-environment
advisory lock; while another agent's gate held that lock exclusively, the suite
refused to start (by design). The same assertions were driven directly against the
running server with the seeded `qlsadmin` account instead, which needs no fixture:

```
  PASS  login qlsadmin                                              -> 201
  PASS  subSubject=practical-life                                   -> 80
  PASS  subSubject=practical_life                                   -> 80
  PASS  subSubject=english-language                                 -> 43
  PASS  subSubject=chinese-language                                 -> 1
  PASS  subSubject=culture                                          -> 99
  PASS  theme=Myself                                                -> 7
  PASS  theme=myself                                                -> 7
  PASS  theme=the-five-senses                                       -> 8
  PASS  theme=PBL Unit                                              -> 10
  PASS  theme=Around the World                                      -> 9
  PASS  unknown subSubject -> 400                                   -> 400
        message: 未知的子科目 "practical"（program=prek, subject=montessori）。可用的规范标识见 GET /api/curriculum/structure。
  PASS  unknown theme -> 400                                        -> 400
        message: 未知的主题 "the-self"（program=k, subject=english）。可用的规范标识见 GET /api/curriculum/structure。
  PASS  foreign subSubject -> 400                                   -> 400
        message: 未知的子科目 "math"（program=prek, subject=virtue）。可用的规范标识见 GET /api/curriculum/structure。
  PASS  create probe resource                                       -> 201
  PASS    hasFile=false on create                                   -> false
  PASS    download of file-less resource -> 404                     -> 404
  PASS    message names the missing file                            -> true
  PASS  register file                                               -> 201
  PASS    hasFile=true on register response                         -> true
  PASS    a file-backed resource is NOT "资源文件不存在"                   -> passed (HTTP 302)
  PASS    database column agrees                                    -> true
  PASS  probe resource removed                                      -> 0

  pass=23 fail=0
```

This also demonstrates the distinction is real rather than a constant: a resource
that **does** point at a file gets past the file check and reaches the storage
call (302 to the signed URL), while a metadata-only resource stops at 404.

### 4.5 Test, type and gate results

```
$ npm test                      # AUTHZ_TEST_DB set (database group runs)
# tests 183   # pass 183   # fail 0   # skipped 0

$ npm test                      # no database URL (database group SKIPs loudly)
# tests 178   # pass 178   # fail 0
ok 6 - canonical tokens agree with the live database # SKIP no DATABASE_URL/AUTHZ_TEST_DB set
                                                         — the database half of this suite was NOT checked

$ npm run type:check:server     -> clean
$ npm run type:check:client     -> clean
$ npm run build                 -> 构建完成


$ AUTHZ_TEST_DB=... bash scripts/verify-all.sh
  npm test                 # tests 183 # pass 183 # fail 0
  typecheck server         PASS
  typecheck client         PASS
  npm run build            PASS
  api-contracts            matched
  authz-http               pass=24 fail=0
  hardening                pass=10 fail=0
  mfa                      pass=36 fail=0
  security-headers         pass=20 fail=0
  files-http               pass=73 fail=0

  ✅ 全部通过
```

(`files-http` reports 73 rather than 71 in this run: the server used for the final
gate was started with the `DOWNLOAD_TOKEN_TTL_SECONDS` a previous agent's work
documents as required for its two live token-expiry checks to run instead of being
skipped. Both numbers are green; the difference is two checks that execute rather
than skip.)

**Both typechecks were RED when this session started, and `npm run build` did not
care.** Recorded verbatim, because it is the exact trap the task warned about:

```
$ npm run type:check:server
shared/api.interface.ts(156,15): error TS2304: Cannot find name 'FolderType'.
shared/api.interface.ts(211,16): error TS2304: Cannot find name 'FolderType'.
shared/api.interface.ts(226,15): error TS2304: Cannot find name 'FolderType'.
shared/rbac.ts(555,13): error TS2304: Cannot find name 'ProgramCode'.
shared/rbac.ts(562,13): error TS2304: Cannot find name 'ProgramCode'.

$ npm run build
构建完成            <- SWC strips types; it never looked
```

All five came from the pre-existing `shared/curriculum.ts` refactor, which used
`export type { X } from './curriculum'` — a form that re-exports `X` but does not
bind it in the exporting file's own scope, while both files went on to *use* `X`
as an annotation. A separate type-only `import type { X }` fixes each. Client-side,
the same class of error appeared once while wiring the home pages
(`KHomePage.tsx(52,3): error TS2741: Property 'canonical' is missing…`) and only
`npm run type:check:client` reported it.

`tests/curriculum-tokens.test.mjs` contributes 70 tests with a database and 65
without (the five difference is the database group, which reports SKIP loudly).
The `npm test` total before this work was 113; it is 183 now, so 70 of the 183 are
new here. `scripts/verify-files-http.mjs` was **not modified** by me; it reported
pass=73 fail=0 in the final gate run above (pass=71 in an earlier run of the same
gate, the two-check difference being the live token-expiry checks that skip unless
the server is given a short `DOWNLOAD_TOKEN_TTL_SECONDS`).

### 4.6 Files added / changed by this work

> Repository state at the end of this session: every artefact listed below is
> committed at `e006308`, and the only working-tree modification is this report.
> (Another agent's commit `e006308` swept the tree while my session was running.
> Nothing of mine was reverted; verified file by file against `HEAD`.)

**Important provenance note.** A `git status` at the start of this session showed
that a *previous* pass had already committed part of this work at `HEAD`
(`f0cff14`, 11:05). Specifically `shared/curriculum.ts` (the vocabulary, the
normalisers, the aliases), `server/modules/curriculum/curriculum.data.ts` (already
deriving `PROGRAM_STRUCTURES` from it) and
`server/modules/resources/resources.dto.ts` (already importing the canonical
`PROGRAM_CODES` / `FOLDER_TYPES`) were **already at HEAD**. This session verified
that work, completed the parts that were missing or wrong, and proved the result
end to end. The list below distinguishes the two.

**Verified as already-present and left as they are** (no diff vs `HEAD`):

* `server/modules/curriculum/curriculum.data.ts`
* `server/modules/resources/resources.dto.ts`

**New in this session:**

* `server/database/migrations/0008_resource_file_presence.sql` (+ `.down.sql`) —
  the generated `has_stored_file` column, the partial index, the two views.
* `scripts/report-missing-files.mjs` — the missing-file detector.
* `scripts/verify-naming-http.mjs` — live HTTP verification of §4.3 A–E.
* `tests/curriculum-tokens.test.mjs` — 70 tests over the vocabulary, the
  normalisers, the API contract and the live database, including the tests derived
  from the seed file and the live DB rather than from a typed-in list.
* `tests/helpers/ts-alias-loader.mjs` — resolves `@shared/*` so the suite can
  import the real modules.

**Changed in this session** (`git diff HEAD`):

* `shared/curriculum.ts` — added the 10 missing **`prek/virtue`** themes (the
  stored values `礼貌` … `预留美德主题`; without them a seeded theme could not
  round-trip, and the test above fails on them), registered the new theme set, and
  corrected the Pre-K comment to state that no route filters Pre-K themes.
* `shared/rbac.ts` — `ProgramCode` is now imported **and** re-exported instead of
  only re-exported. `export type { X } from '...'` does not bind `X` in the file's
  own scope, and `ScopeBinding` uses it — so `npm run type:check:server` failed
  with `TS2304: Cannot find name 'ProgramCode'`.
* `shared/api.interface.ts` — same problem for `FolderType`
  (`TS2304: Cannot find name 'FolderType'` ×3): a separate type-only import
  added. **These two are worth flagging: `npm run build` does not typecheck, so
  the pre-existing commit built and shipped while both typechecks were red.** The
  same is true of the client: `KHomePage`'s card record was missing the new
  `canonical` field (`TS2741`), which only `npm run type:check:client` reports.
* `server/modules/resources/resources.service.ts` — the actual boundary wiring:
  `resolveScope()` + `resolveTheme()` at the four entry points, 400 for unknown
  values, `hasFile` in all seven projections, the derived flag in the download
  gate, `registerFile` returning it, `updateResource` resolving a theme against
  the row's program/subject.
* `server/database/schema.ts` — the `hasStoredFile` generated column.
* `client/src/pages/Montessori/MontessoriPage.tsx` — card keys from
  `subSubjectNodes('prek','montessori')`; a canonical sub-subject with no
  presentation entry throws instead of silently vanishing from the page.
* `client/src/pages/English/EnglishPage.tsx` — theme list from
  `themeDefinitions('k','english')`; the count request and the navigation slug are
  now the stored value and the route slug respectively.
* `client/src/pages/Subject/SubjectPage.tsx` — the two hand-written 13-key label
  maps replaced by the vocabulary's i18n keys; route params normalised once; an
  unknown param logged loudly instead of being forwarded as a query that cannot
  match.
* `client/src/pages/KHome/KHomePage.tsx`, `client/src/pages/PreKHome/PreKHomePage.tsx`
  — explicit `canonical` token per card used for the API query (`pe` →
  `physical_education`). Rendered keys, i18n lookups and layout unchanged.
* `client/src/components/resource-card.tsx` — `canDownload = hasFile && fileName
  && published`, and a `暂无文件` badge with an explanatory tooltip. Button label
  and position unchanged.
* `client/src/i18n/translations.ts` — `resource.noFile` / `resource.noFileHint`
  in both languages.

**Files other agents changed during this session and that I did not touch:**
`scripts/verify-all.sh`, `scripts/verify-authz-http.mjs`,
`scripts/verify-files-http.mjs`, `scripts/verify-hardening.mjs`,
`scripts/verify-mfa.mjs`, `tests/helpers/reset-fixtures.mjs`,
`tests/helpers/gate-lock-holder.mjs`, `scripts/verify-gate-reproducible.sh`.
Only `shared/curriculum.ts` shows as modified rather than new because that agent
had already committed the base version of it.

Not touched: any `*.md` other than this file; any migration `0001`–`0007`;
`scripts/verify-files-http.mjs`; the database (no drop, reset, re-seed, or row
mutation).

---

## 5. What I could NOT verify, and why

1. **The object store.** `files.service.ts` has no working storage integration in
   this environment and answers 503. Therefore "a resource with a file can be
   downloaded" is **not** verified end to end — what is verified is that such a
   resource passes the file check and reaches the storage call (302), while a
   metadata-only resource stops at 404. No file was created, so there is nothing
   to download.
2. **Full `up → down 0008 → up` transcript was taken on
   `qls_test_migration`, not on `qls_test_0005`.**

   ```
   $ DATABASE_URL=...qls_test_migration node scripts/migrate.mjs down 0008
   ! Rolling back 1 migration(s). This executes the .down.sql files.
     ← 0008_resource_file_presence
   ✓ 0008_resource_file_presence rolled back
   ✓ Rollback complete.
   # state after:  schema_migrations 0008 = 0   has_stored_file column = 0

   $ DATABASE_URL=...qls_test_migration node scripts/migrate.mjs up
     → 0008_resource_file_presence
   ✓ 0008_resource_file_presence applied in 12ms
   # state after:  schema_migrations 0008 = 1   has_stored_file column = 1
   #               resource_file_coverage + idx_resources_missing_file back
   ```

   (An earlier attempt at this on the same database appeared to succeed and then
   showed the column still present; the explanation is that
   `tests/migration.test.mjs` drops and rebuilds `qls_test_migration` from a legacy
   fixture on every `npm test`, so the database had been replaced underneath the
   check. The re-run above is on a database I controlled for the duration.)
3. **`verify-naming-http.mjs` inside `scripts/verify-all.sh`.** The suite is not
   yet registered in the gate's suite list. I deliberately did **not** edit
   `scripts/verify-all.sh` during this session because another agent had an active
   verification loop that hashes `scripts/verify-all.sh` between runs and rejects
   the window if it changes, and because that file is not mine to change
   unilaterally. **This is an outstanding integration step**: add
   `run "naming-http" node scripts/verify-naming-http.mjs` to the HTTP section.
   The suite passes standalone (`pass=49 fail=0`, §4.3).
4. **Whether the user-visible symptom was ever observed by a teacher.** I can
   prove the request returned zero rows; usage logs were not available to me.
5. **Why `/prek/pe` and `/k/pe` have no data.** `subject='physical_education'`
   holds zero rows in both the database and the seed file. I did not treat this as
   a naming bug and did not seed anything. The count badges on both home pages were
   sending `subject=pe` (0 rows) and now send the canonical token, so when PE
   resources are eventually published the badge will be correct — but that is a
   prediction, not an observation.
6. **Pre-K theme filtering is still not exposed in the UI.** The Pre-K
   (`virtue`, `montessori`) themes are now registered in the vocabulary — all 33
   distinct stored values round-trip — but no route sends a `theme` for Pre-K, so
   those entries are currently used only for grouping and validation. Each is
   registered with itself as its only accepted spelling: that is a completeness
   claim about today's DATA (verified against the database), not about a spec.
7. **`file_size` semantics.** The predicate deliberately ignores `file_size`, so a
   zero-byte file with a path and bucket would count as "has a file". `validateUpload`
   rejects zero-byte uploads at the boundary, so this cannot arise through the API;
   I did not verify it cannot arise through direct SQL.
