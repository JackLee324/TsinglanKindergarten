/**
 * client/src/directory/path.ts —— **唯一**的目录 URL authority
 * ============================================================================
 * 全站只有这里能把目录节点变成 URL、或把 URL 还原成目录节点。
 * 页面、侧边栏、面包屑、卡片全部调它，任何组件都不允许 `'/directory/' + code` 这种拼接。
 *
 * 为什么必须是纯函数：它是"改名后六处同步"这条验收的可测部分。
 * 服务端保证改 `name` 不动 `slug`；这里保证 URL 只由 `slug` 生成。
 * 两者合起来 = 改中文名不会让任何链接失效。
 *
 * ⚠️ 这里**没有**任何写死的目录名或路径段。
 * V1 的 `/prek`、`/virtue`、`/growth` 那些是写死的；V2 只有 `/directory/<slug>/…`，
 * 因此管理员新增一级栏目「活动」时，前端一行都不用改。
 */
import type { DirectoryNode } from '../api/types'

/** 目录 URL 前缀。只有这一个常量。 */
export const DIRECTORY_BASE = '/directory'

/** 节点 → URL。只用 slug（稳定、不可变），不用 name（可改）。 */
export function directoryUrl(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0)
  return segments.length === 0 ? DIRECTORY_BASE : `${DIRECTORY_BASE}/${segments.join('/')}`
}

/** URL 段 → 目录路径（去掉可能的结尾斜杠与空段）。 */
export function segmentsToPath(segments: readonly string[]): string {
  return segments.filter((s) => s.length > 0).join('/')
}

/** 当前 URL 是否落在这个节点之下（用于侧边栏高亮与面包屑）。 */
export function isWithinPath(currentPath: string, nodePath: string): boolean {
  if (nodePath === '') return true
  return currentPath === nodePath || currentPath.startsWith(`${nodePath}/`)
}

export interface ResolvedTarget {
  /** 能解析到的**最深**节点；`null` 表示一段都没解析到。 */
  readonly node: DirectoryNode | null
  /** 从根到 node 的完整祖先链（含 node 自身）。 */
  readonly chain: readonly DirectoryNode[]
  /** 成功解析的段数。 */
  readonly resolvedCount: number
  /** 没有解析成功的剩余段。 */
  readonly restSegments: readonly string[]
}

/**
 * 在已经加载好的目录树里按 slug 段查找节点。
 *
 * WHY 不额外发一次 `by-path` 请求：侧边栏、面包屑、卡片页读的必须是**同一棵树**。
 * 多一次请求就多一次"某处拿到了不同版本"的机会 —— 那正是 V1 改名不同步的成因。
 *
 * 解析失败时返回**最近一个可解析的祖先**，由界面提示"已回到 X"，
 * 而不是白屏或 404（与 `DIRECTORY_MODEL.md` §4 的规则一致）。
 */
export function resolveInTree(
  roots: readonly DirectoryNode[],
  segments: readonly string[],
): ResolvedTarget {
  let list: readonly DirectoryNode[] = roots
  const chain: DirectoryNode[] = []

  for (const segment of segments) {
    const found = list.find((n) => n.slug === segment)
    if (!found) break
    chain.push(found)
    list = found.children
  }

  return {
    node: chain.length > 0 ? chain[chain.length - 1] : null,
    chain,
    resolvedCount: chain.length,
    restSegments: segments.slice(chain.length),
  }
}
