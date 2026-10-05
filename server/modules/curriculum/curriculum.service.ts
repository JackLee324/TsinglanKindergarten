import { Injectable, Logger } from '@nestjs/common';
import { PROGRAM_STRUCTURES, FOLDER_DEFINITIONS, ROLE_DEFINITIONS } from './curriculum.data';
import type { ProgramStructure, FolderType, RoleCode, SubjectNode } from '@shared/api.interface';
// 与 resources/dashboard 同一个判定：shared/rbac.ts 的 isPlatformAdmin。
// 这里原本自带 ADMIN_ROLES，漏掉 super_admin —— super_admin 会看到
// 「无权限」的各班型结构。第六个同源缺陷点。
import { isPlatformAdmin } from '@shared/rbac';

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
    const hasPrekHead = roles.includes('prek_head');
    const hasKHead = roles.includes('k_head');
    const hasPeSpecialist = roles.includes('pe_specialist');
    const hasPrekAssistant = roles.includes('prek_assistant');
    const hasKAssistant = roles.includes('k_assistant');

    const result: ProgramStructure[] = [];

    const prekProgram = source.find((p) => p.program === 'prek');
    const kProgram = source.find((p) => p.program === 'k');

    if (hasPrekHead || hasPrekAssistant) {
      if (prekProgram) result.push(prekProgram);
    }

    if (hasKHead || hasKAssistant) {
      if (kProgram) result.push(kProgram);
    }

    if (hasPeSpecialist) {
      if (prekProgram && !result.find((p) => p.program === 'prek')) {
        result.push({
          ...prekProgram,
          subjects: prekProgram.subjects.filter(
            (s) => s.key === 'physical_education',
          ),
        });
      } else if (prekProgram) {
        const existing = result.find((p) => p.program === 'prek');
        if (existing) {
          const hasPe = existing.subjects.some(
            (s) => s.key === 'physical_education',
          );
          if (!hasPe) {
            const peSubject = prekProgram.subjects.find(
              (s) => s.key === 'physical_education',
            );
            if (peSubject) existing.subjects.push(peSubject);
          }
        }
      }
      if (kProgram && !result.find((p) => p.program === 'k')) {
        result.push({
          ...kProgram,
          subjects: kProgram.subjects.filter(
            (s) => s.key === 'physical_education',
          ),
        });
      } else if (kProgram) {
        const existing = result.find((p) => p.program === 'k');
        if (existing) {
          const hasPe = existing.subjects.some(
            (s) => s.key === 'physical_education',
          );
          if (!hasPe) {
            const peSubject = kProgram.subjects.find(
              (s) => s.key === 'physical_education',
            );
            if (peSubject) existing.subjects.push(peSubject);
          }
        }
      }
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
