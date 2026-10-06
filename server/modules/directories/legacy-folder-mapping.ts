import type { FolderType } from '@shared/api.interface';

/**
 * 目录节点 → legacy `resources.folder_type` 的**唯一映射表**。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * §7 的决定：**不要再让老师在上传页手动选那 6 个 legacy 资料夹**
 * （`curriculum_outline` / `weekly_plans` / `courseware` / `materials` /
 * `observation` / `research_archive`）。老师只需要选"这份资源放到哪个目录"，
 * 剩下那个字段由服务端**自动维护**。
 *
 * `folder_type` 列是 `NOT NULL` 且历史查询（`WHERE folder_type = …`）与索引
 * `idx_resources_folder` 都在用它，所以它不能被删掉 —— 它从"用户要填的字段"
 * 降级成"服务端维护的兼容列"。这里就是维护规则，只有一份。
 *
 * ⚠️ 映射不是猜的，是 §9 逐条给的：
 *   `curriculum_outline → 课程大纲`、`weekly_plans → 教学详案`、
 *   `courseware`/`materials → 教学资源`、`observation → 考核评估`。
 * `research_archive` **在 PDF 里没有对应**，所以它**反向映射不到任何目录**
 * （本表里不出现它），也就不会被自动写入 —— 强行给它编一个目录，
 * 正是业主明确禁止的"为了看起来完成而猜"。
 *
 * 与 migration 0012 的关系（这段历史必须留在这里，否则下一个人会以为两者矛盾）
 * ---------------------------------------------------------------------------
 * `0012_resource_directory.sql` 当初**刻意没有**编码这张映射表，理由写得很清楚：
 *   「只有 curriculum_outline→outline 是同名，其余（courseware→?、weekly_plans→lesson?、
 *     observation→assessment?、research_archive→无对应）都需要业务判断，PDF 没有规定。
 *     用户明确要求'PDF 没有明确规定的地方不要擅自扩大业务含义'，所以一律留 NULL。」
 * 于是那次回填只把资源挂到**科目节点**，资料夹级归属留空
 * —— 这也是今天"348 条只到科目层"的来源，不是 bug。
 *
 * **现在业主在 §9 里把那张映射表逐条给出来了**，所以本文件才存在。
 * 但两件事必须同时成立，否则就是对 0012 那个决定的背叛：
 *   1. 迁移文件**一个字都不改**（它有 SHA-256 校验，改了 `migrate:verify` 会拒绝迁移，
 *      而且生产上早已应用 —— 见 `scripts/migrate.mjs` 的 checksum drift 检查）；
 *   2. 这张表**只作用于新增写入与管理员显式同步**，绝不回头批量改写历史行的
 *      `folder_type`。§9 要求的是"如实报告、不要篡改"，而不是"悄悄对齐"。
 * 也就是说：历史行仍然是它本来的样子（`LEGACY_RESOURCE_DIRECTORY_MIGRATION_REPORT.md`
 * 如实统计了这一点），而从此以后新建的资源不会再产生含糊的分类。
 */

/**
 * 官方资料夹节点的 code 后缀 → legacy 值。
 *
 * 用 **code 后缀**而不是中文 `name` 做键：`name` 是可改的显示名
 * （§5：「美德」可以改成「美德课程」），拿显示名当程序判断的键，
 * 管理员改个名字就会把映射改错。code 是稳定标识，改不了。
 *
 * 于是「显示名称可改」与「自动分类仍然正确」这两件事不再互相冲突。
 */
const CODE_SUFFIX_TO_FOLDER_TYPE: Record<string, FolderType> = {
  outline: 'curriculum_outline',
  lesson: 'weekly_plans',
  resource: 'courseware',
  assessment: 'observation',
};

/** 目录节点在本模块需要的最小形状（只读，不持有 ORM 行对象）。 */
export interface LegacyFolderMappingInput {
  code: string;
  name: string;
  type: string;
}

/**
 * 从官方资料夹节点推导 legacy 值；不是官方资料夹（例如自建文件夹）返回 null。
 *
 * 判定用 `code` 的最后一段：`prek:virtue_outline` → `outline`。
 */
export function folderTypeFromDirectoryNode(node: LegacyFolderMappingInput): FolderType | null {
  if (node.type !== 'folder') return null;
  return CODE_SUFFIX_TO_FOLDER_TYPE[suffixOf(node.code)] ?? null;
}

