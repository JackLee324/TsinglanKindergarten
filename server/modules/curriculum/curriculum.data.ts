import type { ProgramStructure, FolderType, RoleCode } from '@shared/api.interface';

export const PROGRAM_STRUCTURES: ProgramStructure[] = [
  {
    program: 'prek',
    name: 'Pre-K',
    nameEn: 'Pre-K',
    subjects: [
      {
        key: 'virtue',
        name: '美德',
        nameEn: 'Virtue',
        path: 'virtue',
      },
      {
        key: 'montessori',
        name: '蒙特梭利',
        nameEn: 'Montessori',
        path: 'montessori',
        children: [
          {
            key: 'practical_life',
            name: '日常生活',
            nameEn: 'Practical Life',
            path: 'montessori/practical_life',
          },
          {
            key: 'sensorial',
            name: '感官',
            nameEn: 'Sensorial',
            path: 'montessori/sensorial',
          },
          {
            key: 'math',
            name: '数学',
            nameEn: 'Math',
            path: 'montessori/math',
          },
          {
            key: 'english_language',
            name: '英文语言',
            nameEn: 'English Language',
            path: 'montessori/english_language',
          },
          {
            key: 'chinese_language',
            name: '中文语言',
            nameEn: 'Chinese Language',
            path: 'montessori/chinese_language',
          },
          {
            key: 'culture',
            name: '文化',
            nameEn: 'Culture',
            path: 'montessori/culture',
          },
        ],
      },
      {
        key: 'physical_education',
        name: '体能',
        nameEn: 'Physical Education',
        path: 'physical_education',
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
        path: 'virtue',
      },
      {
        key: 'chinese',
        name: '中文',
        nameEn: 'Chinese',
        path: 'chinese',
        children: [
          {
            key: 'ancient_poetry',
            name: '古诗',
            nameEn: 'Ancient Poetry',
            path: 'chinese/ancient_poetry',
          },
          {
            key: 'picture_books',
            name: '绘本',
            nameEn: 'Picture Books',
            path: 'chinese/picture_books',
          },
          {
            key: 'drama',
            name: '戏剧',
            nameEn: 'Drama',
            path: 'chinese/drama',
          },
          {
            key: 'stem',
            name: '科学与工程',
            nameEn: 'STEM',
            path: 'chinese/stem',
          },
        ],
      },
      {
        key: 'english',
        name: '英文',
        nameEn: 'English',
        path: 'english',
        children: [
          {
            key: 'reading_comprehension',
            name: '阅读理解',
            nameEn: 'Reading Comprehension',
            path: 'english/reading_comprehension',
          },
          {
            key: 'language_skills',
            name: '语言技能',
            nameEn: 'Language Skills',
            path: 'english/language_skills',
          },
          {
            key: 'math',
            name: '数学',
            nameEn: 'Math',
            path: 'english/math',
          },
        ],
      },
      {
        key: 'physical_education',
        name: '体能',
        nameEn: 'Physical Education',
        path: 'physical_education',
        children: [
          {
            key: 'pe_special',
            name: '体能专项',
            nameEn: 'PE Special',
            path: 'physical_education/pe_special',
          },
          {
            key: 'sports',
            name: '体育',
            nameEn: 'Sports',
            path: 'physical_education/sports',
          },
          {
            key: 'rock_climbing',
            name: '攀岩',
            nameEn: 'Rock Climbing',
            path: 'physical_education/rock_climbing',
          },
        ],
      },
    ],
  },
];

export interface FolderDefinition {
  key: FolderType;
  name: string;
  nameEn: string;
}

export const FOLDER_DEFINITIONS: FolderDefinition[] = [
  { key: 'curriculum_outline', name: '课程大纲', nameEn: 'Curriculum Outline' },
  { key: 'weekly_plans', name: '周次教案', nameEn: 'Weekly Lesson Plans' },
  { key: 'courseware', name: '课件与示范', nameEn: 'Courseware & Demonstration' },
  { key: 'materials', name: '素材与工作单', nameEn: 'Materials & Worksheets' },
  { key: 'observation', name: '观察与评价', nameEn: 'Observation & Assessment' },
  { key: 'research_archive', name: '教研归档', nameEn: 'Teaching Research Archive' },
];

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
