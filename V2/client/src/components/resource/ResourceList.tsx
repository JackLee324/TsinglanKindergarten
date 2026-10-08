import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { resourcesApi } from '../../api/resources'
import { ApiError } from '../../api/http'
import type { ResourceListItem } from '../../api/types'
import { useDirectory } from '../../directory/DirectoryProvider'
import { ResourceCard } from './ResourceCard'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'

/**
 * 某个目录下的资源列表：搜索 + 服务端分页。
 *
 * 两条约束：
 *   · **分页在服务端**。"一次读完再由前端截断"在数据量小的时候看不出问题，
 *     等资源多了就变成"页面越来越慢，而且某天开始只显示前 N 条"。
 *   · **位置标签由目录树翻译**。资源只带 `directoryPath`（slug 路径），
 *     中文名从 `DirectoryProvider` 查 —— 这样管理员改名之后，
 *     列表里的位置显示自动跟着变，不需要重新请求资源。
 */
export function ResourceList({
  directoryId,
  pageSize = 12,
}: {
  readonly directoryId: string
  readonly pageSize?: number
}) {
  const { resolve, roots } = useDirectory()
  const [items, setItems] = useState<readonly ResourceListItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 点「重试」时 +1，让上面的 effect 再跑一次。 */
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    resourcesApi
      // 目录浏览**只看已发布**（业主 Stage 7 §17）：
      // 老师自己那份还没发布的草稿在「我的资源」里管理，
      // 目录里看到的永远是"大家都能用的东西"。这也让"这条资源上线了吗"
      // 在界面上有一个唯一、不会误解的答案。
      .list({ directoryId, status: 'PUBLISHED', page, pageSize, q: appliedQuery })
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setTotal(res.total)
        setTotalPages(res.totalPages)
      })
      .catch((e) => {
        if (cancelled) return
        setItems([])
        setTotal(0)
        setError(e instanceof ApiError ? e.message : '资源加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // reloadToken 让"重试"有一个明确的触发点（见下面的错误块）。
  }, [directoryId, page, pageSize, appliedQuery, reloadToken])

  /** slug 路径 → 中文位置（在已加载的目录树里查，不额外发请求）。 */
  const labelOf = (path: string): string => {
    const segments = path.split('/')
    const names: string[] = []
    let prefix = ''
    for (const slug of segments) {
      prefix = prefix === '' ? slug : `${prefix}/${slug}`
      const target = resolve(prefix.split('/'))
      names.push(target.node?.name ?? slug)
    }
    void roots
    return names.join(' / ')
  }

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    setAppliedQuery(query.trim())
  }

  /**
   * 清空搜索。
   *
   * ⚠️ 入口必须**只要"有已应用的搜索词"就出现**。
   * 第一版只在"搜不到任何结果"时才给清空按钮 —— 于是搜到东西之后反而没有一键清空，
   * 只能手动删掉输入框里的字。这是浏览器验收里撞出来的（点不到那个按钮）。
   */
  const clearSearch = () => {
    setQuery('')
    setAppliedQuery('')
    setPage(1)
  }

  if (loading && items.length === 0) return <Spinner label="正在加载资源…" />

  return (
    <section className="mt-8" data-testid="resource-list-section" data-directory-id={directoryId}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-foreground">
          资源
          <span className="ml-2 text-sm font-normal text-muted-foreground" data-testid="resource-total">
            共 {total} 条
          </span>
        </h2>
        <form onSubmit={submitSearch} className="flex items-center gap-2" data-testid="resource-search-form">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、英文标题、描述"
            className="w-64"
            data-testid="resource-search-input"
          />
          <Button type="submit" variant="outline" size="sm" data-testid="resource-search-submit">
            <Search className="size-4" /> 搜索
          </Button>
          {appliedQuery !== '' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearSearch}
              data-testid="resource-search-clear"
            >
              清空
            </Button>
          )}
        </form>
      </div>

      {/*
        出错时给一个**明确的重试入口**（业主 Stage 11 §20：Loading → Error → Retry）。
        以前只有一个红条：网络恢复之后，老师唯一的办法是自己再搜一次或刷新整页 ——
        在手机上这两件事都不顺手。
      */}
      {error !== null && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2"
          data-testid="resource-list-error"
        >
          <p className="text-sm text-destructive">{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReloadToken((n) => n + 1)}
            data-testid="resource-list-retry"
          >
            重试
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title={appliedQuery === '' ? '暂无资源' : `没有找到与「${appliedQuery}」匹配的资源`}
          description={
            appliedQuery === ''
              ? '这个目录下还没有资源。'
              : '可以换一个关键词，或者清空搜索看看全部。'
          }
          testId="resource-list-empty"
          action={
            appliedQuery === '' ? undefined : (
              <Button
                variant="outline"
                onClick={clearSearch}
                data-testid="resource-search-clear-empty"
              >
                清空搜索
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="resource-list">
            {items.map((item) => (
              <ResourceCard key={item.id} resource={item} locationLabel={labelOf(item.directoryPath)} />
            ))}
          </div>

          {/* 服务端分页：按钮只改 page，数据由服务端再取一次 */}
          <div className="mt-6 flex items-center justify-between gap-3" data-testid="resource-pagination">
            <p className="text-sm text-muted-foreground" data-testid="resource-page-info">
              第 {page} 页 / 共 {totalPages} 页 · 本页 {items.length} 条
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                data-testid="resource-page-prev"
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                data-testid="resource-page-next"
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
