import type { ProgramStructure, FolderType } from '@shared/api.interface';
import {
  CURRICULUM,
  FOLDER_DEFINITIONS as CANONICAL_FOLDER_DEFINITIONS,
  type CurriculumNode,
} from '@shared/curriculum';

/**
 * The curriculum tree served by `GET /api/curriculum/structure`.
 *
 * THIS FILE NO LONGER DECLARES THE VOCABULARY. It used to hold the only
 * hand-written copy of the subject and sub-subject tokens on the server, while
 * the client held others (`practical-life` in the Montessori card links,
 * `practical-life` again in SubjectPage's label map, `pe` in the permission
 * matrix) and the database held the stored values (`practical_life`). Four
 * copies, three spellings, no conversion — 123 Pre-K rows were unreachable.
 *
 * The tokens now live in ONE place (`@shared/curriculum`) and this module
 * DERIVES the API shape from them. `path` is derived from the canonical keys
 * rather than typed by hand, so a path can no longer disagree with the token it
 * points at.
 *
 * BACKWARD COMPATIBILITY: the emitted JSON is identical to the previous
 * hand-written literal for every program/subject/sub-subject key, name and path,
 * and `normalizeSubject` / `normalizeSubSubject` accept every spelling that
 * existed before, so neither a client nor a stored row has to change.
 */
function toSubjectNode(node: CurriculumNode, parentPath: string): ProgramStructure['subjects'][number] {
  const path = parentPath ? `${parentPath}/${node.key}` : node.key;
  return {
    key: node.key,
    name: node.name,
    nameEn: node.nameEn,
    path,
    ...(node.children && node.children.length > 0
      ? { children: node.children.map((child) => toSubjectNode(child, path)) }
      : {}),
  };
}

export const PROGRAM_STRUCTURES: ProgramStructure[] = CURRICULUM.map((program) => ({
  program: program.program,
  name: program.name,
  nameEn: program.nameEn,
  subjects: program.subjects.map((subject) => toSubjectNode(subject, '')),
}));

export interface FolderDefinition {
  key: FolderType;
  name: string;
  nameEn: string;
}

/**
 * The six folder types, from the canonical vocabulary.
 *
 * Previously a second local copy of the same six tokens (the others being
 * `@shared/api.interface` and `resources.dto.ts`'s own array).
 */
export const FOLDER_DEFINITIONS: FolderDefinition[] = CANONICAL_FOLDER_DEFINITIONS;

// =============================================================================
// ROLE DEFINITIONS
// =============================================================================
// MOVED to shared/rbac.ts — the single source of truth for roles, permissions
// and scope. This local copy had drifted: it listed only 7 roles and was
// MISSING `k_assistant`, so `GET /api/curriculum/roles` could not label that
// role in the permission-matrix UI, while `RoleCode` claimed 8 roles.
//
// Re-exported here so existing imports of ROLE_DEFINITIONS from this module
// keep working without change.
export type { RoleDefinition } from '@shared/rbac';
export { ROLE_DEFINITIONS } from '@shared/rbac';

// ---------------------------------------------------------------------------
// 冻结导出的课程数据（§21 结构性防线）
// ---------------------------------------------------------------------------
// `CurriculumService.getStructure()` 曾经 `return PROGRAM_STRUCTURES`，并在
// `hasPeSpecialist` 分支对**同一个共享对象**执行 `existing.subjects.push(...)`。
// 后果：一个同时持有 prek_head + pe_specialist 的账号发一次请求，就会把「体能」
// 永久追加进全局 Pre-K 科目表，此后所有账号（含 visitor）都看到被改过的结构 ——
// 「用户 A 改变了用户 B 看到的数据」。
//
// 服务层现在返回深拷贝（`cloneForResponse`）。这里再深冻结一层，作为**结构性**保证：
// 万一将来有人又直接对共享常量做 push/splice，会立刻 `TypeError: Cannot add property …,
// object is not extensible` —— 在开发期就炸，而不是在生产上悄悄污染所有人的视图。
//
// 注意：冻结发生在**模块求值时**，且这些数组只由上面的字面量推导，之后没有任何代码
// 依赖它们的可变性（服务层已改为先 clone 再变换）。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

deepFreeze(PROGRAM_STRUCTURES);
deepFreeze(FOLDER_DEFINITIONS);
