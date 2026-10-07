/**
 * scripts/seed.mjs —— 按 PDF《教师平台》初始化目录树
 * ============================================================================
 *   node scripts/seed.mjs            幂等写入初始目录
 *
 * 三条规则（都来自业主的明确要求）：
 *
 * 1. **严格按 PDF。** 树的结构逐字来自 PDF 与业主的确认清单，
 *    包含「Pre-K → 英文」与「职业道德规范 → 师风师德建设」—— 这两个节点
 *    **不得自行删除**。
 *
 * 2. **幂等且不覆盖。** 已存在的节点只补不存在的，**绝不覆盖**管理员改过的
 *    名称/英文名/说明。判断依据是 `(parent_id, slug)`，而 `slug` 是不可变的，
 *    所以重跑 seed 不会产生重复节点、也不会把「美德课程」改回「美德」。
 *
 * 3. **PDF 只是初始数据。** 跑完之后一切都可以在管理界面里改名、增删、排序、
 *    启停。seed 里没有任何"系统节点不可改"的标记 —— 那是业主要求删掉的旧规则。
 *
 * 能力开关（allowFiles / allowCustomFolders）不是随手写的：
 *   · 只有**叶节点**允许放资源（allowFiles = true），中间层只做导航。
 *   · 只有 PDF 明确标注允许自建文件夹的 **教学详案 / 教学资源** 允许
 *     普通教师建文件夹（allowCustomFolders = true）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
void ROOT

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_v2_dev'

/** 教育教学叶节点下的四个固定资料夹。 */
const FOUR_FOLDERS = [
  { slug: 'outline', name: '课程大纲', nameEn: 'Curriculum Outline', allowCustomFolders: false },
  { slug: 'lesson', name: '教学详案', nameEn: 'Lesson Plans', allowCustomFolders: true },
  { slug: 'resources', name: '教学资源', nameEn: 'Teaching Resources', allowCustomFolders: true },
  { slug: 'assessment', name: '考核评估', nameEn: 'Assessment', allowCustomFolders: false },
]

/** 把"科目 → 四个资料夹"展开成节点列表。 */
function withFolders(parentPath, subject) {
  const nodes = [{ path: parentPath, ...subject }]
  for (const [i, f] of FOUR_FOLDERS.entries()) {
    nodes.push({
      path: `${parentPath}/${f.slug}`,
      slug: f.slug,
      name: f.name,
      nameEn: f.nameEn,
      type: 'FOLDER',
      sortOrder: i + 1,
      allowChildren: true,
      allowFiles: true,
      allowCustomFolders: f.allowCustomFolders,
    })
  }
  return nodes
}

/** 教师成长的分支：结构按 PDF，叶节点直接放文件（PDF 未定义下级资料夹）。 */
function growthBranch(parentPath, node) {
  const nodes = [
    {
      path: parentPath,
      slug: node.slug,
      name: node.name,
      nameEn: node.nameEn,
      type: 'SECTION',
      sortOrder: node.sortOrder ?? 0,
      allowChildren: true,
      allowFiles: node.children === undefined || node.children.length === 0,
      allowCustomFolders: false,
    },
  ]
  for (const [i, child] of (node.children ?? []).entries()) {
    nodes.push(...growthBranch(`${parentPath}/${child.slug}`, { sortOrder: i + 1, ...child }))
  }
  return nodes
}

/**
 * 完整节点清单。**父节点必须排在子节点之前** —— 写入时按顺序解析 parent。
 */
