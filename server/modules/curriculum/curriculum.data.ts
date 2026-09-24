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

export interface RoleDefinition {
  code: RoleCode;
  name: string;
  nameEn: string;
  description: string;
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    code: 'principal',
    name: '园长/平台管理员',
    nameEn: 'Principal',
    description: '全部权限，教师/角色/权限管理',
  },
  {
    code: 'curriculum_director',
    name: '教学主任/教研主管',
    nameEn: 'Curriculum Director',
    description: '审核发布、全部课程查看、教师权限分配',
  },
  {
    code: 'prek_head',
    name: 'Pre-K 主教',
    nameEn: 'Pre-K Head Teacher',
    description: 'Pre-K 全部科目上传、提交审核',
  },
  {
    code: 'k_head',
    name: 'K 主教',
    nameEn: 'K Head Teacher',
    description: 'K 全部科目上传、提交审核',
  },
  {
    code: 'pe_specialist',
    name: '体能专科教师',
    nameEn: 'PE Specialist',
    description: '体能类科目上传、提交审核',
  },
  {
    code: 'prek_assistant',
    name: 'Pre-K 配班/代课',
    nameEn: 'Pre-K Assistant',
    description: 'Pre-K 只读（可配置部分上传）',
  },
  {
    code: 'visitor',
    name: '普通访客/家长',
    nameEn: 'Visitor',
    description: '不能进入课程内容',
  },
];
