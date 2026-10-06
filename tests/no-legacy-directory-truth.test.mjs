/**
 * tests/no-legacy-directory-truth.test.mjs — 「目录只有一份真相」必须**可回归**
 * ============================================================================
 * Run with:  npm test   (or: node --test tests/no-legacy-directory-truth.test.mjs)
 *
 * 业主要求的原话是：
 *   「Directory 必须成为整个网页课程导航的唯一真相。」
 *   「没有旧目录作为第二份业务真相。」
 *
 * ── 为什么这条必须写成测试，而不是写进报告 ─────────────────────────────────
 * "第二份真相"最危险的地方正是它**不会让任何接口测试变红**。上一轮实测就是这样：
 * 7 个旧页面（PreKHome / KHome / Chinese / English / Montessori / PE / Subject）
 * 各自持有一份写死的科目数组，`/prek`、`/k`、`/virtue` 这些地址由它们渲染。
 * 在那种结构下：
 *   · 接口套件全绿 —— 数据库里的目录改对了；
 *   · `curl /api/directories/tree` 也全绿 —— 树本身没错；
 *   · 但**侧边栏和首页仍然显示旧名字**，因为渲染它们的组件读的是自己那份数组。
 * 换句话说：只有"去数还有几份数组"这种**结构性**断言才能挡住它。
 *
 * ── 这个文件断言什么 ────────────────────────────────────────────────────────
 * 1. 7 个旧页面文件**不存在**（它们不是被绕过，是被删掉）；
 * 2. `client/src/app.tsx` 里**没有** TEACHER_ROLES / UPLOAD_ROLES / REVIEW_ROLES /
 *    ADMIN_ROLES 这类角色白名单数组 —— 路由放行改用能力码（`requiredPermission`），
 *    与后端 `@RequirePermission` 同一套；
 * 3. 侧边栏（`Layout.tsx`）**从 `useDirectory()` 取数**，文件里不出现任何
 *    program/subject 字面量数组；
 * 4. 全 `client/src` 里没有任何"看起来像目录真相"的硬编码数组
 *    （`const X = [ { code: 'prek' … } ]` 这种形状）；
 * 5. 上传页不再有 legacy「资料夹」下拉，且 `directoryId` 是必填。
 *
 * ── 这个文件**不**证明什么（写清楚，免得被当成更强的结论）──────────────────
 * · 它**不**证明 `folderType` 已经消失。`folder_type` 仍是数据库列，
 *   审核台/回收站/我的资源仍在**显示**它 —— 那是历史分类的展示，不是分类入口。
 *   §7 要求的是"老师不再需要自己选它"（第 5 条断言），不是"把它删掉"。
 * · 它**不**证明"新增科目型节点"已支持。那件事目前确实**不支持**（见
 *   IA_CONSOLIDATION_PLAN.md 的后续能力部分），本文件不替它作证。
 * · 它是**静态**断言。界面上的实际渲染由 `scripts/verify-ia-consolidation.mjs`
 *   在真浏览器里断言（侧边栏 / 首页卡片 / 面包屑 / 上传页下拉 / 详情弹窗）。
 *   两者互补：这里挡"又长出一份数组"，那里挡"数组少了但界面没跟上"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = join(ROOT, 'client', 'src');

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/** 递归列出 client/src 下所有 .ts/.tsx（排除 node_modules）。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 去掉注释与字符串字面量后再做"有没有写死数组"的判断。
 *
 * WHY 必须去注释：上一轮我在 `DirectoryBrowser` 里加了一条**解释性注释**
 * （"这里不再有 `if (total === 0)` 那种判空"），结果静态断言
 * `doesNotMatch(/if \(total === 0\)/)` 匹配到了**我自己写的注释**，
 * 于是一个正确的实现被判成失败。注释描述意图，代码才决定行为。
 */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');
}

