import { useEffect, useState } from 'react'
import { FileClock } from 'lucide-react'
import { resourcesApi } from '../../api/resources'
import { useDirectoryLabel } from '../../directory/label'
import { ApiError } from '../../api/http'
import type { ResourceListItem } from '../../api/types'
import { ResourceCard } from './ResourceCard'

/**
 * 「我的未发布资源」—— 目录页里**只给我自己看**的一块（业主 Stage 13B §4）。
 *
 * 为什么需要它（真实问题）：目录页的公开列表按设计只看 `PUBLISHED`，
 * 而上传动作创建的是一条 `DRAFT` 草稿 —— 老师上传完、返回原来的目录，
 * **看不到自己刚放上去的东西**，看起来像"上传失败了"。上传其实是成功的，
 * 问题只是"在哪儿能找到它"。
 *
 * 三条边界（都不许破）：
 *   1. **不公开别人的草稿**：请求带 `onlyMine`，服务端按 `uploader_id` 过滤
 *      （前端过滤只是显示层，安全边界在服务端 —— 见 resources.service 的 SQL）；
 *   2. **不污染公开列表**：这一块与上面的「资源」区域是**两个请求**，
 *      公开列表的总数/分页仍然只算已发布；
 *   3. **不重做 UI**：复用同一张 `ResourceCard`（自带状态标签与位置标签），
 *      没有未发布内容时**整块不渲染**，不给页面添噪音。
 *   4. **它不属于搜索/分页**：搜索框过滤的是下面那块公开列表（`ResourceList`），
 *      这一块说的是"你在这个目录下还没上线的东西"，与关键词无关 ——
 *      所以它稳在搜索框**上方**，而不是混进搜索结果里。
 *   5. **已撤回的不算**：撤回是老师**主动**把东西从目录里拿走的动作，
 *      再把它摆回目录页就等于把"撤回"变成"没撤回"。已撤回只在「我的资源」里
 *      （在那里可以重新编辑/提交）。已退回**算**：它正等着老师改完再交，
 *      卡片上会带退回意见与「已退回」标签。
 *
 * 管理员身份下这里同样只列"自己"的未发布资源 —— "管理员能看全部"是
 * 审核台/我的资源的职责，不该把全站草稿塞进每个目录页。
 */
export function MyUnpublishedResources({ directoryId }: { readonly directoryId: string }) {
  const [items, setItems] = useState<readonly ResourceListItem[]>([])
  const [error, setError] = useState<string | null>(null)
  // 位置标签用**同一份**目录翻译（见 directory/label.ts）：
  // 卡片上不写"东西在哪"，就等于把"我上传的东西去哪了"这个原始问题留着不答。
  const labelOf = useDirectoryLabel()

  useEffect(() => {
    let cancelled = false
    setError(null)
    resourcesApi
      // onlyMine：服务端强制按上传者过滤；不带 status → 拿到自己在**这个目录**下的全部状态
      .list({ directoryId, onlyMine: true, pageSize: 100 })
      .then((res) => {
        if (cancelled) return
        // 目录页上该出现的"还没上线"：草稿（刚上传）/ 待审核（交出去了）/
        // 已退回（等我改）。**已撤回不算** —— 见上面第 5 条边界。
        setItems(res.items.filter((r) => r.status !== 'PUBLISHED' && r.status !== 'RECALLED'))
      })
      .catch((e) => {
        if (cancelled) return
        // 这一块加载失败**不该**挡住页面上"大家都能用的资源"，
        // 所以只在自己这一块里显示一句可读提示。
        setItems([])
        setError(e instanceof ApiError ? e.message : '未发布资源加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [directoryId])

  if (error !== null) {
    return (
      <p className="mb-5 text-sm text-destructive" data-testid="my-unpublished-error">
        {error}
      </p>
    )
  }
  if (items.length === 0) return null

  return (
    <section className="mb-6" data-testid="my-unpublished-section">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* flex-wrap：320px 这种极窄宽度下，"我的未发布资源 + 共 N 个"要能换行，
            不许把页面顶出横向滚动条（阶段 11 的断点回归会逐格量这个）。 */}
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-foreground">
          <FileClock className="size-5 text-muted-foreground" /> 我的未发布资源
          <span className="text-sm font-normal text-muted-foreground" data-testid="my-unpublished-count">
            共 {items.length} 个
          </span>
        </h2>
        <p className="text-sm text-muted-foreground">
          只有你自己能看到（草稿 / 待审核 / 已退回）；发布后才会出现在上面的「资源」里。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="my-unpublished-list">
        {items.map((resource) => (
          <ResourceCard
            key={resource.id}
            resource={resource}
            locationLabel={labelOf(resource.directoryPath)}
            testId="my-unpublished-card"
          />
        ))}
      </div>
    </section>
  )
}
