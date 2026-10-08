/**
 * scripts/lib/resolve-legacy-directory.mjs —— **唯一**的 V1 资源 → V2 目录 落位器
 * ============================================================================
 * 业主 Stage 12B 的硬要求：
 *
 *   · program + subject + sub_subject（如果该课程结构有这一级）+ folder_type
 *     共同决定最终目录，**不许漏 sub_subject**；
 *   · **不许**"找不到就退回 Section"（那会让资源落在 allowFiles=false 的节点上 →
 *     数据在库里、接口也查得到，但老师在目录里看不到）；
 *   · 只在**一个地方**实现：导入脚本、报告脚本、测试都用它，不许各写一套；
 *   · 用**明确映射 + 精确 code 匹配**，不用 startsWith/includes 之类的模糊猜路径。
 *
 * 判定过程（全部可解释，没有一步是猜的）：
 *
 *   1. folder_type → 资料夹 kind（V1 自己的分类表）：
 *        curriculum_outline → outline      课程大纲
 *        weekly_plans       → lesson       教学详案
 *        courseware         → resource     教学资源
 *        materials          → resource     教学资源（V1 分类表里就是归到"教学资源"）
 *        observation        → assessment   考核评估
 *        research_archive   → **没有对应**（V1 自己也没给它建资料夹）→ UNRESOLVED
 *   2. 目标 code 有两个候选（顺序固定）：
 *        有 sub_subject：`<program>:<subject>:<sub_subject>_<kind>`
 *        无 sub_subject：`<program>:<subject>_<kind>`
 *      **两个都拿去做精确 code 匹配**：
 *        · 先试带 sub_subject 的那个（K/中文 那一支只有这种）；
 *        · 再试不带 sub_subject 的那个（Pre-K/蒙特梭利 这类只有科目层资料夹）。
 *      两个都存在时**优先带 sub_subject 的那个**（更精确）；
 *      一个都不存在 → `resolved: false`，进 UNRESOLVED 清单。
 *
 *   这样既不会漏 sub_subject，也不会因为"这一级没有独立资料夹"而失败 ——
 *   例如 `prek:montessori` 的资源带 `sub_subject=practical_life`，
 *   而树里只有 `prek:montessori_outline`，那就精确落到它（它不是 Section）。
 */

/** V1 的 folder_type → V2 资料夹的 kind（code 后缀）。 */
export const FOLDER_KIND_BY_TYPE = Object.freeze({
  curriculum_outline: 'outline',
  weekly_plans: 'lesson',
  courseware: 'resource',
  materials: 'resource',
  observation: 'assessment',
})

/** kind → 中文名（报告里用，便于人核对）。 */
export const FOLDER_KIND_LABEL = Object.freeze({
  outline: '课程大纲',
  lesson: '教学详案',
  resource: '教学资源',
  assessment: '考核评估',
})

/**
 * 生成候选 code（顺序即优先级）。
 *
 * @returns {readonly string[]} 0~2 个候选；`research_archive` 这类无映射的返回空数组。
 */
export function candidateCodes({ program, subject, sub_subject, folder_type }) {
  const kind = FOLDER_KIND_BY_TYPE[folder_type]
  if (kind === undefined) return []
  const p = String(program ?? '').trim()
  const s = String(subject ?? '').trim()
  if (p === '' || s === '') return []
  const sub = sub_subject === null || sub_subject === undefined ? '' : String(sub_subject).trim()
  const out = []
  if (sub !== '') out.push(`${p}:${s}:${sub}_${kind}`)
  out.push(`${p}:${s}_${kind}`)
  return out
}

/**
 * 唯一的落位入口。
 *
 * @param {{program:string, subject:string, sub_subject?:string|null, folder_type:string}} resource
 * @param {ReadonlyMap<string, {id:string, path?:string|null, name?:string|null}>} directoriesByCode
 *        目录索引：V1 的 code → 该节点在 V2 里的信息。**必须是建完目录之后的索引**
 *        （历史缺陷就是拿了导入前的旧列表去查，结果永远查不到 → 回退到 Section）。
 * @returns {{
 *   resolved: boolean,
 *   code: string|null,
 *   directoryId: string|null,
 *   path: string|null,
 *   kind: string|null,
 *   reason: string,
 *   tried: readonly string[],
 * }}
 */
export function resolveLegacyResourceDirectory(resource, directoriesByCode) {
  const kind = FOLDER_KIND_BY_TYPE[resource.folder_type] ?? null
  const tried = candidateCodes(resource)
  const base = {
    code: null,
    directoryId: null,
    path: null,
    kind,
    tried,
  }

  if (kind === null) {
    return {
      ...base,
      resolved: false,
      reason: `folder_type「${resource.folder_type}」在 V1 自己的分类表里没有对应的资料夹（不猜）`,
    }
  }
  if (tried.length === 0) {
    return { ...base, resolved: false, reason: 'program / subject 缺失，无法定位资料夹' }
  }

  for (const code of tried) {
    const hit = directoriesByCode.get(code)
    if (hit !== undefined) {
      return {
        ...base,
        resolved: true,
        code,
        directoryId: hit.id,
        path: hit.path ?? null,
        reason:
          code === tried[0] && tried.length > 1
            ? '精确命中（含 sub_subject 的资料夹）'
            : '精确命中（该科目只有科目层资料夹，树里没有 sub_subject 那一级）',
      }
    }
  }

  return {
    ...base,
    resolved: false,
    reason:
      `树里没有 ${tried.map((c) => `「${c}」`).join(' / ')} 这个资料夹 —— ` +
      '**不回退到科目层**（那会让资源落在 allowFiles=false 的节点上，老师看不到）',
  }
}

/** 把 V2 的目录列成 code → 节点 的索引（code 取自 V1 的目录，存在 v1_migration_map 里）。 */
export function buildDirectoryCodeIndex(rows) {
  const map = new Map()
  for (const row of rows) {
    if (row.code === null || row.code === undefined) continue
    map.set(String(row.code), { id: String(row.id), path: row.path ?? null, name: row.name ?? null })
  }
  return map
}
