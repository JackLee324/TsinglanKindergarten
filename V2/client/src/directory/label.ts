import { useDirectory } from './DirectoryProvider'

/**
 * slug 路径 → 中文位置（如 `教育教学 / Pre-K / 美德 / 教学资源`）。
 *
 * WHY 抽成一处：这段"把 slug 链翻译成中文链路"的逻辑原本**只**写在
 * `ResourceList` 里。Stage 13B 新增的「我的未发布资源」也要在卡片上显示位置
 * （业主最关心的问题就是"我上传的东西到底去哪了"），如果就地再抄一份，
 * 就等于出现了"第二份目录翻译"—— 目录改名之后两处会不一致，
 * 而这正是信息架构收口时要消灭的东西（见 `docs/DIRECTORY_MODEL.md`）。
 *
 * 它只读**已经加载好的那棵树**（`DirectoryProvider` 里唯一那份），
 * 不额外发请求：多一次请求就多一次"某处拿到不同版本"的机会。
 */
export function useDirectoryLabel(): (path: string) => string {
  const { roots, resolve } = useDirectory()
  // `roots` 只用来表明"树加载完之后标签会重算"，本身不参与翻译。
  void roots
  return (path: string) => {
    const names: string[] = []
    let prefix = ''
    for (const slug of path.split('/')) {
      prefix = prefix === '' ? slug : `${prefix}/${slug}`
      const target = resolve(prefix.split('/'))
      names.push(target.node?.name ?? slug)
    }
    return names.join(' / ')
  }
}