export const DIRECTORY_TREE = [
  // ── 教育教学 ──────────────────────────────────────────────────────────────
  {
    path: 'education',
    slug: 'education',
    name: '教育教学',
    nameEn: 'Education',
    type: 'ROOT',
    sortOrder: 1,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  },
  // 班型层是**普通节点**，不带资料夹 ——
  // 四个资料夹挂在每个科目下面，不是挂在班型下面。
  {
    path: 'education/pre-k',
    slug: 'pre-k',
    name: 'Pre-K',
    nameEn: 'Pre-K',
    type: 'CATEGORY',
    sortOrder: 1,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  },
  ...withFolders('education/pre-k/virtue', {
    slug: 'virtue',
    name: '美德',
    nameEn: 'Virtue',
    type: 'SECTION',
    sortOrder: 1,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  ...withFolders('education/pre-k/montessori', {
    slug: 'montessori',
    name: '蒙特梭利',
    nameEn: 'Montessori',
    type: 'SECTION',
    sortOrder: 2,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  ...withFolders('education/pre-k/pe', {
    slug: 'pe',
    name: '体能',
    nameEn: 'Physical Education',
    type: 'SECTION',
    sortOrder: 3,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  // PDF 里有「英文」，业主确认保留 —— 不得自行删除。
  ...withFolders('education/pre-k/english', {
    slug: 'english',
    name: '英文',
    nameEn: 'English',
    type: 'SECTION',
    sortOrder: 4,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),

  {
    path: 'education/k',
    slug: 'k',
    name: 'K',
    nameEn: 'K',
    type: 'CATEGORY',
    sortOrder: 2,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  },
  {
    path: 'education/k/chinese',
    slug: 'chinese',
    name: '中文教学',
    nameEn: 'Chinese',
    type: 'SECTION',
    sortOrder: 1,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  },
  ...withFolders('education/k/chinese/picture-books', {
    slug: 'picture-books',
    name: '绘本阅读',
    nameEn: 'Picture Books',
    type: 'SECTION',
    sortOrder: 1,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  ...withFolders('education/k/chinese/poetry', {
    slug: 'poetry',
    name: '古诗',
    nameEn: 'Ancient Poetry',
    type: 'SECTION',
    sortOrder: 2,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  ...withFolders('education/k/chinese/stem', {
    slug: 'stem',
    name: 'STEM',
    nameEn: 'STEM',
    type: 'SECTION',
    sortOrder: 3,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  ...withFolders('education/k/chinese/arts', {
    slug: 'arts',
    name: '美育',
    nameEn: 'Arts',
    type: 'SECTION',
    sortOrder: 4,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  ...withFolders('education/k/english', {
    slug: 'english',
    name: '英文教学',
    nameEn: 'English',
    type: 'SECTION',
    sortOrder: 2,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),
  ...withFolders('education/k/pe', {
    slug: 'pe',
    name: '体能',
    nameEn: 'Physical Education',
    type: 'SECTION',
    sortOrder: 3,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  }),

  // ── 教师成长 ──────────────────────────────────────────────────────────────
  {
    path: 'growth',
    slug: 'growth',
    name: '教师成长',
    nameEn: 'Teacher Growth',
    type: 'ROOT',
    sortOrder: 2,
    allowChildren: true,
    allowFiles: false,
    allowCustomFolders: false,
  },
  ...growthBranch('growth/l1', {
    slug: 'l1',
    name: 'L1 基础规范',
    nameEn: 'L1 Foundations',
    sortOrder: 1,
    children: [
      {
        slug: 'ethics',
        name: '职业道德规范',
        nameEn: 'Professional Ethics',
        children: [
          // 业主确认：PDF 里「职业道德规范」下有这个节点，保留。
          { slug: 'conduct', name: '师风师德建设', nameEn: 'Teacher Conduct' },
        ],
      },
      {
        slug: 'safety',
        name: '安全施教规范',
        nameEn: 'Safe Teaching',
        children: [
          {
            slug: 'plan',
            name: '应急预案',
            nameEn: 'Emergency Plans',
            children: [
              { slug: 'disease', name: '传染病识别与防治', nameEn: 'Infectious Disease' },
              { slug: 'injury', name: '意外伤害预防与处置', nameEn: 'Injury Prevention' },
            ],
          },
        ],
      },
      { slug: 'knowledge', name: '专业知识', nameEn: 'Professional Knowledge' },
      {
        slug: 'skill',
        name: '专业技能',
        nameEn: 'Professional Skills',
        children: [
          { slug: 'daily', name: '一日生活规范', nameEn: 'Daily Routines' },
          { slug: 'connection', name: '与幼儿建立连接', nameEn: 'Connecting with Children' },
          { slug: 'playful-teaching', name: '游戏化教学', nameEn: 'Playful Teaching' },
        ],
      },
    ],
  }),
  ...growthBranch('growth/l2', {
    slug: 'l2',
    name: 'L2 独立胜任',
    nameEn: 'L2 Independent',
    sortOrder: 2,
  }),
  ...growthBranch('growth/l3', {
    slug: 'l3',
    name: 'L3 卓越引领',
    nameEn: 'L3 Leading',
    sortOrder: 3,
  }),
]

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })

async function main() {
  // 依赖顺序保证：父先于子。这里做一次自检，避免以后有人插错位置。
  const seen = new Set()
  for (const node of DIRECTORY_TREE) {
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : null
    if (parent !== null && !seen.has(parent)) {
      throw new Error(`seed 顺序错误：${node.path} 的父节点 ${parent} 还没出现`)
    }
    seen.add(node.path)
  }

  const ids = new Map()
  let created = 0
  let kept = 0

  for (const node of DIRECTORY_TREE) {
    const parentPath = node.path.includes('/')
      ? node.path.slice(0, node.path.lastIndexOf('/'))
      : null
    const parentId = parentPath === null ? null : ids.get(parentPath)
    if (parentPath !== null && !parentId) throw new Error(`找不到父节点：${parentPath}`)

    // 幂等：已存在就**什么都不改**（管理员可能已经改过名字）。
    const existing = parentId
      ? await sql`SELECT id FROM directories WHERE parent_id = ${parentId} AND slug = ${node.slug}`
      : await sql`SELECT id FROM directories WHERE parent_id IS NULL AND slug = ${node.slug}`

    if (existing.length > 0) {
      ids.set(node.path, existing[0].id)
      kept += 1
      continue
    }

    const inserted = await sql`
      INSERT INTO directories
        (parent_id, slug, name, name_en, type, sort_order,
         allow_children, allow_files, allow_custom_folders)
      VALUES
        (${parentId}, ${node.slug}, ${node.name}, ${node.nameEn ?? null}, ${node.type},
         ${node.sortOrder ?? 0}, ${node.allowChildren ?? true}, ${node.allowFiles ?? false},
         ${node.allowCustomFolders ?? false})
      RETURNING id
    `
    ids.set(node.path, inserted[0].id)
    created += 1
  }

  const total = await sql`SELECT count(*)::int AS n FROM directories`
  console.log(`  seed 完成：新建 ${created} 个，已存在跳过 ${kept} 个，库中合计 ${total[0].n} 个节点`)
}

try {
  await main()
} catch (error) {
  console.error('seed 失败：' + (error?.message ?? error))
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
