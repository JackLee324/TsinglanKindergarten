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

@Injectable()
export class CurriculumService {
  private readonly logger = new Logger(CurriculumService.name);

  getStructure(roles: RoleCode[] = []): ProgramStructure[] {
    if (roles.length === 0 || isPlatformAdmin(roles)) {
      return PROGRAM_STRUCTURES;
    }
    const hasPrekHead = roles.includes('prek_head');
    const hasKHead = roles.includes('k_head');
    const hasPeSpecialist = roles.includes('pe_specialist');
    const hasPrekAssistant = roles.includes('prek_assistant');
    const hasKAssistant = roles.includes('k_assistant');

    const result: ProgramStructure[] = [];

    const prekProgram = PROGRAM_STRUCTURES.find((p) => p.program === 'prek');
    const kProgram = PROGRAM_STRUCTURES.find((p) => p.program === 'k');

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
    return FOLDER_DEFINITIONS;
  }

  getRoles(): RoleDefinitionResponse[] {
    return ROLE_DEFINITIONS;
  }
}
