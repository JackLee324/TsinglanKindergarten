/**
 * directory-vocabulary.ts — 目录树节点与规范课程词汇之间的**唯一**换算表。
 * =============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `directories` 表里的 `code` 是**树路径**（`prek:pe`、`k:chinese:reading`），
 * 而 `resources.subject` 与 `shared/curriculum.ts` 用的是**规范 token**
 * （`physical_education`、`picture_books`）。两者不是同一套拼写
 * —— 这正是本项目历史上反复出现的「同一个东西五种写法」缺陷形态
 * （见 shared/curriculum.ts 头部的考证）。
 *
 * 所以换算只写在这里一处，且**必须**与 `@shared/curriculum` 对齐：
 * 本文件不发明任何 token，它只声明「目录节点 code → 已存在的规范 token」。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 两个节点没有规范 token —— 这是 PDF 要求、需要业主决策的真实缺口
 * -----------------------------------------------------------------------------
 * 业主给的《教师平台》PDF 比现有应用**多**两个科目（docs/DIRECTORY_SPEC.md §2.2）：
 *
 *   `prek:english`   Pre-K 英文
 *   `k:chinese:arts` K 中文教学 · 美育
 *
 * 而 `shared/curriculum.ts` 的 `CURRICULUM` 里：
 *   * Pre-K 只有 virtue / montessori / physical_education —— **没有英文**；
 *   * K 中文的子科是 ancient_poetry / picture_books / drama / stem —— **没有美育**（PDF 有美育、无戏剧）。
 *
 * 我**不**擅自把它们塞进 `CURRICULUM`：那会改变 `GET /api/curriculum/structure`
 * 的输出、进而改变现有页面渲染的科目卡，属于「未经确认的产品变更」。
 * 我也**不**给它们编一个 token：编出来的 token 没有任何角色授权覆盖它，
 * 等于凭空造出一个谁都没有权限的科目。
 *
 * 本文件的处理是**显式登记为 null（非规范）**，并让可见性判定在这种情况下
 * **失败关闭**（见 directories.service.ts 的 isSubjectVisible）：
 * 只有「整班型可见」的账号（平台管理员 / prek_head / k_head / 配班看结构）
 * 能看到它们；按科目点授的账号（pe_specialist）看不到 —— 因为它们本来就不是体能。
 * 不会出现「因为 token 认不出来，所以谁都能看」这种放开。
 *
 * 需要业主确认的事项（已记入 FINAL_COMPLETION_REPORT 待决项）：
 *   (1) 是否把 Pre-K 英文 / K 美育 正式纳入规范科目词汇（以及是否保留现有的「戏剧」）；
 *   (2) 纳入后由哪些角色默认持有这两个科目的授权。
 */

import type { ProgramCode } from '@shared/curriculum';

/**
 * 目录树里 `type IN ('subject','sub_subject')` 的节点 code → 规范 subject token。
 *
 * 值为 `null` = 该科目在规范词汇中**不存在**（PDF 新增，见文件头）。
 * `undefined`（即没写进来）= 编程错误：本文件未登记的节点。查询前必须先
 * `normalizeDirectoryCode()`，未登记一律当作不可见 —— 缺一条映射会让科目消失，
 * 而不会让它对所有人开放。
 */
export const DIRECTORY_SUBJECT_TO_CANONICAL: Readonly<Record<string, string | null>> = Object.freeze({
  // ---- Pre-K ----
  'prek:virtue': 'virtue',
  'prek:montessori': 'montessori',
  'prek:pe': 'physical_education',
  'prek:english': null, // PDF 新增，规范词汇里没有 Pre-K 英文

  // ---- K ----
  'k:chinese': 'chinese',
  'k:english': 'english',
  'k:pe': 'physical_education',

  // ---- K · 中文教学的子科（PDF 的 4 个子科）----
  // 注意：PDF 的「绘本阅读」对应规范词汇的 picture_books（绘本），
  // 这是显示名不同、实体相同；「古诗」「STEM」逐字相同。
  'k:chinese:reading': 'picture_books',
  'k:chinese:poetry': 'ancient_poetry',
  'k:chinese:stem': 'stem',
  'k:chinese:arts': null, // PDF 新增「美育」；规范词汇这里是「戏剧」drama
});

/**
 * 目录树里 `type = 'program'` 的 code → 规范 ProgramCode。
 * `root:*` / `growth_*` 节点不属于任何班型，返回 null。
 */
export function programOfDirectoryCode(code: string): ProgramCode | null {
  const head = code.split(':')[0];
  return head === 'prek' || head === 'k' ? head : null;
}

/** 该 code 是否是已登记的科目节点（含显式登记为 null 的 PDF 新增科目）。 */
export function isKnownSubjectCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIRECTORY_SUBJECT_TO_CANONICAL, code);
}

/**
 * 规范 token，或 null（PDF 新增 / 未登记）。
 *
 * 调用方**必须**先处理 `isKnownSubjectCode` 为 false 的情况并当作不可见，
 * 不要用这里的 null 去代表两种不同含义。分成两个函数就是为了不混淆
 * 「已知但非规范」与「根本没登记」。
 */
export function canonicalSubjectOfDirectoryCode(code: string): string | null {
  return DIRECTORY_SUBJECT_TO_CANONICAL[code] ?? null;
}

/** 全部规范科目 code（便于断言与测试遍历）。 */
export function knownSubjectCodes(): string[] {
  return Object.keys(DIRECTORY_SUBJECT_TO_CANONICAL);
}

/** 没有规范 token 的 PDF 新增科目 —— 供自检/报告使用，不参与鉴权放开。 */
export function pdfOnlySubjectCodes(): string[] {
  return Object.entries(DIRECTORY_SUBJECT_TO_CANONICAL)
    .filter(([, token]) => token === null)
    .map(([code]) => code);
}
