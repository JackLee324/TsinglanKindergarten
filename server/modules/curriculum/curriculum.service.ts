import { Injectable, Logger } from '@nestjs/common';
import { PROGRAM_STRUCTURES, FOLDER_DEFINITIONS, ROLE_DEFINITIONS } from './curriculum.data';
import type { ProgramStructure, FolderType, RoleCode, SubjectNode } from '@shared/api.interface';
// 与 resources/dashboard 同一个判定：shared/rbac.ts 的 isPlatformAdmin。
// 这里原本自带 ADMIN_ROLES，漏掉 super_admin —— super_admin 会看到
// 「无权限」的各班型结构。第六个同源缺陷点。
import { isPlatformAdmin, programsVisibleForStructure, roleSubjectScope } from '@shared/rbac';

export interface FolderDefinitionResponse {
  key: FolderType;
  name: string;
  nameEn: string;
}

export interface RoleDefinitionResponse {
  code: RoleCode;
  name: string;
  nameEn: string;
  description: string;
}

/**
 * Deep copy before handing curriculum data to a caller.
 *
 * WHY THIS EXISTS (verified defect, not a precaution)
 * ---------------------------------------------------
 * `getStructure()` used to `return PROGRAM_STRUCTURES` — the module-level array
 * itself — and, on the non-admin path, to `result.push(prekProgram)`, i.e. the
 * SAME object rather than a copy. The `hasPeSpecialist` branch then did
 * `existing.subjects.push(peSubject)` on that shared object. Net effect:
 *
 *   one request from an account holding `prek_head` + `pe_specialist` would
 *   permanently append Physical Education to the GLOBAL Pre-K subject list,
 *   and every later request from every other account (including a plain
 *   `prek_assistant`, or a `visitor`) would see it.
 *
 * That is "user A changes what user B sees", and it survives the request because
 * the array lives in module scope. Returning copies removes the mechanism
 * entirely; the transformations below then only ever touch their own copy.
 */
function cloneForResponse<T>(value: T): T {
  return structuredClone(value);
}

@Injectable()
export class CurriculumService {
  private readonly logger = new Logger(CurriculumService.name);

  getStructure(roles: RoleCode[] = []): ProgramStructure[] {
    // 一开始就拷贝：后面的 find/push 全部作用在这份拷贝上，任何分支都不可能
    // 再碰到模块级常量（见 cloneForResponse 的注释）。
    const source = cloneForResponse(PROGRAM_STRUCTURES);

    if (roles.length === 0 || isPlatformAdmin(roles)) {
      return source;
    }

    // §8：「角色 → 数据范围」这条规则只有一份实现，在 shared/rbac.ts。
    // 这里以前自己写死 prek_head / k_head / pe_specialist 三个字面量判断，
    // 与 resources.service.ts、dashboard.service.ts 各一份 —— 三份同源同规则。
    // 而"同一条规则抄 N 遍"正是 ADMIN_ROLES 缺陷连出三次的成因。
    const scope = roleSubjectScope(roles);

    // 配班（assistant）看得到本班型的**结构**，但"能取到哪些数据"仍由
    // subject_permissions 决定 —— 结构与数据范围是两件事。两条规则都在
    // shared/rbac.ts：本文件不再自己写 roles.includes('prek_assistant')。
    const visible = programsVisibleForStructure(roles);
    const seesPrek = visible.includes('prek');
    const seesK = visible.includes('k');

    const result: ProgramStructure[] = [];
    const prekProgram = source.find((p) => p.program === 'prek');
    const kProgram = source.find((p) => p.program === 'k');

    if (seesPrek && prekProgram) result.push(prekProgram);
    if (seesK && kProgram) result.push(kProgram);

    // pe_specialist 这类"只授单个科目"的授权：若该班型已整段可见就跳过
    // （整段可见时该科目本就在里面；旧代码在这条分支上做的正是空操作）。
    for (const pair of scope.explicitPairs) {
      if (result.some((p) => p.program === pair.program)) continue;
      const program = pair.program === 'prek' ? prekProgram : kProgram;
      if (!program) continue;
      if (!program.subjects.some((subject) => subject.key === pair.subject)) continue;
      result.push({
        ...program,
        subjects: program.subjects.filter((subject) => subject.key === pair.subject),
      });
    }

    return result;
  }

  getFolders(): FolderDefinitionResponse[] {
    return cloneForResponse(FOLDER_DEFINITIONS) as FolderDefinitionResponse[];
  }

  getRoles(): RoleDefinitionResponse[] {
    return cloneForResponse(ROLE_DEFINITIONS) as RoleDefinitionResponse[];
  }
}