/**
 * 从一个目录 code 里取出**资料夹后缀**（`outline` / `lesson` / `resource` / `assessment`）。
 *
 * ⚠️ 这里踩过一个真实的坑，值得写下来：
 * 第一版是 `code.split(':').pop()` —— 对**官方资料夹根本匹配不上**。
 * 因为官方资料夹的 code 是 `prek:virtue_outline`（末段是 `virtue_outline`），
 * 而表的键是 `outline`。于是 `folderTypeFromDirectoryNode()` **永远返回 null**，
 * 新建资源直接 400「无法为该目录推导历史资料夹分类」——
 * 也就是说做完整套 UI 之后，**整个上传功能是坏的**。
 *
 * 之所以没被更早发现：这条路径直到"用真浏览器/真接口建一条资源"才会走到，
 * 而单元测试只断言了「映射表里没有 research_archive」这类静态事实。
 * 是门禁（files-http / resource-versions / upload-web 一起红）把它逼出来的。
 *
 * 正确规则按顺序：
 *   1. 取最后一个 `:` 段：`k:chinese:reading_lesson` → `reading_lesson`
 *   2. 去掉自建文件夹的 `.custom_xxx` 尾巴：`virtue_lesson.custom_x` → `virtue_lesson`
 *   3. 取**最后一个** `_` 之后的部分：`virtue_outline` → `outline`
 */
export function folderSuffixOf(code: string): string | null {
  const suffix = suffixOf(code);
  return CODE_SUFFIX_TO_FOLDER_TYPE[suffix] === undefined ? null : suffix;
}

function suffixOf(code: string): string {
  const lastSegment = code.split(':').pop() ?? '';
  const withoutCustom = lastSegment.split('.')[0];
  const underscore = withoutCustom.lastIndexOf('_');
  return underscore === -1 ? withoutCustom : withoutCustom.slice(underscore + 1);
}

/**
 * 自建文件夹 → 它**最近的一个官方资料夹祖先**的 legacy 值。
 *
 * 自建文件夹本身没有 legacy 分类（它的 code 形如
 * `prek:virtue_lesson.custom_xxx`，末段是随机的 `.custom_*`）。
 * 但它的父节点一定是一个官方资料夹（服务端只允许在
 * `allow_custom_folders = true` 的叶节点下建），所以沿着 code 的
 * `:` 与 `.` 逐级剥掉，第一个能映射上的就是答案。
 *
 * 找不到就返回 null —— 调用方必须**明确报错**而不是编一个值。
 */
export function folderTypeForCustomFolder(ancestorCodes: string[]): FolderType | null {
  for (const code of ancestorCodes) {
    const mapped = CODE_SUFFIX_TO_FOLDER_TYPE[suffixOf(code)];
    if (mapped !== undefined) return mapped;
  }
  return null;
}

/** 供测试与脚本核对：本表**刻意**不包含 `research_archive`。 */
/**
 * 用真实的官方资料夹 code 形态**自检**这张表。
 *
 * 为什么需要它：上面那个 bug 的本质是"表的键"与"真实 code 的形态"不匹配，
 * 而两者都是静态数据 —— 单测很容易写成"断言表里有什么"，
 * 于是表错了测试也跟着错。这里改成用**真实形态的样本 code** 走一遍推导函数，
 * 任何形态变化（例如将来 code 改成 `prek:virtue.outline`）都会立刻炸出来。
 */
export function assertLegacyFolderMappingIntegrity(): void {
  const samples: Array<[string, string, FolderType]> = [
    ['prek:virtue_outline', 'folder', 'curriculum_outline'],
    ['prek:virtue_lesson', 'folder', 'weekly_plans'],
    ['prek:virtue_resource', 'folder', 'courseware'],
    ['prek:virtue_assessment', 'folder', 'observation'],
    ['k:chinese:reading_lesson', 'folder', 'weekly_plans'],
    ['k:chinese:arts_resource', 'folder', 'courseware'],
    // 自建文件夹：靠祖先链推导
    ['prek:virtue_lesson.custom_abc123', 'folder', 'weekly_plans'],
  ];
  for (const [code, type, expected] of samples) {
    const got =
      folderTypeFromDirectoryNode({ code, name: '', type }) ??
      folderTypeForCustomFolder([code]);
    if (got !== expected) {
      throw new Error(
        `legacy-folder-mapping 自检失败：code=${code} 期望 ${expected}，实际 ${String(got)}。` +
          '要么映射表与真实 code 形态不一致，要么 suffixOf() 的规则需要更新。',
      );
    }
  }
}

export const LEGACY_FOLDER_MAPPING_ENTRIES: ReadonlyArray<{
  codeSuffix: string;
  folderType: FolderType;
  pdfFolderName: string;
}> = [
  { codeSuffix: 'outline', folderType: 'curriculum_outline', pdfFolderName: '课程大纲' },
  { codeSuffix: 'lesson', folderType: 'weekly_plans', pdfFolderName: '教学详案' },
  { codeSuffix: 'resource', folderType: 'courseware', pdfFolderName: '教学资源' },
  { codeSuffix: 'assessment', folderType: 'observation', pdfFolderName: '考核评估' },
];
