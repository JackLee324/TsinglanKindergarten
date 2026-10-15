/**
 * tests/helpers/source.mjs —— 读源码做**结构性断言**的公共助手
 * ============================================================================
 * 有些要求没法用接口测试证明，只能对源码本身断言：
 *   · 「批量删除里不存在物理删除这条路」—— 日常路径全绿，直到某天东西真的没了；
 *   · 「回收站判定与筛选条件之间没有优先级可踩」—— 写成或而不是与，
 *     表现为结果范围**悄悄变大**，不会让任何一条已有用例变红。
 *
 * 这类断言在仓库里已有先例（`single-permission-truth`、`route-declarations`、
 * `mobile-nav`）。这个文件只是把"去注释"和"截方法体"这两个反复要用的动作收口，
 * 免得每个测试各写一份、各自踩一遍同样的坑。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 读一份源码并**去掉注释**。
 *
 * 为什么必须去注释：这些源码里到处是解释性注释，而注释里提到
 * `DELETE FROM resources` / `purge` / 两段旧 SQL 是**正常而且应该被鼓励**的。
 * 不去注释就会把"解释缺陷的注释"当成缺陷本身（假红），
 * 于是下一个人会把注释删掉来让测试变绿 —— 那是最坏的结果。
 */
export function readSource(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * 截出某个方法的源码区间（从签名一直到最后那个闭合花括号）。
 *
 * 两个必须写对的细节：
 *
 * 1. **不能靠"下一个 `/**`"来判定结束** —— 注释在上面刚被剥掉了，
 *    结束标记根本不存在，于是会一路吞到文件末尾。表现是断言在**错误的地盘**
 *    上求值（比如 `bulkSoftDelete` 里"出现"了 `purge()` 的 DELETE），假红。
 * 2. **找方法体的 `{` 之前要先跳过参数表与装饰器** ——
 *    `@DirectoryScope({ kind: 'resource', param: 'id' })` 里的 `{` 也在签名之后，
 *    直接 `indexOf('{')` 会切出一段 `{ kind: 'resource', param: 'id' }`。
 *    办法：只在**圆括号深度为 0** 的时候认 `{`。
 *
 * 找不到签名、括号不配对、或者切出来的区间里出现了别的方法签名（说明越界了），
 * 一律抛错 —— 这类助手最危险的失败方式就是**静默返回半截内容**。
 */
export function bodyOf(source, signature) {
  const start = source.indexOf(signature)
  if (start === -1) {
    throw new Error(`源码里找不到「${signature}」—— 方法被改名了？请同步更新引用它的测试`)
  }

  let paren = 0
  let open = -1
  /*
    ⚠️ 从 `start` 扫起，**不是**从 `start + signature.length`。
    签名自己就带着那个开括号，从它后面扫的话 `paren` 会一直是 0，
    于是参数里的**对象字面量类型**会被当成方法体：

      async queryResources(opt: { scope: ... }) { ... }
                             ^ 这里就被切断了

    表现是 bodyOf 返回 347 个字符（只有参数声明），后面所有断言都在错的地盘上求值。

    ⚠️ 还**不能**只取第一个深度为 0 的 `{`：返回值类型里也有花括号 ——

      private async assertDeletable(...): Promise<{ reason: string } | null> {
                                                      ^ 会被误当成方法体

    这里只跟踪圆括号，看不到尖括号。所以把候选都收起来，
    优先取"后面紧跟换行"的那个（方法体的写法），没有就退回第一个。
    （这个坑是 2026-10-15 写 `assertDeletable` 的结构断言时踩到的：
      bodyOf 只截到 138 个字符，断言报"状态名单必须引用共享的那一份"，
      而真实原因是切错了地方 —— 又一次假红的形状。）
  */
  const candidates = []
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(') paren += 1
    else if (ch === ')') paren = Math.max(0, paren - 1)
    else if (ch === '{' && paren === 0) {
      candidates.push(i)
      if (/^\s*\n/.test(source.slice(i + 1, i + 40))) {
        open = i
        break
      }
    }
  }
  if (open === -1) open = candidates[0] ?? -1
  if (open === -1) throw new Error(`「${signature}」后面找不到方法体的 {`)

  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const text = source.slice(start, i + 1)
        // 防御：区间里只应该有它自己那一个方法签名
        const found =
          text.match(/async (?:softDeleteOne|purge|bulkSoftDelete|list|mine|recycleBin|queryResources|countMatching)\(/g) ?? []
        if (found.length > 1) {
          throw new Error(`「${signature}」截出来的区间越界了（吞掉了后面的方法）：${found.join(' / ')}`)
        }
        return text
      }
    }
  }
  throw new Error(`「${signature}」的花括号没有配对`)
}