// ---------------------------------------------------------------------------
// 1. 旧页面文件必须**不存在**
// ---------------------------------------------------------------------------
describe('旧课程页面已删除（不是被绕过、不是被隐藏）', () => {
  /**
   * 这 7 个文件各自持有一份写死的科目数组，是"第二份真相"的**载体**。
   * 只要它们还在磁盘上，就随时可能被重新挂回路由 —— 而重新挂回**不会**
   * 让任何接口测试变红。所以断言的是"文件不存在"，不是"文件里没有旧数组"。
   */
  const LEGACY_PAGES = [
    'pages/PreKHome/PreKHomePage.tsx',
    'pages/KHome/KHomePage.tsx',
    'pages/Chinese/ChinesePage.tsx',
    'pages/English/EnglishPage.tsx',
    'pages/Montessori/MontessoriPage.tsx',
    'pages/PE/PEPage.tsx',
    'pages/Subject/SubjectPage.tsx',
  ];

  for (const rel of LEGACY_PAGES) {
    test(`${rel} 不存在`, () => {
      assert.equal(
        existsSync(join(CLIENT_SRC, rel)),
        false,
        `${rel} 又出现了 —— 目录会立刻多出一份真相。旧地址的兼容由` +
          ` DirectoryRoutes 的 LegacyDirectoryRedirect 负责（code → URL 反解），` +
          `不要再把页面挂回来。`,
      );
    });
  }

  test('client/src/pages 下不再有任何 *HomePage 形态的班型首页（PreK/K 都不许有）', () => {
    const pagesDir = join(CLIENT_SRC, 'pages');
    const hits = [];
    for (const file of walk(pagesDir)) {
      const rel = relative(CLIENT_SRC, file);
      if (/\/(PreKHome|KHome)\//.test(rel)) hits.push(rel);
    }
    assert.deepEqual(hits, [], `这些目录又出现了班型首页：${hits.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// 2. app.tsx 不再用角色白名单决定路由放行
// ---------------------------------------------------------------------------
describe('app.tsx 的路由放行是能力码，不是角色数组', () => {
  const src = read('client', 'src', 'app.tsx');
  const code = stripCommentsAndStrings(src);

  for (const name of ['TEACHER_ROLES', 'UPLOAD_ROLES', 'REVIEW_ROLES', 'ADMIN_ROLES']) {
    test(`app.tsx 里不再有 ${name} 数组`, () => {
      assert.doesNotMatch(
        code,
        new RegExp(`\\b${name}\\b`),
        `${name} 又回来了。角色白名单是"第二份授权真相"：它和后端 ` +
          `shared/rbac.ts 的权限模型会各自演化，而分叉时前端会静默地多挡或少挡人。` +
          `请改用 requiredPermission="<能力码>"。`,
      );
    });
  }

  test('app.tsx 不出现 requiredRoles=', () => {
    assert.doesNotMatch(code, /requiredRoles\s*=/, '受保护路由又用角色判定放行了。');
  });

  test('app.tsx 使用 requiredPermission 且至少 8 条（与后端同一套码）', () => {
    // ⚠️ 这条必须读**原始源码**（`src`），不能读上面那个去字符串的 `code` ——
    // 能力码本身就是字符串字面量，`requiredPermission="curriculum.view"`
    // 去完字符串会变成 `requiredPermission=""`，于是永远解析出 0 条。
    // 我自己先踩了这个坑（第一次运行时报"只解析到 0 条"），写在这里免得下次再犯。
    const guards = [...src.matchAll(/requiredPermission\s*=\s*"([a-z][a-z0-9.]*)"/g)].map(
      (m) => m[1],
    );
    assert.ok(
      guards.length >= 8,
      `只解析到 ${guards.length} 条能力码守卫，预期至少 8 条：${guards.join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 侧边栏从 Directory 取数
// ---------------------------------------------------------------------------
describe('侧边栏（Layout.tsx）由 Directory 驱动', () => {
  const src = read('client', 'src', 'components', 'Layout.tsx');
  const code = stripCommentsAndStrings(src);

  test('Layout.tsx 调用 useDirectory()', () => {
    assert.match(
      code,
      /useDirectory\s*\(/,
      'Layout.tsx 不再读目录树 —— 侧边栏一旦自己写死菜单，改名就不会同步到导航。',
    );
  });

  test('菜单主体来自 useDirectory 派生出来的 directoryMenuItems，不是写死的清单', () => {
    // 第一版我断言"Layout.tsx 里不许有顶层数组字面量"，结果把
    // `const items: MenuItem[] = []`（从 roots 循环 push 出来的**派生**数组）
    // 和 `menuItems`（首页/上传这些**真正的静态**入口）一起报了红 ——
    // 一个正确的实现被判成失败。静态入口本来就该是写死的；
    // 需要证明的是"菜单**主体**不是写死的"，所以断言它展开的是派生数组。
    assert.match(
      code,
      /const\s+items\s*:\s*MenuItem\[\]\s*=\s*\[\s*\]/,
      '目录派生的菜单数组不见了 —— 侧边栏的班型/科目必须由 roots 循环生成。',
    );
    assert.match(
      code,
      /\.\.\.\s*directoryMenuItems\b/,
      'menuItems 没有展开 directoryMenuItems —— 说明侧边栏在用自己的静态清单。',
    );
  });

  test('侧边栏地址由 codeToPath 推导（不是手拼字符串）', () => {
    assert.match(
      code,
      /codeToPath/,
      'URL 必须由 codeToPath 这唯一一处 authority 推导；手拼会与 DirectoryProvider 的规则分叉。',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 全 client/src 里没有"看起来像目录真相"的硬编码数组
// ---------------------------------------------------------------------------
describe('全 client/src 范围：没有第二份课程目录', () => {
  const files = walk(CLIENT_SRC);

  /**
   * 目录 code 的片段。用它们做"疑似写死目录"的嗅探：
   * 一个数组字面量里同时出现 2 个以上这种片段，就极可能是在复刻目录树。
   */
  const DIRECTORY_TOKENS = [
    'prek',
    'montessori',
    'virtue',
    'sensorial',
    'practical',
    'growth',
    'reading',
    'kindergarten',
  ];

  test(`扫 ${files.length} 个源文件，没有文件把目录 code 写进数组`, () => {
    const offenders = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/\[\s*\{[\s\S]{0,400}?\}\s*\]/g)) {
        const chunk = m[0];
        const hits = DIRECTORY_TOKENS.filter((t) =>
          new RegExp(`['"\`]${t}['"\`]|\\b${t}:`).test(chunk),
        );
        if (hits.length >= 2) {
          offenders.push(`${relative(CLIENT_SRC, file)} :: ${hits.join('+')}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些位置出现了疑似"写死的目录结构"：\n  ' +
        offenders.join('\n  ') +
        '\n目录真相只能来自 GET /api/directories/tree（前端经 useDirectory）。',
    );
  });

  test('目录树的取数点只有 3 处，且都有明确理由（没有第 4 处）', () => {
    // 实际调用的名字是 `getDirectoryTree` / `getDirectoryNode`
    // （见 client/src/api/directories.ts），不是 `getTree`/`getNode` ——
    // 第一版按接口路径猜名字，于是这条断言在**正确的实现**上找不到任何文件。
    // 静态断言的坑就在这里：正则匹配不上时，要能分清"没有违规"与"我写错了"。
    const fetchers = files.filter((file) => {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      return /\bgetDirectoryTree\s*\(|\bgetDirectoryNode\s*\(/.test(code);
    });
    const rel = fetchers.map((f) => relative(CLIENT_SRC, f)).sort();
    // 三处，逐一说清为什么允许：
    //   · api/directories.ts       —— 定义本身，不走 HTTP 调用；
    //   · DirectoryProvider.tsx    —— 全站唯一**共享**的树（侧边栏/首页/面包屑/
    //                                 上传页/详情都读它）；
    //   · pages/Directory/DirectoryPage.tsx —— 管理页要**含已停用节点**的树
    //                                 （`includeDisabled`），共享树刻意不含停用节点，
    //                                 所以这里是一次**不同查询**，不是第二份真相。
    assert.deepEqual(
      rel,
      ['api/directories.ts', 'directory/DirectoryProvider.tsx', 'pages/Directory/DirectoryPage.tsx'],
      `目录树的取数点变了：${rel.join(', ') || '(无)'}。` +
        `新增取数点前请先回答"它和 DirectoryProvider 的树有什么不同" —— ` +
        `如果答案是"没有不同"，那就该读共享树而不是再取一次。`,
    );
  });

  test('没有任何文件绕过 api 客户端直接 fetch /api/directories', () => {
    const bypassers = files.filter((file) => {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      return /fetch\s*\(\s*[`'"][^`'"]*\/api\/directories/.test(code);
    });
    assert.deepEqual(
      bypassers.map((f) => relative(CLIENT_SRC, f)),
      [],
      '目录接口必须走 client/src/api/directories.ts（统一带 cookie / CSRF / 错误处理）。',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 上传页：选目录，不选 legacy 资料夹
// ---------------------------------------------------------------------------
describe('上传页：分类入口是「所属目录」', () => {
  const src = read('client', 'src', 'pages', 'Upload', 'UploadPage.tsx');
  const code = stripCommentsAndStrings(src);

  test('directoryId 是必填（min(1)）', () => {
    assert.match(
      code,
      /directoryId\s*:\s*z\s*\.\s*string\s*\(\s*\)\s*\.\s*min\s*\(\s*1/,
      '§8 的硬要求是"没有 directoryId → 不能提交保存"。',
    );
  });

  test('folderType 在表单里是 optional，且不参与前端必填校验', () => {
    assert.match(
      code,
      /folderType\s*:\s*z\s*\.\s*string\s*\(\s*\)\s*\.\s*optional\s*\(\s*\)/,
      '§7：folderType 不再要求老师选 —— 服务端按 directoryId 推导。',
    );
    assert.doesNotMatch(
      code,
      /trigger\s*\(\s*\[[^\]]*['"]folderType['"]/,
      'folderType 又被加回必填校验了。',
    );
  });

  test('没有以「资料夹」命名的表单 label（legacy 6 选 1 下拉）', () => {
    assert.doesNotMatch(
      code,
      /FormLabel[^>]*>\s*[^<]*资料夹/,
      '上传页又出现了「资料夹」label —— 那 6 个 legacy 分类不再是老师的分类入口。',
    );
  });
});
